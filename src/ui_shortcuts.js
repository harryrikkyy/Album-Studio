// @ts-check
// ui_shortcuts.js — global keyboard shortcuts + the "?" help dialog,
// extracted from main.js (Phase 2 split).
//
// Single delegated keydown handler. Ignores keystrokes when the user is
// editing a form field. Modifier-aware: Cmd/Ctrl keys for power actions,
// plain keys (J/K/?) for navigation. Designed to be discoverable through "?".
// Cmd/Ctrl+S/O/E are routed by clicking the real buttons so they stay in
// lockstep with whatever those buttons do.

/**
 * @typedef {import('./state/store').Store} Store
 */

const { _isEditingTarget } = require('./renderer_pure');

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
    let dlg = /** @type {HTMLDialogElement | null} */ (document.getElementById('shortcutHelpDialog'));
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

/**
 * Install the global keydown handler.
 *
 * @param {Store} store
 * @param {object} deps
 * @param {() => void} deps.undo
 * @param {() => void} deps.redo
 * @param {(pageNum: number) => void} deps.changePage
 * @param {(index: number, scroll?: boolean) => void} deps.setPreview
 * @param {() => void} deps.renderStoryboard
 */
function createShortcuts(store, deps) {
    document.addEventListener('keydown', (e) => {
        // Don't hijack typing.
        if (_isEditingTarget(/** @type {any} */ (e.target))) {
            // Allow undo/redo even when an input is focused.
            if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                if (e.shiftKey) deps.redo(); else deps.undo();
            }
            return;
        }

        const cmd = e.metaKey || e.ctrlKey;

        // Undo / Redo
        if (cmd && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            if (e.shiftKey) deps.redo(); else deps.undo();
            return;
        }

        // Tab switching: Cmd/Ctrl + 1..7
        if (cmd && /^[1-7]$/.test(e.key)) {
            e.preventDefault();
            const targets = ['tab-album','tab-wallpapers','tab-png','tab-masked','tab-tools','tab-photos','tab-export'];
            const btn = /** @type {HTMLElement | null} */ (document.querySelector(`.tab-btn[data-target="${targets[parseInt(e.key) - 1]}"]`));
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
            deps.changePage(store.get('currentPage') - 1);
            return;
        }
        if (e.key === 'k' || e.key === 'ArrowRight') {
            e.preventDefault();
            deps.changePage(store.get('currentPage') + 1);
            return;
        }

        // Template hotpicks: 1..5 selects from current filteredTemplates
        if (/^[1-5]$/.test(e.key)) {
            const idx = parseInt(e.key) - 1;
            const filteredTemplates = store.get('filteredTemplates');
            if (filteredTemplates && filteredTemplates[idx]) {
                e.preventDefault();
                deps.setPreview(idx, true);
            }
            return;
        }

        // Space refreshes storyboard if Tab 7 is active
        if (e.key === ' ' || e.code === 'Space') {
            const exportPane = document.getElementById('tab-export');
            if (exportPane && exportPane.classList.contains('active')) {
                e.preventDefault();
                deps.renderStoryboard();
            }
            return;
        }

        // Esc closes any open dialog
        if (e.key === 'Escape') {
            document.querySelectorAll('dialog[open]').forEach(d => /** @type {HTMLDialogElement} */ (d).close());
            return;
        }

        // ? help
        if (e.key === '?' || (e.shiftKey && e.key === '/')) {
            e.preventDefault();
            showShortcutHelp();
        }
    });
}

module.exports = { createShortcuts };
