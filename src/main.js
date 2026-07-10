// Folder picking + persisted-token resolution live in the fs/paths service
// (src/services/fs_paths.js), which replaced the old UXP stubs (Phase 2).
const fsPaths = require("./services/fs_paths").createFsPaths(
    (channel, ...args) => require('electron').ipcRenderer.invoke(channel, ...args));

// Pure, testable helpers extracted from this file (no DOM / no shared state).
// See src/renderer_pure.js. Destructured here so every existing call site
// (escapeHtml(...), _generativePreviewSvg(...), etc.) resolves unchanged.
const {
    _generativePreviewSvg,
    getPanelHeaderHTML,
    _hashPage,
    _proofTemplatePreviewPath,
} = require("./renderer_pure");

// ⚡ PERFORMANCE NOTE: All CSS that was previously injected here as a JS string
// has been moved to style.css. This removes a render-blocking JS-to-CSSOM path.

// ==========================================
// --- TAB SWITCHING LOGIC ---
// ==========================================
// The tab bar (pane switching + lazy per-tab first paints), the thumb-size
// sliders, and the empty-state action forwarder live in src/ui_tabs.js
// (Phase 2 split). It owns the lazy Tab 6 flag; isTab6Rendered/
// invalidateTab6 are the seams the photo library and project restore use.
const { isTab6Rendered, invalidateTab6 } = require('./ui_tabs').createTabs({
    renderStoryboard: () => renderStoryboard(),
    renderPhotosGrid: () => renderPhotosGrid(),
    refreshToolsBarStatus: () => refreshToolsBarStatus(),
    refreshLibraryView: () => refreshLibraryView(),
    refreshPluginsView: () => refreshPluginsView(),
});

// ==========================================
// --- GLOBAL VARIABLES & MEMORY ---
// ==========================================
// Phase 2 state store: the undoable core (album pages, paging, project data,
// template lists) lives in src/state/store.js — the single source of truth.
// exposeOnGlobal surfaces each migrated slice as an accessor property on
// globalThis, so every bare reference below transparently reads/writes the
// store until the module split rewrites them to explicit store access.
/* global albumPages:writable, currentPage:writable, totalActivePages:writable */
const store = require('./state/store').createStore();
require('./state/store').exposeOnGlobal(store, [
    'albumPages', 'templateLibrary', 'filteredTemplates',
    'currentPage', 'totalActivePages', 'projectData',
    'photoCache', 'outputFolder',
    'activeImageFolders', 'activeTemplateFolders', 'activeWallpaperFolders',
    'activePngFolders', 'activeMaskedFolders',
    'globalHighResMap', 'globalWpHighResMap',
]);
// Template sync state (_syncTemplates / _activeMatchPanel) lives in
// src/features/template_filter.js.
// The J1 adjustment-layers flag lives in src/features/export_actions.js
// (wired in the export section below).
// photoCache / wallpaperCache / pngCache / maskedCache / outputFolder live in
// the state store (see the exposeOnGlobal block above).

// projectData lives in the store (seeded with the same defaults) — see the
// exposeOnGlobal block above.

// The five active*Folders Sets (which source folders are checked) live in the
// state store.

// autoHighResFolder / globalHighResMap / globalWpHighResMap live in the state
// store.

// ⚡ Reverse lookup: photoId → Set<pageNumber>
// Eliminates the O(n×m) scan in applyGlobalRotation and other places.
const photoPageMap = {};
function addToPageMap(photoId, pageNum) {
    if (!photoPageMap[photoId]) photoPageMap[photoId] = new Set();
    photoPageMap[photoId].add(pageNum);
}
function removeFromPageMap(photoId, pageNum) {
    if (photoPageMap[photoId]) photoPageMap[photoId].delete(pageNum);
}
function rebuildPhotoPageMap() {
    Object.keys(photoPageMap).forEach(k => delete photoPageMap[k]);
    Object.entries(albumPages).forEach(([pageNum, page]) => {
        if (page && page.photos) {
            page.photos.forEach(p => addToPageMap(p.id, parseInt(pageNum)));
        }
    });
}

