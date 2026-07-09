const fs = require("./stubs/uxp").storage.localFileSystem;
const { app } = require("./stubs/photoshop");

// Pure, testable helpers extracted from this file (no DOM / no shared state).
// See src/renderer_pure.js. Destructured here so every existing call site
// (escapeHtml(...), _generativePreviewSvg(...), etc.) resolves unchanged.
const {
    _generativePreviewSvg,
    getPanelHeaderHTML,
    _hashPage,
    _proofTemplatePreviewPath,
    _isEditingTarget,
} = require("./renderer_pure");

// ⚡ PERFORMANCE NOTE: All CSS that was previously injected here as a JS string
// has been moved to style.css. This removes a render-blocking JS-to-CSSOM path.

// ==========================================
// --- TAB SWITCHING LOGIC ---
// ==========================================
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

// ⚡ Lazy Tab 6 flag — photosGrid is only built when the user first opens Tab 6
let tab6Rendered = false;

tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        tabButtons.forEach(b => b.classList.remove('active'));
        tabPanes.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const targetId = btn.getAttribute('data-target');
        const targetPane = document.getElementById(targetId);
        if (targetPane) targetPane.classList.add('active');

        if (targetId === 'tab-export') renderStoryboard();

        // ⚡ Lazy render: build Tab 6 grid only on first visit
        if (targetId === 'tab-photos' && !tab6Rendered) {
            tab6Rendered = true;
            renderPhotosGrid();
        }
    });
});

// ==========================================
// --- GLOBAL VARIABLES & MEMORY ---
// ==========================================
// Phase 2 state store: the undoable core (album pages, paging, project data,
// template lists) lives in src/state/store.js — the single source of truth.
// exposeOnGlobal surfaces each migrated slice as an accessor property on
// globalThis, so every bare reference below transparently reads/writes the
// store until the module split rewrites them to explicit store access.
/* global albumPages:writable, templateLibrary:writable, filteredTemplates:writable,
   currentPage:writable, totalActivePages:writable,
   projectData:writable, renderQueue:writable, renderHashes:writable,
   renderActive:writable, renderStats:writable, photoCache:writable,
   outputFolder:writable, activeImageFolders:writable, activeTemplateFolders:writable */
const store = require('./state/store').createStore();
require('./state/store').exposeOnGlobal(store, [
    'albumPages', 'templateLibrary', 'filteredTemplates',
    'currentPage', 'totalActivePages', 'projectData',
    'renderQueue', 'renderHashes', 'renderActive', 'renderStats',
    'photoCache', 'outputFolder',
    'activeImageFolders', 'activeTemplateFolders', 'activeWallpaperFolders',
    'activePngFolders', 'activeMaskedFolders',
    'globalHighResMap', 'globalWpHighResMap',
]);
// Template sync state (_syncTemplates / _activeMatchPanel) lives in
// src/features/template_filter.js.
// J1: render colour as editable clipped adjustment layers instead of baking
// pixels. EXPERIMENTAL — off by default (the bake path stays the safe default).
let _useAdjLayers = (() => { try { return localStorage.getItem('adt_adj_layers') === '1'; } catch (_) { return false; } })();
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
const photosGrid = document.getElementById("photosGrid");
const photosSlider = document.getElementById("photosSlider");

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
const { toast, setStatus, notify } = require('./ui_feedback');

// getPanelHeaderHTML moved to src/renderer_pure.js (required at top).

