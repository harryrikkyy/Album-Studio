// @ts-check
// state/history.js — the undo/redo history system, extracted from main.js
// (first module of the Phase 2 split).
//
// Every mutation that should be undoable is wrapped in mutate(label, fn).
// We snapshot the relevant slices BEFORE the mutation and push the snapshot
// onto the undo stack; Cmd+Z / Cmd+Shift+Z replay snapshots.
//
// What's tracked: albumPages (photo placement, templates), totalActivePages,
// projectData.imageRotations, currentPage. NOT tracked: folder loads, file
// IPC, ephemeral UI state — those have explicit re-do paths.
//
// Snapshots are COMPACT (⚡ Task 3.2): only the structural skeleton — per
// page the template id (+ generative spec) and ordered photo refs WITHOUT
// the url or any other re-derivable field. On apply we re-hydrate full photo
// objects from photoCache (url) and re-link templates from templateLibrary,
// shrinking each snapshot ~10–50× with identical restore fidelity. A naive
// structuredClone(albumPages) snapshot of a 200-page album was multiple MB,
// and the 80-entry cap could hold hundreds of MB.
//
// Deliberately DOM-free: view refresh, persistence, and user feedback are
// injected via `deps`, so this module depends only on the store and the pure
// compact/hydrate helpers — and is unit-testable with a bare store.

/**
 * @typedef {import('../shared/domain').HistorySnapshot} HistorySnapshot
 * @typedef {import('../shared/domain').Page} Page
 * @typedef {import('../shared/domain').CompactPage} CompactPage
 * @typedef {import('./store').Store} Store
 */

const { _compactPage, _hydratePage } = require('../renderer_pure');

const _HISTORY_CAP = 80;

/**
 * Wire the history system to a store.
 *
 * The store's historyUndo / historyRedo slices hold the stacks; historyMuted
 * is the "inside an apply" depth guard (mutate() calls during undo/redo must
 * not push history).
 *
 * @param {Store} store
 * @param {object} deps
 * @param {() => void} deps.afterApply  re-sync the view after a snapshot is applied
 * @param {() => void} deps.persist    save album state (debounced upstream)
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 */
function createHistory(store, deps) {
    /** @param {string} label @returns {HistorySnapshot} */
    function snapshot(label) {
        /** @type {Record<string, CompactPage>} */
        const compactPages = {};
        for (const [num, page] of Object.entries(store.get('albumPages'))) {
            compactPages[num] = _compactPage(page);
        }
        return {
            label,
            albumPages: compactPages,
            totalActivePages: store.get('totalActivePages'),
            imageRotations: structuredClone(store.get('projectData').imageRotations || {}),
            currentPage: store.get('currentPage'),
        };
    }

    /** @param {HistorySnapshot} snap */
    function apply(snap) {
        const templateLibrary = store.get('templateLibrary');
        const photoCache = store.get('photoCache');
        /** @type {Record<string, Page>} */
        const hydrated = {};
        for (const [num, cpage] of Object.entries(snap.albumPages)) {
            hydrated[num] = _hydratePage(cpage, templateLibrary, photoCache);
        }
        store.set('albumPages', hydrated);
        store.set('totalActivePages', snap.totalActivePages);
        store.get('projectData').imageRotations = structuredClone(snap.imageRotations);
        store.set('currentPage', snap.currentPage || 1);

        deps.afterApply();
        deps.persist();
    }

    /** @param {HistorySnapshot} snap */
    function applyMuted(snap) {
        store.set('historyMuted', store.get('historyMuted') + 1);
        try { apply(snap); }
        finally { store.set('historyMuted', store.get('historyMuted') - 1); }
    }

    /**
     * Run a mutating function with undo support. Snapshots state before the
     * call, pushes onto the undo stack, clears the redo stack, runs the
     * mutator, and persists.
     *
     * Usage:
     *   mutate('Add page', () => { albumPages[N+1] = {...}; totalActivePages++; });
     *
     * Nested mutate() calls each push their own snapshot (undo unwinds them
     * in reverse — pinned by characterization test; the pre-split code's
     * comment claimed outermost-only but never implemented it). Inside
     * undo()/redo() applies, mutate() does not push at all (historyMuted
     * guard).
     *
     * @template T
     * @param {string} label
     * @param {() => T} fn
     * @returns {T}
     */
    function mutate(label, fn) {
        if (store.get('historyMuted') > 0) {
            // Already inside a history apply — don't snapshot, just run.
            return fn();
        }
        const snap = snapshot(label);
        let result;
        try {
            result = fn();
        } catch (e) {
            // Rollback on throw so we don't leave partial state behind.
            applyMuted(snap);
            throw e;
        }
        const undoStack = store.get('historyUndo');
        undoStack.push(snap);
        if (undoStack.length > _HISTORY_CAP) undoStack.shift();
        store.get('historyRedo').length = 0; // any new mutation invalidates redo
        deps.persist();
        return result;
    }

    function undo() {
        const undoStack = store.get('historyUndo');
        if (undoStack.length === 0) { deps.toast('Nothing to undo', 'info', { duration: 1500 }); return; }
        const current = snapshot('redo');
        const prev = /** @type {HistorySnapshot} */ (undoStack.pop());
        store.get('historyRedo').push(current);
        applyMuted(prev);
        deps.toast('Undo: ' + (prev.label || 'change'), 'info', { duration: 1400 });
    }

    function redo() {
        const redoStack = store.get('historyRedo');
        if (redoStack.length === 0) { deps.toast('Nothing to redo', 'info', { duration: 1500 }); return; }
        const current = snapshot('undo');
        const next = /** @type {HistorySnapshot} */ (redoStack.pop());
        store.get('historyUndo').push(current);
        applyMuted(next);
        deps.toast('Redo', 'info', { duration: 1200 });
    }

    return { mutate, undo, redo };
}

module.exports = { createHistory };