// ⚡ Task 2.3: single idempotent "apply album state → view" function.
// Rebuilds the `.used` markers (and clears stale opacity) on Tab 1 source
// thumbnails and Tab 6 photo cards purely from albumPages. Previously this
// 6-line loop was copy-pasted at ~6 call sites (history apply, refreshTab,
// clear-album, restore, etc.) and the partial copies drifted, causing
// stale-marker bugs. Every mutation path now funnels through this.
function syncViewToState() {
    // 1. Clear every source thumbnail (Tab 1) + photo card (Tab 6).
    document.querySelectorAll('.thumb-red').forEach(img => {
        img.classList.remove('used');
        img.style.opacity = '1';
    });
    document.querySelectorAll('#photosGrid .wp-card').forEach(c => c.classList.remove('used'));

    // 2. Re-mark everything currently placed in the album.
    Object.values(albumPages).forEach(page => {
        if (!page || !page.photos) return;
        page.photos.forEach(p => {
            const r = document.getElementById(p.id); if (r) r.classList.add('used');
            const c = document.getElementById('pt_' + p.id); if (c) c.classList.add('used');
        });
    });
}

const redBox = document.getElementById("redBox");
const whiteBox = document.getElementById("whiteBox");
const wallpaperGrid = document.getElementById("wallpaperGrid");
const pngGrid = document.getElementById("pngGrid"), maskedGrid = document.getElementById("maskedGrid");

// Live preview state lives in src/features/proofs.js (wired below).

// saveStateToStorage (debounced localStorage autosave) lives in
// src/features/project_io.js — wired in the PROJECT section below.

// escapeHtml + _generativePreviewSvg moved to src/renderer_pure.js (required above).

// ─── HISTORY (undo / redo) ─────────────────────────────────────
// The undo/redo history system lives in src/state/history.js (the first
// module of the Phase 2 split): compact snapshots of the undoable core,
// replayed through the store. The DOM-flavored bits — view re-sync,
// persistence, toasts — are injected here.
const { mutate, undo, redo } = require('./state/history').createHistory(store, {
    afterApply: () => {
        rebuildPhotoPageMap();
        if (typeof updatePageDropdowns === 'function') updatePageDropdowns();
        if (typeof renderGreenBox === 'function') renderGreenBox();
        if (typeof scheduleFilterUpdate === 'function') scheduleFilterUpdate();
        if (typeof renderStoryboard === 'function') renderStoryboard();
        // Refresh the .used markers on source thumbnails (single owner).
        syncViewToState();
    },
    persist: () => saveStateToStorage(),
    toast: (msg, kind, opts) => toast(msg, kind, opts),
});

// ─── TOAST + STATUS SYSTEM ─────────────────────────────────────
// setStatus / toast / notify live in src/ui_feedback.js (Phase 2 split);
// feature modules keep receiving them as injected deps below.
const { toast, setStatus, notify, showAlert } = require('./ui_feedback');

// getPanelHeaderHTML moved to src/renderer_pure.js (required at top).

// The folder rail engine — the shared folder-row builder (createFolderRow),
// global photo rotation, the remove-folders dialog, and the checked-folder
// refresh engine — lives in src/features/folder_refresh.js (Phase 2 split).
// The five processXxxFolder engines are injected via late-bound arrows (they
// are created further down by photo_library / asset_library).
const { createFolderRow, applyGlobalRotation } =
    require('./features/folder_refresh').createFolderRefresh(store, {
        mutate: (label, fn) => mutate(label, fn),
        isTab6Rendered: () => isTab6Rendered(),
        getPhotoPages: (photoId) => photoPageMap[photoId],
        renderGreenBox: () => renderGreenBox(),
        scheduleFilterUpdate: () => scheduleFilterUpdate(),
        saveState: () => saveStateToStorage(),
        syncViewToState: () => syncViewToState(),
        getEntryForToken: (token) => fsPaths.entryForToken(token),
        buildHighResMap: (folder, mapObj) => buildHighResMap(folder, mapObj),
        processImageFolder: (folder, hrFolder, token, id) => processImageFolder(folder, hrFolder, token, id),
        processWallpaperFolder: (folder, hrFolder, name, token, id) => processWallpaperFolder(folder, hrFolder, name, token, id),
        processTemplateFolder: (folder, token, id) => processTemplateFolder(folder, token, id),
        processPngFolder: (folder, token, id) => processPngFolder(folder, token, id),
        processMaskedFolder: (folder, token, id) => processMaskedFolder(folder, token, id),
        setStatus: (msg) => setStatus(msg),
        notify: (msg, kind, opts) => notify(msg, kind, opts),
    });