// The folder rail engine — the shared folder-row builder (createFolderRow),
// global photo rotation, the remove-folders dialog, and the checked-folder
// refresh engine — lives in src/features/folder_refresh.js (Phase 2 split).
// The five processXxxFolder engines are injected via late-bound arrows (they
// are created further down by photo_library / asset_library).
const { createFolderRow, applyGlobalRotation } =
    require('./features/folder_refresh').createFolderRefresh(store, {
        mutate: (label, fn) => mutate(label, fn),
        isTab6Rendered: () => tab6Rendered,
        getPhotoPages: (photoId) => photoPageMap[photoId],
        renderGreenBox: () => renderGreenBox(),
        scheduleFilterUpdate: () => scheduleFilterUpdate(),
        saveState: () => saveStateToStorage(),
        syncViewToState: () => syncViewToState(),
        getEntryForToken: (token) => fs.getEntryForPersistentToken(token),
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
        resetRenderHashes: () => { try { renderHashes = {}; _saveRenderHashes(); } catch (_) {} },
        sortPhotosByExif: (items) => sortPhotosByExif(items),
        updateAdjustPanel: () => updateAdjustPanel(),
        takeSourceDragItems: () => { const v = _sourceDragItems; _sourceDragItems = null; return v; },
        hasSourceDragItems: () => !!_sourceDragItems,
        setStatus: (msg) => setStatus(msg),
        toast: (msg, kind, opts) => toast(msg, kind, opts),
        notify: (msg, kind, opts) => notify(msg, kind, opts),
        showAlert: (msg) => app.showAlert(msg),
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

// ⚡ Per-image click state map for event-delegated double-click detection
const _redClickState = {};

// ⚡ FIX: Single event-delegated listener on redBox instead of one listener per image.
// With 500+ images this eliminates 500+ live event listeners and their memory overhead.
redBox.addEventListener('pointerup', (e) => {
    if (e.target.closest('.btn-rotate-red')) return;
    const wrapper = e.target.closest('.img-wrapper-red');
    if (!wrapper) return;
    const img = wrapper.querySelector('.thumb-red');
    if (!img) return;
    const safeId = img.id;

    if (!_redClickState[safeId]) _redClickState[safeId] = { count: 0, timer: null };
    const state = _redClickState[safeId];
    state.count++;

    if (state.count === 1) {
        state.timer = setTimeout(() => {
            state.count = 0;
            img.classList.toggle("selected");
            setActiveMatchPanel('source'); // B2: working in the source panel
            scheduleFilterUpdate(); // selection drives template matching
        }, 300);
    } else if (state.count === 2) {
        clearTimeout(state.timer);
        state.count = 0;
        prepareAndMove([{ id: img.id, url: img.src }]);
    }
});

// ── Source → Photoshop native drag-out ──────────────────────────────────
// Dragging a source thumbnail now starts a NATIVE OS file drag carrying the
// ORIGINAL high-res file, so dropping onto Photoshop (or Finder) behaves just
// like dragging from Finder. Multi-selection drags the whole selected set.
// (In-app placement still works via double-click and Auto-Fill.)
let _sourceDragItems = null;
redBox.addEventListener('dragstart', (e) => {
    const img = e.target.closest('.thumb-red');
    if (!img) return;
    const selected = Array.from(redBox.querySelectorAll('.thumb-red.selected'));
    const ids = (img.classList.contains('selected') && selected.length > 0)
        ? selected.map(el => el.id)
        : [img.id];
    const paths = ids.map(id => photoNativePath(id)).filter(Boolean);
    if (paths.length === 0) return;
    e.preventDefault(); // cancel the default thumbnail (proxy) drag
    require('electron').ipcRenderer.send('start-native-drag', paths);
});

// Photos tab (Tab 6) → Photoshop native drag-out (original file).
if (photosGrid) {
    photosGrid.addEventListener('dragstart', (e) => {
        const card = e.target.closest('.wp-card');
        if (!card) return;
        const id = card.dataset.photoId;
        const p = id ? photoNativePath(id) : null;
        if (!p) return;
        e.preventDefault();
        require('electron').ipcRenderer.send('start-native-drag', [p]);
    });
}

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
        pickFolder: () => fs.getFolder(),
        createToken: (folder) => fs.createPersistentToken(folder),
        showAlert: (msg) => app.showAlert(msg),
        saveState: () => saveStateToStorage(),
        setStatus: (msg) => setStatus(msg),
        toast: (msg, kind, opts) => toast(msg, kind, opts),
        notify: (msg, kind, opts) => notify(msg, kind, opts),
        applyGlobalRotation: (safeId, newRot) => applyGlobalRotation(safeId, newRot),
        renderGreenBox: () => renderGreenBox(),
        invalidateTab6: () => { if (tab6Rendered) tab6Rendered = false; },
    });

// Empty-state action buttons: a single delegated listener forwards a click on
// any `.empty-state__action[data-load]` to the real load button it names, so
// the empty states are actionable without duplicating the load handlers.
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.empty-state__action[data-load]');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.load);
    if (target) target.click();
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
    showAlert: (msg) => app.showAlert(msg),
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

const btnAutoThis = document.getElementById("btnAutoThis");
if (btnAutoThis) {
    btnAutoThis.addEventListener("click", async () => {
        const pageData = albumPages[currentPage];
        if (!pageData || pageData.photos.length === 0) return app.showAlert("Pull photos into Green Box first!");
        if (!pageData.template) return app.showAlert("Select a template from PSD Library!");
        try {
            setStatus(`Building Page ${currentPage}…`);
            const exportData = buildExportData(currentPage, currentPage);
            const pageEntry = exportData.pages[currentPage];
            if (!pageEntry) return app.showAlert("Could not resolve page data!");
            // Bake per-photo adjustments so the built PSD reflects the preview —
            // UNLESS J1 (editable adjustment layers) is on, which places
            // originals + adds clipped adjustment layers in the JSX instead.
            if (!_useAdjLayers) await bakeExportAdjustments(exportData);
            const payload = {
                templatePath: pageEntry.templatePath,
                pageName: String(currentPage).padStart(3, '0'),
                photos: pageEntry.photos,
                useAdjustmentLayers: _useAdjLayers
            };
            await require('electron').ipcRenderer.invoke('build-page', payload);
            notify(`Page ${currentPage} built successfully`, "success");
        } catch(err) { app.showAlert("Build Error: " + err.message); }
    });
}

