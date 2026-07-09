// @ts-check
// features/spread_editor.js — the Spread Editor bridge, extracted from
// main.js (Phase 2 split). Builds the payload the editor window needs (frame
// geometry + photo proxies + current placement/adjust), opens the editor,
// and applies the edits it pushes back: placement/adjustment changes,
// photo swaps, and page navigation.
//
// DOM footprint is a single button (#btnEditSpread); everything else is IPC
// glue between this window and the editor window (via the main process).

/**
 * @typedef {import('../state/store').Store} Store
 */

/**
 * Wire the Spread Editor bridge: the Edit Spread button and the three
 * editor push channels (editor-changes / editor-swap / editor-goto).
 *
 * @param {Store} store
 * @param {object} deps
 * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke  IPC dispatch
 * @param {(channel: string, listener: (event: any, ...args: any[]) => void) => void} deps.on  IPC push subscribe
 * @param {(template: any) => Promise<any>} deps.ensureTemplateFrames
 * @param {(pageNum: number) => void} deps.scheduleEditedPageReproof
 * @param {(label: string, fn: () => void) => void} deps.mutate
 * @param {() => void} deps.saveState  debounced workspace autosave
 * @param {() => void} deps.scheduleLivePreview
 * @param {() => void} deps.updateAdjustPanel
 * @param {() => void} deps.renderGreenBox
 * @param {(msg: string) => void} deps.setStatus
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 */
function createSpreadEditor(store, deps) {
    /**
     * Build the payload for one page: canvas geometry, per-frame photo
     * assignments (same partition + ordering the renderer/JSX use), and the
     * lightweight list of editable spreads for the editor's left rail.
     * @param {number} pageNum
     */
    async function buildSpreadPayload(pageNum) {
        const albumPages = store.get('albumPages');
        const photoCache = /** @type {Record<string, any>} */ (store.get('photoCache'));
        const projectData = store.get('projectData');

        const page = albumPages[pageNum];
        if (!page || !page.template) return null;
        const tpl = await deps.ensureTemplateFrames(page.template);
        if (!tpl || !tpl._frames || !tpl._canvas) return null;

        // Same partition + ordering the renderer/JSX use: h photos → h frames,
        // v photos → v frames, each sorted by frame name.
        const hFrames = tpl._frames.filter((/** @type {any} */ f) => /toolkithframe/i.test(f.name)).sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name));
        const vFrames = tpl._frames.filter((/** @type {any} */ f) => /toolkitvframe/i.test(f.name)).sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name));
        const pagePhotos = page.photos || [];
        const hPhotos = pagePhotos.filter((/** @type {any} */ p) => p.orient === 'h');
        const vPhotos = pagePhotos.filter((/** @type {any} */ p) => p.orient === 'v');
        /** @type {any[]} */
        const items = [];
        const assign = (/** @type {any[]} */ photos, /** @type {any[]} */ frames, /** @type {string} */ orient) => {
            for (let i = 0; i < photos.length && i < frames.length; i++) {
                const p = photos[i];
                const c = photoCache[p.id];
                items.push({
                    id: p.id,
                    url: (c && c.url) || p.url,
                    orient,
                    frame: frames[i],
                    rotation: projectData.imageRotations?.[p.id] || 0,
                    placement: projectData.imagePlacements?.[p.id] || null,
                    adjust: projectData.imageAdjustments?.[p.id] || null,
                });
            }
        };
        assign(hPhotos, hFrames, 'h');
        assign(vPhotos, vFrames, 'v');

        // Lightweight list of every editable spread so the editor's left rail can
        // navigate between pages (full payload is fetched lazily per page).
        const spreads = [];
        for (let i = 1; i <= store.get('totalActivePages'); i++) {
            const pg = albumPages[i];
            if (!pg || !pg.template || !(pg.photos && pg.photos.length)) continue;
            spreads.push({ pageNum: i, backdropUrl: pg.template.url || null });
        }

        return {
            pageNum,
            canvasW: tpl._canvas.w,
            canvasH: tpl._canvas.h,
            backdropUrl: tpl.url || null,
            items,
            spreads,
        };
    }

    const btnEditSpread = document.getElementById('btnEditSpread');
    if (btnEditSpread) {
        btnEditSpread.addEventListener('click', async () => {
            const currentPage = store.get('currentPage');
            const page = store.get('albumPages')[currentPage];
            if (!page || !page.template || !(page.photos && page.photos.length)) {
                deps.toast('Add a template and photos to this page first', 'info');
                return;
            }
            deps.setStatus('Opening Spread Editor…');
            const payload = await buildSpreadPayload(currentPage);
            if (!payload) { deps.toast('Could not read this page for editing', 'error'); return; }
            try { await deps.invoke('editor-open', payload); }
            catch (e) { deps.toast('Could not open editor: ' + ((/** @type {any} */ (e)).message || e), 'error'); }
            deps.setStatus('');
        });
    }

    // Editor → here: persist placement/adjustment edits and refresh the preview.
    deps.on('editor-changes', (_e, changes) => {
        if (!changes) return;
        const projectData = store.get('projectData');
        if (!projectData.imagePlacements) projectData.imagePlacements = {};
        if (!projectData.imageAdjustments) projectData.imageAdjustments = {};
        if (changes.placements) {
            for (const [id, pl] of Object.entries(changes.placements)) {
                if (pl) projectData.imagePlacements[id] = pl; else delete projectData.imagePlacements[id];
            }
        }
        if (changes.adjustments) {
            for (const [id, adj] of Object.entries(changes.adjustments)) {
                if (adj) projectData.imageAdjustments[id] = adj; else delete projectData.imageAdjustments[id];
            }
        }
        try { deps.saveState(); } catch (_) {}
        // Refresh the on-app live preview if the edited page is the current one.
        if (!changes.pageNum || changes.pageNum === store.get('currentPage')) {
            deps.scheduleLivePreview();
            deps.updateAdjustPanel();
        }
        // The edited page's storyboard proof (Tab 7 / page_NNN.jpg) is now stale.
        // Invalidate its cache and re-render it in the background (debounced) so
        // the proof reflects the edit without a manual "Generate Proofs" pass.
        if (changes.pageNum) deps.scheduleEditedPageReproof(changes.pageNum);
    });

    // Editor → here: swap two photos between frames on a page. Photos keep their
    // own per-id placement/adjust (keyed by photo id), so each photo's crop and
    // colour travel with it into the new slot. We swap the two photos' positions
    // in albumPages[page].photos; since frames are assigned by orientation+order,
    // swapping two same-orientation photos swaps which frame each lands in.
    deps.on('editor-swap', (_e, msg) => {
        if (!msg || !msg.aId || !msg.bId) return;
        const page = store.get('albumPages')[msg.pageNum];
        if (!page || !page.photos) return;
        const photos = page.photos;
        const ia = photos.findIndex((/** @type {any} */ p) => p.id === msg.aId);
        const ib = photos.findIndex((/** @type {any} */ p) => p.id === msg.bId);
        if (ia === -1 || ib === -1 || ia === ib) return;
        deps.mutate('Swap photos', () => {
            const a = photos[ia];
            const b = photos[ib];
            // Swap orientation too so cross-shape swaps re-derive the right frame
            // assignment (frames are assigned by orientation + order). For
            // same-orientation swaps this is a no-op and only the positions matter.
            const ao = a.orient; a.orient = b.orient; b.orient = ao;
            photos[ia] = b;
            photos[ib] = a;
        });
        if (msg.pageNum === store.get('currentPage')) {
            deps.renderGreenBox();
            deps.scheduleLivePreview();
        }
        // The swapped page's storyboard proof is now stale — refresh it too.
        deps.scheduleEditedPageReproof(msg.pageNum);
    });

    // Editor → here: navigate the editor to a different page. Rebuild that page's
    // payload and push it to the editor window (single source of truth).
    deps.on('editor-goto', async (_e, msg) => {
        if (!msg || !msg.pageNum) return;
        try {
            const payload = await buildSpreadPayload(msg.pageNum);
            if (payload) await deps.invoke('editor-open', payload);
        } catch (_) {}
    });

    return { buildSpreadPayload };
}

module.exports = { createSpreadEditor };