// getDisplayName moved to src/renderer_pure.js (required at top).

// applyGlobalRotation lives in src/features/folder_refresh.js (created above).


// HR source resolution (getTrueFile), EXIF capture-time sorting, and the
// high-res map builder live in src/features/photo_sources.js (Phase 2 split).
const { getTrueFile, sortPhotosByExif, buildHighResMap } =
    require('./features/photo_sources').createPhotoSources(store, {
        setStatus: (msg) => setStatus(msg),
    });

// ==========================================
// --- 1. SETUP & PAGE NAVIGATION ---
// ==========================================
// The page engine — navigation (updatePageDropdowns/changePage), add/
// remove/clear page, the green-box composer (prepareAndMove/renderGreenBox
// + drag-reorder/remove/sort/teleport), and Smart Auto-Fill — lives in
// src/features/album_pages.js (Phase 2 split). Cross-module seams and the
// photo→page reverse map are injected here.
const { updatePageDropdowns, changePage, renderGreenBox, prepareAndMove } =
    require('./features/album_pages').createAlbumPages(store, {
        mutate: (label, fn) => mutate(label, fn),
        addToPageMap: (photoId, pageNum) => addToPageMap(photoId, pageNum),
        removeFromPageMap: (photoId, pageNum) => removeFromPageMap(photoId, pageNum),
        rebuildPhotoPageMap: () => rebuildPhotoPageMap(),
        clearPhotoPageMap: () => { Object.keys(photoPageMap).forEach(k => delete photoPageMap[k]); },
        syncViewToState: () => syncViewToState(),
        scheduleFilterUpdate: () => scheduleFilterUpdate(),
        scheduleLivePreview: () => scheduleLivePreview(),
        renderStoryboard: () => renderStoryboard(),
        clearProofs: () => _clearProofs(),
        resetRenderHashes: () => { try { store.set('renderHashes', {}); saveRenderHashes(store); } catch (_) {} },
        sortPhotosByExif: (items) => sortPhotosByExif(items),
        updateAdjustPanel: () => updateAdjustPanel(),
        setStatus: (msg) => setStatus(msg),
        toast: (msg, kind, opts) => toast(msg, kind, opts),
        notify: (msg, kind, opts) => notify(msg, kind, opts),
        showAlert: (msg) => showAlert(msg),
    });

// ==========================================
// --- 2. FOLDER DIALOG & REFRESH ENGINE ---
// ==========================================
// The remove-folders dialog (.btn-remove-fld → #removeFolderDialog) and the
// checked-folder refresh engine (refreshTab + .btn-reload-fld) live in
// src/features/folder_refresh.js (created above).

// ==========================================
// --- 3. FILE LOADING (PHOTOS / TAB 6) ---
// ==========================================

// scanFolderRecursive moved to src/features/asset_library.js (its only caller).

// Source-pool selection clicks + native drag-out (source pool and Photos
// tab) live in src/ui_source_drag.js (Phase 2 split).
require('./ui_source_drag').createSourceDrag({
    prepareAndMove: (items) => prepareAndMove(items),
    setActiveMatchPanel: (panel) => setActiveMatchPanel(panel),
    scheduleFilterUpdate: () => scheduleFilterUpdate(),
    photoNativePath: (id) => photoNativePath(id),
    startNativeDrag: (paths) => require('electron').ipcRenderer.send('start-native-drag', paths),
});

// ⚡ FIX: processImageFolder only builds Tab 1 (redBox) DOM now.
// Tab 6 is built lazily via renderPhotosGrid() the first time the user opens that tab.
// photoCache entries now carry extra fields needed for lazy Tab 6 rendering.
// The source-photo library lives in src/features/photo_library.js (Phase 2
// split): processImageFolder (Tab 1 wrappers + photoCache), the lazy
// virtualized Photos tab (renderPhotosGrid + IntersectionObserver + inject
// delegation), and the Load Photos buttons. Selection, template matching,
// and native drag-out stay here. Cross-cutting glue is injected.
const { processImageFolder, renderPhotosGrid } =
    require('./features/photo_library').createPhotoLibrary(store, {
        invoke: (channel, ...args) => require('electron').ipcRenderer.invoke(channel, ...args),
        createFolderRow,
        getTrueFile,
        pickFolder: () => fsPaths.pickFolder(),
        createToken: (folder) => fsPaths.tokenForFolder(folder),
        showAlert: (msg) => showAlert(msg),
        saveState: () => saveStateToStorage(),
        setStatus: (msg) => setStatus(msg),
        toast: (msg, kind, opts) => toast(msg, kind, opts),
        notify: (msg, kind, opts) => notify(msg, kind, opts),
        applyGlobalRotation: (safeId, newRot) => applyGlobalRotation(safeId, newRot),
        renderGreenBox: () => renderGreenBox(),
        invalidateTab6: () => invalidateTab6(),
    });

