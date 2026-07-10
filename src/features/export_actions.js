// @ts-check
// features/export_actions.js — the build/export buttons, the output-folder
// pickers, and the J1 adjustment-layers toggle, extracted from main.js
// (Phase 2 split). The queue/cache mechanics live in render_queue.js;
// this module is the button-level glue that assembles payloads and hands
// them over.

/** @typedef {import('../state/store').Store} Store */

/**
 * @param {Store} store
 * @param {object} deps
 * @param {(start: number, end: number) => any} deps.buildExportData
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
