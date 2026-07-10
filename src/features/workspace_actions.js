// @ts-check
// features/workspace_actions.js — the Save/Load workspace buttons, the save
// split-menu (Save As / New Project), and the New Project flow, extracted
// from main.js (Phase 2 split). Persistence itself lives in project_io.js;
// this module is the toolbar-level glue around it.

const { getPanelHeaderHTML } = require('../renderer_pure');

/** @typedef {import('../state/store').Store} Store */

/**
 * @param {Store} store
 * @param {object} deps
 * @param {(msg: string) => boolean} deps.confirmDialog
 * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke
 * @param {(saveAs: boolean) => Promise<void> | void} deps.saveProject
 * @param {() => void} deps.loadProjectFromDisk
 * @param {() => void} deps.clearPhotoPageMap
 * @param {() => void} deps.resetRenderHashes
 * @param {() => void} deps.clearProofs
 * @param {() => void} deps.syncViewToState
 * @param {() => void} deps.updatePageDropdowns
 * @param {() => void} deps.renderGreenBox
 * @param {(pageNum: number) => void} deps.changePage
 * @param {() => void} deps.invalidateTab6
 * @param {(msg: string, kind?: string, opts?: object) => void} deps.toast
 */
function createWorkspaceActions(store, deps) {
    // New Project: keep the reusable library (templates/wallpapers/assets/
    // output + settings); clear the project-specific source photos, Photos
    // tab, and album layout; then save to a freshly named/created file.
    // Confirmed first so it's never a silent data loss.
    async function newProject() {
        const ok = deps.confirmDialog(
            'Start a new project?\n\n' +
            'Your loaded source photos, the Photos tab, and the current album layout will be cleared. ' +
            'Loaded templates, wallpapers, other assets, the output folder, and settings stay. ' +
            'Save your current project first if you need it.'
        );
        if (!ok) return;
        const target = await deps.invoke('project-pick-save', 'New Album Project');
        if (!target) return;
        try {
            // Clear source images + Photos tab.
            const projectData = store.get('projectData');
            store.set('photoCache', {});
            store.get('activeImageFolders').clear();
            projectData.imageTokens = [];
            if (projectData.highResTokens) projectData.highResTokens = [];
            const redBox = /** @type {HTMLElement} */ (document.getElementById('redBox'));
            redBox.innerHTML = `<div class="empty-state">
                <div class="empty-state__icon">🖼️</div>
                <div class="empty-state__title">No photos loaded</div>
                <div class="empty-state__hint">Load a folder of photos to build your source pool, then drag or auto-fill them onto pages.</div>
                <button class="btn btn--primary btn--sm empty-state__action" data-load="btnLoadPhotos">📂 Load photos</button>
            </div>`;
            const photosGrid = document.getElementById('photosGrid');
            if (photosGrid) photosGrid.innerHTML = "";
            deps.invalidateTab6();
            const rfp = document.getElementById('redFolderPanel'); if (rfp) rfp.innerHTML = getPanelHeaderHTML('images');
            const pfp = document.getElementById('photosFolderPanel'); if (pfp) pfp.innerHTML = getPanelHeaderHTML('images');
            // Reset the album to a single blank page + per-photo edit maps.
            store.set('albumPages', { 1: { photos: [], template: null } });
            store.set('totalActivePages', 1);
            store.set('currentPage', 1);
            deps.clearPhotoPageMap();
            projectData.imageRotations = {};
            projectData.imageAdjustments = {};
            projectData.imagePlacements = {};
            deps.resetRenderHashes();
            deps.clearProofs();
            deps.syncViewToState();
            deps.updatePageDropdowns();
            deps.renderGreenBox();
            deps.changePage(1);
        } catch (e) {
            console.error('New Project clear failed:', e);
            deps.toast('New Project: clearing failed — ' + /** @type {Error} */ (e).message, 'error');
            return;
        }
        store.set('currentProjectPath', target);
        await deps.saveProject(false);
    }

    const btnSaveWorkspace = document.getElementById("btnSaveWorkspace");
    if (btnSaveWorkspace) {
        btnSaveWorkspace.addEventListener("click", () => { deps.saveProject(false); });
    }

    // Save split-button menu (Save As / New Project). Reparented to <body> and
    // fixed-positioned from the button (same approach as the theme dropdown) so it
    // can't be clipped or painted under the tab content / stacking contexts.
    const btnSaveMenuBtn = document.getElementById("btnSaveMenuBtn");
    const saveMenu = document.getElementById("saveMenu");
    if (btnSaveMenuBtn && saveMenu) {
        let _saveMenuReparented = false;
        const positionSaveMenu = () => {
            if (!_saveMenuReparented) { document.body.appendChild(saveMenu); _saveMenuReparented = true; }
            const r = btnSaveMenuBtn.getBoundingClientRect();
            saveMenu.style.position = 'fixed';
            saveMenu.style.top = (r.bottom + 4) + 'px';
            saveMenu.style.left = 'auto';
            saveMenu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
            saveMenu.style.zIndex = '100000';
        };
        const closeSaveMenu = () => { saveMenu.classList.remove('open'); btnSaveMenuBtn.setAttribute('aria-expanded', 'false'); };
        btnSaveMenuBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (saveMenu.classList.contains('open')) { closeSaveMenu(); return; }
            positionSaveMenu();
            saveMenu.classList.add('open');
            btnSaveMenuBtn.setAttribute('aria-expanded', 'true');
        });
        document.addEventListener('click', (e) => {
            const t = /** @type {HTMLElement} */ (e.target);
            if (!t.closest('.save-split') && !t.closest('#saveMenu')) closeSaveMenu();
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSaveMenu(); });
        window.addEventListener('resize', () => { if (saveMenu.classList.contains('open')) positionSaveMenu(); });
        const btnSaveAs = document.getElementById("btnSaveAs");
        if (btnSaveAs) btnSaveAs.addEventListener("click", () => { closeSaveMenu(); deps.saveProject(true); });
        const btnNewProject = document.getElementById("btnNewProject");
        if (btnNewProject) btnNewProject.addEventListener("click", () => { closeSaveMenu(); newProject(); });
    }

    const btnLoadWorkspace = document.getElementById("btnLoadWorkspace");
    if (btnLoadWorkspace) {
        btnLoadWorkspace.addEventListener("click", () => { deps.loadProjectFromDisk(); });
    }
}

module.exports = { createWorkspaceActions };
