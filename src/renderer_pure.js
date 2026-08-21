// @ts-check
// renderer_pure.js
//
// Pure, dependency-free helpers extracted from the main renderer (src/main.js).
//
// This is the first module migrated to strict type-checking (via // @ts-check +
// JSDoc). Domain shapes come from the shared contract in src/shared/domain.d.ts
// (type-only import — no runtime dependency), so every module speaks the same
// vocabulary.
//
/**
 * @typedef {import('./shared/domain').Frame} Frame
 * @typedef {import('./shared/domain').Template} Template
 * @typedef {import('./shared/domain').Photo} Photo
 * @typedef {import('./shared/domain').Page} Page
 * @typedef {import('./shared/domain').PhotoRef} PhotoRef
 * @typedef {import('./shared/domain').CompactPage} CompactPage
 * @typedef {import('./shared/domain').HashablePage} HashablePage
 * @typedef {import('./shared/domain').RenderJob} RenderJob
 */
// Everything here is a plain function of its arguments — no DOM, no shared
// mutable module state, no I/O — which is exactly why it can live outside the
// 5,000-line renderer and be unit-tested in isolation. main.js pulls these
// back in via `require('./renderer_pure')` (nodeIntegration is on in the main
// window, the same mechanism it already uses for the UXP stubs).
//
// Rule for this file: if a function would need `document`, `albumPages`,
// `ipcRenderer`, `fs`, or any other ambient state, it does NOT belong here.

// Escape a string for safe interpolation into innerHTML. Template names, urls,
// and folder labels derive from user filenames/folders (and can arrive via a
// shared library), so a value like `<img src=x onerror=…>` would otherwise
// execute with full nodeIntegration privileges.
/** @param {unknown} value @returns {string} */
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Generative templates have no on-disk preview JPG — render a synthetic SVG
// from the frame geometry so the template grid and yellow preview show
// something meaningful. Cheap to recompute, no I/O, no images to cache.
/** @param {Template} template @param {boolean} [large] @returns {string} */
function _generativePreviewSvg(template, large = false) {
    const w = template._canvas?.w || 3000;
    const h = template._canvas?.h || 2000;
    const frames = template._frames || [];
    const fillH = '#7d4dff';
    const fillV = '#ff6b9b';
    const rects = frames.map(f => {
        const fill = f.name.toLowerCase().includes('toolkithframe') ? fillH : fillV;
        return `<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" fill="${fill}" fill-opacity="0.55" stroke="${fill}" stroke-width="6"/>`;
    }).join('');
    const sizeAttr = large ? 'width="100%" height="100%"' : '';
    return `<svg ${sizeAttr} viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" style="background:#11142e">
        <rect x="0" y="0" width="${w}" height="${h}" fill="#11142e"/>${rects}</svg>`;
}

// The folder-rail panel header (Refresh / Remove actions). `type` comes from a
// controlled set of panel kinds.
/** @param {string} type @returns {string} */
function getPanelHeaderHTML(type) {
    return `<div class="folder-rail__header">`
         +   `<button class="folder-rail__collapse" type="button" aria-label="Toggle folder list"></button>`
         +   `<span>Folders:</span>`
         +   `<div class="folder-rail__actions">`
         +     `<span class="btn-reload-fld folder-rail__action" data-type="${type}" title="Refresh folders">${require('./ui_icons').icn('refresh')}</span>`
         +     `<span class="btn-remove-fld folder-rail__action" data-type="${type}" title="Remove folders">${require('./ui_icons').icn('trash')}</span>`
         +   `</div>`
         + `</div>`;
}

// Display name for a folder entry. A `_Thumbnails` folder is shown under its
// parent's name (so two source folders' thumb caches don't both read
// "_Thumbnails"); everything else shows its own name.
/** @param {{ name: string, nativePath: string }} folder @returns {string} */
function getDisplayName(folder) {
    if (folder.name.toLowerCase() !== "_thumbnails") return folder.name;
    try {
        const parts = folder.nativePath.split(/[\\/]/).filter(p => p.length > 0);
        if (parts.length >= 2) return parts[parts.length - 2];
    } catch(e) {}
    return "Thumbs";
}