// ==========================================
// --- 9. UI SLIDERS & RESIZERS ---
// ==========================================
const redSlider = document.getElementById("redSlider"); if (redSlider) redSlider.oninput = (e) => document.documentElement.style.setProperty('--red-thumb-size', e.target.value + "px");
const greenSlider = document.getElementById("greenSlider"); if (greenSlider) greenSlider.oninput = (e) => document.documentElement.style.setProperty('--green-thumb-size', e.target.value + "px");
const whiteSlider = document.getElementById("whiteSlider"); if (whiteSlider) whiteSlider.oninput = (e) => document.documentElement.style.setProperty('--white-thumb-size', e.target.value + "px");
const yellowSlider = document.getElementById("yellowSlider"); if (yellowSlider) yellowSlider.oninput = (e) => document.documentElement.style.setProperty('--yellow-thumb-size', e.target.value + "px");
const wallpaperSlider = document.getElementById("wallpaperSlider"); if (wallpaperSlider) wallpaperSlider.oninput = (e) => document.documentElement.style.setProperty('--wp-thumb-size', e.target.value + "px");
const pngSlider = document.getElementById("pngSlider"); if (pngSlider) pngSlider.oninput = (e) => document.documentElement.style.setProperty('--wp-thumb-size', e.target.value + "px");
const maskedSlider = document.getElementById("maskedSlider"); if (maskedSlider) maskedSlider.oninput = (e) => document.documentElement.style.setProperty('--wp-thumb-size', e.target.value + "px");
if (photosSlider) photosSlider.oninput = (e) => document.documentElement.style.setProperty('--wp-thumb-size', e.target.value + "px");
const storyboardSlider = document.getElementById("storyboardSlider");
if (storyboardSlider) storyboardSlider.oninput = (e) => document.documentElement.style.setProperty('--sb-thumb-size', e.target.value + "px");

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
        pickFolder: () => fs.getFolder(),
        createToken: (folder) => fs.createPersistentToken(folder),
        showAlert: (msg) => app.showAlert(msg),
        saveState: () => saveStateToStorage(),
        setStatus: (msg) => setStatus(msg),
        toast: (msg, kind, opts) => toast(msg, kind, opts),
        notify: (msg, kind, opts) => notify(msg, kind, opts),
        scheduleFilterUpdate: () => scheduleFilterUpdate(),
    });

// ==========================================
// --- 12. TAB 5: TOOLS (SWAP & THUMBS) ---
// ==========================================
const btnSwapImages = document.getElementById("btnSwapImages");
if (btnSwapImages) {
    btnSwapImages.addEventListener("click", async () => {
        try {
            setStatus('Swapping images…');
            const result = await require('electron').ipcRenderer.invoke('swap-images');
            if (result && result.startsWith('ALERT:')) {
                app.showAlert(result.replace('ALERT:', ''));
            } else if (result && result.startsWith('ERROR:')) {
                toast('Swap error: ' + result.replace('ERROR:', ''), 'error');
            } else {
                notify('Swap complete', 'success');
            }
        } catch(err) { toast('Swap error: ' + err.message, 'error'); }
    });
}

// J1 toggle: editable adjustment layers on render (experimental, persisted).
const chkAdjLayers = document.getElementById('chkAdjLayers');
if (chkAdjLayers) {
    chkAdjLayers.checked = _useAdjLayers;
    chkAdjLayers.addEventListener('change', () => {
        _useAdjLayers = chkAdjLayers.checked;
        try { localStorage.setItem('adt_adj_layers', _useAdjLayers ? '1' : '0'); } catch (_) {}
        toast(_useAdjLayers
            ? 'Renders will use editable adjustment layers (experimental)'
            : 'Renders will bake colour into pixels (exact preview match)', 'info');
    });
}

const btnGenerateThumbs = document.getElementById("btnGenerateThumbs");
if (btnGenerateThumbs) {
    const ipcT = require('electron').ipcRenderer;
    // Live progress from both lanes (fast sharp + RAW Photoshop).
    ipcT.on('thumbs-progress', (_e, p) => {
        const laneLabel = p.lane === 'raw' ? 'RAW' : 'fast';
        if (p.total > 0) setStatus(`Thumbnails (${laneLabel}) ${p.done}/${p.total}…`);
    });
    btnGenerateThumbs.addEventListener("click", async () => {
        try {
            const folder = await fs.getFolder();
            if (!folder) return;
            btnGenerateThumbs.disabled = true;
            setStatus('Generating thumbnails…');
            const res = await ipcT.invoke('thumbnails-generate', folder.nativePath);
            if (!res?.ok) {
                toast('Thumbnail error: ' + (res?.error || 'unknown'), 'error');
                return;
            }
            const secs = (res.durationMs / 1000).toFixed(1);
            const parts = [`${res.fastProcessed} fast`];
            if (res.rawTotal > 0) parts.push(`${res.rawProcessed} RAW`);
            if (res.failed) parts.push(`${res.failed} failed`);
            notify(`Thumbnails done · ${parts.join(' · ')} in ${secs}s`,
                res.failed ? 'warning' : 'success', { duration: 6000 });
            if (res.failed && res.errors?.length) {
                for (const msg of res.errors.slice(0, 3)) toast('Thumbnail: ' + msg, 'error', { duration: 8000 });
            }
        } catch(err) {
            toast("Thumbnail error: " + err.message, 'error');
        } finally {
            btnGenerateThumbs.disabled = false;
        }
    });
}

// ─── BATCH JPEG EXPORT ───────────────────────────────────────
// Pick a PSD folder, get JPEG-High-Res/ (quality 12) and JPEG-Low-Res/
// (quality 1) created as siblings. Live progress bar driven by an IPC
// stream from main; poll cadence is 500 ms which feels smooth on a
// 200-PSD album (~1 PSD per 1–3s on a typical Mac).
const btnJpegExport = document.getElementById('btnJpegExport');
const jpegProgressEl  = document.getElementById('jpegProgress');
const jpegProgressFill = document.getElementById('jpegProgressFill');
const jpegProgressText = document.getElementById('jpegProgressText');
const jpegStatusEl    = document.getElementById('jpegExportStatus');

