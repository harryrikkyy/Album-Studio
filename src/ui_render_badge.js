// @ts-check
// ui_render_badge.js — the floating render-progress badge, extracted from
// main.js (Phase 2 split). Pure DOM over the render store slices: mounted
// in the Tab 7 export toolbar when a queue is active, removed when idle.
// The cancel button empties the live queue array in place (the render
// worker in features/render_queue.js holds the same reference).

/** @typedef {import('./state/store').Store} Store */

/**
 * @param {Store} store
 */
function createRenderBadge(store) {
    function updateBadge() {
        let badge = document.getElementById('renderBadge');
        const renderQueue = store.get('renderQueue');
        const renderActive = store.get('renderActive');
        const renderStats = store.get('renderStats');
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
        /** @type {HTMLElement} */ (badge.querySelector('.render-badge__cancel')).onclick = () => {
            renderStats.cancelled = true;
            renderQueue.length = 0;
        };
    }
    return { updateBadge };
}

module.exports = { createRenderBadge };
