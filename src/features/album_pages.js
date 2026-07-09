// @ts-check
// features/album_pages.js — the green-box page engine, extracted from
// main.js (Phase 2 split): page navigation/management (Tab 4's command bar)
// and the current-page photo composer.
//
// Owns: updatePageDropdowns/changePage, add/remove/clear page (all undoable
// via the injected mutate), the PULL flow (prepareAndMove: orientation
// analysis + rotation-aware H/V), renderGreenBox (tile grid with
// Finder-style click/Shift/Cmd selection), the delegated green-box
// drag-reorder, remove-selected, EXIF sort-this-page, teleport-to-page, and
// the Smart Auto-Fill batch (min/max or desired-sheets distribution,
// EXIF-ordered, committed as ONE undoable mutation).
//
// DOM-owning module with explicit store access; injected: history mutate,
// the photo→page reverse map, view seams owned by other modules
// (scheduleFilterUpdate, scheduleLivePreview, renderStoryboard, clearProofs,
// resetRenderHashes), EXIF sorting, and status/toast/notify/alert.

/**
 * @typedef {import('../state/store').Store} Store
 * @typedef {import('../shared/domain').Page} Page
 */

const { escapeHtml } = require('../renderer_pure');

/** @param {unknown} e */
function _errMessage(e) {
    return e instanceof Error ? e.message : String(e);
}

/**
 * Wire the page engine. Binds the command bar, green box, and Auto-Fill.
 *
 * @param {Store} store
 * @param {object} deps
 * @param {<T>(label: string, fn: () => T) => T} deps.mutate
 * @param {(photoId: string, pageNum: number) => void} deps.addToPageMap
 * @param {(photoId: string, pageNum: number) => void} deps.removeFromPageMap
 * @param {() => void} deps.rebuildPhotoPageMap
 * @param {() => void} deps.clearPhotoPageMap
 * @param {() => void} deps.syncViewToState
 * @param {() => void} deps.scheduleFilterUpdate
 * @param {() => void} deps.scheduleLivePreview
 * @param {() => void} deps.renderStoryboard
 * @param {() => void} deps.clearProofs
 * @param {() => void} deps.resetRenderHashes  wipe the final-render cache
 * @param {(items: any[]) => Promise<void>} deps.sortPhotosByExif  in-place chronological sort
 * @param {() => void} deps.updateAdjustPanel
 * @param {() => any[] | null} deps.takeSourceDragItems  claim (and clear) an in-app source drag payload
 * @param {() => boolean} deps.hasSourceDragItems
 * @param {(msg: string) => void} deps.setStatus
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.notify
 * @param {(msg: string) => void} deps.showAlert
 */
