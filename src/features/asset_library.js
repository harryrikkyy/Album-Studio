// @ts-check
// features/asset_library.js — the wallpaper / PNG-frame / masked-frame
// libraries (Tabs 2–3), extracted from main.js (Phase 2 split).
//
// Each asset type follows the same shape: a process*Folder builder that
// populates its cache slice + card grid (DocumentFragment batch insert) and
// adds a folder-rail row whose checkbox toggles that folder's cards, a
// place* action that ships the asset to Photoshop over IPC (double-click),
// and a Load button that picks a folder, persists its token, and processes
// it.
//
// This is a DOM-owning module (it builds the grids and rail rows directly);
// what's injected is the cross-cutting glue still living in main.js: the
// folder-row factory, the HR-file resolver, folder pickers/tokens, debounced
// persistence, and status/toast/notify.

/**
 * @typedef {import('../state/store').Store} Store
 */

const { getDisplayName } = require('../renderer_pure');

/**
 * Wire the asset libraries to the store and bind their Load buttons.
 *
 * @param {Store} store
 * @param {object} deps
 * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke  IPC dispatch
 * @param {(displayName: string, folderId: string, token: unknown, count?: number) => { row: HTMLElement, checkbox: HTMLInputElement }} deps.createFolderRow
 * @param {(cacheData: any) => Promise<{ file: any, isHr: boolean }>} deps.getTrueFile
 * @param {() => Promise<any>} deps.pickFolder  fs.getFolder dialog (null on cancel)
 * @param {(folder: any) => Promise<unknown>} deps.createToken
 * @param {(msg: string) => void} deps.showAlert
 * @param {() => void} deps.saveState  debounced workspace autosave
 * @param {(msg: string) => void} deps.setStatus
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.notify
 */
