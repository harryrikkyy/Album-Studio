// @ts-check
// features/photo_library.js — the source-photo library, extracted from
// main.js (Phase 2 split): Tab 1 (redBox) thumbnail building and the lazy,
// virtualized Photos tab (Tab 6).
//
// processImageFolder populates photoCache and builds ONLY the Tab 1 wrappers
// (DocumentFragment batch insert) plus twin folder-rail rows whose checkboxes
// toggle the folder in both tabs. Tab 6 DOM is deferred to renderPhotosGrid,
// called once when the user first opens that tab: cards are always built (so
// layout + scroll height are stable) but images are virtualized — an
// IntersectionObserver attaches each <img> src as the card nears the viewport
// and releases it far off-screen, capping decoded thumbnails at ~the visible
// window instead of all N.
//
// This is a DOM-owning module. Selection, template matching, and native
// drag-out stay in main.js (they're delegated listeners entangled with the
// match-panel/selection state); what's injected is the cross-cutting glue:
// rotation, folder rows, HR resolution, pickers, persistence, and status.

/**
 * @typedef {import('../state/store').Store} Store
 */

const { getDisplayName } = require('../renderer_pure');

/**
 * Wire the photo library to the store and bind its Load buttons.
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
 * @param {(safeId: string, newRot: number) => void} deps.applyGlobalRotation
 * @param {() => void} deps.renderGreenBox
 * @param {() => void} deps.invalidateTab6  force a Tab 6 rebuild on next open
 */