if (btnJpegExport) {
    const ipc = require('electron').ipcRenderer;

    // Single delegated progress listener — registered once at module load
    // so the renderer never accumulates duplicate listeners across runs.
    ipc.on('jpeg-export-progress', (_e, p) => {
        if (!jpegProgressEl) return;
        jpegProgressEl.style.display = 'flex';
        const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
        if (jpegProgressFill) jpegProgressFill.style.width = pct + '%';
        if (jpegProgressText) {
            jpegProgressText.textContent = `${p.done}/${p.total}`;
        }
        if (jpegStatusEl) {
            jpegStatusEl.textContent = p.current ? `Now: ${p.current}` : '';
        }
    });

    btnJpegExport.addEventListener('click', async () => {
        try {
            const folder = await fs.getFolder();
            if (!folder) return;
            btnJpegExport.disabled = true;
            jpegProgressEl.style.display = 'flex';
            if (jpegProgressFill) jpegProgressFill.style.width = '0%';
            if (jpegProgressText) jpegProgressText.textContent = 'Starting…';
            if (jpegStatusEl) jpegStatusEl.textContent = 'Scanning PSDs…';
            setStatus('Exporting JPEGs from ' + folder.name + '…');

            const res = await ipc.invoke('jpeg-export', folder.nativePath);
            if (!res?.ok) {
                toast('JPEG export failed: ' + (res?.error || 'unknown'), 'error');
                if (jpegStatusEl) jpegStatusEl.textContent = 'Failed';
                return;
            }
            if (res.total === 0) {
                toast('No PSDs found in that folder', 'info');
                if (jpegStatusEl) jpegStatusEl.textContent = 'No PSDs found';
                jpegProgressEl.style.display = 'none';
                return;
            }
            // Final "100%" tick in case the last progress write didn't land.
            if (jpegProgressFill) jpegProgressFill.style.width = '100%';
            if (jpegProgressText) jpegProgressText.textContent = `${res.processed}/${res.total}`;
            const seconds = (res.durationMs / 1000).toFixed(1);
            const summary = `Exported ${res.processed} of ${res.total}` +
                (res.failed ? ` · ${res.failed} failed` : '') +
                ` in ${seconds}s`;
            if (jpegStatusEl) jpegStatusEl.textContent = summary;
            notify(summary, res.failed ? 'warning' : 'success', { duration: 6000 });

            // If any PSDs failed, surface the first few error messages so
            // the user knows what to look at instead of just a count.
            if (res.failed && res.errors?.length) {
                for (const msg of res.errors.slice(0, 3)) {
                    toast('JPEG export error: ' + msg, 'error', { duration: 8000 });
                }
            }

            // Open the parent folder in Finder so the new JPEG-High-Res /
            // JPEG-Low-Res folders are immediately visible.
            try {
                const parent = res.hiResFolder.replace(/\/JPEG-High-Res$/, '');
                await ipc.invoke('open-external', 'file://' + parent);
            } catch (_) {}
        } catch (e) {
            toast('JPEG export error: ' + e.message, 'error');
        } finally {
            btnJpegExport.disabled = false;
            // Hide the progress bar after a few seconds so it doesn't sit
            // there permanently after a successful run.
            setTimeout(() => {
                if (jpegProgressEl) jpegProgressEl.style.display = 'none';
            }, 5000);
        }
    });
}

// ─── PSD RESIZER (F1) ────────────────────────────────────────
// Pick a folder of PSDs → resize each to 12in tall @ 300ppi (proportional).
// Overwrite originals or save copies into a Resized/ subfolder. Live progress
// via the resize-psds-progress IPC stream, mirroring JPEG export.
const btnResizePsds = document.getElementById('btnResizePsds');
const resizeProgressEl = document.getElementById('resizeProgress');
const resizeProgressFill = document.getElementById('resizeProgressFill');
const resizeProgressText = document.getElementById('resizeProgressText');
const resizeStatusEl = document.getElementById('resizeStatus');
if (btnResizePsds) {
    const ipc = require('electron').ipcRenderer;
    ipc.on('resize-psds-progress', (_e, p) => {
        if (!resizeProgressEl) return;
        resizeProgressEl.style.display = 'flex';
        const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
        if (resizeProgressFill) resizeProgressFill.style.width = pct + '%';
        if (resizeProgressText) resizeProgressText.textContent = `${p.done}/${p.total}`;
        if (resizeStatusEl) resizeStatusEl.textContent = p.current ? `Now: ${p.current}` : '';
    });

    btnResizePsds.addEventListener('click', async () => {
        try {
            const folder = await fs.getFolder();
            if (!folder) return;
            const overwrite = !!document.getElementById('chkResizeOverwrite')?.checked;
            if (overwrite) {
                const ok = confirm('Overwrite the original PSDs in "' + folder.name + '"?\n\nThis replaces each file in place. Turn the toggle off to save copies into a Resized/ subfolder instead.');
                if (!ok) return;
            }
            btnResizePsds.disabled = true;
            resizeProgressEl.style.display = 'flex';
            if (resizeProgressFill) resizeProgressFill.style.width = '0%';
            if (resizeProgressText) resizeProgressText.textContent = 'Starting…';
            if (resizeStatusEl) resizeStatusEl.textContent = 'Scanning PSDs…';
            setStatus('Resizing PSDs in ' + folder.name + '…');

            const res = await ipc.invoke('resize-psds', folder.nativePath, overwrite ? 'overwrite' : 'copy');
            if (!res?.ok) {
                toast('PSD resize failed: ' + (res?.error || 'unknown'), 'error');
                if (resizeStatusEl) resizeStatusEl.textContent = 'Failed';
                return;
            }
            if (res.total === 0) {
                toast('No PSDs found in that folder', 'info');
                if (resizeStatusEl) resizeStatusEl.textContent = 'No PSDs found';
                resizeProgressEl.style.display = 'none';
                return;
            }
            if (resizeProgressFill) resizeProgressFill.style.width = '100%';
            if (resizeProgressText) resizeProgressText.textContent = `${res.processed}/${res.total}`;
            const seconds = (res.durationMs / 1000).toFixed(1);
            const dest = overwrite ? 'overwritten in place' : 'saved to Resized/';
            const summary = `Resized ${res.processed} of ${res.total} (${dest})` +
                (res.failed ? ` · ${res.failed} failed` : '') + ` in ${seconds}s`;
            if (resizeStatusEl) resizeStatusEl.textContent = summary;
            notify(summary, res.failed ? 'warning' : 'success', { duration: 6000 });
            if (res.failed && res.errors?.length) {
                for (const msg of res.errors.slice(0, 3)) toast('Resize error: ' + msg, 'error', { duration: 8000 });
            }
        } catch (e) {
            toast('PSD resize error: ' + e.message, 'error');
        } finally {
            btnResizePsds.disabled = false;
            setTimeout(() => { if (resizeProgressEl) resizeProgressEl.style.display = 'none'; }, 5000);
        }
    });
}

