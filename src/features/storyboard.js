// @ts-check
// features/storyboard.js — the Tab 7 virtual storyboard engine, extracted
// from main.js (Phase 2 split).
//
// renderStoryboard() is a pure DOM builder: one card per composed page
// (template preview + photo tiles), rebuilt wholesale into the stable
// storyboardGrid container. Interaction is delegated ONCE onto that
// container and survives every innerHTML rebuild, split into two cleanly
// separated systems: SELECTION via native `click` (multi-select keyed on
// photoId so it survives moves between pages) and DRAG via
// pointerdown/move/up with a movement threshold — pointer capture is only
// acquired after the threshold so tile :hover keeps working. A drop is one
// undoable mutate(): photos are pulled out of every page they occupy and
// spliced into the target position.
//
// DOM-owning module with explicit store access; injected: the history
// mutate(), the photo→page reverse-map helpers, the view refreshes a move
// triggers, and the proof re-apply (proof rendering still lives in main.js).

/**
 * @typedef {import('../state/store').Store} Store
 */

const { escapeHtml, _generativePreviewSvg } = require('../renderer_pure');

/**
 * Wire the storyboard. Binds the delegated DnD/selection listeners and the
 * Refresh button.
 *
 * @param {Store} store
 * @param {object} deps
 * @param {<T>(label: string, fn: () => T) => T} deps.mutate  undoable mutation wrapper
 * @param {(photoId: string, pageNum: number) => void} deps.addToPageMap
 * @param {(photoId: string, pageNum: number) => void} deps.removeFromPageMap
 * @param {() => void} deps.renderGreenBox
 * @param {() => void} deps.scheduleFilterUpdate
 * @param {() => void} deps.reapplyProofs  re-swap cached page proofs into the rebuilt DOM
 */