function createPhotoLibrary(store, deps) {
    const redBox = /** @type {HTMLElement} */ (document.getElementById("redBox"));
    const photosGrid = /** @type {HTMLElement} */ (document.getElementById("photosGrid"));

    // ⚡ FIX: processImageFolder only builds Tab 1 (redBox) DOM now.
    // Tab 6 is built lazily via renderPhotosGrid() the first time the user
    // opens that tab. photoCache entries carry the extra fields lazy Tab 6
    // rendering needs.
    /**
     * @param {any} folder
     * @param {any} hrFolder
     * @param {unknown} token
     * @param {string | null} [existingFolderId]
     */
    async function processImageFolder(folder, hrFolder, token, existingFolderId = null) {
        const displayName = getDisplayName(folder);
        const folderId = existingFolderId || ("imgFld_" + displayName.replace(/[^a-zA-Z0-9]/g, '_') + Date.now());
        store.get('activeImageFolders').add(folderId);
        const photoCache = /** @type {Record<string, any>} */ (store.get('photoCache'));
        const projectData = store.get('projectData');

        if (existingFolderId) {
            Array.from(redBox.querySelectorAll(`.img-wrapper-red[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
            Array.from(photosGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
            // Force Tab 6 re-render on next open if it had previously been rendered
            deps.invalidateTab6();
        }

        const entries = await folder.getEntries();
        const imgs = entries.filter((/** @type {any} */ e) => e.isFile && e.name.match(/\.(jpg|jpeg|png|tif)$/i));
        imgs.sort((/** @type {any} */ a, /** @type {any} */ b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        // ⚡ Build all redBox wrappers into a DocumentFragment — single DOM append at the end
        const frag = document.createDocumentFragment();

        imgs.forEach((/** @type {any} */ file) => {
            const baseName = file.name.replace(/\.[^/.]+$/, "").toLowerCase();
            const safeId = "img_" + (displayName + "_" + file.name).replace(/[^a-zA-Z0-9]/g, '_');
            const savedRotation = (projectData.imageRotations || {})[safeId] || 0;

            // Store extra fields so lazy Tab 6 render doesn't need to re-scan
            photoCache[safeId] = {
                proxy: file, hrFolder: hrFolder, baseName: baseName,
                folderId: folderId, displayName: displayName,
                fileName: file.name, url: file.url,
                orient: null  // ⚡ Task 2.1: cached on first thumbnail load below
            };

            Object.values(store.get('albumPages')).forEach(page => {
                if (page.photos) page.photos.forEach(p => { if (p.id === safeId) p.url = file.url; });
            });

            // --- Build Tab 1 (redBox) wrapper ---
            const wrapper = document.createElement("div");
            wrapper.className = "img-wrapper-red";
            wrapper.dataset.folderId = folderId;

            const img = document.createElement("img");
            img.src = file.url; img.className = "thumb-red"; img.id = safeId; img.draggable = true;
            if (savedRotation !== 0) img.style.transform = `rotate(${savedRotation}deg)`;
            // ⚡ Task 2.1: capture true pixel orientation once the proxy decodes,
            // so auto-fill can read photoCache[id].orient instead of creating a
            // throwaway off-DOM <img> per photo to measure naturalWidth/Height.
            img.addEventListener('load', () => {
                const c = photoCache[safeId];
                if (c) c.orient = img.naturalWidth >= img.naturalHeight ? 'h' : 'v';
            }, { once: true });

            const badge = document.createElement("div");
            badge.className = "rot-badge";
            if (savedRotation !== 0) { badge.style.display = "block"; badge.innerText = savedRotation + "°"; }

            const btnRotate = document.createElement("button");
            btnRotate.className = "btn-rotate-red"; btnRotate.innerHTML = "🔄";
            btnRotate.title = "Rotate image (Syncs with UI & High-Res)";
            // Inline onclick — rotate buttons are few, inline is fine
            btnRotate.onclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                deps.applyGlobalRotation(safeId, (((projectData.imageRotations || {})[safeId] || 0) + 90) % 360);
            };
            btnRotate.addEventListener('pointerup', e => e.stopPropagation());

            wrapper.appendChild(badge); wrapper.appendChild(img); wrapper.appendChild(btnRotate);
            frag.appendChild(wrapper);
            // ⚡ No Tab 6 DOM built here — deferred to renderPhotosGrid()
        });

        // Remove the initial empty-state placeholder on first load (appending,
        // not clearing, so other already-loaded folders' thumbnails survive).
        const _redEmpty = redBox.querySelector('.empty-state');
        if (_redEmpty) _redEmpty.remove();
        redBox.appendChild(frag); // ⚡ Single live DOM insertion for all images

        if (!existingFolderId) {
            const r1 = deps.createFolderRow(displayName, folderId, token, imgs.length);
            const r6 = deps.createFolderRow(displayName, folderId, token, imgs.length);
            const pnl1 = /** @type {HTMLElement} */ (document.getElementById("redFolderPanel"));
            const pnl6 = /** @type {HTMLElement} */ (document.getElementById("photosFolderPanel"));

            /** @param {any} e */
            function handleToggle(e) {
                if (e.target.checked) store.get('activeImageFolders').add(folderId); else store.get('activeImageFolders').delete(folderId);
                r1.checkbox.checked = e.target.checked;
                r6.checkbox.checked = e.target.checked;
                Array.from(redBox.querySelectorAll('.img-wrapper-red')).forEach(wrp => {
                    if (/** @type {HTMLElement} */ (wrp).dataset.folderId === folderId) {
                        /** @type {HTMLElement} */ (wrp).style.display = e.target.checked ? "inline-flex" : "none";
                        if (!e.target.checked) wrp.querySelector('.thumb-red') && /** @type {HTMLElement} */ (wrp.querySelector('.thumb-red')).classList.remove("selected");
                    }
                });
                Array.from(photosGrid.querySelectorAll('.wp-card')).forEach(card => {
                    if (/** @type {HTMLElement} */ (card).dataset.folderId === folderId) /** @type {HTMLElement} */ (card).style.display = e.target.checked ? "inline-block" : "none";
                });
            }
            r1.checkbox.onchange = handleToggle;
            r6.checkbox.onchange = handleToggle;
            pnl1.appendChild(r1.row); pnl6.appendChild(r6.row);
        }
    }

    // ⚡ FIX: Lazy Tab 6 renderer — called once when user first opens Tab 6.
    // Reads from photoCache (already populated) instead of re-scanning folders.
    // ⚡ Task 4.1: NO per-card listeners (single delegated handler below).
    // ⚡ Task 4.2: VIRTUALIZED. Cards are always built (so layout + scroll height
    // are stable), but each <img> starts with NO src — only `data-src`. An
    // IntersectionObserver attaches the real src when a card scrolls within ~1
    // viewport of view, and detaches it when it scrolls far away. This caps the
    // number of decoded thumbnails held in host/GPU memory at ~the visible window
    // instead of all N (a 2,000-photo folder previously decoded 2,000 images at
    // once). Card dimensions are fixed via CSS so detaching doesn't shift layout.
    /** @type {IntersectionObserver | null} */
    let _tab6Observer = null;
    function _ensureTab6Observer() {
        if (_tab6Observer) return _tab6Observer;
        _tab6Observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                const img = /** @type {HTMLImageElement | null} */ (entry.target.querySelector('.tab6-photo-img'));
                if (!img) continue;
                const wrap = img.parentElement;
                if (entry.isIntersecting) {
                    // Attach the real source as the card nears the viewport. Show
                    // a skeleton shimmer on the wrapper until the image decodes.
                    if (!img.src && img.dataset.src) {
                        if (wrap) wrap.classList.add('skeleton');
                        img.addEventListener('load', () => {
                            if (wrap) wrap.classList.remove('skeleton');
                        }, { once: true });
                        img.addEventListener('error', () => {
                            if (wrap) wrap.classList.remove('skeleton');
                        }, { once: true });
                        img.src = img.dataset.src;
                    }
                } else {
                    // Far off-screen: release the decoded image to reclaim memory.
                    // Keep data-src so it re-attaches instantly when scrolled back.
                    if (img.src) { img.removeAttribute('src'); if (wrap) wrap.classList.remove('skeleton'); }
                }
            }
        }, {
            root: photosGrid,
            // Pre-load a viewport's worth above/below so scrolling feels instant.
            rootMargin: '300px 0px 300px 0px',
            threshold: 0,
        });
        return _tab6Observer;
    }

    function renderPhotosGrid() {
        const _ph = photosGrid.querySelector('.placeholder-text, .empty-state');
        if (_ph) photosGrid.innerHTML = "";

        // Disconnect any prior observation — we're rebuilding the card set.
        if (_tab6Observer) { _tab6Observer.disconnect(); }
        const observer = _ensureTab6Observer();

        const usedIds = new Set();
        Object.values(store.get('albumPages')).forEach(page => {
            if (page && page.photos) page.photos.forEach(p => usedIds.add(p.id));
        });

        const projectData = store.get('projectData');
        const frag = document.createDocumentFragment();
        /** @type {HTMLElement[]} */
        const cardsToObserve = [];

        Object.entries(/** @type {Record<string, any>} */ (store.get('photoCache'))).forEach(([safeId, cacheData]) => {
            const savedRotation = (projectData.imageRotations || {})[safeId] || 0;

            const photoCard = document.createElement("div");
            photoCard.className = "wp-card";
            photoCard.dataset.folderId = cacheData.folderId;
            photoCard.dataset.photoId = safeId;
            photoCard.id = "pt_" + safeId;
            photoCard.draggable = true; // native drag-out to Photoshop (original file)

            const photoImgWrapper = document.createElement("div");
            photoImgWrapper.className = "wp-card-img-wrapper";

            const photoImg = document.createElement("img");
            // Virtualized: store the source in data-src; the observer attaches the
            // real src only when the card is near the viewport.
            photoImg.dataset.src = cacheData.url;
            photoImg.className = "tab6-photo-img"; photoImg.draggable = false;
            if (savedRotation !== 0) photoImg.style.transform = `rotate(${savedRotation}deg)`;

            const badge6 = document.createElement("div"); badge6.className = "rot-badge";
            if (savedRotation !== 0) { badge6.style.display = "block"; badge6.innerText = savedRotation + "°"; }

            const btnRotate6 = document.createElement("button");
            btnRotate6.className = "btn-rotate-red"; btnRotate6.innerHTML = "🔄"; btnRotate6.title = "Rotate image";

            photoImgWrapper.appendChild(badge6); photoImgWrapper.appendChild(photoImg); photoImgWrapper.appendChild(btnRotate6);

            const photoLabel = document.createElement("div");
            photoLabel.className = "label"; photoLabel.innerText = cacheData.fileName.substring(0, 15); photoLabel.style.pointerEvents = "none";

            if (usedIds.has(safeId)) photoCard.classList.add("used");

            photoCard.appendChild(photoImgWrapper); photoCard.appendChild(photoLabel);
            frag.appendChild(photoCard);
            cardsToObserve.push(photoCard);
        });

        photosGrid.appendChild(frag); // ⚡ Single live DOM insertion
        // Observe after insertion so the observer has real layout rects.
        cardsToObserve.forEach(c => observer.observe(c));
    }

    // Heavy "inject this photo into the active Photoshop layer" routine, lifted
    // out of the per-card closure so the delegated handler can call it by id.
    // Runs through the JSX bridge (IPC) — NOT the UXP stub, whose app.activeDocument
    // is a fake that only tracks docs this app opened (the cause of the spurious
    // "Please open a PSD document first!" when a doc was open in Photoshop).
    /** @param {string} safeId */
    async function _tab6InjectPhoto(safeId) {
        const cacheData = /** @type {Record<string, any>} */ (store.get('photoCache'))[safeId];
        if (!cacheData) return;
        try {
            deps.setStatus('Injecting photo into active layer…');
            // Resolve the best file (HR original when available, else proxy).
            const fetchResult = await deps.getTrueFile(cacheData);
            const filePath = fetchResult.file?.nativePath;
            if (!filePath) { deps.toast('Could not resolve photo file', 'error'); return; }
            const layerName = (fetchResult.isHr ? cacheData.baseName + '_HighRes' : cacheData.baseName);

            const res = await deps.invoke('inject-photo', { filePath, layerName });
            if (res?.ok) {
                // Mark used in both tabs.
                const redImg = document.getElementById(safeId); if (redImg) redImg.classList.add('used');
                const card = document.getElementById('pt_' + safeId); if (card) card.classList.add('used');
                deps.notify('Photo injected into active layer', 'success', { duration: 2500 });
            } else if (res?.reason === 'no_document') {
                deps.showAlert('Please open a PSD document in Photoshop first!');
            } else if (res?.reason === 'no_layer') {
                deps.showAlert('Select exactly one frame or layer on the Photoshop canvas first!');
            } else {
                deps.toast('Inject failed: ' + (res?.error || 'unknown'), 'error');
            }
        } catch (e) {
            deps.toast('Inject error: ' + (e instanceof Error ? e.message : String(e)), 'error');
        }
    }

    // ⚡ Task 4.1: ONE delegated handler for the whole Tab 6 grid. Handles rotate
    // button clicks and double-click-to-inject via a small per-target click
    // counter keyed off the card id (mirrors the redBox delegation pattern).
    ;(function _tab6InitDelegation() {
        if (!photosGrid) return;
        /** @type {Record<string, { count: number, timer: any }>} */
        const clickState = {};
        photosGrid.addEventListener('pointerup', (e) => {
            const target = /** @type {HTMLElement} */ (e.target);
            const rotateBtn = target.closest('.btn-rotate-red');
            if (rotateBtn) {
                e.preventDefault(); e.stopPropagation();
                const card = /** @type {HTMLElement | null} */ (rotateBtn.closest('.wp-card'));
                const safeId = card && card.dataset.photoId;
                if (safeId) {
                    const projectData = store.get('projectData');
                    deps.applyGlobalRotation(safeId, (((projectData.imageRotations || {})[safeId] || 0) + 90) % 360);
                }
                return;
            }
            const card = /** @type {HTMLElement | null} */ (target.closest('.wp-card'));
            if (!card) return;
            const safeId = card.dataset.photoId;
            if (!safeId) return;
            if (!clickState[safeId]) clickState[safeId] = { count: 0, timer: null };
            const st = clickState[safeId];
            st.count++;
            if (st.count === 1) {
                st.timer = setTimeout(() => { st.count = 0; }, 350);
            } else if (st.count === 2) {
                clearTimeout(st.timer); st.count = 0;
                _tab6InjectPhoto(safeId);
            }
        });
    })();

    const btnLoadPhotos = document.getElementById("btnLoadPhotos");
    if (btnLoadPhotos) {
        btnLoadPhotos.addEventListener("click", async () => {
            const folder = await deps.pickFolder(); if (!folder) return;
            if (folder.name.toLowerCase() === "_thumbnails") {
                return deps.showAlert("🛑 UXP SANDBOX BLOCK!\n\nYou selected the '_Thumbnails' folder directly. Adobe security prevents plugins from reading 'backwards' into the previous folder to get your high-res files.\n\nPlease click Load again and select the MASTER FOLDER instead. The plugin will automatically grab the thumbnails for you!");
            }
            deps.setStatus("Scanning folder…");
            await new Promise(resolve => setTimeout(resolve, 50));

            let targetFolderToLoad = folder, hrFolder = null;
            let thumbFolder = null;
            try {
                const tf = await folder.getEntry("_Thumbnails");
                if (tf && tf.isFolder) thumbFolder = tf;
            } catch (e) { /* no _Thumbnails yet */ }

            // Auto-cache: no _Thumbnails subfolder → generate one now (slow on the
            // first load, instant on every load after), then Smart-Load from it.
            if (!thumbFolder) {
                try {
                    deps.setStatus("First load — generating thumbnails (this folder will open fast next time)…");
                    const genRes = await deps.invoke('thumbnails-generate', folder.nativePath);
                    if (genRes && genRes.ok && genRes.processed > 0) {
                        try { const tf2 = await folder.getEntry("_Thumbnails"); if (tf2 && tf2.isFolder) thumbFolder = tf2; } catch (e2) {}
                    } else if (genRes && genRes.error) {
                        deps.toast('Thumbnail cache skipped: ' + genRes.error + ' — loading originals.', 'warning');
                    }
                } catch (genErr) {
                    console.error('Auto thumbnail generation failed:', genErr);
                    // Fall through and load the master folder directly (originals).
                }
            }

            const projectData = store.get('projectData');
            if (thumbFolder) {
                targetFolderToLoad = thumbFolder; hrFolder = folder;
                const hrToken = await deps.createToken(folder);
                if (!projectData.highResTokens) projectData.highResTokens = [];
                if (!projectData.highResTokens.includes(hrToken)) projectData.highResTokens.push(hrToken);
                deps.toast("Smart Load active — high-res master folder linked", "info");
            }

            const token = await deps.createToken(folder);
            if (!(projectData.imageTokens || []).includes(token)) /** @type {unknown[]} */ (projectData.imageTokens).push(token);
            await processImageFolder(targetFolderToLoad, hrFolder, token);
            deps.saveState(); deps.renderGreenBox();
        });
    }
    const btnLoadPhotosTab = document.getElementById("btnLoadPhotosTab");
    if (btnLoadPhotosTab) { btnLoadPhotosTab.addEventListener("click", () => { if (btnLoadPhotos) btnLoadPhotos.click(); }); }

    return { processImageFolder, renderPhotosGrid };
}

module.exports = { createPhotoLibrary };