// ─── FLOATING TOOLS BAR LAUNCHER ─────────────────────────────
// Opens (or focuses) the thin frameless window that docks itself to
// Photoshop's bottom edge. Status pill on the card mirrors open/closed.
const btnOpenToolsBar = document.getElementById('btnOpenToolsBar');
const toolsBarStatusEl = document.getElementById('toolsBarStatus');

async function refreshToolsBarStatus() {
    if (!toolsBarStatusEl) return;
    try {
        const ipc = require('electron').ipcRenderer;
        const r = await ipc.invoke('tools-bar-status');
        const open = !!r?.open;
        toolsBarStatusEl.textContent = open ? 'Active' : 'Closed';
        toolsBarStatusEl.classList.toggle('tools-card__pill--active', open);
        toolsBarStatusEl.classList.toggle('tools-card__pill--neutral', !open);
        if (btnOpenToolsBar) {
            btnOpenToolsBar.textContent = open ? '🪄 TOOLS BAR ACTIVE' : '🪄 OPEN TOOLS BAR';
        }
    } catch (_) {}
}

if (btnOpenToolsBar) {
    btnOpenToolsBar.addEventListener('click', async () => {
        const ipc = require('electron').ipcRenderer;
        const r = await ipc.invoke('tools-bar-open');
        if (!r?.ok) {
            toast('Could not open Tools Bar: ' + (r?.error || 'unknown'), 'error');
            return;
        }
        notify('Tools Bar attached to Photoshop', 'success', { duration: 4000 });
        refreshToolsBarStatus();
        // Poll status briefly so the pill updates when PS minimizes/closes.
        setTimeout(refreshToolsBarStatus, 1500);
    });
}

// ── RENAMER ───────────────────────────────────────────────
// Opens the dedicated Renamer window (src/renamer.html). Standalone window
// so the drag-and-drop workspace has room to breathe.
const btnOpenRenamer = document.getElementById('btnOpenRenamer');
if (btnOpenRenamer) {
    btnOpenRenamer.addEventListener('click', async () => {
        const ipc = require('electron').ipcRenderer;
        try {
            const r = await ipc.invoke('renamer-open');
            if (!r?.ok) {
                toast('Could not open Renamer: ' + (r?.error || 'unknown'), 'error');
            }
        } catch (e) {
            toast('Could not open Renamer: ' + (e.message || e), 'error');
        }
    });
}


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
    pickFolder: () => fs.getFolder(),
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
        pickFolder: () => fs.getFolder(),
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
async function refreshPluginsView() {
    const ipc = require('electron').ipcRenderer;
    const res = await ipc.invoke('plugins-list');
    const view = document.getElementById('pluginsView');
    if (!view) return;
    if (!res?.ok) { view.innerHTML = `<span class="u-text-secondary">Plugins unavailable</span>`; return; }
    const list = res.plugins;
    if (list.length === 0) {
        view.innerHTML = `<div style="padding:8px 0;color:var(--txt-secondary);">
            No plugins installed. Drop a plugin folder into <code>${res.dir}</code> and click Refresh.
        </div>`;
        return;
    }
    view.innerHTML = `
        <table style="width:100%; border-collapse: collapse; font-size:12px;">
            <thead><tr style="text-align:left; border-bottom:1px solid var(--border-main);">
                <th style="padding:6px;">Plugin</th>
                <th style="padding:6px;">Hooks</th>
                <th style="padding:6px;">Source</th>
                <th style="padding:6px;">Status</th>
                <th style="padding:6px;"></th>
            </tr></thead>
            <tbody>
                ${list.map(p => `
                    <tr style="border-bottom:1px solid var(--border-main);">
                        <td style="padding:6px;"><strong>${p.id}</strong> <span class="u-text-secondary">v${p.manifest?.version || '?'}</span></td>
                        <td style="padding:6px;">${(p.manifest?.hooks || []).join(', ') || '—'}</td>
                        <td style="padding:6px;">${p.builtin ? 'built-in' : 'user'}</td>
                        <td style="padding:6px;">${p.error
                            ? `<span style="color:var(--btn-red-bg)">error: ${p.error}</span>`
                            : (p.disabled ? '<span class="u-text-secondary">disabled</span>' : '<span style="color:#4caf50;">active</span>')}</td>
                        <td style="padding:6px;">${p.builtin
                            ? '<span class="u-text-secondary">built-in</span>'
                            : `<button class="btn btn--ghost" data-plugin="${p.id}" data-enable="${p.disabled ? 'true' : 'false'}">${p.disabled ? 'Enable' : 'Disable'}</button>`}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
    view.querySelectorAll('button[data-plugin]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.plugin;
            const enable = btn.dataset.enable === 'true';
            const r = await ipc.invoke('plugins-set-enabled', id, enable);
            if (!r?.ok) { toast('Plugin toggle failed: ' + (r?.error || ''), 'error'); return; }
            refreshPluginsView();
        });
    });
}