// Deterministic stringification of the inputs that affect a page's render
// output. Includes adjust + placement so colour/zoom-pan edits re-render (they
// don't change filePath, so they'd otherwise be cached as unchanged), and the
// page's overlay layers + background for the same reason — retyping a caption
// changes no photo at all. The render queue caches this hash so an unchanged
// page is a no-op re-render.
/** @param {HashablePage} pageData @returns {string} */
function _hashPage(pageData) {
    const parts = [
        pageData.templatePath,
        ...pageData.photos.map(p => {
            const a = p.adjust ? JSON.stringify(p.adjust) : '';
            const pl = p.placement ? JSON.stringify(p.placement) : '';
            return `${p.filePath}|${p.orient}|${p.rotation || 0}|${p.baseName}|${a}|${pl}`;
        }),
        pageData.overlays ? JSON.stringify(pageData.overlays) : '',
        pageData.pageBackground || '',
        pageData.layerEdits ? JSON.stringify(pageData.layerEdits) : '',
    ];
    return parts.join('§');
}

// Tiny, dependency-free JPEG EXIF parser. Reads a buffer (the first ~256 KB of
// a JPEG is plenty — EXIF lives in the APP1 marker right after SOI), finds tag
// 0x9003 (DateTimeOriginal), parses "YYYY:MM:DD HH:MM:SS" → epoch ms, or null.
// Byte math only (no Buffer methods) so it accepts the bare Uint8Array the
// bundled renderer gets from the preload bridge; node Buffers still work
// (Buffer IS a Uint8Array). Out-of-range reads yield NaN and fall through to
// the null returns, which is stricter than Buffer's throwing reads.
/** @param {Uint8Array} buf @returns {number | null} */
function _parseExifDateFromBuffer(buf) {
    const ascii = (/** @type {number} */ start, /** @type {number} */ end) => {
        let str = '';
        for (let i = start; i < end && i < buf.length; i++) str += String.fromCharCode(buf[i]);
        return str;
    };
    const be16 = (/** @type {number} */ p) => (buf[p] << 8) | buf[p + 1];
    const le16 = (/** @type {number} */ p) => buf[p] | (buf[p + 1] << 8);
    const be32 = (/** @type {number} */ p) => (((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0);
    const le32 = (/** @type {number} */ p) => ((buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0);

    // JPEG SOI must be 0xFFD8
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let off = 2;
    while (off < buf.length - 8) {
        if (buf[off] !== 0xFF) return null;
        const marker = buf[off + 1];
        const size = be16(off + 2);
        // APP1 (0xE1) holds EXIF.
        if (marker === 0xE1) {
            // EXIF\0\0 magic
            if (ascii(off + 4, off + 10) === 'Exif\u0000\u0000') {
                const tiff = off + 10;
                const little = ascii(tiff, tiff + 2) === 'II';
                const u16 = (/** @type {number} */ p) => little ? le16(p) : be16(p);
                const u32 = (/** @type {number} */ p) => little ? le32(p) : be32(p);
                const ifd0 = tiff + u32(tiff + 4);
                const numEntries = u16(ifd0);
                let exifIfd = 0;
                for (let i = 0; i < numEntries; i++) {
                    const e = ifd0 + 2 + i * 12;
                    if (u16(e) === 0x8769) { exifIfd = tiff + u32(e + 8); break; }
                }
                if (!exifIfd) return null;
                const n2 = u16(exifIfd);
                for (let i = 0; i < n2; i++) {
                    const e = exifIfd + 2 + i * 12;
                    if (u16(e) === 0x9003) { // DateTimeOriginal
                        const valOff = tiff + u32(e + 8);
                        const str = ascii(valOff, valOff + 19);
                        // "YYYY:MM:DD HH:MM:SS"
                        const m = str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
                        if (!m) return null;
                        return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime();
                    }
                }
                return null;
            }
        }
        off += 2 + size;
    }
    return null;
}

// A template entry carries a `url` (file://…) pointing at its JPG/PNG sibling
// preview. Decode it back to a filesystem path so sharp can read it. Returns
// null when there's no url or it isn't a file: URL.
/** @param {{ url?: string } | null | undefined} template @returns {string | null} */
function _proofTemplatePreviewPath(template) {
    if (!template?.url) return null;
    try {
        const u = new URL(template.url);
        if (u.protocol === 'file:') return decodeURIComponent(u.pathname);
    } catch (_) {}
    return null;
}

// True when a keyboard event target is a text-entry control, so global
// shortcuts can bow out while the user is typing. Works on any object exposing
// `tagName` / `isContentEditable` (a real DOM node in the app; a plain object
// in tests).
/** @param {{ tagName?: string, isContentEditable?: boolean } | null | undefined} t @returns {boolean | undefined} */
function _isEditingTarget(t) {
    if (!t) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t.isContentEditable;
}

// ─── Undo/redo snapshot compaction ──────────────────────────────────────────
// The history stack stores a COMPACT skeleton per page (template id + spec, and
// per-photo id + orient) rather than the full hydrated page with embedded
// thumbnail urls — ~10–50× smaller snapshots. On undo/redo the skeleton is
// re-hydrated back into a full page. These two must stay exact inverses or
// undo/redo silently corrupts the album, which is why they live here under test.

// Full page → compact skeleton. Pure. `orient` is kept because rotation can flip
// it and it is not recomputed on hydrate; url/baseName are re-derived later.
/** @param {Page | null | undefined} page @returns {CompactPage} */
function _compactPage(page) {
    if (!page) return { template: null, photos: [] };
    return {
        template: page.template ? {
            id: page.template.id,
            generative: !!page.template._generative,
            spec: page.template._spec || null,
        } : null,
        photos: (page.photos || []).map(p => ({ id: p.id, orient: p.orient })),
    };
}

// Compact skeleton → full page. Dependency-injected: `templateLibrary` (to
// re-link a template by id) and `photoCache` (to re-derive each photo's url)
// are passed in rather than read from renderer globals, so this stays pure and
// testable. The main renderer passes its own live collections at the call site.
/**
 * @param {CompactPage | null | undefined} cpage
 * @param {readonly Template[]} [templateLibrary]
 * @param {Record<string, { url?: string }>} [photoCache]
 * @returns {{ template: Template | null, photos: Array<{ id?: string, orient?: string, url: string | undefined }> }}
 */
function _hydratePage(cpage, templateLibrary = [], photoCache = {}) {
    if (!cpage) return { template: null, photos: [] };
    /** @type {Template | null} */
    let template = null;
    if (cpage.template) {
        const tref = cpage.template; // hoisted so TS keeps the non-null narrowing in the closure
        template = templateLibrary.find(t => t.id === tref.id) || null;
        // Generative templates may not be in templateLibrary if the user
        // toggled them off; keep the lightweight ref so a re-enable re-links.
        if (!template && tref.generative && tref.spec) {
            template = { id: tref.id, _generative: true, _spec: tref.spec };
        }
    }
    const photos = (cpage.photos || []).map(ref => {
        const c = ref.id != null ? photoCache[ref.id] : undefined;
        return {
            id: ref.id,
            orient: ref.orient,
            url: c ? c.url : '',
        };
    });
    return { template, photos };
}

// Render-queue dirty tracking. Given a batch of render jobs and the stored
// hash cache, decide which need rendering vs can be skipped (unchanged since
// their last successful render). This is the "re-render 5 changed pages, not
// all 200" logic. Pure: the cache is passed in, not read from localStorage.
//   job:   { pageNum, pageData, outputPath, ... }
//   key:   `${outputPath}|${pageNum}` — same page to a different output, or a
//          different page to the same output, are distinct cache entries.
// A job is skipped when its stored hash equals the current hash of its
// pageData. Fresh jobs come back with `hash` + `cacheKey` attached, ready to
// write into the cache on a successful render.
/**
 * @param {RenderJob[]} jobs
 * @param {Record<string, string>} [renderHashes]
 * @returns {{ fresh: Array<RenderJob & { hash: string, cacheKey: string }>, skipped: RenderJob[] }}
 */
function partitionByRenderCache(jobs, renderHashes = {}) {
    const fresh = [];
    const skipped = [];
    for (const job of jobs) {
        const hash = _hashPage(job.pageData);
        const cacheKey = `${job.outputPath}|${job.pageNum}`;
        if (renderHashes[cacheKey] === hash) {
            skipped.push(job);
        } else {
            fresh.push({ ...job, hash, cacheKey });
        }
    }
    return { fresh, skipped };
}

/**
 * Parse a page selection like "1, 3, 9-12" into an ordered list of page
 * numbers.
 *
 * Album work is rarely "render everything" — it's "the client changed three
 * spreads". Re-rendering 80 pages to deliver 3 costs minutes of Photoshop
 * time, so the selection has to be expressible directly.
 *
 * Accepts commas, spaces and newlines as separators, and `a-b` ranges in
 * either direction. Out-of-range numbers are DROPPED rather than clamped:
 * clamping "1-999" to the album length would silently render everything,
 * which is precisely the surprise this feature exists to avoid. Invalid
 * tokens are reported so the UI can say what it didn't understand.
 *
 * @param {string} spec
 * @param {number} totalPages
 * @returns {{ pages: number[], invalid: string[], outOfRange: number[] }}
 */
function parsePageSpec(spec, totalPages) {
    /** @type {Set<number>} */
    const pages = new Set();
    /** @type {string[]} */
    const invalid = [];
    /** @type {Set<number>} */
    const outOfRange = new Set();

    const inBounds = (/** @type {number} */ n) => {
        if (n >= 1 && n <= totalPages) { pages.add(n); return; }
        outOfRange.add(n);
    };

    for (const raw of String(spec == null ? '' : spec).split(/[,\n]/)) {
        const token = raw.trim();
        if (!token) continue;
        // A range: "9-12", and "12-9" means the same span.
        const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(token);
        if (range) {
            const a = parseInt(range[1], 10);
            const b = parseInt(range[2], 10);
            const lo = Math.min(a, b);
            const hi = Math.max(a, b);
            // A wild upper bound would otherwise spin for a very long time.
            if (hi - lo > 10000) { invalid.push(token); continue; }
            for (let n = lo; n <= hi; n++) inBounds(n);
            continue;
        }
        if (/^\d+$/.test(token)) { inBounds(parseInt(token, 10)); continue; }
        invalid.push(token);
    }

    return {
        pages: [...pages].sort((a, b) => a - b),
        invalid,
        outOfRange: [...outOfRange].sort((a, b) => a - b),
    };
}

/**
 * A photo's effective orientation once the user's rotation is applied.
 *
 * The decoded pixels say one thing; a 90°/270° rotation swaps it. Getting
 * this wrong sends a portrait photo to a landscape frame, where it is cropped
 * to ribbons — so it is worth pinning rather than inlining.
 *
 * @param {number} naturalWidth
 * @param {number} naturalHeight
 * @param {number} [rotation] degrees, any multiple of 90
 * @returns {'h'|'v'}
 */
function effectiveOrientation(naturalWidth, naturalHeight, rotation) {
    const base = naturalWidth >= naturalHeight ? 'h' : 'v';
    const rot = ((Number(rotation) || 0) % 360 + 360) % 360;
    const quarterTurned = rot === 90 || rot === 270;
    if (!quarterTurned) return base;
    return base === 'h' ? 'v' : 'h';
}

/**
 * Decide how many photos land on each page in an Auto-Fill run.
 *
 * Two modes:
 *   desired — spread ALL photos across exactly N sheets. Every sheet gets
 *             floor(total/N); the remainder is handed out one-per-sheet to a
 *             shuffled subset, so the heavy pages aren't always the first few.
 *   range   — take a random count in [min, max] per page until photos run out.
 *
 * `rng` is injectable purely so the distribution can be tested deterministically.
 *
 * Guarantees, whatever the input: the counts sum to exactly `total` (no photo
 * lost or placed twice) and the function always terminates. The previous
 * inline version did neither — min = max = 0 passed validation (0 > 0 is
 * false), pushed a 0 forever and never decremented the remaining count, so
 * the app hung and the array grew until it ran out of memory. Negative values
 * were worse: `remaining` grew.
 *
 * @param {number} total  photos available to place
 * @param {{ mode?: 'desired'|'range', desiredSheets?: number, min?: number, max?: number }} opts
 * @param {() => number} [rng]
 * @returns {{ counts: number[], cappedTo: number|null, error: string|null }}
 */
function planAutoFillCounts(total, opts, rng = Math.random) {
    const n = Math.floor(Number(total) || 0);
    if (n <= 0) return { counts: [], cappedTo: null, error: 'No photos available to place.' };

    if (opts && opts.mode === 'desired') {
        const want = Math.floor(Number(opts.desiredSheets));
        if (!Number.isFinite(want) || want < 1) {
            return { counts: [], cappedTo: null, error: 'Enter a valid number of desired sheets (1 or more).' };
        }
        // Never more sheets than photos — an empty sheet helps nobody.
        const sheets = Math.min(want, n);
        const base = Math.floor(n / sheets);
        const remainder = n - base * sheets;

        const order = Array.from({ length: sheets }, (_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {           // Fisher–Yates
            const j = Math.floor(rng() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
        const bonus = new Set(order.slice(0, remainder));
        const counts = [];
        for (let i = 0; i < sheets; i++) counts.push(base + (bonus.has(i) ? 1 : 0));
        return { counts, cappedTo: sheets < want ? sheets : null, error: null };
    }

    const min = Math.floor(Number(opts && opts.min));
    const max = Math.floor(Number(opts && opts.max));
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        return { counts: [], cappedTo: null, error: 'Invalid Min/Max values.' };
    }
    // A page must take at least one photo, or the loop below cannot converge.
    if (max < 1) {
        return { counts: [], cappedTo: null, error: 'Max photos per page must be at least 1.' };
    }
    const lo = Math.max(1, min);

    const counts = [];
    let remaining = n;
    while (remaining > 0) {
        let take = Math.floor(rng() * (max - lo + 1)) + lo;
        // Belt and braces: even a misbehaving rng cannot stall this loop.
        if (!Number.isFinite(take) || take < 1) take = 1;
        if (take > remaining) take = remaining;
        counts.push(take);
        remaining -= take;
    }
    return { counts, cappedTo: null, error: null };
}

/**
 * Read the result string a build JSX returns.
 *
 * The scripts answer with one of:
 *   "OK 12/12"                     every page built
 *   "PARTIAL 10/12: 003,007"       some pages failed, named
 *   "BATCH_ERROR: <message>"       the run died
 *   "BUILD_PAGE_ERROR: <message>"  single-page equivalent
 *
 * Anything else is treated as a FAILURE rather than a success. Photoshop can
 * return an empty string or a stray warning, and the previous code took
 * "didn't throw" as proof the pages rendered — so a batch that produced
 * nothing still marked every page as cached and the user could never retry
 * without clearing the cache by hand.
 *
 * @param {unknown} result raw JSX return value
 * @param {string[]} expected zero-padded page names in the batch
 * @returns {{ fatal: string|null, failed: string[] }}
 */
function parseBatchResult(result, expected) {
    const text = typeof result === 'string' ? result.trim() : '';
    if (/^(BATCH_ERROR|BUILD_PAGE_ERROR):/.test(text)) {
        return { fatal: text.replace(/^[A-Z_]+:\s*/, ''), failed: [] };
    }
    const partial = /^PARTIAL\s+\d+\/\d+:\s*(.*)$/.exec(text);
    if (partial) {
        const named = partial[1].split(',').map((s2) => s2.trim()).filter(Boolean);
        return { fatal: null, failed: named };
    }
    if (/^OK\s+\d+\/\d+$/.test(text)) return { fatal: null, failed: [] };
    // Unrecognised: assume nothing rendered. Better a spurious retry than a
    // page silently marked done that was never written.
    return {
        fatal: text ? `unexpected result from Photoshop: ${text.slice(0, 120)}` : 'Photoshop returned no result',
        failed: expected.slice(),
    };
}

module.exports = {
    escapeHtml,
    parsePageSpec,
    parseBatchResult,
    planAutoFillCounts,
    effectiveOrientation,
    _generativePreviewSvg,
    getPanelHeaderHTML,
    getDisplayName,
    _hashPage,
    _parseExifDateFromBuffer,
    _proofTemplatePreviewPath,
    _isEditingTarget,
    _compactPage,
    _hydratePage,
    partitionByRenderCache,
}
