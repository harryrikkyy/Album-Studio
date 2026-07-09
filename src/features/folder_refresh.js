// @ts-check
// features/folder_refresh.js — the folder rail engine, extracted from main.js
// (Phase 2 split): the shared per-folder row builder, global photo rotation,
// the remove-folders dialog, and the checked-folder refresh engine that
// re-scans sources and rebuilds each tab's grid.
//
// This is a DOM-owning module (folder rows, the #removeFolderDialog, and the
// delegated .btn-remove-fld / .btn-reload-fld clicks). The five
// processXxxFolder engines stay in photo_library / asset_library and are
// injected, as are the cross-cutting seams (mutate, filter updates, autosave).

/**
 * @typedef {import('../state/store').Store} Store
 */

const { escapeHtml, getDisplayName } = require('../renderer_pure');

/** Panel element id for each folder-rail type. */
const PANEL_IDS = {
    images: 'redFolderPanel',
    templates: 'whiteFolderPanel',
    wallpapers: 'wpFolderPanel',
    pngs: 'pngFolderPanel',
    masks: 'maskedFolderPanel',
};

/**
 * Wire the folder rails: row builder, rotation, remove dialog, refresh engine.
 *
 * @param {Store} store
 * @param {object} deps
 * @param {(label: string, fn: () => void) => void} deps.mutate
 * @param {() => boolean} deps.isTab6Rendered
 * @param {(photoId: string) => Set<number> | undefined} deps.getPhotoPages  photoPageMap reverse lookup
 * @param {() => void} deps.renderGreenBox
 * @param {() => void} deps.scheduleFilterUpdate
 * @param {() => void} deps.saveState  debounced workspace autosave
 * @param {() => void} deps.syncViewToState
 * @param {(token: string) => Promise<any>} deps.getEntryForToken  fs.getEntryForPersistentToken
 * @param {(parentFolder: any, mapObj: Record<string, any>) => Promise<void>} deps.buildHighResMap
 * @param {(folder: any, hrFolder: any, token: unknown, existingFolderId?: string | null) => Promise<void>} deps.processImageFolder
 * @param {(folder: any, hrFolder: any, displayName: string, token: unknown, existingFolderId?: string | null) => Promise<void>} deps.processWallpaperFolder
 * @param {(folder: any, token: unknown, existingFolderId?: string | null) => Promise<void>} deps.processTemplateFolder
 * @param {(folder: any, token: unknown, existingFolderId?: string | null) => Promise<void>} deps.processPngFolder
 * @param {(folder: any, token: unknown, existingFolderId?: string | null) => Promise<void>} deps.processMaskedFolder
 * @param {(msg: string) => void} deps.setStatus
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.notify
 */