document.getElementById('btnPluginsRefresh')?.addEventListener('click', async () => {
    const ipc = require('electron').ipcRenderer;
    await ipc.invoke('plugins-reload');
    refreshPluginsView();
});

document.getElementById('btnOpenPluginsFolder')?.addEventListener('click', async () => {
    const ipc = require('electron').ipcRenderer;
    const res = await ipc.invoke('plugins-list');
    if (res?.ok) await ipc.invoke('open-external', 'file://' + res.dir);
});

// First-paint of library + plugins panels when the user first visits Tab 5.
const _origToolsTabBtn = document.querySelector('.tab-btn[data-target="tab-tools"]');
if (_origToolsTabBtn) {
    let _toolsPainted = false;
    _origToolsTabBtn.addEventListener('click', () => {
        // Status pills should always reflect current state, even after the
        // first paint, so refresh tools-bar status on every visit.
        refreshToolsBarStatus();
        if (_toolsPainted) return;
        _toolsPainted = true;
        // Defer to next tick so the tab is visible first.
        setTimeout(() => { refreshLibraryView(); refreshPluginsView(); }, 50);
    });
}

// ==========================================
// --- 13. EXPORT & OUTPUT (TAB 1 FALLBACK) ---
// ==========================================
const btnOutput = document.getElementById("btnOutput");
if (btnOutput) {
    btnOutput.addEventListener("click", async () => {
        const folder = await fs.getFolder(); if (!folder) return;
        outputFolder = folder; projectData.outputToken = await fs.createPersistentToken(folder); saveStateToStorage();
        notify(`Output folder set: ${folder.name}`, 'success');
        const ftxt = document.getElementById("finalOutputText"); if(ftxt) ftxt.innerText = folder.name;
    });
}

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

const _RENDER_HASH_KEY = 'adt_render_hashes';
// renderHashes lives in the state store (see the exposeOnGlobal block up
// top); seed it from localStorage at boot so cache hits survive restarts.
renderHashes = (() => {
    try { return JSON.parse(localStorage.getItem(_RENDER_HASH_KEY) || '{}'); }
    catch (_) { return {}; }
})();
function _saveRenderHashes() {
    try { localStorage.setItem(_RENDER_HASH_KEY, JSON.stringify(renderHashes)); }
    catch (_) {}
}
// _hashPage moved to src/renderer_pure.js (required at top).

// renderQueue / renderActive / renderStats live in the state store (see the
// exposeOnGlobal block up top).

function _updateRenderBadge() {
    let badge = document.getElementById('renderBadge');
    if (!renderQueue.length && !renderActive) {
        if (badge) badge.remove();
        return;
    }
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'renderBadge';
        badge.className = 'render-badge';
        const exportTb = document.querySelector('#tab-export .export-toolbar');
        if (exportTb) exportTb.appendChild(badge);
        else document.body.appendChild(badge);
    }
    const remaining = renderQueue.length + (renderActive ? 1 : 0);
    const pct = renderStats.total > 0
        ? Math.round((renderStats.done + renderStats.skipped) / renderStats.total * 100)
        : 0;
    badge.innerHTML = `
        <div class="render-badge__bar"><div class="render-badge__fill" style="width:${pct}%"></div></div>
        <div class="render-badge__text">
            ${renderStats.done + renderStats.skipped} / ${renderStats.total}
            ${renderStats.skipped ? `· <span class="u-text-secondary">${renderStats.skipped} cached</span>` : ''}
            ${renderStats.failed ? `· <span style="color:var(--btn-red-bg)">${renderStats.failed} failed</span>` : ''}
            <button class="render-badge__cancel" title="Cancel queue">×</button>
        </div>`;
    badge.querySelector('.render-badge__cancel').onclick = () => {
        renderStats.cancelled = true;
        renderQueue.length = 0;
    };
}

// The render worker + queueRender live in src/features/render_queue.js
// (Phase 2 split): chunking, cache partition, IPC dispatch, and stats via
// explicit store access. The DOM badge, status/notify/toast, hash
// persistence, and the adjustment bake stay here and are injected.
const { queueRender } = require('./features/render_queue').createRenderQueue(store, {
    invoke: (channel, payload) => require('electron').ipcRenderer.invoke(channel, payload),
    updateBadge: () => _updateRenderBadge(),
    setStatus: (msg) => setStatus(msg),
    notify: (msg, kind, opts) => notify(msg, kind, opts),
    toast: (msg, kind, opts) => toast(msg, kind, opts),
    persistHashes: () => _saveRenderHashes(),
    bakeAdjustments: (exportData) => bakeExportAdjustments(exportData),
    useAdjLayers: () => _useAdjLayers,
});