function createAssetLibrary(store, deps) {
    const wallpaperGrid = /** @type {HTMLElement} */ (document.getElementById("wallpaperGrid"));
    const pngGrid = /** @type {HTMLElement} */ (document.getElementById("pngGrid"));
    const maskedGrid = /** @type {HTMLElement} */ (document.getElementById("maskedGrid"));

    // ── Wallpapers (Tab 2) ──────────────────────────────────────────────

    /** @param {string} wallpaperId */
    async function placeWallpaper(wallpaperId) {
        const wpData = /** @type {any} */ (store.get('wallpaperCache'))[wallpaperId]; if (!wpData) return;
        const fetchResult = await deps.getTrueFile(wpData);
        try {
            deps.setStatus('Placing wallpaper…');
            const filePath = fetchResult.file.nativePath;
            const result = await deps.invoke('place-wallpaper', filePath, fetchResult.isHr);
            if (result && (result.startsWith('Error') || result.startsWith('Failed'))) {
                deps.toast('Wallpaper error: ' + result, 'error');
            } else {
                deps.notify('Wallpaper placed', 'success');
            }
        } catch (err) { deps.toast('Wallpaper error: ' + (err instanceof Error ? err.message : String(err)), 'error'); }
    }

    // ⚡ FIX: Uses DocumentFragment for wallpaper card batch insert
    /**
     * @param {any} uiFolder
     * @param {any} hrFolder
     * @param {string} displayName
     * @param {unknown} token
     * @param {string | null} [existingFolderId]
     */
    async function processWallpaperFolder(uiFolder, hrFolder, displayName, token, existingFolderId = null) {
        if (wallpaperGrid.querySelector('.placeholder-text, .empty-state')) wallpaperGrid.innerHTML = "";
        const folderId = existingFolderId || ("wpFld_" + displayName.replace(/[^a-zA-Z0-9]/g, '_') + Date.now());
        store.get('activeWallpaperFolders').add(folderId);
        if (existingFolderId) Array.from(wallpaperGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());

        const entries = await uiFolder.getEntries();
        const imgs = entries.filter((/** @type {any} */ e) => e.isFile && e.name.match(/\.(jpg|jpeg|png|tif)$/i));
        imgs.sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        const frag = document.createDocumentFragment();
        imgs.forEach((/** @type {any} */ file) => {
            const baseName = file.name.replace(/\.[^/.]+$/, "").toLowerCase();
            const safeId = "wp_" + (displayName + "_" + file.name).replace(/[^a-zA-Z0-9]/g, '_');
            /** @type {any} */ (store.get('wallpaperCache'))[safeId] = { proxy: file, hrFolder: hrFolder, baseName: baseName };
            const card = document.createElement("div"); card.className = "wp-card"; card.dataset.folderId = folderId;
            const img = document.createElement("img"); img.src = file.url;
            const label = document.createElement("div"); label.className = "label"; label.innerText = file.name.substring(0, 15);
            card.appendChild(img); card.appendChild(label);
            card.ondblclick = () => placeWallpaper(safeId);
            frag.appendChild(card);
        });
        wallpaperGrid.appendChild(frag); // ⚡ Single insertion

        if (!existingFolderId) {
            const pnl = /** @type {HTMLElement} */ (document.getElementById("wpFolderPanel"));
            const { row, checkbox } = deps.createFolderRow(displayName, folderId, token);
            checkbox.onchange = (e) => {
                const checked = /** @type {HTMLInputElement} */ (e.target).checked;
                if (checked) store.get('activeWallpaperFolders').add(folderId); else store.get('activeWallpaperFolders').delete(folderId);
                Array.from(wallpaperGrid.querySelectorAll('.wp-card')).forEach(c => {
                    if (/** @type {HTMLElement} */ (c).dataset.folderId === folderId) /** @type {HTMLElement} */ (c).style.display = checked ? "inline-block" : "none";
                });
            };
            pnl.appendChild(row);
        }
    }

    const btnLoadWallpapers = document.getElementById("btnLoadWallpapers");
    if (btnLoadWallpapers) {
        btnLoadWallpapers.addEventListener("click", async () => {
            const folder = await deps.pickFolder(); if (!folder) return;
            if (folder.name.toLowerCase() === "_thumbnails") {
                return deps.showAlert("🛑 UXP SANDBOX BLOCK!\n\nYou selected the '_Thumbnails' folder directly. Please select the MASTER FOLDER instead.");
            }
            deps.setStatus("Scanning Wallpapers…");
            await new Promise(resolve => setTimeout(resolve, 50));
            let uiFolder = folder, hrFolder = null;
            const displayName = folder.name;
            let wpThumb = null;
            try {
                const tf = await folder.getEntry("_Thumbnails");
                if (tf && tf.isFolder) wpThumb = tf;
            } catch (e) { /* no _Thumbnails yet */ }
            if (!wpThumb) {
                try {
                    deps.setStatus("First load — generating wallpaper thumbnails (faster next time)…");
                    const genRes = await deps.invoke('thumbnails-generate', folder.nativePath);
                    if (genRes && genRes.ok && genRes.processed > 0) {
                        try { const tf2 = await folder.getEntry("_Thumbnails"); if (tf2 && tf2.isFolder) wpThumb = tf2; } catch (e2) {}
                    }
                } catch (genErr) { console.error('Auto wallpaper thumbnail generation failed:', genErr); }
            }
            if (wpThumb) { uiFolder = wpThumb; hrFolder = folder; deps.toast('Smart Wallpaper Load active — high-res master folder linked', 'info'); }
            const token = await deps.createToken(folder);
            const projectData = store.get('projectData');
            if (!(projectData.wallpaperTokens || []).includes(token)) /** @type {unknown[]} */ (projectData.wallpaperTokens).push(token);
            await processWallpaperFolder(uiFolder, hrFolder, displayName, token);
            deps.saveState();
        });
    }

    // ── PNG frames + masked frames (Tab 3) ──────────────────────────────

    /** @param {string} pngId */
    async function placePngFrame(pngId) {
        const fileObj = /** @type {any} */ (store.get('pngCache'))[pngId]; if (!fileObj) return;
        try {
            deps.setStatus('Placing PNG frame…');
            const layerName = fileObj.name.replace(/\.[^/.]+$/, '');
            const result = await deps.invoke('place-png-frame', fileObj.nativePath, layerName);
            if (result && result.startsWith('Failed')) deps.toast('PNG error: ' + result, 'error');
            else deps.notify('PNG frame placed', 'success');
        } catch (err) { deps.toast('PNG placement error: ' + (err instanceof Error ? err.message : String(err)), 'error'); }
    }

    // ⚡ FIX: DocumentFragment for PNG cards
    /**
     * @param {any} folder
     * @param {unknown} token
     * @param {string | null} [existingFolderId]
     */
    async function processPngFolder(folder, token, existingFolderId = null) {
        if (pngGrid.querySelector('.placeholder-text, .empty-state')) pngGrid.innerHTML = "";
        const displayName = getDisplayName(folder);
        const folderId = existingFolderId || ("pngFld_" + displayName.replace(/[^a-zA-Z0-9]/g, '_') + Date.now());
        store.get('activePngFolders').add(folderId);
        if (existingFolderId) Array.from(pngGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());

        const entries = await folder.getEntries();
        const imgs = entries.filter((/** @type {any} */ e) => e.isFile && e.name.match(/\.(png)$/i));
        imgs.sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        const frag = document.createDocumentFragment();
        imgs.forEach((/** @type {any} */ file) => {
            const safeId = "png_" + (displayName + "_" + file.name).replace(/[^a-zA-Z0-9]/g, '_');
            /** @type {any} */ (store.get('pngCache'))[safeId] = file;
            const card = document.createElement("div"); card.className = "wp-card"; card.dataset.folderId = folderId;
            const img = document.createElement("img"); img.src = file.url;
            const label = document.createElement("div"); label.className = "label"; label.innerText = file.name.substring(0, 15);
            card.appendChild(img); card.appendChild(label);
            card.ondblclick = () => placePngFrame(safeId);
            frag.appendChild(card);
        });
        pngGrid.appendChild(frag); // ⚡

        if (!existingFolderId) {
            const pnl = /** @type {HTMLElement} */ (document.getElementById("pngFolderPanel"));
            const { row, checkbox } = deps.createFolderRow(displayName, folderId, token);
            checkbox.onchange = (e) => {
                const checked = /** @type {HTMLInputElement} */ (e.target).checked;
                if (checked) store.get('activePngFolders').add(folderId); else store.get('activePngFolders').delete(folderId);
                Array.from(pngGrid.querySelectorAll('.wp-card')).forEach(c => {
                    if (/** @type {HTMLElement} */ (c).dataset.folderId === folderId) /** @type {HTMLElement} */ (c).style.display = checked ? "inline-block" : "none";
                });
            };
            pnl.appendChild(row);
        }
    }

    const btnLoadPng = document.getElementById("btnLoadPng");
    if (btnLoadPng) {
        btnLoadPng.addEventListener("click", async () => {
            const folder = await deps.pickFolder(); if (!folder) return;
            const token = await deps.createToken(folder);
            const projectData = store.get('projectData');
            if (!(projectData.pngTokens || []).includes(token)) /** @type {unknown[]} */ (projectData.pngTokens).push(token);
            await processPngFolder(folder, token);
            deps.saveState();
        });
    }

    /** @param {string} maskId */
    async function placeMaskedFrame(maskId) {
        const fileObj = /** @type {any} */ (store.get('maskedCache'))[maskId]; if (!fileObj) return;
        try {
            deps.setStatus('Placing masked frame…');
            const layerName = 'MaskBase_' + fileObj.name.replace(/\.[^/.]+$/, '');
            const isJpg = !!fileObj.name.match(/\.(jpg|jpeg)$/i);
            const result = await deps.invoke('place-masked-frame', fileObj.nativePath, layerName, isJpg);
            if (result && result.startsWith('Failed')) deps.toast('Mask error: ' + result, 'error');
            else deps.notify('Masked frame placed', 'success');
        } catch (err) { deps.toast('Mask generation error: ' + (err instanceof Error ? err.message : String(err)), 'error'); }
    }

    // ⚡ FIX: DocumentFragment for masked cards
    /**
     * @param {any} folder
     * @param {unknown} token
     * @param {string | null} [existingFolderId]
     */
    async function processMaskedFolder(folder, token, existingFolderId = null) {
        if (maskedGrid.querySelector('.placeholder-text, .empty-state')) maskedGrid.innerHTML = "";
        const displayName = getDisplayName(folder);
        const folderId = existingFolderId || ("maskFld_" + displayName.replace(/[^a-zA-Z0-9]/g, '_') + Date.now());
        store.get('activeMaskedFolders').add(folderId);
        if (existingFolderId) Array.from(maskedGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());

        const entries = await folder.getEntries();
        const imgs = entries.filter((/** @type {any} */ e) => e.isFile && e.name.match(/\.(jpg|jpeg|png)$/i));
        imgs.sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        const frag = document.createDocumentFragment();
        imgs.forEach((/** @type {any} */ file) => {
            const safeId = "mask_" + (displayName + "_" + file.name).replace(/[^a-zA-Z0-9]/g, '_');
            /** @type {any} */ (store.get('maskedCache'))[safeId] = file;
            const card = document.createElement("div"); card.className = "wp-card"; card.dataset.folderId = folderId;
            const img = document.createElement("img"); img.src = file.url;
            const label = document.createElement("div"); label.className = "label"; label.innerText = file.name.substring(0, 15);
            card.appendChild(img); card.appendChild(label);
            card.ondblclick = () => placeMaskedFrame(safeId);
            frag.appendChild(card);
        });
        maskedGrid.appendChild(frag); // ⚡

        if (!existingFolderId) {
            const pnl = /** @type {HTMLElement} */ (document.getElementById("maskedFolderPanel"));
            const { row, checkbox } = deps.createFolderRow(displayName, folderId, token);
            checkbox.onchange = (e) => {
                const checked = /** @type {HTMLInputElement} */ (e.target).checked;
                if (checked) store.get('activeMaskedFolders').add(folderId); else store.get('activeMaskedFolders').delete(folderId);
                Array.from(maskedGrid.querySelectorAll('.wp-card')).forEach(c => {
                    if (/** @type {HTMLElement} */ (c).dataset.folderId === folderId) /** @type {HTMLElement} */ (c).style.display = checked ? "inline-block" : "none";
                });
            };
            pnl.appendChild(row);
        }
    }

    const btnLoadMasked = document.getElementById("btnLoadMasked");
    if (btnLoadMasked) {
        btnLoadMasked.addEventListener("click", async () => {
            const folder = await deps.pickFolder(); if (!folder) return;
            const token = await deps.createToken(folder);
            const projectData = store.get('projectData');
            if (!(projectData.maskTokens || []).includes(token)) /** @type {unknown[]} */ (projectData.maskTokens).push(token);
            await processMaskedFolder(folder, token);
            deps.saveState();
        });
    }

    return { processWallpaperFolder, processPngFolder, processMaskedFolder };
}

module.exports = { createAssetLibrary };
