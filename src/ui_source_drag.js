// @ts-check
// ui_source_drag.js — source-pool selection clicks + native drag-out,
// extracted from main.js (Phase 2 split).
//
// ⚡ One delegated pointerup on the source pool replaces a listener per image
// (with 500+ images that eliminated 500+ live listeners): a single click
// toggles selection (after the 300 ms double-click window), a double click
// places the photo on the current page.
//
// Dragging a source or Photos-tab thumbnail starts a NATIVE OS file drag
// carrying the ORIGINAL high-res file, so dropping onto Photoshop (or
// Finder) behaves just like dragging from Finder. Multi-selection drags the
// whole selected set. (In-app placement works via double-click and
// Auto-Fill; there is no in-app HTML5 drag from the source pool.)

/**
 * @param {object} deps
 * @param {(items: Array<{id: string, url: string}>) => void} deps.prepareAndMove
 * @param {(panel: string) => void} deps.setActiveMatchPanel
 * @param {() => void} deps.scheduleFilterUpdate
 * @param {(id: string) => string | null} deps.photoNativePath
 * @param {(paths: string[]) => void} deps.startNativeDrag
 */
function createSourceDrag(deps) {
    const redBox = /** @type {HTMLElement} */ (document.getElementById('redBox'));
    const photosGrid = document.getElementById('photosGrid');

    // ⚡ Per-image click state map for event-delegated double-click detection
    /** @type {Record<string, { count: number, timer: any }>} */
    const clickState = {};

    redBox.addEventListener('pointerup', (e) => {
        const target = /** @type {HTMLElement} */ (e.target);
        if (target.closest('.btn-rotate-red')) return;
        const wrapper = target.closest('.img-wrapper-red');
        if (!wrapper) return;
        const img = /** @type {HTMLImageElement | null} */ (wrapper.querySelector('.thumb-red'));
        if (!img) return;
        const safeId = img.id;

        if (!clickState[safeId]) clickState[safeId] = { count: 0, timer: null };
        const state = clickState[safeId];
        state.count++;

        if (state.count === 1) {
            state.timer = setTimeout(() => {
                state.count = 0;
                img.classList.toggle("selected");
                deps.setActiveMatchPanel('source'); // B2: working in the source panel
                deps.scheduleFilterUpdate(); // selection drives template matching
            }, 300);
        } else if (state.count === 2) {
            clearTimeout(state.timer);
            state.count = 0;
            deps.prepareAndMove([{ id: img.id, url: img.src }]);
        }
    });

    redBox.addEventListener('dragstart', (e) => {
        const img = /** @type {HTMLElement | null} */ (
            /** @type {HTMLElement} */ (e.target).closest('.thumb-red'));
        if (!img) return;
        const selected = Array.from(redBox.querySelectorAll('.thumb-red.selected'));
        const ids = (img.classList.contains('selected') && selected.length > 0)
            ? selected.map(el => el.id)
            : [img.id];
        const paths = /** @type {string[]} */ (ids.map(id => deps.photoNativePath(id)).filter(Boolean));
        if (paths.length === 0) return;
        e.preventDefault(); // cancel the default thumbnail (proxy) drag
        deps.startNativeDrag(paths);
    });

    // Photos tab (Tab 6) → Photoshop native drag-out (original file).
    if (photosGrid) {
        photosGrid.addEventListener('dragstart', (e) => {
            const card = /** @type {HTMLElement | null} */ (
                /** @type {HTMLElement} */ (e.target).closest('.wp-card'));
            if (!card) return;
            const id = card.dataset.photoId;
            const p = id ? deps.photoNativePath(id) : null;
            if (!p) return;
            e.preventDefault();
            deps.startNativeDrag([p]);
        });
    }
}

module.exports = { createSourceDrag };
