// @ts-check
// features/render_queue.js — the HR render queue, extracted from main.js
// (Phase 2 split).
//
// queueRender(exportData) enqueues a page range and returns immediately; a
// single background worker drains the queue (one at a time — Photoshop is
// single-threaded). Consecutive jobs that share a template chunk into one
// batched IPC call (the warm-process batch JSX opens the template once per
// chunk, saving the ~1–4s app.open() cost per page), and the render cache
// (renderHashes: cacheKey → page-input hash) makes re-rendering an unchanged
// page a no-op — the difference between "render took 4 minutes" and "render
// took 4 seconds" on iterative work.
//
// Deliberately DOM-free: the progress badge, status line, notifications,
// hash persistence (localStorage), and the adjustment bake all stay in the
// caller and are injected via `deps` — this module owns queue/cache/stats
// logic through explicit store access, and is unit-testable with a fake
// `invoke`.

/**
 * @typedef {import('../shared/domain').RenderJob} RenderJob
 * @typedef {import('../shared/domain').ExportData} ExportData
 */

const { partitionByRenderCache } = require('../renderer_pure');

/** @param {unknown} e */
function _errMessage(e) {
    return e instanceof Error ? e.message : String(e);
}

/**
 * Wire the render queue to a store.
 *
 * @param {import('../state/store').Store} store
 * @param {object} deps
 * @param {(channel: string, payload: object) => Promise<unknown>} deps.invoke
 *   IPC dispatch. Looked up per call so the generative HR interceptor's
 *   monkey-patch of ipcRenderer.invoke still applies.
 * @param {() => void} deps.updateBadge  refresh the DOM progress badge
 * @param {(msg: string) => void} deps.setStatus
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.notify
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 * @param {() => void} deps.persistHashes  save renderHashes (localStorage)
 * @param {(exportData: ExportData) => Promise<number>} deps.bakeAdjustments
 *   bake per-photo edits into source files; resolves to the count baked
 * @param {() => boolean} deps.useAdjLayers  live J1 flag (editable adjustment layers)
 */
function createRenderQueue(store, deps) {
    async function _renderWorker() {
        if (store.get('renderActive')) return; // one worker only
        store.set('renderActive', true);
        const queue = store.get('renderQueue');
        while (queue.length > 0) {
            // Re-read per use: project load/clear can replace the slice object
            // while a render is in flight.
            const renderHashes = store.get('renderHashes');
            const stats = store.get('renderStats');
            if (stats.cancelled) break;

            // Chunk consecutive jobs that share a template path.
            const chunk = [/** @type {RenderJob} */ (queue.shift())];
            while (
                queue.length > 0 &&
                queue[0].pageData.templatePath === chunk[0].pageData.templatePath &&
                queue[0].outputPath === chunk[0].outputPath
            ) {
                chunk.push(/** @type {RenderJob} */ (queue.shift()));
            }
            deps.updateBadge();

            // Filter out pages whose hash matches the previous successful render.
            const { fresh, skipped } = partitionByRenderCache(chunk, renderHashes);
            stats.skipped += skipped.length;
            deps.updateBadge();
            if (fresh.length === 0) continue;

            const tplName = (chunk[0].pageData.templatePath || '').split('/').pop();
            if (fresh.length === 1) {
                deps.setStatus(`Rendering page ${fresh[0].pageNum}…`);
            } else {
                deps.setStatus(`Rendering pages ${fresh[0].pageNum}–${fresh[fresh.length - 1].pageNum} (${tplName})…`);
            }

            try {
                await deps.invoke('build-pages-batch', {
                    templatePath: chunk[0].pageData.templatePath,
                    outputPath: chunk[0].outputPath,
                    useAdjustmentLayers: deps.useAdjLayers(),
                    pages: fresh.map(j => ({
                        pageName: String(j.pageNum).padStart(3, '0'),
                        photos: j.pageData.photos
                    }))
                });
                for (const j of fresh) {
                    renderHashes[j.cacheKey] = j.hash;
                    stats.done++;
                }
                deps.persistHashes();
            } catch (err) {
                // Batch failed wholesale — fall back to per-page renders so we
                // don't lose the entire chunk to one bad page.
                for (const j of fresh) {
                    if (stats.cancelled) break;
                    try {
                        await deps.invoke('build-page', {
                            templatePath: j.pageData.templatePath,
                            pageName: String(j.pageNum).padStart(3, '0'),
                            photos: j.pageData.photos,
                            useAdjustmentLayers: deps.useAdjLayers()
                        });
                        renderHashes[j.cacheKey] = j.hash;
                        deps.persistHashes();
                        stats.done++;
                    } catch (e2) {
                        stats.failed++;
                        deps.toast(`Page ${j.pageNum} failed: ${_errMessage(e2)}`, 'error');
                    }
                }
                if (!stats.cancelled) {
                    console.warn('Batch render failed, fell back to per-page:', _errMessage(err));
                }
            }
            deps.updateBadge();
        }
        store.set('renderActive', false);
        deps.updateBadge();

        const stats = store.get('renderStats');
        if (stats.cancelled) {
            deps.notify(`Render cancelled (${stats.done} of ${stats.total} done)`, 'warning');
        } else if (stats.failed > 0) {
            deps.notify(`Render finished with ${stats.failed} failures`, 'warning', { duration: 6000 });
        } else if (stats.total > 0) {
            deps.notify(
                `Render complete · ${stats.done} fresh${stats.skipped ? `, ${stats.skipped} cached` : ''}`,
                'success',
                { duration: 5000 }
            );
        }
        store.set('renderStats', { total: 0, done: 0, skipped: 0, failed: 0, cancelled: false });
    }

    /**
     * Public entry: queue up a range of pages for rendering. Returns
     * immediately; the worker drains the queue in the background.
     *
     * @param {ExportData} exportData - Result of buildExportData(start, end)
     */
    async function queueRender(exportData) {
        const pages = exportData.pages;
        const numbers = Object.keys(pages).map(n => parseInt(n)).sort((a, b) => a - b);
        if (numbers.length === 0) {
            deps.toast('No complete pages to render in this range', 'info');
            return;
        }
        // Bake per-photo adjustments into the sources before queueing, so every
        // built PSD reflects the live preview. Mutates pages[*].photos[*].filePath
        // in place, which is what the queue holds a reference to. Skipped when J1
        // (editable adjustment layers) is on — the JSX places originals + adds
        // clipped adjustment layers instead.
        try {
            if (!deps.useAdjLayers()) {
                const baked = await deps.bakeAdjustments(exportData);
                if (baked > 0) deps.setStatus(`Applied edits to ${baked} photo${baked === 1 ? '' : 's'} before render…`);
            }
        } catch (_) { /* fall back to unadjusted sources */ }
        store.get('renderStats').total += numbers.length;
        const queue = store.get('renderQueue');
        numbers.forEach(n => {
            queue.push({ pageNum: n, pageData: pages[n], outputPath: exportData.outputPath });
        });
        deps.updateBadge();
        _renderWorker();
    }

    return { queueRender };
}

module.exports = { createRenderQueue };
