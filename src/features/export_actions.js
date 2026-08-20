// @ts-check
// features/export_actions.js — the build/export buttons, the output-folder
// pickers, and the J1 adjustment-layers toggle, extracted from main.js
// (Phase 2 split). The queue/cache mechanics live in render_queue.js;
// this module is the button-level glue that assembles payloads and hands
// them over.

/** @typedef {import('../state/store').Store} Store */

const { parsePageSpec } = require('../renderer_pure');

/**
 * @param {Store} store
 * @param {object} deps
 * @param {(start: number, end: number) => any} deps.buildExportData
 * @param {(pages: number[]) => any} deps.buildExportDataForPages
 * @param {(exportData: any) => Promise<void>} deps.bakeExportAdjustments
 * @param {(exportData: any) => void} deps.queueRender
 * @param {(channel: string, payload?: any) => Promise<any>} deps.invoke
 * @param {() => Promise<any>} deps.pickFolder
 * @param {(folder: any) => Promise<any>} deps.createToken   persistent-access token for the picked folder
 * @param {() => void} deps.saveState
 * @param {(msg: string) => void} deps.setStatus
 * @param {(msg: string, kind?: string, opts?: object) => void} deps.notify
 * @param {(msg: string, kind?: string, opts?: object) => void} deps.toast
 * @param {(msg: string) => void} deps.showAlert
 */