function createAlbumPages(store, deps) {
    const redBox = /** @type {HTMLElement} */ (document.getElementById("redBox"));
    const greenBox = /** @type {HTMLElement} */ (document.getElementById("greenBox"));
    const pageSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("pageSelect"));
    const teleportSelect = /** @type {HTMLSelectElement | null} */ (document.getElementById("teleportTargetPage"));

    // ── Page navigation ─────────────────────────────────────────────────────

    function updatePageDropdowns() {
        const totalActivePages = store.get('totalActivePages');
        const currentPage = store.get('currentPage');
        if (pageSelect) pageSelect.innerHTML = "";
        if (teleportSelect) teleportSelect.innerHTML = "";
        for (let i = 1; i <= totalActivePages; i++) {
            if (pageSelect) { const opt = document.createElement("option"); opt.value = String(i); opt.innerText = "Page " + String(i).padStart(3, '0'); if (i === currentPage) opt.selected = true; pageSelect.appendChild(opt); }
            if (teleportSelect) { const opt2 = document.createElement("option"); opt2.value = String(i); opt2.innerText = "To Pg " + i; teleportSelect.appendChild(opt2); }
        }
        if (teleportSelect) { const optPlus1 = document.createElement("option"); optPlus1.value = String(totalActivePages + 1); optPlus1.innerText = "To Pg " + (totalActivePages + 1); teleportSelect.appendChild(optPlus1); }
        const trackerText = document.getElementById("pageTrackerText"); if (trackerText) trackerText.innerText = `Total: ${totalActivePages}`;
    }
    updatePageDropdowns();

    /** @param {number} newPage */
    function changePage(newPage) {
        if (newPage < 1 || newPage > store.get('totalActivePages')) return;
        store.set('currentPage', newPage);
        store.set('previewIndex', 0); // ⚡ FIX: reset stale preview index on every page switch
        if (pageSelect) pageSelect.value = String(newPage);
        const greenTitle = document.getElementById("greenBoxTitle"); if (greenTitle) greenTitle.innerText = `Page ${String(newPage).padStart(3, '0')}`;
        const albumPages = store.get('albumPages');
        if (!albumPages[newPage]) albumPages[newPage] = { photos: [], template: null };
        renderGreenBox(); deps.scheduleFilterUpdate();
    }

    if (pageSelect) pageSelect.onchange = (e) => changePage(parseInt(/** @type {HTMLSelectElement} */ (e.target).value));
    const btnPrev = document.getElementById("btnPrev"); if (btnPrev) btnPrev.onclick = () => changePage(store.get('currentPage') - 1);
    const btnNext = document.getElementById("btnNext"); if (btnNext) btnNext.onclick = () => changePage(store.get('currentPage') + 1);
    const btnAddPage = document.getElementById("btnAddPage");
    if (btnAddPage) {
        btnAddPage.onclick = () => deps.mutate('Add page', () => {
            const albumPages = store.get('albumPages');
            const currentPage = store.get('currentPage');
            for (let i = store.get('totalActivePages'); i > currentPage; i--) albumPages[i + 1] = albumPages[i];
            albumPages[currentPage + 1] = { photos: [], template: null };
            store.set('totalActivePages', store.get('totalActivePages') + 1);
            updatePageDropdowns();
            changePage(currentPage + 1);
        });
    }
    const btnRemovePage = document.getElementById("btnRemovePage");
    if (btnRemovePage) {
        btnRemovePage.onclick = () => {
            if (store.get('totalActivePages') === 1) return deps.showAlert("Cannot delete the only page!");
            deps.mutate('Delete page', () => {
                const albumPages = store.get('albumPages');
                const currentPage = store.get('currentPage');
                const pageData = albumPages[currentPage];
                if (pageData && pageData.photos) {
                    pageData.photos.forEach(p => {
                        deps.removeFromPageMap(/** @type {string} */ (p.id), currentPage);
                        const red = document.getElementById(/** @type {string} */ (p.id));
                        if (red) { red.classList.remove("used"); red.style.opacity = "1"; }
                    });
                }
                const total = store.get('totalActivePages');
                for (let i = currentPage; i < total; i++) albumPages[i] = albumPages[i + 1];
                delete albumPages[total];
                store.set('totalActivePages', total - 1);
                if (store.get('currentPage') > store.get('totalActivePages')) store.set('currentPage', store.get('totalActivePages'));
                updatePageDropdowns();
                changePage(store.get('currentPage'));
            });
        };
    }

    // ─── CLEAR ALBUM ─────────────────────────────────────────────
    // Wipes every page's template + photos, leaves a single empty page, and
    // clears the "used" markers on Tab 1 and Tab 6 thumbnails. Wrapped in
    // mutate() so a misclick is one Cmd+Z away. Folders, library, and project
    // path are intentionally left intact — this only resets the layout itself.
    const btnClearAlbum = document.getElementById("btnClearAlbum");
    // ⚡ B.2: command-bar overflow menu (houses Clear album away from Auto Fill).
    const btnCmdOverflow = document.getElementById("btnCmdOverflow");
    const cmdOverflowMenu = document.getElementById("cmdOverflowMenu");
    if (btnCmdOverflow && cmdOverflowMenu) {
        const closeOverflow = () => {
            cmdOverflowMenu.classList.remove('open');
            btnCmdOverflow.setAttribute('aria-expanded', 'false');
        };
        btnCmdOverflow.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = cmdOverflowMenu.classList.toggle('open');
            btnCmdOverflow.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        document.addEventListener('click', (e) => {
            if (!(/** @type {HTMLElement} */ (e.target).closest('.cmd-overflow'))) closeOverflow();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeOverflow();
        });
        // Selecting Clear album should also dismiss the menu.
        if (btnClearAlbum) btnClearAlbum.addEventListener('click', closeOverflow);
    }
    if (btnClearAlbum) {
        btnClearAlbum.addEventListener("click", () => {
            const albumPages = store.get('albumPages');
            const pageCount = Object.keys(albumPages).length;
            const photoCount = Object.values(albumPages).reduce(
                (sum, p) => sum + (p?.photos?.length || 0), 0
            );
            if (pageCount === 0 || (pageCount === 1 && photoCount === 0)) {
                deps.toast('Album is already empty', 'info');
                return;
            }
            const ok = confirm(
                `Clear all ${pageCount} page${pageCount > 1 ? 's' : ''} and ${photoCount} photo placement${photoCount === 1 ? '' : 's'}?\n\n` +
                `Folders, photos on disk, and library assets stay loaded — only the page layout is reset. ` +
                `You can undo this with Cmd+Z.`
            );
            if (!ok) return;

            deps.mutate('Clear album', () => {
                store.set('albumPages', { 1: { photos: [], template: null } });
                store.set('totalActivePages', 1);
                store.set('currentPage', 1);

                // Clear Tab 1 red thumbnails and Tab 6 photo cards "used"
                // badges via the single state→view owner (albumPages is now
                // empty so this clears everything).
                deps.syncViewToState();

                // Clear the photo→page reverse map; rebuilt empty since
                // albumPages is empty.
                deps.clearPhotoPageMap();

                // Drop render hashes — every page is now empty, so cached
                // final renders for those page numbers no longer correspond to
                // anything. Without this, a future render at the same page
                // numbers would skip rather than re-render.
                deps.resetRenderHashes();

                // Drop cached proof paths so Tab 7 doesn't show stale composites.
                deps.clearProofs();

                updatePageDropdowns();
                changePage(1);
                deps.renderStoryboard();
            });

            deps.notify('Album cleared · Cmd+Z to restore', 'success', { duration: 5000 });
        });
    }

    // ── Green box (current-page composer) ───────────────────────────────────

    const btnPull = document.getElementById("btnPull");
    if (btnPull) {
        btnPull.onclick = () => {
            const selected = Array.from(redBox.querySelectorAll(".selected")).map(el => ({ id: el.id, url: /** @type {HTMLImageElement} */ (el).src }));
            if (selected.length > 0) prepareAndMove(selected);
        };
    }

    /** @param {{ id: string, url: string }[]} items */
    async function prepareAndMove(items) {
        const albumPages = store.get('albumPages');
        const currentPage = store.get('currentPage');
        const projectData = store.get('projectData');
        if (!albumPages[currentPage]) albumPages[currentPage] = { photos: [], template: null };
        items.forEach(item => { const redImg = document.getElementById(item.id); if (redImg) { redImg.classList.add("used"); redImg.classList.remove("selected"); } });
        const analysisPromises = items.map(item => new Promise((resolve) => {
            const img = document.createElement("img"); img.style.cssText = "position: absolute; top: -9999px; left: -9999px; visibility: hidden;";
            img.onload = () => { const isH = img.naturalWidth >= img.naturalHeight; document.body.removeChild(img); resolve({ ...item, orient: isH ? 'h' : 'v' }); };
            img.onerror = () => { if (img.parentNode) document.body.removeChild(img); resolve({ ...item, orient: 'h' }); };
            document.body.appendChild(img); img.src = item.url;
        }));
        const analyzedResults = /** @type {any[]} */ (await Promise.all(analysisPromises));
        const finalResults = analyzedResults.map(res => {
            const rotation = (projectData.imageRotations || {})[res.id] || 0;
            if (rotation === 90 || rotation === 270) res.orient = (res.orient === 'h') ? 'v' : 'h';
            return res;
        });
        deps.mutate(`Pull ${finalResults.length} photo${finalResults.length === 1 ? '' : 's'}`, () => {
            const page = /** @type {{ photos: any[] }} */ (albumPages[currentPage]);
            page.photos = page.photos.concat(finalResults);
            finalResults.forEach(p => deps.addToPageMap(p.id, currentPage));
            renderGreenBox(); deps.scheduleFilterUpdate();
        });
    }

    // ⚡ FIX: renderGreenBox uses DocumentFragment + caches the CSS var read
    // outside the loop (getComputedStyle inside a loop forces repeated layout
    // recalculations).

    // Tracks the last container the user clicked so Shift+click can extend a
    // range. Reset on every render because container indexes are unstable
    // across re-renders.
    /** @type {number | null} */
    let _greenLastClickedIdx = null;

    function renderGreenBox() {
        const albumPages = store.get('albumPages');
        const currentPage = store.get('currentPage');
        const projectData = store.get('projectData');
        const pageData = albumPages[currentPage];
        if (!pageData || !pageData.photos || pageData.photos.length === 0) {
            greenBox.innerHTML = `<div class="empty-state">
                <div class="empty-state__icon">🗂️</div>
                <div class="empty-state__title">This page is empty</div>
                <div class="empty-state__hint">Drag photos here from the Source pool (or double-click them), or use Auto-Fill to populate the album.</div>
            </div>`;
            deps.scheduleLivePreview(); // empty page → live preview reverts to template
            return;
        }

        // Container sizing now lives entirely in style.css so the slider
        // (which sets --green-thumb-size on :root) controls both width and
        // height in lockstep. Inline width/height previously fought the CSS
        // and produced "fit-to-height" stretching where the slider only grew
        // the cell horizontally.
        const containerStyle = '';

        const frag = document.createDocumentFragment();

        pageData.photos.forEach((p, idx) => {
            const wrapperW = document.createElement("div");
            wrapperW.className = "greenbox-wrapper";

            const container = document.createElement("div");
            container.className = "img-container";
            // Selection lives on the CONTAINER (was on the img before).
            // Outlining the whole tile is visually obvious; the previous
            // img-border approach collided with the inline `border: 2px solid
            // transparent` set below and produced an invisible "selected"
            // state.
            container.dataset.photoId = p.id;
            container.dataset.photoIdx = String(idx);
            container.draggable = true;
            if (containerStyle) container.style.cssText = containerStyle;

            const savedRotation = (projectData.imageRotations || {})[/** @type {string} */ (p.id)] || 0;
            // No more inline `border` here — selection is conveyed via the
            // container's outline ring.
            const cssRotation = `transform: rotate(${savedRotation}deg); transform-origin: center; transition: transform 0.2s ease; max-height:100%; max-width:100%; object-fit:contain; cursor:pointer;`;
            container.innerHTML = `<img src="${escapeHtml(/** @type {string} */ (p.url))}" class="thumb-green" style="${cssRotation}" draggable="false"><div class="orient-label">${escapeHtml(/** @type {string} */ (p.orient)).toUpperCase()}</div>`;

            const imgEl = /** @type {HTMLElement} */ (container.querySelector('.thumb-green'));

            // Single click toggles selection. Shift+click extends selection
            // from the last clicked tile to this one. Cmd/Ctrl+click toggles a
            // single tile without affecting others — same model as Finder /
            // VS Code.
            container.addEventListener('click', (e) => {
                // Ignore clicks on overlay buttons inside the container.
                if (/** @type {HTMLElement} */ (e.target).closest('button')) return;
                const all = Array.from(greenBox.querySelectorAll('.img-container'));
                const here = all.indexOf(container);
                if (e.shiftKey && _greenLastClickedIdx != null) {
                    const [a, b] = [_greenLastClickedIdx, here].sort((x, y) => x - y);
                    for (let i = a; i <= b; i++) all[i].classList.add('selected');
                } else if (e.metaKey || e.ctrlKey) {
                    container.classList.toggle('selected');
                } else {
                    const wasSelected = container.classList.contains('selected');
                    all.forEach(el => el.classList.remove('selected'));
                    if (!wasSelected) container.classList.add('selected');
                }
                _greenLastClickedIdx = here;
                deps.updateAdjustPanel();
            });

            imgEl.ondblclick = () => deps.mutate('Remove photo from page', () => {
                const page = /** @type {{ photos: any[] }} */ (store.get('albumPages')[store.get('currentPage')]);
                page.photos = page.photos.filter(x => x.id !== p.id);
                deps.removeFromPageMap(/** @type {string} */ (p.id), store.get('currentPage'));
                const red = document.getElementById(/** @type {string} */ (p.id));
                if (red) { red.classList.remove("used"); red.style.opacity = "1"; }
                renderGreenBox(); deps.scheduleFilterUpdate();
            });

            wrapperW.appendChild(container);
            frag.appendChild(wrapperW);
        });

        greenBox.innerHTML = "";
        greenBox.appendChild(frag);
        _greenLastClickedIdx = null;
        deps.scheduleLivePreview(); // page composition changed → re-composite if live
        deps.updateAdjustPanel(); // selection cleared on rebuild
    }

    // ─── DRAG-AND-DROP REORDER (greenBox) ─────────────────────────────────
    // Single delegated handler — listeners stay attached to the stable
    // greenBox node and survive every renderGreenBox() innerHTML rebuild.
    ;(function _greenInitDnd() {
        if (!greenBox) return;
        /** @type {HTMLElement | null} */
        let dragging = null;        // .img-container being dragged
        /** @type {string | null | undefined} */
        let dragSrcId = null;
        /** @type {HTMLElement | null} */
        let lastDropTarget = null;

        function clearDropMarkers() {
            greenBox.querySelectorAll('.drop-before, .drop-after').forEach(el =>
                el.classList.remove('drop-before', 'drop-after'));
        }

        greenBox.addEventListener('dragstart', (e) => {
            const c = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.img-container'));
            if (!c) return;
            dragging = c;
            dragSrcId = c.dataset.photoId;
            c.classList.add('is-dragging');
            // C.3: highlight the green box as the active drop zone for the drag.
            greenBox.classList.add('dropzone--active');
            try { /** @type {DataTransfer} */ (e.dataTransfer).effectAllowed = 'move'; /** @type {DataTransfer} */ (e.dataTransfer).setData('text/plain', /** @type {string} */ (dragSrcId)); } catch (_) {}
        });

        greenBox.addEventListener('dragover', (e) => {
            if (!dragging) {
                // Source-pool photo being dragged in: accept a drop anywhere on
                // the page (it appends, like double-click / PULL).
                if (deps.hasSourceDragItems()) {
                    e.preventDefault();
                    try { /** @type {DataTransfer} */ (e.dataTransfer).dropEffect = 'copy'; } catch (_) {}
                }
                return;
            }
            const c = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.img-container'));
            if (!c || c === dragging) return;
            e.preventDefault();
            try { /** @type {DataTransfer} */ (e.dataTransfer).dropEffect = 'move'; } catch (_) {}
            // Decide drop side based on horizontal position relative to the
            // hovered tile's center.
            const rect = c.getBoundingClientRect();
            const before = (e.clientX - rect.left) < rect.width / 2;
            if (lastDropTarget && lastDropTarget !== c) {
                lastDropTarget.classList.remove('drop-before', 'drop-after');
            }
            c.classList.toggle('drop-before', before);
            c.classList.toggle('drop-after', !before);
            lastDropTarget = c;
        });

        greenBox.addEventListener('dragleave', (e) => {
            // Only clear when actually leaving a tile, not when transitioning
            // between child elements of the same tile.
            const c = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.img-container'));
            if (!c) return;
            // If relatedTarget is inside the same tile, ignore.
            if (e.relatedTarget && c.contains(/** @type {Node} */ (e.relatedTarget))) return;
            c.classList.remove('drop-before', 'drop-after');
        });

        greenBox.addEventListener('drop', (e) => {
            if (!dragging) {
                // Source-pool drop → add the dragged photo(s) to the current page.
                const items = deps.takeSourceDragItems();
                if (items) {
                    e.preventDefault();
                    greenBox.classList.remove('dropzone--active');
                    prepareAndMove(items);
                }
                return;
            }
            e.preventDefault();
            const target = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.img-container'));
            if (!target || target === dragging) {
                clearDropMarkers();
                dragging.classList.remove('is-dragging');
                greenBox.classList.remove('dropzone--active');
                dragging = null; lastDropTarget = null;
                return;
            }
            const before = target.classList.contains('drop-before');
            clearDropMarkers();

            // Reorder albumPages[currentPage].photos using the source/target ids.
            deps.mutate('Reorder photos', () => {
                const page = /** @type {{ photos: any[] }} */ (store.get('albumPages')[store.get('currentPage')]);
                const photos = page.photos;
                const srcIdx = photos.findIndex(p => p.id === dragSrcId);
                const dstIdx = photos.findIndex(p => p.id === target.dataset.photoId);
                if (srcIdx === -1 || dstIdx === -1) return;
                const [moved] = photos.splice(srcIdx, 1);
                // After removal, the destination index may have shifted by one.
                let insertAt = photos.findIndex(p => p.id === target.dataset.photoId);
                if (!before) insertAt += 1;
                photos.splice(insertAt, 0, moved);
                renderGreenBox();
                deps.scheduleFilterUpdate();
            });

            dragging.classList.remove('is-dragging');
            greenBox.classList.remove('dropzone--active');
            dragging = null; lastDropTarget = null;
        });

        greenBox.addEventListener('dragend', () => {
            if (dragging) dragging.classList.remove('is-dragging');
            greenBox.classList.remove('dropzone--active');
            clearDropMarkers();
            dragging = null; lastDropTarget = null;
        });
    })();

    const btnRemoveSelected = document.getElementById("btnRemoveSelected");
    if (btnRemoveSelected) {
        btnRemoveSelected.onclick = () => {
            const currentPage = store.get('currentPage');
            const pageData = store.get('albumPages')[currentPage]; if (!pageData) return;
            // Selection now lives on the .img-container, not the inner img.
            const selectedContainers = /** @type {HTMLElement[]} */ (Array.from(greenBox.querySelectorAll('.img-container.selected')));
            if (selectedContainers.length === 0) return;
            const selectedIds = selectedContainers.map(c => c.dataset.photoId).filter(Boolean);
            deps.mutate(`Remove ${selectedIds.length} photo${selectedIds.length === 1 ? '' : 's'}`, () => {
                const page = /** @type {{ photos: any[] }} */ (pageData);
                for (const photoId of selectedIds) {
                    const photoObj = page.photos.find(p => p.id === photoId);
                    if (!photoObj) continue;
                    page.photos = page.photos.filter(p => p.id !== photoObj.id);
                    deps.removeFromPageMap(photoObj.id, currentPage);
                    const red = document.getElementById(photoObj.id);
                    if (red) { red.classList.remove("used"); red.style.opacity = "1"; }
                }
                renderGreenBox(); deps.scheduleFilterUpdate();
            });
        };
    }

    // ─── SORT THIS PAGE ──────────────────────────────────────────
    // Sorts only the current page's photos chronologically by EXIF capture
    // time. Uses the same resolver the global Auto-Fill uses, so it benefits
    // from the HR-then-proxy fallback that handles RAW/TIFF cases.
    const btnSortPage = /** @type {HTMLButtonElement | null} */ (document.getElementById('btnSortPage'));
    if (btnSortPage) {
        btnSortPage.addEventListener('click', async () => {
            const pageData = store.get('albumPages')[store.get('currentPage')];
            if (!pageData?.photos?.length) {
                deps.toast('Nothing on this page to sort', 'info');
                return;
            }
            if (pageData.photos.length === 1) {
                deps.toast('Only one photo — nothing to sort', 'info');
                return;
            }
            btnSortPage.disabled = true;
            try {
                // Snapshot a copy so we can detect "no change" and skip the
                // mutate() entry (keeps the undo history clean).
                const beforeOrder = pageData.photos.map(p => p.id);
                // sortPhotosByExif sorts the array in place by EXIF date with
                // filename fallback. Run on a clone first so we can compare.
                const clone = pageData.photos.slice();
                await deps.sortPhotosByExif(clone);
                const changed = clone.some((p, i) => p.id !== beforeOrder[i]);
                if (!changed) {
                    deps.toast('Page is already in chronological order', 'info');
                    return;
                }
                deps.mutate('Sort page by capture time', () => {
                    /** @type {{ photos: any[] }} */ (store.get('albumPages')[store.get('currentPage')]).photos = clone;
                    renderGreenBox();
                    deps.scheduleFilterUpdate();
                });
                deps.notify('Page sorted by capture time · Cmd+Z to undo', 'success', { duration: 4000 });
            } catch (e) {
                deps.toast('Sort failed: ' + _errMessage(e), 'error');
            } finally {
                btnSortPage.disabled = false;
            }
        });
    }

    const btnTeleportGlobal = document.getElementById("btnTeleportGlobal");
    if (btnTeleportGlobal) {
        btnTeleportGlobal.onclick = () => {
            const targetPage = parseInt(/** @type {HTMLSelectElement} */ (teleportSelect).value);
            const currentPage = store.get('currentPage');
            if (targetPage === currentPage) return;
            const albumPages = store.get('albumPages');
            const pageData = albumPages[currentPage];
            // Selection lives on .img-container now — same model as remove.
            const selectedContainers = /** @type {HTMLElement[]} */ (Array.from(greenBox.querySelectorAll('.img-container.selected')));
            if (selectedContainers.length === 0) return deps.showAlert("Select photos in the Green Box to teleport!");
            const selectedIds = selectedContainers.map(c => c.dataset.photoId).filter(Boolean);
            deps.mutate(`Teleport ${selectedIds.length} photo${selectedIds.length === 1 ? '' : 's'} to page ${targetPage}`, () => {
                if (targetPage > store.get('totalActivePages')) { store.set('totalActivePages', targetPage); updatePageDropdowns(); }
                if (!albumPages[targetPage]) albumPages[targetPage] = { photos: [], template: null };
                const page = /** @type {{ photos: any[] }} */ (pageData);
                const tgt = /** @type {{ photos: any[] }} */ (albumPages[targetPage]);
                for (const photoId of selectedIds) {
                    const photoObj = page.photos.find(p => p.id === photoId);
                    if (!photoObj) continue;
                    page.photos = page.photos.filter(p => p.id !== photoObj.id);
                    deps.removeFromPageMap(photoObj.id, currentPage);
                    tgt.photos.push(photoObj);
                    deps.addToPageMap(photoObj.id, targetPage);
                }
                renderGreenBox(); deps.scheduleFilterUpdate();
            });
        };
    }

    // ── Smart Auto-Fill (all pages) ─────────────────────────────────────────

    const btnAutoAll = document.getElementById("btnAutoAll");
    if (btnAutoAll) {
        btnAutoAll.addEventListener("click", async () => {
            const useDesired = /** @type {HTMLInputElement | null} */ (document.getElementById('chkDesiredSheets'))?.checked;
            const minVal = parseInt(/** @type {HTMLInputElement} */ (document.getElementById("minImgs")).value);
            const maxVal = parseInt(/** @type {HTMLInputElement} */ (document.getElementById("maxImgs")).value);
            const desiredVal = parseInt(/** @type {HTMLInputElement} */ (document.getElementById("desiredSheetsCount")).value);

            if (useDesired) {
                if (isNaN(desiredVal) || desiredVal < 1) return deps.showAlert("Enter a valid number of desired sheets (1 or more).");
            } else {
                if (isNaN(minVal) || isNaN(maxVal) || minVal > maxVal) return deps.showAlert("Invalid Min/Max values.");
            }

            const activeTemplateFolders = store.get('activeTemplateFolders');
            const activeLibrary = store.get('templateLibrary').filter(t => activeTemplateFolders.has(/** @type {string} */ (t.folderId)));
            if (activeLibrary.length === 0) return deps.showAlert("Load and check at least one Template folder first!");

            // ⚡ PERF (Task 2.2): build the available-photo list from photoCache
            // + a usedIds Set instead of querySelectorAll('.thumb-red:not(.used)').
            // The DOM query forced a layout reflow and read
            // .parentElement.dataset per node on a hot path; this is a pure
            // in-memory pass and lets auto-fill run without depending on
            // rendered DOM state.
            const albumPages = store.get('albumPages');
            const photoCache = /** @type {Record<string, any>} */ (store.get('photoCache'));
            const projectData = store.get('projectData');
            const activeImageFolders = store.get('activeImageFolders');
            const usedIdSet = new Set();
            Object.values(albumPages).forEach(pg => {
                if (pg && pg.photos) pg.photos.forEach(p => usedIdSet.add(p.id));
            });
            const availablePhotos = Object.entries(photoCache)
                .filter(([id, c]) => activeImageFolders.has(c.folderId) && !usedIdSet.has(id))
                .map(([id, c]) => ({ id, url: c.url }));
            if (availablePhotos.length === 0) return deps.showAlert("No unused photos left in active folders!");

            // ⚡ EXIF chronological order — most weddings flow
            // ceremony→reception and benefit hugely from time-ordered
            // auto-fill. The user can opt out for pre-sorted folders via the
            // #chkExifOrder checkbox.
            const exifToggle = /** @type {HTMLInputElement | null} */ (document.getElementById('chkExifOrder'));
            if (!exifToggle || exifToggle.checked) {
                deps.setStatus('Reading capture times…');
                await deps.sortPhotosByExif(availablePhotos);
            }

            deps.setStatus("Processing Auto-Fill…");

            // Build the list of "pull counts" per page up front. Two modes:
            //
            //   Desired-sheets ON  → distribute ALL available photos across
            //                        exactly desiredVal sheets. base =
            //                        floor(N/D); the remainder is spread by
            //                        handing out a +1 to a randomly-shuffled
            //                        subset of sheets so the heavy pages
            //                        aren't always front-loaded.
            //
            //   Desired-sheets OFF → original behavior. Pull a random number
            //                        in [min, max] per page until photos run
            //                        out.
            const pullCounts = [];
            if (useDesired) {
                const N = availablePhotos.length;
                const D = Math.min(desiredVal, N); // can't make more pages than photos
                const base = Math.floor(N / D);
                const remainder = N - base * D;
                // Sheets that receive the +1
                const bonusIdx = new Set();
                const order = Array.from({ length: D }, (_, i) => i);
                // Shuffle (Fisher–Yates)
                for (let i = order.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [order[i], order[j]] = [order[j], order[i]];
                }
                for (let i = 0; i < remainder; i++) bonusIdx.add(order[i]);
                for (let i = 0; i < D; i++) pullCounts.push(base + (bonusIdx.has(i) ? 1 : 0));
                if (D < desiredVal) {
                    deps.toast(`Only ${N} photos available — capping at ${D} sheets`, 'warning', { duration: 4000 });
                }
            } else {
                // Original Min/Max random walk
                let remaining = availablePhotos.length;
                while (remaining > 0) {
                    let n = Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal;
                    if (n > remaining) n = remaining;
                    pullCounts.push(n);
                    remaining -= n;
                }
            }

            // Build all page assignments off-DOM first, THEN commit in a
            // single mutate() so undo restores the entire pre-auto-fill state
            // in one shot.
            /** @type {Record<number, Page>} */
            const newPages = {};
            /** @type {string[]} */
            const usedIds = [];
            for (let pageIdx = 0; pageIdx < pullCounts.length; pageIdx++) {
                const pullCount = pullCounts[pageIdx];
                const selectedForPage = availablePhotos.splice(0, pullCount);
                if (selectedForPage.length === 0) break;

                // ⚡ Task 2.1: prefer the orientation cached on photoCache (set
                // when the thumbnail decoded). Only fall back to an off-DOM
                // probe for the rare photo whose proxy hasn't loaded yet.
                const analysisPromises = selectedForPage.map(item => {
                    const cached = photoCache[item.id]?.orient;
                    if (cached) return Promise.resolve({ ...item, orient: cached });
                    return new Promise((resolve) => {
                        const img = document.createElement("img"); img.style.cssText = "position: absolute; top: -9999px; left: -9999px; visibility: hidden;";
                        img.onload = () => {
                            const isH = img.naturalWidth >= img.naturalHeight;
                            if (photoCache[item.id]) photoCache[item.id].orient = isH ? 'h' : 'v';
                            document.body.removeChild(img);
                            resolve({ ...item, orient: isH ? 'h' : 'v' });
                        };
                        img.onerror = () => { if (img.parentNode) document.body.removeChild(img); resolve({ ...item, orient: 'h' }); };
                        document.body.appendChild(img); img.src = item.url;
                    });
                });
                const analyzedPhotos = /** @type {any[]} */ (await Promise.all(analysisPromises));
                const syncedPhotos = analyzedPhotos.map(res => {
                    const rotation = (projectData.imageRotations || {})[res.id] || 0;
                    if (rotation === 90 || rotation === 270) res.orient = (res.orient === 'h') ? 'v' : 'h';
                    return res;
                });

                const hCount = syncedPhotos.filter(p => p.orient === 'h').length;
                const vCount = syncedPhotos.filter(p => p.orient === 'v').length;
                const matchingTemplates = activeLibrary.filter(t => t.h === hCount && t.v === vCount);
                const tpl = matchingTemplates.length > 0
                    ? matchingTemplates[Math.floor(Math.random() * matchingTemplates.length)]
                    : null;
                newPages[pageIdx + 1] = { photos: syncedPhotos, template: tpl };
                syncedPhotos.forEach(p => usedIds.push(p.id));
            }

            const totalNewPages = Math.max(Object.keys(newPages).length, 1);

            deps.mutate(useDesired ? `Auto-Fill (desired ${totalNewPages} sheets)` : 'Auto-Fill all pages', () => {
                store.set('albumPages', newPages);
                store.set('totalActivePages', totalNewPages);
                deps.rebuildPhotoPageMap();
                updatePageDropdowns(); changePage(1);
                usedIds.forEach(id => { const r = document.getElementById(id); if (r) r.classList.add('used'); });
            });

            deps.notify(`Auto-Fill complete — ${totalNewPages} pages allocated. Open Tab 7 (Export Studio) to review.`, "success", { duration: 6000 });
        });
    }

    // Cross-disable Min/Max ↔ Desired sheets so the user always sees which
    // inputs are active. Updated reactively on toggle and on initial load.
    function _syncAutoFillModeUI() {
        const desiredOn = /** @type {HTMLInputElement | null} */ (document.getElementById('chkDesiredSheets'))?.checked;
        const minEl = /** @type {HTMLInputElement | null} */ (document.getElementById('minImgs'));
        const maxEl = /** @type {HTMLInputElement | null} */ (document.getElementById('maxImgs'));
        const cntEl = /** @type {HTMLInputElement | null} */ (document.getElementById('desiredSheetsCount'));
        if (minEl) minEl.disabled = !!desiredOn;
        if (maxEl) maxEl.disabled = !!desiredOn;
        if (cntEl) cntEl.disabled = !desiredOn;
    }
    document.getElementById('chkDesiredSheets')?.addEventListener('change', _syncAutoFillModeUI);
    _syncAutoFillModeUI();

    return { updatePageDropdowns, changePage, renderGreenBox, prepareAndMove };
}

module.exports = { createAlbumPages };