// ==========================================
// --- 4. TEMPLATES ENGINE ---
// ==========================================
// processTemplateFolder + the Load Templates button live in
// src/features/asset_library.js (wired in the asset-libraries section).

// ==========================================
// --- 5. FILTERING & TEMPLATE SAFE OPENER ---
// ==========================================

// The template matching/filtering engine, white-box picker, preview pane
// (setPreview), quick-build, PS context menus, and the HR path resolver live
// in src/features/template_filter.js (Phase 2 split). The live-preview seam
// stays here and is injected.
const { scheduleFilterUpdate, setPreview, setActiveMatchPanel, photoNativePath } =
    require('./features/template_filter').createTemplateFilter(store, {
        invoke: (channel, ...args) => require('electron').ipcRenderer.invoke(channel, ...args),
        isLivePreviewOn: () => isLivePreviewOn(),
        scheduleLivePreview: () => scheduleLivePreview(),
        setStatus: (msg) => setStatus(msg),
        toast: (msg, kind, opts) => toast(msg, kind, opts),
        notify: (msg, kind, opts) => notify(msg, kind, opts),
    });

// ── Live preview + proofs + client gallery ─────────────────────
// The live preview (debounced libvips composite of the current page), the
// fast proof renderer (per-page composite JPEGs, bounded-concurrency batch),
// and the client gallery export live in src/features/proofs.js (Phase 2
// split). scheduleEditedPageReproof/ensureTemplateFrames keep their old
// names for the Spread Editor call sites below.
const {
    isLivePreviewOn, scheduleLivePreview,
    ensureTemplateFrames, scheduleEditedPageReproof: _scheduleEditedPageReproof,
    reapplyProofs: _reapplyProofs, clearProofs: _clearProofs,
} = require('./features/proofs').createProofs(store, {
    invoke: (channel, ...args) => require('electron').ipcRenderer.invoke(channel, ...args),
    setStatus: (msg) => setStatus(msg),
    toast: (msg, kind, opts) => toast(msg, kind, opts),
    notify: (msg, kind, opts) => notify(msg, kind, opts),
    showAlert: (msg) => showAlert(msg),
});

// ── Per-photo adjustments ──────────────────────────────────────
// The inline Pages adjust panel (H1) was removed — per-photo colour grading
// now lives solely in the Spread Editor. `updateAdjustPanel` is kept as a
// no-op so existing call sites stay valid. The adjustment *data model*
// (projectData.imageAdjustments) is unchanged and still drives the preview,
// the export, and the editor.
function updateAdjustPanel() { /* no-op: adjust UI moved to the Spread Editor */ }
// Initialise (no-op).
updateAdjustPanel();


// ── Spread Editor bridge ───────────────────────────────────────
// The payload builder (buildSpreadPayload), the Edit Spread button, and the
// editor-changes/swap/goto push handlers live in
// src/features/spread_editor.js (Phase 2 split).
require('./features/spread_editor').createSpreadEditor(store, {
    invoke: (channel, ...args) => require('electron').ipcRenderer.invoke(channel, ...args),
    on: (channel, listener) => require('electron').ipcRenderer.on(channel, listener),
    ensureTemplateFrames: (tpl) => ensureTemplateFrames(tpl),
    scheduleEditedPageReproof: (pageNum) => _scheduleEditedPageReproof(pageNum),
    mutate: (label, fn) => mutate(label, fn),
    saveState: () => saveStateToStorage(),
    scheduleLivePreview: () => scheduleLivePreview(),
    updateAdjustPanel: () => updateAdjustPanel(),
    renderGreenBox: () => renderGreenBox(),
    setStatus: (msg) => setStatus(msg),
    toast: (msg, kind, opts) => toast(msg, kind, opts),
});

// ==========================================
// --- 6. GREEN BOX & TOOLBAR ACTIONS ---
// ==========================================
// The green-box composer and Smart Auto-Fill live in
// src/features/album_pages.js (wired in the page-navigation section).