function createStoryboard(store, deps) {
    const storyboardGrid = document.getElementById("storyboardGrid");

    // ─── DRAG STATE ──────────────────────────────────────────────────────────
    /** @type {{ ghost: HTMLElement, ids: string[], pointerId: number, sourcePhotoId: string } | null} */
    let _sbDrag = null;
    /** @type {{ el: HTMLElement, before: boolean } | null} */
    let _sbDrop = null; // last known valid drop target

    // ─── SELECTION STATE ─────────────────────────────────────────────────────
    // Multi-select is keyed on photoId (globally unique) rather than
    // (page, idx) so it survives moves between pages.
    const _sbSelected = new Set();

    function _sbClearSelection() {
        _sbSelected.clear();
        document.querySelectorAll('.sb-photo-item.is-selected')
            .forEach(el => el.classList.remove('is-selected'));
    }

    /** @param {string} photoId @param {boolean} on */
    function _sbSetSelected(photoId, on) {
        if (on) _sbSelected.add(photoId); else _sbSelected.delete(photoId);
        document.querySelectorAll(`.sb-photo-item[data-photo-id="${photoId}"]`)
            .forEach(el => el.classList.toggle('is-selected', on));
    }

    // Apply current selection state to all rendered tiles. Called from
    // renderStoryboard() so a re-render does not lose the visual highlight.
    function _sbReapplySelectionToDom() {
        document.querySelectorAll('.sb-photo-item').forEach(el => {
            el.classList.toggle('is-selected', _sbSelected.has(/** @type {HTMLElement} */ (el).dataset.photoId));
        });
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────
    /** @param {number} x @param {number} y */
    function _sbHitTest(x, y) {
        const items = document.querySelectorAll('.sb-photo-item');
        for (const el of items) {
            const r = el.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
                return { el: /** @type {HTMLElement} */ (el), before: x < r.left + r.width / 2 };
            }
        }
        return null;
    }
    // Forgiving tile lookup for SELECTION clicks. If e.target is the tile or any
    // descendant, closest() finds it instantly. Otherwise we look for the visually
    // nearest tile within _SB_CLICK_RADIUS px — covers the case where the user's
    // click landed in the inter-tile gap, on the selection glow, or on the
    // outline that sits outside the actual element box.
    const _SB_CLICK_RADIUS = 14; // px — generous, ~quarter of default tile size
    /** @param {MouseEvent} e @returns {HTMLElement | null} */
    function _sbFindClickedTile(e) {
        const direct = /** @type {HTMLElement} */ (e.target).closest('.sb-photo-item');
        if (direct) return /** @type {HTMLElement} */ (direct);
        const x = e.clientX, y = e.clientY;
        /** @type {HTMLElement | null} */
        let best = null; let bestDist = Infinity;
        document.querySelectorAll('.sb-photo-item').forEach(el => {
            const r = el.getBoundingClientRect();
            // Distance from point to rectangle (0 if inside, else perpendicular).
            const cx = Math.max(r.left, Math.min(x, r.right));
            const cy = Math.max(r.top,  Math.min(y, r.bottom));
            const d = Math.hypot(x - cx, y - cy);
            if (d <= _SB_CLICK_RADIUS && d < bestDist) {
                best = /** @type {HTMLElement} */ (el); bestDist = d;
            }
        });
        return best;
    }
    function _sbClearBars() {
        document.querySelectorAll('.sb-photo-item').forEach(el =>
            el.classList.remove('drop-before', 'drop-after')
        );
    }

    // ─── DOM BUILDER — pure, no listener management ──────────────────────────
    // renderStoryboard() only builds HTML. The DnD listeners are attached ONCE
    // via the IIFE below and survive every innerHTML rebuild because they sit
    // on the stable storyboardGrid container (event delegation).
    function renderStoryboard() {
        if (!storyboardGrid) return;

        // Abort any drag in progress before wiping the DOM
        if (_sbDrag) {
            try { _sbDrag.ghost.remove(); } catch (e) {}
            _sbDrag = null; _sbDrop = null;
        }

        const albumPages = store.get('albumPages');
        const totalActivePages = store.get('totalActivePages');
        const projectData = store.get('projectData');

        let hasPages = false;
        const frag = document.createDocumentFragment();

        for (let i = 1; i <= totalActivePages; i++) {
            const pageData = albumPages[i];
            if (!pageData || !pageData.template) continue;
            hasPages = true;

            const card = document.createElement("div");
            card.className = "sb-page-card";

            const header = document.createElement("div");
            header.className = "sb-page-header";
            header.innerText = `Page ${String(i).padStart(3, '0')}`;
            card.appendChild(header);

            const preview = document.createElement("div");
            preview.className = "sb-template-preview";
            if (pageData.template._generative) {
                preview.innerHTML = _generativePreviewSvg(pageData.template);
            } else {
                preview.innerHTML = `<img src="${escapeHtml(/** @type {string} */ (pageData.template.url))}" alt="Template">`;
            }
            card.appendChild(preview);

            const pgrid = document.createElement("div");
            pgrid.className = "sb-photo-grid";
            pgrid.dataset.pageIdx = String(i);

            if (pageData.photos && pageData.photos.length > 0) {
                pageData.photos.forEach((photo, photoIdx) => {
                    const pItem = document.createElement("div");
                    pItem.className = "sb-photo-item";
                    pItem.dataset.pageIdx  = String(i);
                    pItem.dataset.photoId  = photo.id;
                    pItem.dataset.photoIdx = String(photoIdx);
                    const rot = (projectData.imageRotations || {})[/** @type {string} */ (photo.id)] || 0;
                    pItem.innerHTML = `<img src="${photo.url}" draggable="false"${rot ? ` style="transform:rotate(${rot}deg);"` : ""}>`;
                    pgrid.appendChild(pItem);
                });
            } else {
                const empty = document.createElement("div");
                empty.className = "placeholder-row";
                empty.innerText = "No Photos";
                pgrid.appendChild(empty);
            }

            card.appendChild(pgrid);
            frag.appendChild(card);
        }

        storyboardGrid.innerHTML = "";
        storyboardGrid.appendChild(hasPages ? frag
            : Object.assign(document.createElement("div"), {
                className: "empty-state",
                innerHTML: `<div class="empty-state__icon">🎞️</div>
                    <div class="empty-state__title">Storyboard is empty</div>
                    <div class="empty-state__hint">Run Auto-Fill in the Album tab, then refresh the storyboard to review your spread before rendering.</div>`
            })
        );

        // Re-apply selection rings after the DOM is freshly rebuilt.
        _sbReapplySelectionToDom();

        // Re-apply any cached page proofs so a renderStoryboard() rebuild
        // doesn't wipe the composite previews back to static template thumbs.
        deps.reapplyProofs();
    }

    // ─── DnD ENGINE — attached ONCE, never re-attached ───────────────────────
    // WHY ONCE: storyboardGrid is a const pointing to a fixed DOM node.
    // Event delegation means bubbled events from any child (including newly
    // rendered .sb-photo-item nodes) always reach storyboardGrid.
    // The broken "clone-replace + re-attach" approach replaced the DOM node
    // while the const kept pointing to the detached original, so
    // renderStoryboard() was writing to an element that was no longer in the
    // page — invisible to the user.
    ;(function _sbInitDnd() {
        if (!storyboardGrid) return;
        const grid = storyboardGrid; // non-null within the DnD engine

        // ── Architecture ─────────────────────────────────────────────────────
        // We split the interaction into two cleanly separated systems:
        //
        //   1. SELECTION  — handled by native `click` events. The browser only
        //      fires a click when pointerdown and pointerup happen on the same
        //      element with negligible movement, so click-vs-drag detection is
        //      effectively free, and hover state on other tiles is never broken.
        //
        //   2. DRAG       — handled by pointerdown/move/up. Pointer capture is
        //      only acquired AFTER the user has moved past _DRAG_THRESHOLD; up
        //      to that point the grid does not steal pointer events from any
        //      other tile so :hover keeps working.
        //
        // The previous implementation captured on every pointerdown and ran a
        // home-grown click detector inside pointerup, which both broke hover
        // and wiped the selection on near-miss shift-clicks.

        const _DRAG_THRESHOLD = 5;

        // Pre-drag state: pointer is down on a tile but threshold not yet crossed
        /** @type {{ startX: number, startY: number, pointerId: number, el: HTMLElement } | null} */
        let _sbPending = null;
        // Set true on pointerup that ENDED a real drag, cleared on next click
        // cycle. Used to suppress the synthetic click event a drag generates
        // on most browsers.
        let _sbSuppressNextClick = false;

        /** @param {PointerEvent} e */
        function _sbStartDrag(e) {
            // Promote the pending pointerdown to an actual drag.
            const pItem = /** @type {NonNullable<typeof _sbPending>} */ (_sbPending).el;
            const pointedId = /** @type {string} */ (pItem.dataset.photoId);
            const ids = _sbSelected.has(pointedId)
                ? /** @type {string[]} */ (Array.from(_sbSelected))
                : [pointedId];

            const ghost = document.createElement('div');
            ghost.className = 'sb-drag-ghost';
            ghost.style.left = (e.clientX - 30) + 'px';
            ghost.style.top  = (e.clientY - 30) + 'px';
            const srcImg = /** @type {HTMLImageElement | null} */ (pItem.querySelector('img'));
            if (srcImg) {
                const gi = document.createElement('img');
                gi.src = srcImg.src;
                if (srcImg.style.cssText) gi.style.cssText = srcImg.style.cssText;
                ghost.appendChild(gi);
            }
            if (ids.length > 1) {
                const badge = document.createElement('div');
                badge.className = 'sb-drag-ghost__count';
                badge.textContent = '+' + ids.length;
                ghost.appendChild(badge);
            }
            document.body.appendChild(ghost);

            ids.forEach(id => {
                document.querySelectorAll(`.sb-photo-item[data-photo-id="${id}"]`)
                    .forEach(el => el.classList.add('sb-dragging'));
            });

            _sbDrag = {
                ghost,
                ids,
                pointerId: /** @type {NonNullable<typeof _sbPending>} */ (_sbPending).pointerId,
                sourcePhotoId: pointedId
            };
            _sbPending = null;

            // C.3: highlight the storyboard as the active drop zone (same accent
            // dashed outline used by the green box) so the target is unambiguous.
            grid.classList.add('dropzone--active');

            // NOW capture — events from any tile route to the grid for the rest
            // of the drag. Before this point, individual tiles still get hover.
            try { grid.setPointerCapture(_sbDrag.pointerId); } catch (_) {}
        }

        // ── POINTER DOWN ─────────────────────────────────────────────────────
        // Just remember the start position. No preventDefault, no capture, no
        // selection mutation — that is the click handler's job.
        storyboardGrid.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            // Use forgiving hit-test so a press that lands in the inter-tile gap
            // (parent .sb-photo-grid) or on the selection glow still snaps to
            // the nearest tile. The previous closest('.sb-photo-item') call
            // returned null in those cases, killing the drag pipeline before it
            // ever started.
            const pItem = _sbFindClickedTile(e);
            if (!pItem) return;

            if (e.shiftKey || e.metaKey || e.ctrlKey) {
                return;
            }

            _sbPending = {
                startX: e.clientX,
                startY: e.clientY,
                pointerId: e.pointerId,
                el: pItem
            };
            _sbDrop = null;
        });

        // ── POINTER MOVE ─────────────────────────────────────────────────────
        storyboardGrid.addEventListener('pointermove', (e) => {
            // Pre-drag: see whether we've crossed the drag threshold yet.
            if (_sbPending) {
                const dx = e.clientX - _sbPending.startX;
                const dy = e.clientY - _sbPending.startY;
                const dist = Math.hypot(dx, dy);
                if (dist < _DRAG_THRESHOLD) return;
                _sbStartDrag(e);
            }

            if (!_sbDrag) return;

            _sbDrag.ghost.style.left = (e.clientX - 30) + 'px';
            _sbDrag.ghost.style.top  = (e.clientY - 30) + 'px';

            _sbClearBars();
            const hit = _sbHitTest(e.clientX, e.clientY);
            const draggingSet = new Set(_sbDrag.ids);
            if (hit && !draggingSet.has(/** @type {string} */ (hit.el.dataset.photoId))) {
                hit.el.classList.add(hit.before ? 'drop-before' : 'drop-after');
                _sbDrop = hit;
            } else {
                _sbDrop = null;
            }
        });

        // ── POINTER UP ────────────────────────────────────────────────────────
        storyboardGrid.addEventListener('pointerup', (e) => {
            // Pre-drag, never moved enough → leave the click handler to it.
            if (_sbPending && !_sbDrag) {
                _sbPending = null;
                return;
            }
            if (!_sbDrag) return;

            try { storyboardGrid.releasePointerCapture(_sbDrag.pointerId); } catch (_) {}

            // Tear down the drag visuals.
            const ids = _sbDrag.ids;
            ids.forEach(pid => {
                document.querySelectorAll(`.sb-photo-item[data-photo-id="${pid}"]`)
                    .forEach(el => el.classList.remove('sb-dragging'));
            });
            try { _sbDrag.ghost.remove(); } catch (_) {}
            _sbClearBars();
            storyboardGrid.classList.remove('dropzone--active');

            const drop = _sbHitTest(e.clientX, e.clientY) || _sbDrop;
            const draggingSet = new Set(ids);
            if (drop && !draggingSet.has(/** @type {string} */ (drop.el.dataset.photoId))) {
                const targetPageIdx = parseInt(/** @type {string} */ (drop.el.dataset.pageIdx));
                const targetPhotoId = drop.el.dataset.photoId;
                const insertBefore = drop.before;
                const albumPages = store.get('albumPages');
                const targetPage = albumPages[targetPageIdx];
                if (targetPage) {
                    deps.mutate(`Move ${ids.length} photo${ids.length === 1 ? '' : 's'}`, () => {
                        /** @type {{ photo: any, sourcePage: number, sourceIdx: number }[]} */
                        const grabbed = [];
                        Object.entries(albumPages).forEach(([pageNumStr, page]) => {
                            if (!page || !page.photos) return;
                            const pageNum = parseInt(pageNumStr);
                            /** @type {any[]} */
                            const stillThere = [];
                            page.photos.forEach((p, idx) => {
                                if (draggingSet.has(/** @type {string} */ (p.id))) {
                                    grabbed.push({ photo: p, sourcePage: pageNum, sourceIdx: idx });
                                    deps.removeFromPageMap(/** @type {string} */ (p.id), pageNum);
                                } else {
                                    stillThere.push(p);
                                }
                            });
                            page.photos = stillThere;
                        });

                        const tp = /** @type {{ photos: any[] }} */ (targetPage);
                        let tgtIdx = tp.photos.findIndex(p => p.id === targetPhotoId);
                        if (tgtIdx === -1) tgtIdx = tp.photos.length;
                        else if (!insertBefore) tgtIdx++;

                        grabbed.sort((a, b) => (a.sourcePage - b.sourcePage) || (a.sourceIdx - b.sourceIdx));
                        grabbed.forEach((g, i) => {
                            tp.photos.splice(tgtIdx + i, 0, g.photo);
                            deps.addToPageMap(g.photo.id, targetPageIdx);
                        });

                        renderStoryboard();
                        deps.renderGreenBox();
                        deps.scheduleFilterUpdate();
                    });
                }
            }

            // Suppress the click event the OS will fire for this gesture so it
            // does not also re-toggle selection on the source tile.
            _sbSuppressNextClick = true;

            _sbDrag = null;
            _sbDrop = null;
        });

        // ── POINTER CANCEL — UXP modal opened mid-drag etc. ──────────────────
        storyboardGrid.addEventListener('pointercancel', () => {
            if (_sbDrag) {
                try { _sbDrag.ghost.remove(); } catch (e) {}
                (_sbDrag.ids || []).forEach(pid => {
                    document.querySelectorAll(`.sb-photo-item[data-photo-id="${pid}"]`)
                        .forEach(el => el.classList.remove('sb-dragging'));
                });
            }
            _sbClearBars();
            storyboardGrid.classList.remove('dropzone--active');
            _sbPending = null;
            _sbDrag = null;
            _sbDrop = null;
        });

        // ── CLICK — selection ─────────────────────────────────────────────────
        // Bound on the grid (event delegation). The browser only fires a click
        // when the gesture stayed effectively in place, so we don't have to
        // re-implement that logic.
        storyboardGrid.addEventListener('click', (e) => {
            if (_sbSuppressNextClick) {
                _sbSuppressNextClick = false;
                return;
            }

            // Forgiving hit-test: tolerate clicks in the gap or on the selection
            // glow by snapping to the nearest tile within _SB_CLICK_RADIUS.
            const pItem = _sbFindClickedTile(e);
            const hasModifier = e.shiftKey || e.metaKey || e.ctrlKey;

            if (!pItem) {
                if (!hasModifier) _sbClearSelection();
                return;
            }

            const id = /** @type {string} */ (pItem.dataset.photoId);
            if (hasModifier) {
                _sbSetSelected(id, !_sbSelected.has(id));
            } else {
                const wasOnlySelected = _sbSelected.size === 1 && _sbSelected.has(id);
                _sbClearSelection();
                if (!wasOnlySelected) _sbSetSelected(id, true);
            }
        });

        // ── KEYBOARD: Escape clears selection (only when Tab 7 is active) ────
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && _sbSelected.size > 0) {
                const exportPane = document.getElementById('tab-export');
                if (exportPane && exportPane.classList.contains('active')) {
                    _sbClearSelection();
                }
            }
        });
    })();

    const btnRefreshStoryboard = document.getElementById("btnRefreshStoryboard");
    if (btnRefreshStoryboard) btnRefreshStoryboard.addEventListener("click", () => renderStoryboard());

    return { renderStoryboard };
}

module.exports = { createStoryboard };