const btnExport = document.getElementById("btnExport");
if (btnExport) {
    btnExport.addEventListener("click", () => {
        if (!outputFolder) return app.showAlert("Please select an Output Folder first!");
        const start = parseInt(document.getElementById("exportStart").value);
        const end = parseInt(document.getElementById("exportEnd").value);
        if (isNaN(start) || isNaN(end) || start > end) return app.showAlert("Invalid Start/End pages.");
        const exportData = buildExportData(start, end);
        if (Object.keys(exportData.pages).length === 0) return app.showAlert("No complete pages in range!");
        queueRender(exportData);
    });
}

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

const btnSetFinalOutput = document.getElementById("btnSetFinalOutput");
if (btnSetFinalOutput) {
    btnSetFinalOutput.addEventListener("click", async () => {
        const folder = await fs.getFolder(); if (!folder) return;
        outputFolder = folder;
        projectData.outputToken = await fs.createPersistentToken(folder);
        saveStateToStorage();
        document.getElementById("finalOutputText").innerText = folder.name;
    });
}

// (buildExportData defined once above — duplicate removed)

const btnRenderFinalAlbum = document.getElementById("btnRenderFinalAlbum");
if (btnRenderFinalAlbum) {
    btnRenderFinalAlbum.addEventListener("click", () => {
        if (!outputFolder) return app.showAlert("Please SET OUTPUT FOLDER first!");
        const exportData = buildExportData(1, totalActivePages);
        if (Object.keys(exportData.pages).length === 0) return app.showAlert("Storyboard is empty!");
        queueRender(exportData);
    });
}

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
    getEntryForToken: (t) => fs.getEntryForPersistentToken(t),
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
        tab6Rendered = false;  // ⚡ Force Tab 6 rebuild with fresh data on next visit
        updatePageDropdowns(); changePage(1);
    },
    persistHashes: () => _saveRenderHashes(),
    setStatus: (msg) => setStatus(msg),
    notify: (msg, kind, opts) => notify(msg, kind, opts),
    toast: (msg, kind, opts) => toast(msg, kind, opts),
});

// New Project: keep the reusable library (templates/wallpapers/assets/output +
// settings); clear the project-specific source photos, Photos tab, and album
// layout; then save to a freshly named/created file. Confirmed first so it's
// never a silent data loss.
async function newProject() {
    const ok = confirm(
        'Start a new project?\n\n' +
        'Your loaded source photos, the Photos tab, and the current album layout will be cleared. ' +
        'Loaded templates, wallpapers, other assets, the output folder, and settings stay. ' +
        'Save your current project first if you need it.'
    );
    if (!ok) return;
    const ipc = require('electron').ipcRenderer;
    const target = await ipc.invoke('project-pick-save', 'New Album Project');
    if (!target) return;
    try {
        // Clear source images + Photos tab.
        photoCache = {};
        activeImageFolders.clear();
        projectData.imageTokens = [];
        if (projectData.highResTokens) projectData.highResTokens = [];
        redBox.innerHTML = `<div class="empty-state">
            <div class="empty-state__icon">🖼️</div>
            <div class="empty-state__title">No photos loaded</div>
            <div class="empty-state__hint">Load a folder of photos to build your source pool, then drag or auto-fill them onto pages.</div>
            <button class="btn btn--primary btn--sm empty-state__action" data-load="btnLoadPhotos">📂 Load photos</button>
        </div>`;
        if (photosGrid) photosGrid.innerHTML = "";
        tab6Rendered = false;
        const rfp = document.getElementById('redFolderPanel'); if (rfp) rfp.innerHTML = getPanelHeaderHTML('images');
        const pfp = document.getElementById('photosFolderPanel'); if (pfp) pfp.innerHTML = getPanelHeaderHTML('images');
        // Reset the album to a single blank page + per-photo edit maps.
        albumPages = { 1: { photos: [], template: null } };
        totalActivePages = 1; currentPage = 1;
        Object.keys(photoPageMap).forEach(k => delete photoPageMap[k]);
        projectData.imageRotations = {};
        projectData.imageAdjustments = {};
        projectData.imagePlacements = {};
        try { renderHashes = {}; _saveRenderHashes(); } catch (_) {}
        _clearProofs();
        syncViewToState();
        updatePageDropdowns();
        renderGreenBox();
        changePage(1);
    } catch (e) {
        console.error('New Project clear failed:', e);
        toast('New Project: clearing failed — ' + e.message, 'error');
        return;
    }
    store.set('currentProjectPath', target);
    await saveProject(false);
}

const btnSaveWorkspace = document.getElementById("btnSaveWorkspace");
if (btnSaveWorkspace) {
    btnSaveWorkspace.addEventListener("click", () => { saveProject(false); });
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
        if (!e.target.closest('.save-split') && !e.target.closest('#saveMenu')) closeSaveMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSaveMenu(); });
    window.addEventListener('resize', () => { if (saveMenu.classList.contains('open')) positionSaveMenu(); });
    const btnSaveAs = document.getElementById("btnSaveAs");
    if (btnSaveAs) btnSaveAs.addEventListener("click", () => { closeSaveMenu(); saveProject(true); });
    const btnNewProject = document.getElementById("btnNewProject");
    if (btnNewProject) btnNewProject.addEventListener("click", () => { closeSaveMenu(); newProject(); });
}

// restoreWorkspace lives in src/features/project_io.js (wired above).