function createExportActions(store, deps) {
    // J1: render colour as editable clipped adjustment layers instead of
    // baking pixels. EXPERIMENTAL — off by default (the bake path stays the
    // safe default). Persisted across sessions.
    let useAdjLayers = (() => {
        try { return localStorage.getItem('adt_adj_layers') === '1'; } catch (_) { return false; }
    })();

    const chkAdjLayers = /** @type {HTMLInputElement | null} */ (document.getElementById('chkAdjLayers'));
    if (chkAdjLayers) {
        chkAdjLayers.checked = useAdjLayers;
        chkAdjLayers.addEventListener('change', () => {
            useAdjLayers = chkAdjLayers.checked;
            try { localStorage.setItem('adt_adj_layers', useAdjLayers ? '1' : '0'); } catch (_) {}
            deps.toast(useAdjLayers
                ? 'Renders will use editable adjustment layers (experimental)'
                : 'Renders will bake colour into pixels (exact preview match)', 'info');
        });
    }

    // Build the current page in Photoshop (Tab 1 toolbar).
    const btnAutoThis = document.getElementById("btnAutoThis");
    if (btnAutoThis) {
        btnAutoThis.addEventListener("click", async () => {
            const currentPage = store.get('currentPage');
            const pageData = store.get('albumPages')[currentPage];
            if (!pageData || !pageData.photos || pageData.photos.length === 0) return deps.showAlert("Pull photos into Green Box first!");
            if (!pageData.template) return deps.showAlert("Select a template from PSD Library!");
            try {
                deps.setStatus(`Building Page ${currentPage}…`);
                const exportData = deps.buildExportData(currentPage, currentPage);
                const pageEntry = exportData.pages[currentPage];
                if (!pageEntry) return deps.showAlert("Could not resolve page data!");
                // Bake per-photo adjustments so the built PSD reflects the preview —
                // UNLESS J1 (editable adjustment layers) is on, which places
                // originals + adds clipped adjustment layers in the JSX instead.
                if (!useAdjLayers) await deps.bakeExportAdjustments(exportData);
                const payload = {
                    templatePath: pageEntry.templatePath,
                    pageName: String(currentPage).padStart(3, '0'),
                    photos: pageEntry.photos,
                    useAdjustmentLayers: useAdjLayers
                };
                await deps.invoke('build-page', payload);
                deps.notify(`Page ${currentPage} built successfully`, "success");
            } catch(err) { deps.showAlert("Build Error: " + /** @type {Error} */ (err).message); }
        });
    }

    // Output-folder pickers (Tab 1 fallback + Tab 7). Both persist an access
    // token on projectData so the folder survives restarts.
    async function pickOutputFolder() {
        const folder = await deps.pickFolder();
        if (!folder) return null;
        store.set('outputFolder', folder);
        store.get('projectData').outputToken = await deps.createToken(folder);
        deps.saveState();
        return folder;
    }

    const btnOutput = document.getElementById("btnOutput");
    if (btnOutput) {
        btnOutput.addEventListener("click", async () => {
            const folder = await pickOutputFolder();
            if (!folder) return;
            deps.notify(`Output folder set: ${folder.name}`, 'success');
            const ftxt = document.getElementById("finalOutputText");
            if (ftxt) ftxt.innerText = folder.name;
        });
    }

    const btnSetFinalOutput = document.getElementById("btnSetFinalOutput");
    if (btnSetFinalOutput) {
        btnSetFinalOutput.addEventListener("click", async () => {
            const folder = await pickOutputFolder();
            if (!folder) return;
            /** @type {HTMLElement} */ (document.getElementById("finalOutputText")).innerText = folder.name;
        });
    }

    // Queue a page range (Tab 1 fallback) / the full album (Tab 7).
    const btnExport = document.getElementById("btnExport");
    if (btnExport) {
        btnExport.addEventListener("click", () => {
            if (!store.get('outputFolder')) return deps.showAlert("Please select an Output Folder first!");
            const start = parseInt(/** @type {HTMLInputElement} */ (document.getElementById("exportStart")).value);
            const end = parseInt(/** @type {HTMLInputElement} */ (document.getElementById("exportEnd")).value);
            if (isNaN(start) || isNaN(end) || start > end) return deps.showAlert("Invalid Start/End pages.");
            const exportData = deps.buildExportData(start, end);
            if (Object.keys(exportData.pages).length === 0) return deps.showAlert("No complete pages in range!");
            deps.queueRender(exportData);
        });
    }

    // ── Selective export ────────────────────────────────────────────────
    // "Render final album" is all-or-nothing, which is the wrong shape for
    // revisions: a client asking for changes to pages 1, 3 and 9 should cost
    // three page renders, not eighty. The spec box accepts "1, 3, 9-12".
    const pageSpecInput = /** @type {HTMLInputElement | null} */ (document.getElementById("exportPageSpec"));
    const pageSpecHint = document.getElementById("exportPageSpecHint");
    const btnRenderSelected = /** @type {HTMLButtonElement | null} */ (document.getElementById("btnRenderSelected"));

    /** Resolve the box to page numbers, and describe the result to the user. */
    function readPageSpec() {
        if (!pageSpecInput) return { pages: [], invalid: [], outOfRange: [] };
        return parsePageSpec(pageSpecInput.value, store.get('totalActivePages'));
    }

    function refreshPageSpecHint() {
        if (!pageSpecInput || !pageSpecHint || !btnRenderSelected) return;
        const raw = pageSpecInput.value.trim();
        if (!raw) {
            pageSpecHint.textContent = 'All pages';
            pageSpecHint.classList.remove('is-error');
            btnRenderSelected.disabled = true;
            return;
        }
        const { pages, invalid, outOfRange } = readPageSpec();

        // Both lists have to be summarised, not enumerated: "1-999" on a
        // 20-page album otherwise reports 979 missing page numbers and buries
        // the useful half of the message.
        const brief = (/** @type {(string|number)[]} */ list, /** @type {number} */ max) => (
            list.length <= max ? list.join(', ') : `${list.slice(0, max).join(', ')} +${list.length - max} more`
        );

        const problems = [];
        if (invalid.length) problems.push(`couldn't read ${brief(invalid, 3)}`);
        // Out-of-range is called out rather than clamped — silently rendering
        // something the user didn't ask for is the failure mode to avoid.
        if (outOfRange.length) {
            problems.push(outOfRange.length === 1
                ? `no page ${outOfRange[0]}`
                : `${outOfRange.length} pages don't exist (album has ${store.get('totalActivePages')})`);
        }

        if (!pages.length) {
            pageSpecHint.textContent = problems.length ? problems.join(' · ') : 'Nothing selected';
            pageSpecHint.classList.add('is-error');
            btnRenderSelected.disabled = true;
            return;
        }
        const label = `${pages.length} page${pages.length === 1 ? '' : 's'}: ${brief(pages, 8)}`;
        pageSpecHint.textContent = problems.length ? `${label} · ${problems.join(' · ')}` : label;
        pageSpecHint.classList.toggle('is-error', problems.length > 0);
        btnRenderSelected.disabled = false;
    }

    if (pageSpecInput) {
        pageSpecInput.addEventListener('input', refreshPageSpecHint);
        // Enter renders, so a selection can be typed and fired without reaching
        // for the mouse.
        pageSpecInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && btnRenderSelected && !btnRenderSelected.disabled) btnRenderSelected.click();
        });
        refreshPageSpecHint();
    }

    const btnClearPageSpec = document.getElementById("btnClearPageSpec");
    if (btnClearPageSpec && pageSpecInput) {
        btnClearPageSpec.addEventListener('click', () => {
            pageSpecInput.value = '';
            refreshPageSpecHint();
        });
    }

    // Fill the box from whatever is ticked in the storyboard, so the two ways
    // of choosing pages feed the same place rather than competing.
    const btnSelectFromStoryboard = document.getElementById("btnSelectFromStoryboard");
    if (btnSelectFromStoryboard && pageSpecInput) {
        btnSelectFromStoryboard.addEventListener('click', () => {
            const ticked = [...document.querySelectorAll('.storyboard-page__pick:checked')]
                .map((cb) => parseInt(/** @type {HTMLInputElement} */ (cb).value, 10))
                .filter((n) => Number.isFinite(n))
                .sort((a, b) => a - b);
            if (!ticked.length) { deps.toast('Tick some pages in the storyboard first', 'info'); return; }
            pageSpecInput.value = ticked.join(', ');
            refreshPageSpecHint();
        });
    }

    if (btnRenderSelected) {
        btnRenderSelected.addEventListener('click', () => {
            if (!store.get('outputFolder')) return deps.showAlert("Please SET OUTPUT FOLDER first!");
            const { pages } = readPageSpec();
            if (!pages.length) return deps.showAlert("No pages selected.");
            const exportData = deps.buildExportDataForPages(pages);
            const ready = Object.keys(exportData.pages).map(Number).sort((a, b) => a - b);
            if (!ready.length) {
                return deps.showAlert(`None of those pages can render yet — a page needs a template and at least one photo.`);
            }
            // Say what was skipped instead of quietly rendering fewer pages
            // than were asked for.
            const skipped = pages.filter((p) => !ready.includes(p));
            if (skipped.length) {
                deps.toast(`Skipping page ${skipped.join(', ')} — no template or no photos`, 'warning', { duration: 6000 });
            }
            deps.queueRender(exportData);
        });
    }

    const btnRenderFinalAlbum = document.getElementById("btnRenderFinalAlbum");
    if (btnRenderFinalAlbum) {
        btnRenderFinalAlbum.addEventListener("click", () => {
            if (!store.get('outputFolder')) return deps.showAlert("Please SET OUTPUT FOLDER first!");
            const exportData = deps.buildExportData(1, store.get('totalActivePages'));
            if (Object.keys(exportData.pages).length === 0) return deps.showAlert("Storyboard is empty!");
            deps.queueRender(exportData);
        });
    }

    return { useAdjLayers: () => useAdjLayers };
}

module.exports = { createExportActions };