// The Build-This-Page button lives in src/features/export_actions.js
// (wired in the export section below).

// ==========================================
// --- 9. UI SLIDERS & RESIZERS ---
// ==========================================
// The thumb-size sliders live in src/ui_tabs.js (Phase 2 split).
// The draggable panel dividers (setupResizer/setupHorizontalResizer + all
// bindings) live in src/ui_resizers.js (Phase 2 split).
require('./ui_resizers').initResizers();

// ==========================================
// --- 10+11. TABS 2–3: ASSET LIBRARIES ---
// ==========================================
// The wallpaper / PNG-frame / masked-frame engines live in
// src/features/asset_library.js (Phase 2 split): cache + card grids +
// folder rails + Photoshop place actions + Load buttons. The cross-cutting
// glue (folder rows, HR resolution, pickers, persistence, status) is
// injected here.
const { processWallpaperFolder, processPngFolder, processMaskedFolder, processTemplateFolder } =
    require('./features/asset_library').createAssetLibrary(store, {
        invoke: (channel, ...args) => require('electron').ipcRenderer.invoke(channel, ...args),
        createFolderRow,
        getTrueFile,
        pickFolder: () => fsPaths.pickFolder(),
        createToken: (folder) => fsPaths.tokenForFolder(folder),
        showAlert: (msg) => showAlert(msg),
        saveState: () => saveStateToStorage(),
        setStatus: (msg) => setStatus(msg),
        toast: (msg, kind, opts) => toast(msg, kind, opts),
        notify: (msg, kind, opts) => notify(msg, kind, opts),
        scheduleFilterUpdate: () => scheduleFilterUpdate(),
    });

// ==========================================
// --- 12. TAB 5: TOOLS (SWAP & THUMBS) ---
// ==========================================
// The Tab 5 tool cards (image swap, thumbnail generation, batch JPEG export,
// PSD resizer, Tools Bar launcher, Renamer opener) live in
// src/features/tools_tab.js (Phase 2 split).
const { refreshToolsBarStatus } =
    require('./features/tools_tab').createToolsTab({
        invoke: (channel, ...args) => require('electron').ipcRenderer.invoke(channel, ...args),
        on: (channel, listener) => require('electron').ipcRenderer.on(channel, listener),
        pickFolder: () => fsPaths.pickFolder(),
        showAlert: (msg) => showAlert(msg),
        setStatus: (msg) => setStatus(msg),
        toast: (msg, kind, opts) => toast(msg, kind, opts),
        notify: (msg, kind, opts) => notify(msg, kind, opts),
    });

// Generative templates (virtual layouts, the checkbox loader, and the
// generative-aware HR render interceptor that diverts build-page(s) to the
// JS-only composite) live in src/features/generative_ui.js (Phase 2 split).
const { loadGenerativeTemplates, ensureGenerativeLoaded } =
    require('./features/generative_ui').createGenerativeUi(store, {
        scheduleFilterUpdate: () => scheduleFilterUpdate(),
        toast: (msg, kind, opts) => toast(msg, kind, opts),
    });

// ==========================================
// --- TIER 3: PHOTO CURATION ---
// ==========================================
// The curation panel (analyze / apply thresholds / export keepers) lives in
// src/features/curation_ui.js (Phase 2 split).
require('./features/curation_ui').createCurationUi({
    invoke: (channel, ...args) => require('electron').ipcRenderer.invoke(channel, ...args),
    on: (channel, listener) => require('electron').ipcRenderer.on(channel, listener),
    off: (channel, listener) => require('electron').ipcRenderer.removeListener(channel, listener),
    pickFolder: () => fsPaths.pickFolder(),
    toast: (msg, kind, opts) => toast(msg, kind, opts),
    notify: (msg, kind, opts) => notify(msg, kind, opts),
});

