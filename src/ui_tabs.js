// @ts-check
// ui_tabs.js — the tab bar (pane switching + per-tab lazy first paints),
// the thumbnail-size sliders, and the empty-state action forwarder,
// extracted from main.js (Phase 2 split).
//
// ⚡ Tab 6 (Photos) is rendered lazily on first visit; the flag lives here
// and is exposed as isTab6Rendered/invalidateTab6 so the photo library and
// project restore can force a rebuild. Tab 5 (Tools) repaints its status
// pills on every visit and first-paints the library + plugins panels once.

// Thumbnail-size sliders → CSS custom properties. The four asset grids
// share --wp-thumb-size deliberately (one zoom level across Tabs 2/3/6).
const _sliderVars = [
    ['redSlider',        '--red-thumb-size'],
    ['greenSlider',      '--green-thumb-size'],
    ['whiteSlider',      '--white-thumb-size'],
    ['yellowSlider',     '--yellow-thumb-size'],
    ['wallpaperSlider',  '--wp-thumb-size'],
    ['pngSlider',        '--wp-thumb-size'],
    ['maskedSlider',     '--wp-thumb-size'],
    ['photosSlider',     '--wp-thumb-size'],
    ['storyboardSlider', '--sb-thumb-size'],
];

/**
 * Wire the tab bar and the small view chrome around it.
 *
 * @param {object} deps
 * @param {() => void} deps.renderStoryboard      refresh Tab 7 on entry
 * @param {() => void} deps.renderPhotosGrid      lazy first paint of Tab 6
 * @param {() => void} deps.refreshToolsBarStatus Tab 5 status pills, every visit
 * @param {() => void} deps.refreshLibraryView    Tab 5 first paint
 * @param {() => void} deps.refreshPluginsView    Tab 5 first paint
 */
function createTabs(deps) {
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    // Lazy flags — Tab 6's grid and Tab 5's library/plugins panels are only
    // built when the user first opens them.
    let tab6Rendered = false;
    let toolsPainted = false;

    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            const targetId = btn.getAttribute('data-target');
            const targetPane = targetId ? document.getElementById(targetId) : null;
            if (targetPane) targetPane.classList.add('active');

            if (targetId === 'tab-export') deps.renderStoryboard();

            // ⚡ Lazy render: build Tab 6 grid only on first visit
            if (targetId === 'tab-photos' && !tab6Rendered) {
                tab6Rendered = true;
                deps.renderPhotosGrid();
            }

            if (targetId === 'tab-tools') {
                // Status pills should always reflect current state, even after
                // the first paint, so refresh tools-bar status on every visit.
                deps.refreshToolsBarStatus();
                if (!toolsPainted) {
                    toolsPainted = true;
                    // Defer to next tick so the tab is visible first.
                    setTimeout(() => { deps.refreshLibraryView(); deps.refreshPluginsView(); }, 50);
                }
            }
        });
    });

    // Empty-state action buttons: a single delegated listener forwards a click
    // on any `.empty-state__action[data-load]` to the real load button it
    // names, so the empty states are actionable without duplicating the load
    // handlers.
    document.addEventListener('click', (e) => {
        const btn = /** @type {HTMLElement | null} */ (
            /** @type {HTMLElement} */ (e.target).closest('.empty-state__action[data-load]'));
        if (!btn) return;
        const target = document.getElementById(/** @type {string} */ (btn.dataset.load));
        if (target) target.click();
    });

    _sliderVars.forEach(([id, cssVar]) => {
        const slider = document.getElementById(id);
        if (slider) slider.oninput = (e) => document.documentElement.style.setProperty(
            cssVar, /** @type {HTMLInputElement} */ (e.target).value + 'px');
    });

    return {
        isTab6Rendered: () => tab6Rendered,
        invalidateTab6: () => { tab6Rendered = false; },
    };
}

module.exports = { createTabs };
