// @ts-check
// features/export_data.js — export-data assembly, extracted from main.js
// (Phase 2 split).
//
// buildExportData turns a page range of album state into the payload the
// render queue consumes: resolved source file paths (upgraded to high-res
// originals when an HR folder is attached), per-photo edits from projectData,
// and the template path (or the generative:// sentinel the IPC interceptor
// dispatches to the JS-only HR composite).
//
// bakeExportAdjustments closes the "edits round-trip to the final PSD" loop:
// photos with `adjust` are baked into full-res copies (same libvips math as
// the preview) and the export data re-pointed at those copies, so Photoshop
// places an already-adjusted file.
//
// Deliberately DOM-free: IPC and directory listing are injected; node
// path/os/fs are used only for the temp bake dir.

/**
 * @typedef {import('../shared/domain').ExportData} ExportData
 * @typedef {import('../state/store').Store} Store
 */

/**
 * Wire export-data assembly to a store.
 *
 * @param {Store} store
 * @param {object} deps
 * @param {(channel: string, payload: object) => Promise<any>} deps.invoke  IPC dispatch
 * @param {(path: string) => string[]} deps.readDir  synchronous directory listing (may throw)
 */
function createExportData(store, deps) {
    /**
     * @param {number} startPage
     * @param {number} endPage
     * @returns {ExportData}
     */
    function buildExportData(startPage, endPage) {
        // ⚡ Memoize HR folder scans: a 200-page album with 5 photos/page used to
        // do up to 1,000 sync readdirSync calls (one per photo) on the renderer
        // thread before the export even started. Now we do one per unique HR folder.
        /** @type {Map<string, string[]>} */
        const _hrDirCache = new Map();
        const nodepath = require('path');
        /** @param {string} p */
        function listHrDir(p) {
            if (!_hrDirCache.has(p)) {
                try { _hrDirCache.set(p, deps.readDir(p)); }
                catch (_) { _hrDirCache.set(p, []); }
            }
            return /** @type {string[]} */ (_hrDirCache.get(p));
        }

        const albumPages = store.get('albumPages');
        const photoCache = /** @type {Record<string, any>} */ (store.get('photoCache'));
        const projectData = store.get('projectData');
        const outputFolder = /** @type {any} */ (store.get('outputFolder'));

        /** @type {ExportData} */
        const exportData = { outputPath: outputFolder.nativePath, pages: {} };
        for (let i = startPage; i <= endPage; i++) {
            const pageData = albumPages[i];
            if (!pageData || !pageData.template || !pageData.photos || pageData.photos.length === 0) continue;
            const photos = [];
            for (const photo of pageData.photos) {
                const cacheData = photoCache[/** @type {string} */ (photo.id)];
                if (!cacheData) continue;
                let filePath = cacheData.file?.nativePath || cacheData.proxy?.nativePath || null;
                if (!filePath) continue;
                if (cacheData.hrFolder && cacheData.hrFolder.nativePath) {
                    const files = listHrDir(cacheData.hrFolder.nativePath);
                    const lower = cacheData.baseName.toLowerCase();
                    const hrFile = files.find(f => f.toLowerCase().startsWith(lower));
                    if (hrFile) filePath = nodepath.join(cacheData.hrFolder.nativePath, hrFile);
                }
                photos.push({
                    filePath,
                    orient: photo.orient,
                    rotation: projectData.imageRotations?.[/** @type {string} */ (photo.id)] || 0,
                    baseName: cacheData.baseName || photo.id,
                    id: photo.id,
                    adjust: projectData.imageAdjustments?.[/** @type {string} */ (photo.id)] || null,
                    placement: projectData.imagePlacements?.[/** @type {string} */ (photo.id)] || null,
                });
            }
            if (photos.length > 0) {
                // Generative templates have no PSD on disk. We synthesize a
                // sentinel templatePath that the IPC interceptor recognizes and
                // dispatches to the JS-only HR composite renderer.
                const templatePath = pageData.template._generative
                    ? 'generative://' + pageData.template.id
                    : /** @type {any} */ (pageData.template).file.nativePath;
                exportData.pages[i] = { templatePath, photos };
            }
        }
        return exportData;
    }

    // Bake per-photo adjustments into full-res copies before the Photoshop build,
    // then point the export data at those copies. Closes the "edits round-trip to
    // the final PSD" loop: PS places an already-adjusted file (same libvips math
    // as the preview), so the delivered PSD matches the on-screen preview.
    // Returns the number of baked photos. Baked files live in a dedicated temp
    // dir that is wiped at the start of each export so they don't accumulate.
    /** @param {ExportData} exportData @returns {Promise<number>} */
    async function bakeExportAdjustments(exportData) {
        const nodepath = require('path');
        const nodeos = require('os');
        const outDir = nodepath.join(nodeos.tmpdir(), 'albumstudio_baked');
        // Wipe previous bake so temp files stay bounded.
        try { require('fs').rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
        let baked = 0;
        for (const pageNum of Object.keys(exportData.pages)) {
            const page = exportData.pages[pageNum];
            // Generative pages render via the libvips final composite, which
            // applies `adjust` from the param directly — baking the source too
            // would double-apply. Only bake for PSD (Photoshop) pages.
            if (typeof page.templatePath === 'string' && page.templatePath.startsWith('generative://')) continue;
            for (const photo of page.photos) {
                if (!photo.adjust) continue;
                try {
                    const r = await deps.invoke('bake-adjusted-source', {
                        srcPath: photo.filePath,
                        adjust: photo.adjust,
                        outDir,
                    });
                    if (r?.ok && r.path) { photo.filePath = r.path; baked++; }
                } catch (_) { /* on failure, fall back to the unadjusted original */ }
            }
        }
        return baked;
    }

    return { buildExportData, bakeExportAdjustments };
}

module.exports = { createExportData };