// ==========================================
// --- TIER 3.B: LIBRARY ---
// ==========================================
// The persistent user library (view + apply/remove/add + save/apply-layout)
// lives in src/features/library_view.js (Phase 2 split).
const { refreshLibraryView } =
    require('./features/library_view').createLibraryView(store, {
        invoke: (channel, ...args) => require('electron').ipcRenderer.invoke(channel, ...args),
        mutate: (label, fn) => mutate(label, fn),
        rebuildPhotoPageMap: () => rebuildPhotoPageMap(),
        updatePageDropdowns: () => updatePageDropdowns(),
        renderGreenBox: () => renderGreenBox(),
        scheduleFilterUpdate: () => scheduleFilterUpdate(),
        renderStoryboard: () => renderStoryboard(),
        saveState: () => saveStateToStorage(),
        pickFolder: () => fsPaths.pickFolder(),
        processTemplateFolder: (folder, token, id) => processTemplateFolder(folder, token, id),
        processWallpaperFolder: (folder, hrFolder, name, token, id) => processWallpaperFolder(folder, hrFolder, name, token, id),
        processPngFolder: (folder, token, id) => processPngFolder(folder, token, id),
        processMaskedFolder: (folder, token, id) => processMaskedFolder(folder, token, id),
        generativeFolderId: require('./features/generative_ui').GENERATIVE_FOLDER_ID,
        ensureGenerativeLoaded: () => ensureGenerativeLoaded(),
        toast: (msg, kind, opts) => toast(msg, kind, opts),
        notify: (msg, kind, opts) => notify(msg, kind, opts),
    });

// ==========================================
// --- TIER 3.B: PLUGINS UI ---
// ==========================================
// The plugins panel lives in src/features/plugins_view.js (Phase 2 split).
const { refreshPluginsView } =
    require('./features/plugins_view').createPluginsView({
        invoke: (channel, ...args) => require('electron').ipcRenderer.invoke(channel, ...args),
        toast: (msg, kind, opts) => toast(msg, kind, opts),
    });

// Tab 5's status refresh + first paint of the library/plugins panels is
// handled by src/ui_tabs.js (wired at the top of this file).

// ==========================================
// --- 13. EXPORT & OUTPUT (TAB 1 FALLBACK) ---
// ==========================================
// The build/export buttons, output-folder pickers, and the J1 toggle live
// in src/features/export_actions.js (Phase 2 split). The render queue reads
// the live J1 flag through exportActions.useAdjLayers().
const exportActions = require('./features/export_actions').createExportActions(store, {
    buildExportData: (start, end) => buildExportData(start, end),
    bakeExportAdjustments: (exportData) => bakeExportAdjustments(exportData),
    queueRender: (exportData) => queueRender(exportData),
    invoke: (channel, payload) => require('electron').ipcRenderer.invoke(channel, payload),
    pickFolder: () => fsPaths.pickFolder(),
    createToken: (folder) => fsPaths.tokenForFolder(folder),
    saveState: () => saveStateToStorage(),
    setStatus: (msg) => setStatus(msg),
    notify: (msg, kind, opts) => notify(msg, kind, opts),
    toast: (msg, kind, opts) => toast(msg, kind, opts),
    showAlert: (msg) => showAlert(msg),
});

// Export-data assembly lives in src/features/export_data.js (Phase 2 split):
// page range → render payload (HR path upgrade, per-photo edits, generative
// sentinel), plus the pre-render adjustment bake.
const { buildExportData, bakeExportAdjustments } = require('./features/export_data').createExportData(store, {
    invoke: (channel, payload) => require('electron').ipcRenderer.invoke(channel, payload),
    readDir: (p) => require('fs').readdirSync(p),
});

// ─── RENDER QUEUE + DIRTY TRACKING ─────────────────────────────
// Ships render jobs to Photoshop one page at a time so the renderer thread
// stays responsive (the user can keep editing while pages render). Caches a
// hash of each page's inputs in localStorage so re-rendering an unchanged
// page is a no-op — this is the difference between "render took 4 minutes"
// and "render took 4 seconds" on iterative work where the user changes 5
// pages out of 200.

// Render-hash persistence lives in src/state/render_hashes.js and the DOM
// progress badge in src/ui_render_badge.js (Phase 2 split). Seed the cache
// from localStorage at boot so cache hits survive restarts.
const { seedRenderHashes, saveRenderHashes } = require('./state/render_hashes');
seedRenderHashes(store);
// _hashPage moved to src/renderer_pure.js (required at top).
const { updateBadge } = require('./ui_render_badge').createRenderBadge(store);

