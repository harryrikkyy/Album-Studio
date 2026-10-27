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

// True when a keyboard event target is a control the user TYPES into.
// Delegates to shortcut_target.js, which owns the rule: this used to count
// every <input> and <select> as typing, so a focused checkbox or slider
// disabled all global shortcuts. Kept as an export for existing callers.
/** @param {{ tagName?: string, type?: string, isContentEditable?: boolean } | null | undefined} t @returns {boolean} */
function _isEditingTarget(t) {
    return require('./shortcut_target').isTextEntry(t);
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

/**
 * The file a render job writes into its output folder. The Photoshop build
 * scripts save `<output>/Page_NNN.psd` (NNN = page number, zero-padded to 3);
 * the generative HR path writes `<output>/Page_NNN.jpg` instead. Keep this in
 * step with build_pages_batch.jsx and the generative interceptor in
 * features/generative_ui.js.
 *
 * @param {RenderJob} job
 * @returns {string}
 */
function _renderedOutputPath(job) {
    const generative = typeof job.pageData.templatePath === 'string' &&
        job.pageData.templatePath.startsWith('generative://');
    const name = 'Page_' + String(job.pageNum).padStart(3, '0') + (generative ? '.jpg' : '.psd');
    return job.outputPath.replace(/\/+$/, '') + '/' + name;
}

// Render-queue dirty tracking. Given a batch of render jobs and the stored
// hash cache, decide which need rendering vs can be skipped (unchanged since
// their last successful render). This is the "re-render 5 changed pages, not
// all 200" logic. Pure: the cache is passed in, not read from localStorage.
//   job:   { pageNum, pageData, outputPath, ... }
//   key:   `${outputPath}|${pageNum}` — same page to a different output, or a
//          different page to the same output, are distinct cache entries.
// A job is skipped when its stored hash equals the current hash of its
// pageData AND, when `outputExists` is supplied, the file it produced is
// still on disk. The hash only proves the inputs are unchanged; it says
// nothing about the deliverable. Without the file check, deleting or moving a
// PSD and pressing Render selected reported "0 fresh, 1 cached" and produced
// nothing. Fresh jobs come back with `hash` + `cacheKey` attached, ready to
// write into the cache on a successful render.
/**
 * @param {RenderJob[]} jobs
 * @param {Record<string, string>} [renderHashes]
 * @param {(filePath: string) => boolean} [outputExists]  true when the rendered
 *   file is still on disk. Omitted → the cache is trusted as-is.
 * @returns {{ fresh: Array<RenderJob & { hash: string, cacheKey: string }>, skipped: RenderJob[] }}
 */
function partitionByRenderCache(jobs, renderHashes = {}, outputExists) {
    const fresh = [];
    const skipped = [];
    for (const job of jobs) {
        const hash = _hashPage(job.pageData);
        const cacheKey = `${job.outputPath}|${job.pageNum}`;
        const unchanged = renderHashes[cacheKey] === hash;
        if (unchanged && (!outputExists || outputExists(_renderedOutputPath(job)))) {
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
    effectiveOrientation,
    _generativePreviewSvg,
    getPanelHeaderHTML,
    getDisplayName,
    _hashPage,
    _renderedOutputPath,
    _proofTemplatePreviewPath,
    _isEditingTarget,
    _compactPage,
    _hydratePage,
    partitionByRenderCache,
}
