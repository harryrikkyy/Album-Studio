// @ts-check
// features/generative_ui.js — renderer-side generative template integration,
// extracted from main.js (Phase 2 split). (The generators themselves live in
// src/generative_templates.js and run in the main process.)
//
// Generative templates are virtual layouts (no PSD on disk). They appear in
// the same template grid as PSD-backed entries and are flagged with
// `_generative: true` so the export queue can route them through the JS-only
// HR composite pipeline instead of Photoshop. Loading is idempotent — toggling
// the checkbox off removes them from templateLibrary, on re-adds them.
//
// This module also installs the ipcRenderer.invoke interceptor that diverts
// build-page(s) calls for generative templates to render-final-composite, so
// instantiate it BEFORE any render is queued (render_queue's deps read
// ipc.invoke at call time, so patch order with its factory doesn't matter).

/**
 * @typedef {import('../state/store').Store} Store
 */

const GENERATIVE_FOLDER_ID = '__generative__';

/**
 * Wire generative templates: the enable checkbox, catalog load/unload, and
 * the generative-aware HR render interceptor.
 *
 * @param {Store} store
 * @param {object} deps
 * @param {() => void} deps.scheduleFilterUpdate
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 */
function createGenerativeUi(store, deps) {
    let _generativeLoaded = false;

    async function loadGenerativeTemplates() {
        if (_generativeLoaded) return;
        const ipc = require('electron').ipcRenderer;
        const res = await ipc.invoke('generative-catalog');
        if (!res?.ok) { deps.toast('Could not load generative templates: ' + (res?.error || ''), 'error'); return; }

        // Each generative template gets a fake folderId so it shows up in the
        // existing folder filter logic, plus a flag the export queue picks up.
        store.get('activeTemplateFolders').add(GENERATIVE_FOLDER_ID);
        const wrapped = res.templates.map((/** @type {any} */ t) => ({
            id: t.id,
            folderId: GENERATIVE_FOLDER_ID,
            name: t.name,
            // No `file` property — that's how downstream code knows this is virtual.
            h: t.h,
            v: t.v,
            url: '', // we'll build a synthetic preview tile via CSS
            _generative: true,
            _spec: { generator: t.generator, params: t.params },
            // Pre-bake frames + canvas so the proof renderer doesn't need to
            // round-trip through Photoshop frame extraction.
            _frames: t.frames,
            _canvas: { w: t.canvasWidth, h: t.canvasHeight },
        }));
        store.set('templateLibrary', store.get('templateLibrary').concat(wrapped));
        _generativeLoaded = true;

        const status = document.getElementById('generativeStatus');
        if (status) status.textContent = `${wrapped.length} layouts available in template grid`;
        deps.scheduleFilterUpdate();
    }

    function unloadGenerativeTemplates() {
        if (!_generativeLoaded) return;
        store.set('templateLibrary', store.get('templateLibrary').filter((/** @type {any} */ t) => t.folderId !== GENERATIVE_FOLDER_ID));
        store.get('activeTemplateFolders').delete(GENERATIVE_FOLDER_ID);
        _generativeLoaded = false;
        const status = document.getElementById('generativeStatus');
        if (status) status.textContent = '';
        deps.scheduleFilterUpdate();
    }

    /** Load the generative set if it isn't already (idempotent). */
    async function ensureGenerativeLoaded() {
        if (!_generativeLoaded) await loadGenerativeTemplates();
    }

    const chkGenerativeTemplates = /** @type {HTMLInputElement | null} */ (document.getElementById('chkGenerativeTemplates'));
    if (chkGenerativeTemplates) {
        chkGenerativeTemplates.addEventListener('change', (e) => {
            if (/** @type {HTMLInputElement} */ (e.target).checked) loadGenerativeTemplates();
            else unloadGenerativeTemplates();
        });
    }

    /**
     * @param {any} p
     * @returns {any}
     */
    function _findTemplateByPath(p) {
        if (!p) return null;
        return store.get('templateLibrary').find((/** @type {any} */ t) =>
            (t._generative && p.startsWith && p.startsWith('generative://') && p.endsWith(t.id)) ||
            (t.file?.nativePath === p)
        ) || null;
    }

    // ─── Generative-aware proof rendering ─────────────────────────────────
    // `ensureTemplateFrames` already short-circuits for templates with
    // pre-baked frames (which generative templates always have), so proofs
    // Just Work. The only remaining piece is HR rendering — see below.

    // ─── Generative-aware HR rendering ────────────────────────────────────
    // The render queue's worker calls IPC `build-pages-batch` for every chunk.
    // We monkey-patch ipcRenderer.invoke for that one channel so generative
    // pages get diverted to the JS-only HR composite, while PSD-backed pages
    // flow through the existing Photoshop bridge unchanged.
    ;(function _interceptHrRenderForGenerative() {
        const ipc = require('electron').ipcRenderer;
        const realInvoke = ipc.invoke.bind(ipc);
        ipc.invoke = async function (channel, ...args) {
            if (channel !== 'build-pages-batch' && channel !== 'build-page') {
                return realInvoke(channel, ...args);
            }
            // Inspect the payload — if its templatePath references a generative
            // template, dispatch it to render-final-composite instead.
            const payload = args[0];
            const isBatch = channel === 'build-pages-batch';
            const pages = isBatch ? payload.pages : [payload];
            const tpl = _findTemplateByPath(payload.templatePath);
            if (!tpl?._generative) {
                return realInvoke(channel, ...args);
            }

            // Run each page through the HR composite. Sequential so libvips
            // doesn't oversaturate memory.
            const projectData = store.get('projectData');
            let successes = 0, failures = 0;
            for (const p of pages) {
                const rawPhotos = p.photos || payload.photos || [];
                // Carry per-photo adjustments into the libvips final composite so
                // the delivered output matches the live preview.
                const photos = rawPhotos.map((/** @type {any} */ ph) => (
                    ph && ph.id && projectData.imageAdjustments?.[ph.id]
                        ? { ...ph, adjust: projectData.imageAdjustments[ph.id] }
                        : ph
                ));
                const outDir = isBatch ? payload.outputPath : null;
                const pageName = isBatch ? p.pageName : payload.pageName;
                const outputPath = (outDir
                    ? outDir + '/Page_' + pageName + '.jpg'
                    : (payload.outputPath || (require('os').tmpdir() + '/Page_' + pageName + '.jpg'))
                );
                const job = {
                    templatePath: 'generative://' + tpl.id,
                    templatePreviewPath: null, // no backdrop — fully synthesized
                    frames: tpl._frames,
                    canvasWidth: tpl._canvas.w,
                    canvasHeight: tpl._canvas.h,
                    photos,
                    outputPath,
                    smartCrop: false, // HR exports stay deterministic
                };
                const r = await realInvoke('render-final-composite', job);
                if (r?.ok) successes++; else failures++;
            }
            return `OK ${successes}/${successes + failures}`;
        };
    })();

    return { loadGenerativeTemplates, unloadGenerativeTemplates, ensureGenerativeLoaded };
}

module.exports = { createGenerativeUi, GENERATIVE_FOLDER_ID };
