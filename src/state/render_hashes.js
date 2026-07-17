// @ts-check
// state/render_hashes.js — localStorage persistence for the render cache
// hashes (store slice `renderHashes`), extracted from main.js (Phase 2
// split). Seeding at boot is what lets render-cache hits survive restarts.

const RENDER_HASH_KEY = 'adt_render_hashes';

/** @typedef {import('./store').Store} Store */

/**
 * Seed store.renderHashes from localStorage. Call once at boot.
 * @param {Store} store
 */
function seedRenderHashes(store) {
    try { store.set('renderHashes', JSON.parse(localStorage.getItem(RENDER_HASH_KEY) || '{}')); }
    catch (_) { store.set('renderHashes', {}); }
}

let _warnedSaveFailure = false;

/**
 * Persist store.renderHashes to localStorage (best-effort — but not silent:
 * a quota failure here means dirty-tracking is lost and the NEXT export
 * re-renders every page, which looks like a mystery slowdown. Warn once so
 * the symptom is diagnosable without spamming per-page saves).
 * @param {Store} store
 */
function saveRenderHashes(store) {
    try { localStorage.setItem(RENDER_HASH_KEY, JSON.stringify(store.get('renderHashes'))); }
    catch (e) {
        if (!_warnedSaveFailure) {
            _warnedSaveFailure = true;
            console.warn('render-hash save failed — next export will re-render all pages:', e instanceof Error ? e.message : String(e));
        }
    }
}

module.exports = { seedRenderHashes, saveRenderHashes };
