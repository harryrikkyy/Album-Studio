// @ts-check
// ui_resizers.js — the draggable panel dividers, extracted from main.js
// (Phase 2 split). Pure DOM, no state: each divider drags its neighbouring
// panel's width (or the top row's height) via pointer capture. Sizes are not
// persisted — the opt-in stage layout in ui_layout.js has its own
// CSS-var-based resizers with persistence.

/**
 * @param {string} resizerId
 * @param {string} leftBoxId
 * @param {string} rowContainerId
 * @param {number} [minW]
 * @param {number} [maxWOffset]
 */
function setupResizer(resizerId, leftBoxId, rowContainerId, minW = 150, maxWOffset = 150) {
    const resizer = document.getElementById(resizerId); const leftBox = document.getElementById(leftBoxId); const rowContainer = document.getElementById(rowContainerId);
    if (!resizer || !leftBox || !rowContainer) return;
    resizer.style.cursor = "col-resize";
    resizer.addEventListener("pointerdown", (e) => {
        resizer.setPointerCapture(e.pointerId); document.body.style.cursor = "col-resize";
        const onMove = (/** @type {PointerEvent} */ ev) => { const rect = rowContainer.getBoundingClientRect(); const w = ev.clientX - rect.left; if (w > minW && w < rect.width - maxWOffset) { leftBox.style.width = w + "px"; leftBox.style.flex = "none"; } };
        const onUp = (/** @type {PointerEvent} */ ev) => { resizer.releasePointerCapture(ev.pointerId); resizer.removeEventListener("pointermove", onMove); resizer.removeEventListener("pointerup", onUp); document.body.style.cursor = "default"; };
        resizer.addEventListener("pointermove", onMove); resizer.addEventListener("pointerup", onUp);
    });
}

/**
 * @param {string} resizerId
 * @param {string} topRowId
 */
function setupHorizontalResizer(resizerId, topRowId) {
    const resizer = document.getElementById(resizerId); const topRow = document.getElementById(topRowId);
    if (!resizer || !topRow) return; let isResizing = false;
    resizer.addEventListener("pointerdown", (e) => { isResizing = true; resizer.setPointerCapture(e.pointerId); document.body.style.cursor = "row-resize"; e.preventDefault(); });
    resizer.addEventListener("pointermove", (e) => { if (!isResizing) return; const containerTop = topRow.getBoundingClientRect().top; const newHeight = e.clientY - containerTop; if (newHeight > 100 && newHeight < window.innerHeight - 150) { topRow.style.flex = "none"; topRow.style.height = newHeight + "px"; } });
    resizer.addEventListener("pointerup", (e) => { if (isResizing) { isResizing = false; resizer.releasePointerCapture(e.pointerId); document.body.style.cursor = "default"; } });
}

/** Bind every panel divider in index.html. Idempotent per element set. */
function initResizers() {
    setupResizer("topResizer", "greenWrapper", "topRow", 150, 150); setupResizer("bottomResizer", "redWrapper", "bottomRow", 150, 150);
    setupResizer("redFolderResizer", "redFolderPanel", "redFolderContainer", 40, 50); setupResizer("whiteFolderResizer", "whiteFolderPanel", "whiteFolderContainer", 40, 50);
    setupResizer("wpResizer", "wpFolderContainer", "wpRow", 100, 150); setupHorizontalResizer("resizerHorizontal", "topRow");
    setupResizer("pngResizer", "pngFolderContainer", "pngRow", 100, 150); setupResizer("maskedResizer", "maskedFolderContainer", "maskedRow", 100, 150);
    setupResizer("photosResizer", "photosFolderContainer", "photosRow", 100, 150);
}

module.exports = { initResizers };