// The render worker + queueRender live in src/features/render_queue.js
// (Phase 2 split): chunking, cache partition, IPC dispatch, and stats via
// explicit store access. Status/notify/toast and the adjustment bake stay
// here and are injected.
const { queueRender } = require('./features/render_queue').createRenderQueue(store, {
    invoke: (channel, payload) => require('electron').ipcRenderer.invoke(channel, payload),
    updateBadge: () => updateBadge(),
    setStatus: (msg) => setStatus(msg),
    notify: (msg, kind, opts) => notify(msg, kind, opts),
    toast: (msg, kind, opts) => toast(msg, kind, opts),
    persistHashes: () => saveRenderHashes(store),
    bakeAdjustments: (exportData) => bakeExportAdjustments(exportData),
    useAdjLayers: () => exportActions.useAdjLayers(),
});

// btnExport is wired by src/features/export_actions.js (created above).

// ==========================================
// --- 14. TAB 7: VIRTUAL STORYBOARD ENGINE ---
// ==========================================

// The virtual storyboard engine lives in src/features/storyboard.js
// (Phase 2 split): the per-page card builder, delegated selection + drag
// system, and the undoable cross-page photo move. Proof re-apply is
// injected from the proofs module (wired in the live-preview section).
const { renderStoryboard } = require('./features/storyboard').createStoryboard(store, {
    mutate: (label, fn) => mutate(label, fn),
    addToPageMap: (photoId, pageNum) => addToPageMap(photoId, pageNum),
    removeFromPageMap: (photoId, pageNum) => removeFromPageMap(photoId, pageNum),
    renderGreenBox: () => renderGreenBox(),
    scheduleFilterUpdate: () => scheduleFilterUpdate(),
    reapplyProofs: () => _reapplyProofs(),
});

// The fast proof renderer + client gallery live in src/features/proofs.js
// (wired in the live-preview section above).

// btnSetFinalOutput and btnRenderFinalAlbum are wired by
// src/features/export_actions.js (created in the export section above).
// (buildExportData defined once above — duplicate removed)

// ==========================================
// --- 15. GLOBAL SAVE / LOAD WORKSPACE ---
// ==========================================

// ─── PROJECT (folder-as-project model) ─────────────────────────
// Replaces the previous single-JSON save with a directory layout:
//   <project>/project.json     ← workspace + albumPages
//   <project>/proofs/          ← fast preview JPEGs (future)
//   <project>/exports/         ← high-res PSDs from the render queue
// Legacy single-file .json projects still load through the same handler.
// currentProjectPath lives in the state store.

// Project persistence lives in src/features/project_io.js (Phase 2 split):
// debounced autosave, payload build, save/load/boot-restore orchestration
// via explicit store access. The DOM-flavored bits — grid/panel resets, the
// folder processors, output label, generative toggle, view re-sync — are
// injected here.
const {
    saveStateToStorage, saveProject,
    restoreWorkspace, loadProjectFromDisk, bootRestore,
} = require('./features/project_io').createProjectIO(store, {
    invoke: (channel, ...args) => require('electron').ipcRenderer.invoke(channel, ...args),
    storage: localStorage,
    getEntryForToken: (t) => fsPaths.entryForToken(t),
    processors: {
        image: (folder, hrFolder, token) => processImageFolder(folder, hrFolder, token),
        template: (folder, token) => processTemplateFolder(folder, token),
        wallpaper: (folder, hrFolder, displayName, token) => processWallpaperFolder(folder, hrFolder, displayName, token),
        png: (folder, token) => processPngFolder(folder, token),
        masked: (folder, token) => processMaskedFolder(folder, token),
    },
    resetSourceViews: () => {
        redBox.innerHTML = ""; whiteBox.innerHTML = "";
        // Only wipe asset grids that actually hold cards (not an empty-state).
        if (wallpaperGrid.querySelector('.wp-card')) wallpaperGrid.innerHTML = "";
        if (pngGrid.querySelector('.wp-card')) pngGrid.innerHTML = "";
        if (maskedGrid.querySelector('.wp-card')) maskedGrid.innerHTML = "";
        document.getElementById("redFolderPanel").innerHTML = getPanelHeaderHTML("images");
        document.getElementById("photosFolderPanel").innerHTML = getPanelHeaderHTML("images");
        document.getElementById("whiteFolderPanel").innerHTML = getPanelHeaderHTML("templates");
        document.getElementById("wpFolderPanel").innerHTML = getPanelHeaderHTML("wallpapers");
        document.getElementById("pngFolderPanel").innerHTML = getPanelHeaderHTML("pngs");
        document.getElementById("maskedFolderPanel").innerHTML = getPanelHeaderHTML("masks");
    },
    setOutputFolderLabel: (text) => {
        const ftxt = document.getElementById("finalOutputText");
        if (ftxt) ftxt.innerText = text;
    },
    ensureGenerativeTemplates: async () => {
        const chk = document.getElementById('chkGenerativeTemplates');
        if (chk && !chk.checked) chk.checked = true;
        await loadGenerativeTemplates();
    },
    afterRestore: () => {
        syncViewToState();
        rebuildPhotoPageMap(); // ⚡ Initialize reverse lookup from loaded album state
        invalidateTab6();  // ⚡ Force Tab 6 rebuild with fresh data on next visit
        updatePageDropdowns(); changePage(1);
    },
    persistHashes: () => saveRenderHashes(store),
    setStatus: (msg) => setStatus(msg),
    notify: (msg, kind, opts) => notify(msg, kind, opts),
    toast: (msg, kind, opts) => toast(msg, kind, opts),
});