function createFolderRefresh(store, deps) {
    // ⚡ Single source of truth for the per-folder row that lives inside a
    // .folder-rail__panel. The 5 processXxxFolder() functions used to inline
    // 4–5 lines of nearly-identical HTML each — this returns the fully-built
    // element so they all share the same DOM contract.
    /**
     * @param {string} displayName
     * @param {string} folderId
     * @param {unknown} token
     * @param {number} [count]
     */
    function createFolderRow(displayName, folderId, token, count) {
        const row = document.createElement('div');
        row.className = 'folder-rail__row';

        const label = document.createElement('label');
        label.className = 'folder-rail__label';
        label.title = displayName;

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.value = folderId;
        cb.dataset.token = /** @type {string} */ (token || '');

        // Full name (was truncated to 10 chars, which made similarly-named source
        // folders impossible to tell apart). CSS ellipsis handles overflow, and
        // the label `title` shows the full path on hover.
        const name = document.createElement('span');
        name.className = 'folder-rail__name';
        name.textContent = '📁 ' + displayName;

        // Optional count badge (e.g. number of photos in the folder).
        const countEl = document.createElement('span');
        countEl.className = 'folder-rail__count';
        if (typeof count === 'number') countEl.textContent = String(count);
        else countEl.style.display = 'none';

        label.appendChild(cb);
        label.appendChild(name);
        label.appendChild(countEl);
        row.appendChild(label);

        return { row, checkbox: cb, countEl };
    }

    // ⚡ FIX: Rotation only triggers renderGreenBox on an orientation flip (h↔v).
    // Non-flip rotations (0→90→180→270 within the same axis) update the CSS
    // transform directly and skip the full green box DOM rebuild entirely.
    // Uses the photoPageMap reverse lookup instead of scanning all pages.
    /**
     * @param {string} safeId
     * @param {number} newRot
     */
    function applyGlobalRotation(safeId, newRot) {
        deps.mutate('Rotate photo', () => {
            const projectData = store.get('projectData');
            const rotations = /** @type {Record<string, number>} */ (projectData.imageRotations);
            const oldRot = rotations[safeId] || 0;
            rotations[safeId] = newRot;
            const isFlip = (Math.abs(newRot - oldRot) % 180) === 90;

            // Update Tab 1 (redBox) thumbnail in-place
            const img1 = document.getElementById(safeId);
            if (img1) {
                img1.style.transform = `rotate(${newRot}deg)`;
                const badge1 = img1.parentElement && /** @type {HTMLElement | null} */ (img1.parentElement.querySelector('.rot-badge'));
                if (badge1) { badge1.style.display = newRot === 0 ? "none" : "block"; badge1.innerText = newRot + "°"; }
            }

            if (deps.isTab6Rendered()) {
                const card6 = document.getElementById("pt_" + safeId);
                if (card6) {
                    const img6 = /** @type {HTMLElement | null} */ (card6.querySelector(".tab6-photo-img"));
                    if (img6) img6.style.transform = `rotate(${newRot}deg)`;
                    const badge6 = /** @type {HTMLElement | null} */ (card6.querySelector('.rot-badge'));
                    if (badge6) { badge6.style.display = newRot === 0 ? "none" : "block"; badge6.innerText = newRot + "°"; }
                }
            }

            if (isFlip) {
                const pages = deps.getPhotoPages(safeId);
                if (pages) {
                    const albumPages = store.get('albumPages');
                    pages.forEach(pageNum => {
                        const page = albumPages[pageNum];
                        if (page && page.photos) {
                            const p = page.photos.find((/** @type {any} */ x) => x.id === safeId);
                            if (p) p.orient = p.orient === 'h' ? 'v' : 'h';
                        }
                    });
                }
                deps.renderGreenBox();
                deps.scheduleFilterUpdate();
            }

        deps.saveState();
        });
    }

    // ── Remove-folders dialog ──────────────────────────────────────
    document.addEventListener('click', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        if (target && target.classList.contains('btn-remove-fld')) {
            const type = /** @type {keyof typeof PANEL_IDS} */ (target.dataset.type);
            const listDiv = /** @type {HTMLElement} */ (document.getElementById("removeDialogList"));
            listDiv.innerHTML = "";
            const panelId = PANEL_IDS[type] || "";

            const panel = document.getElementById(panelId);
            if (!panel) return;
            const checkboxes = /** @type {NodeListOf<HTMLInputElement>} */ (panel.querySelectorAll("input[type='checkbox']"));
            if (checkboxes.length === 0) {
                listDiv.innerHTML = "<div class='dialog-empty'>No folders loaded.</div>";
            } else {
                checkboxes.forEach(cb => {
                    const labelText = /** @type {HTMLElement} */ (cb.parentElement).innerText.replace("📁", "").replace("🗑️", "").replace("🔄", "").trim();
                    const folderId = cb.value;
                    const token = cb.dataset.token || "";
                    listDiv.innerHTML += `<label><input type="checkbox" class="dialog-fld-cb" value="${escapeHtml(folderId)}" data-type="${escapeHtml(type)}" data-token="${escapeHtml(token)}"> 📁 ${escapeHtml(labelText)}</label>`;
                });
            }
            /** @type {HTMLDialogElement} */ (document.getElementById("removeFolderDialog")).showModal();
        }
    });

    const btnCancelRemove = document.getElementById("btnCancelRemove");
    if (btnCancelRemove) {
        btnCancelRemove.addEventListener("click", (e) => {
            e.preventDefault();
            /** @type {HTMLDialogElement} */ (document.getElementById("removeFolderDialog")).close();
        });
    }

    const btnConfirmRemove = document.getElementById("btnConfirmRemove");
    if (btnConfirmRemove) {
        btnConfirmRemove.addEventListener("click", (e) => {
            e.preventDefault();
            const projectData = store.get('projectData');
            const checkboxes = /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll(".dialog-fld-cb:checked"));
            checkboxes.forEach(cb => {
                const folderId = cb.value, type = cb.dataset.type, token = cb.dataset.token;
                document.querySelectorAll(`input[value="${folderId}"]:not(.dialog-fld-cb)`).forEach(input => {
                    if (input.parentElement && input.parentElement.parentElement) input.parentElement.parentElement.remove();
                });
                if (type === "images") {
                    store.get('activeImageFolders').delete(folderId);
                    if (projectData.imageTokens) projectData.imageTokens = projectData.imageTokens.filter((/** @type {unknown} */ t) => t !== token);
                    if (projectData.highResTokens) projectData.highResTokens = projectData.highResTokens.filter((/** @type {unknown} */ t) => t !== token);
                    const redBox = /** @type {HTMLElement} */ (document.getElementById("redBox"));
                    const photosGrid = /** @type {HTMLElement} */ (document.getElementById("photosGrid"));
                    Array.from(redBox.querySelectorAll(`.img-wrapper-red[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
                    Array.from(photosGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
                } else if (type === "templates") {
                    store.get('activeTemplateFolders').delete(folderId);
                    if (projectData.templateTokens) projectData.templateTokens = projectData.templateTokens.filter((/** @type {unknown} */ t) => t !== token);
                    store.set('templateLibrary', store.get('templateLibrary').filter((/** @type {any} */ t) => t.folderId !== folderId));
                    deps.scheduleFilterUpdate();
                } else if (type === "wallpapers") {
                    store.get('activeWallpaperFolders').delete(folderId);
                    if (projectData.wallpaperTokens) projectData.wallpaperTokens = projectData.wallpaperTokens.filter((/** @type {unknown} */ t) => t !== token);
                    if (projectData.wpHighResTokens) projectData.wpHighResTokens = projectData.wpHighResTokens.filter((/** @type {unknown} */ t) => t !== token);
                    const wallpaperGrid = /** @type {HTMLElement} */ (document.getElementById("wallpaperGrid"));
                    Array.from(wallpaperGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
                } else if (type === "pngs") {
                    store.get('activePngFolders').delete(folderId);
                    if (projectData.pngTokens) projectData.pngTokens = projectData.pngTokens.filter((/** @type {unknown} */ t) => t !== token);
                    const pngGrid = /** @type {HTMLElement} */ (document.getElementById("pngGrid"));
                    Array.from(pngGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
                } else if (type === "masks") {
                    store.get('activeMaskedFolders').delete(folderId);
                    if (projectData.maskTokens) projectData.maskTokens = projectData.maskTokens.filter((/** @type {unknown} */ t) => t !== token);
                    const maskedGrid = /** @type {HTMLElement} */ (document.getElementById("maskedGrid"));
                    Array.from(maskedGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
                }
            });
            /** @type {HTMLDialogElement} */ (document.getElementById("removeFolderDialog")).close();
            deps.saveState();
        });
    }

    // ── Checked-folder refresh engine ──────────────────────────────
    /** @param {string} type */
    async function refreshTab(type) {
        deps.setStatus("Refreshing checked folders…");
        const panelId = PANEL_IDS[/** @type {keyof typeof PANEL_IDS} */ (type)] || "";

        const panel = document.getElementById(panelId); if (!panel) return;
        const checkedBoxes = /** @type {NodeListOf<HTMLInputElement>} */ (panel.querySelectorAll("input[type='checkbox']:checked"));

        for (const cb of checkedBoxes) {
            const folderId = cb.value, token = cb.dataset.token;
            if (!token) continue;
            try {
                const masterFolder = await deps.getEntryForToken(token);
                let targetFolder = masterFolder, hrFolder = null;
                if (type === "images" || type === "wallpapers") {
                    try { const thumbFolder = await masterFolder.getEntry("_Thumbnails"); if(thumbFolder.isFolder) { targetFolder = thumbFolder; hrFolder = masterFolder; } } catch(e){}
                    if (type === "images") {
                        await deps.buildHighResMap(masterFolder, store.get('globalHighResMap'));
                        await deps.processImageFolder(targetFolder, hrFolder, token, folderId);
                    } else {
                        await deps.buildHighResMap(masterFolder, store.get('globalWpHighResMap'));
                        await deps.processWallpaperFolder(targetFolder, hrFolder, getDisplayName(masterFolder), token, folderId);
                    }
                } else if (type === "templates") {
                    await deps.processTemplateFolder(masterFolder, token, folderId);
                } else if (type === "pngs") {
                    await deps.processPngFolder(masterFolder, token, folderId);
                } else if (type === "masks") {
                    await deps.processMaskedFolder(masterFolder, token, folderId);
                }
            } catch(e) { console.error("Failed to refresh folder", e); }
        }

        if (type === "images") {
            deps.syncViewToState();
        } else if (type === "templates") {
            const templateLibrary = store.get('templateLibrary');
            Object.values(store.get('albumPages')).forEach((/** @type {any} */ page) => { if (page.template) { const matchedTemp = templateLibrary.find((/** @type {any} */ t) => t.id === page.template.id); if (matchedTemp) page.template = matchedTemp; } });
            deps.scheduleFilterUpdate();
        }
        deps.notify("Refresh complete!", "success");
    }

    document.addEventListener('click', async (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        if (target && target.classList.contains('btn-reload-fld')) {
            await refreshTab(/** @type {string} */ (target.dataset.type));
        }
    });

    return { createFolderRow, applyGlobalRotation, refreshTab };
}

module.exports = { createFolderRefresh };
