// renderer_pure.js
//
// Pure, dependency-free helpers extracted from the main renderer (src/main.js).
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
function getPanelHeaderHTML(type) {
    return `<div class="folder-rail__header">`
         +   `<button class="folder-rail__collapse" type="button" aria-label="Toggle folder list"></button>`
         +   `<span>Folders:</span>`
         +   `<div class="folder-rail__actions">`
         +     `<span class="btn-reload-fld folder-rail__action" data-type="${type}" title="Refresh Folders">🔄</span>`
         +     `<span class="btn-remove-fld folder-rail__action" data-type="${type}" title="Remove Folders">🗑️</span>`
         +   `</div>`
         + `</div>`;
}

// Display name for a folder entry. A `_Thumbnails` folder is shown under its
// parent's name (so two source folders' thumb caches don't both read
// "_Thumbnails"); everything else shows its own name.
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
// don't change filePath, so they'd otherwise be cached as unchanged). The
// render queue caches this hash so an unchanged page is a no-op re-render.
function _hashPage(pageData) {
    const parts = [
        pageData.templatePath,
        ...pageData.photos.map(p => {
            const a = p.adjust ? JSON.stringify(p.adjust) : '';
            const pl = p.placement ? JSON.stringify(p.placement) : '';
            return `${p.filePath}|${p.orient}|${p.rotation || 0}|${p.baseName}|${a}|${pl}`;
        })
    ];
    return parts.join('§');
}

// Tiny, dependency-free JPEG EXIF parser. Reads a buffer (the first ~256 KB of
// a JPEG is plenty — EXIF lives in the APP1 marker right after SOI), finds tag
// 0x9003 (DateTimeOriginal), parses "YYYY:MM:DD HH:MM:SS" → epoch ms, or null.
function _parseExifDateFromBuffer(buf) {
    // JPEG SOI must be 0xFFD8
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
    let off = 2;
    while (off < buf.length - 8) {
        if (buf[off] !== 0xFF) return null;
        const marker = buf[off + 1];
        const size = buf.readUInt16BE(off + 2);
        // APP1 (0xE1) holds EXIF.
        if (marker === 0xE1) {
            // EXIF\0\0 magic
            if (buf.toString('ascii', off + 4, off + 10) === 'Exif\u0000\u0000') {
                const tiff = off + 10;
                const little = buf.toString('ascii', tiff, tiff + 2) === 'II';
                const u16 = (p) => little ? buf.readUInt16LE(p) : buf.readUInt16BE(p);
                const u32 = (p) => little ? buf.readUInt32LE(p) : buf.readUInt32BE(p);
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
                        const str = buf.toString('ascii', valOff, valOff + 19);
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
function _hydratePage(cpage, templateLibrary = [], photoCache = {}) {
    if (!cpage) return { template: null, photos: [] };
    let template = null;
    if (cpage.template) {
        template = templateLibrary.find(t => t.id === cpage.template.id) || null;
        // Generative templates may not be in templateLibrary if the user
        // toggled them off; keep the lightweight ref so a re-enable re-links.
        if (!template && cpage.template.generative && cpage.template.spec) {
            template = { id: cpage.template.id, _generative: true, _spec: cpage.template.spec };
        }
    }
    const photos = (cpage.photos || []).map(ref => {
        const c = photoCache[ref.id];
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

module.exports = {
    escapeHtml,
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