const btnLoadWorkspace = document.getElementById("btnLoadWorkspace");
if (btnLoadWorkspace) {
    btnLoadWorkspace.addEventListener("click", () => { loadProjectFromDisk(); });
}

window.addEventListener("DOMContentLoaded", () => { bootRestore(); });

// ─── KEYBOARD SHORTCUTS ────────────────────────────────────────
// Single delegated handler. Ignores keystrokes when the user is editing
// a form field. Modifier-aware: Cmd/Ctrl keys for power actions, plain
// keys (J/K/?) for navigation. Designed to be discoverable through "?".
const _shortcutHelp = [
    ['J  /  ←',          'Previous page'],
    ['K  /  →',          'Next page'],
    ['1 — 5',            'Pick template 1–5 from filtered'],
    ['Space',            'Refresh storyboard (Tab 7)'],
    ['Cmd/Ctrl + Z',     'Undo'],
    ['Cmd/Ctrl + Shift + Z',     'Redo'],
    ['Cmd/Ctrl + S',     'Save workspace'],
    ['Cmd/Ctrl + O',     'Load workspace'],
    ['Cmd/Ctrl + E',     'Export current page'],
    ['Cmd/Ctrl + Shift + E', 'Render full album'],
    ['Tab 1 — 7',        'Switch to tab N (Cmd/Ctrl + 1..7)'],
    ['Esc',              'Clear storyboard selection / close dialogs'],
    ['?',                'Show this help'],
];

function showShortcutHelp() {
    let dlg = document.getElementById('shortcutHelpDialog');
    if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.id = 'shortcutHelpDialog';
        dlg.innerHTML = `
            <div class="dialog-body">
                <h3 class="dialog-title">Keyboard Shortcuts</h3>
                <div class="dialog-list" style="max-height: 400px;">
                    ${_shortcutHelp.map(([k, v]) =>
                        `<div style="display:flex;justify-content:space-between;gap:var(--space-7);padding:var(--space-1) 0;">
                            <kbd style="font-family:'JetBrains Mono',monospace;color:var(--accent);">${k}</kbd>
                            <span class="u-text-secondary">${v}</span>
                        </div>`
                    ).join('')}
                </div>
                <div class="dialog-actions">
                    <button class="btn btn--ghost" onclick="this.closest('dialog').close()">Close</button>
                </div>
            </div>`;
        document.body.appendChild(dlg);
    }
    dlg.showModal();
}

// _isEditingTarget moved to src/renderer_pure.js (required at top).

document.addEventListener('keydown', (e) => {
    // Don't hijack typing.
    if (_isEditingTarget(e.target)) {
        // Allow undo/redo even when an input is focused.
        if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            if (e.shiftKey) redo(); else undo();
        }
        return;
    }

    const cmd = e.metaKey || e.ctrlKey;

    // Undo / Redo
    if (cmd && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
    }

    // Tab switching: Cmd/Ctrl + 1..7
    if (cmd && /^[1-7]$/.test(e.key)) {
        e.preventDefault();
        const targets = ['tab-album','tab-wallpapers','tab-png','tab-masked','tab-tools','tab-photos','tab-export'];
        const btn = document.querySelector(`.tab-btn[data-target="${targets[parseInt(e.key) - 1]}"]`);
        if (btn) btn.click();
        return;
    }

    // Save / Load workspace
    if (cmd && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        const b = document.getElementById('btnSaveWorkspace'); if (b) b.click();
        return;
    }
    if (cmd && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        const b = document.getElementById('btnLoadWorkspace'); if (b) b.click();
        return;
    }

    // Export current page / full album
    if (cmd && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        if (e.shiftKey) {
            const b = document.getElementById('btnRenderFinalAlbum'); if (b) b.click();
        } else {
            const b = document.getElementById('btnAutoThis'); if (b) b.click();
        }
        return;
    }

    // Page nav: J/← prev, K/→ next
    if (e.key === 'j' || e.key === 'ArrowLeft') {
        e.preventDefault();
        if (typeof changePage === 'function') changePage(currentPage - 1);
        return;
    }
    if (e.key === 'k' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (typeof changePage === 'function') changePage(currentPage + 1);
        return;
    }

    // Template hotpicks: 1..5 selects from current filteredTemplates
    if (/^[1-5]$/.test(e.key)) {
        const idx = parseInt(e.key) - 1;
        if (filteredTemplates && filteredTemplates[idx]) {
            e.preventDefault();
            setPreview(idx, true);
        }
        return;
    }

    // Space refreshes storyboard if Tab 7 is active
    if (e.key === ' ' || e.code === 'Space') {
        const exportPane = document.getElementById('tab-export');
        if (exportPane && exportPane.classList.contains('active')) {
            e.preventDefault();
            renderStoryboard();
        }
        return;
    }

    // Esc closes any open dialog
    if (e.key === 'Escape') {
        document.querySelectorAll('dialog[open]').forEach(d => d.close());
        return;
    }

    // ? help
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        showShortcutHelp();
    }
});


// ── E2E test hook (guarded) ──────────────────────────────────────────────────
// Present ONLY when the (non-packaged) main process launched us with --e2e; it
// never exists in a shipped build. Gives the Playwright suite a dialog-free way
// to load a project and to inspect + drive the real undo/redo history system,
// so the stateful core is covered before the Phase 2 refactor touches it.
if (process.argv.includes('--e2e')) {
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
    };
}