// The Save/Load workspace buttons, the save split-menu, and the New Project
// flow live in src/features/workspace_actions.js (Phase 2 split).
// restoreWorkspace lives in src/features/project_io.js (wired above).
require('./features/workspace_actions').createWorkspaceActions(store, {
    confirmDialog: (msg) => confirm(msg),
    invoke: (channel, ...args) => require('electron').ipcRenderer.invoke(channel, ...args),
    saveProject: (saveAs) => saveProject(saveAs),
    loadProjectFromDisk: () => loadProjectFromDisk(),
    clearPhotoPageMap: () => { Object.keys(photoPageMap).forEach(k => delete photoPageMap[k]); },
    resetRenderHashes: () => { try { store.set('renderHashes', {}); saveRenderHashes(store); } catch (_) {} },
    clearProofs: () => _clearProofs(),
    syncViewToState: () => syncViewToState(),
    updatePageDropdowns: () => updatePageDropdowns(),
    renderGreenBox: () => renderGreenBox(),
    changePage: (pageNum) => changePage(pageNum),
    invalidateTab6: () => invalidateTab6(),
    toast: (msg, kind, opts) => toast(msg, kind, opts),
});

window.addEventListener("DOMContentLoaded", () => { bootRestore(); });

// ─── KEYBOARD SHORTCUTS ────────────────────────────────────────
// The global keydown handler + "?" help dialog live in
// src/ui_shortcuts.js (Phase 2 split). Cmd/Ctrl+S/O/E click the real
// buttons, so those flows need no seams here.
require('./ui_shortcuts').createShortcuts(store, {
    undo: () => undo(),
    redo: () => redo(),
    changePage: (pageNum) => changePage(pageNum),
    setPreview: (idx, scroll) => setPreview(idx, scroll),
    renderStoryboard: () => renderStoryboard(),
});


// ── E2E test hook (guarded) ──────────────────────────────────────────────────
// Present ONLY when the (non-packaged) main process launched us with --e2e; it
// never exists in a shipped build. Gives the Playwright suite a dialog-free way
// to load a project and to inspect + drive the real undo/redo history system,
// so the stateful core is covered before the Phase 2 refactor touches it.
if (window.native && window.native.isE2E) {
    window.__E2E__ = {
        loadProject: (data) => restoreWorkspace(data),
        state: () => ({
            totalActivePages,
            pageCount: Object.keys(albumPages).length,
            currentPage,
        }),
        // A real, undoable mutation routed through the history system.
        clearAlbum: () => mutate('e2e-clear', () => {
            albumPages = { 1: { photos: [], template: null } };
            totalActivePages = 1;
            currentPage = 1;
        }),
        undo: () => undo(),
        redo: () => redo(),
        // Drive the real export path (queue → chunking → render cache →
        // IPC bridge). The main process mocks the Photoshop JSX job behind
        // the same test-mode guard and logs it to ALBUMSTUDIO_E2E_JSX_LOG.
        exportRange: (start, end) => queueRender(buildExportData(start, end)),
        // The render slices have no global accessors anymore, so the export
        // spec resets the cache and polls the queue through these seams.
        resetRenderCache: () => { store.set('renderHashes', {}); saveRenderHashes(store); },
        renderState: () => ({
            active: store.get('renderActive'),
            queued: store.get('renderQueue').length,
            hashCount: Object.keys(store.get('renderHashes')).length,
        }),
    };
}
