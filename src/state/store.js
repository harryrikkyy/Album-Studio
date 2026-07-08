// @ts-check
// state/store.js
//
// The renderer state store — Phase 2's single source of truth.
//
// Every slice that used to live as a reassigned module `let` in main.js
// migrates here, one commit at a time. During the migration main.js exposes
// each migrated slice back onto `globalThis` as an accessor property (see
// exposeOnGlobal), so the hundreds of existing bare references keep working
// while the store owns the data. The module split then replaces those bare
// references with explicit store access and the accessors get deleted.
//
// Deliberately framework-free: a sealed slice map, get/set, and per-slice
// subscriptions. Deep mutation of a slice's contents (albumPages[n].photos
// .push(...)) is still legal and un-observed — history via mutate() covers
// undoability — the store guarantees WHERE state lives, not immutability.
//
/**
 * @typedef {import('../shared/domain').Page} Page
 * @typedef {import('../shared/domain').Template} Template
 * @typedef {import('../shared/domain').ProjectData} ProjectData
 * @typedef {import('../shared/domain').HistorySnapshot} HistorySnapshot
 */

/**
 * All migrated renderer state slices. Grows as globals move over from
 * main.js; a slice is added here in the same commit that wires it.
 *
 * @typedef {Object} AppState
 * @property {Record<string, Page>} albumPages
 * @property {Template[]} templateLibrary
 * @property {Template[]} filteredTemplates
 * @property {number} previewIndex
 * @property {number} currentPage
 * @property {number} totalActivePages
 * @property {ProjectData} projectData
 * @property {HistorySnapshot[]} historyUndo
 * @property {HistorySnapshot[]} historyRedo
 * @property {number} historyMuted   mutate() nesting depth during undo/redo apply
 */

/** @returns {AppState} */
function defaultState() {
    return {
        albumPages: {},
        templateLibrary: [],
        filteredTemplates: [],
        previewIndex: 0,
        currentPage: 1,
        totalActivePages: 1,
        projectData: {
            imageTokens: [], templateTokens: [], wallpaperTokens: [],
            pngTokens: [], maskTokens: [], highResTokens: [], wpHighResTokens: [],
            outputToken: null, imageRotations: {}, imageAdjustments: {}, imagePlacements: {}
        },
        historyUndo: [],
        historyRedo: [],
        historyMuted: 0,
    };
}

/**
 * @typedef {ReturnType<typeof createStore>} Store
 */

/**
 * Create a store. `overrides` lets tests seed slices; production callers
 * create it bare.
 *
 * @param {Partial<AppState>} [overrides]
 */
function createStore(overrides) {
    /** @type {AppState} */
    const state = Object.seal(Object.assign(defaultState(), overrides));

    /** @type {Map<keyof AppState, Set<(value: unknown, prev: unknown) => void>>} */
    const listeners = new Map();

    /** @param {string} key */
    function assertKnown(key) {
        if (!Object.prototype.hasOwnProperty.call(state, key)) {
            throw new Error(`store: unknown state slice "${key}"`);
        }
    }

    return {
        /**
         * @template {keyof AppState} K
         * @param {K} key
         * @returns {AppState[K]}
         */
        get(key) {
            assertKnown(key);
            return state[key];
        },

        /**
         * Replace a slice. No-op (and no notification) if the value is
         * identical — deep mutation of the current value does not notify.
         *
         * @template {keyof AppState} K
         * @param {K} key
         * @param {AppState[K]} value
         */
        set(key, value) {
            assertKnown(key);
            const prev = state[key];
            if (Object.is(prev, value)) return;
            state[key] = value;
            const subs = listeners.get(key);
            if (subs) for (const fn of [...subs]) fn(value, prev);
        },

        /**
         * Subscribe to replacements of one slice. Returns an unsubscribe
         * function.
         *
         * @template {keyof AppState} K
         * @param {K} key
         * @param {(value: AppState[K], prev: AppState[K]) => void} fn
         * @returns {() => void}
         */
        subscribe(key, fn) {
            assertKnown(key);
            let subs = listeners.get(key);
            if (!subs) { subs = new Set(); listeners.set(key, subs); }
            const cb = /** @type {(value: unknown, prev: unknown) => void} */ (fn);
            subs.add(cb);
            return () => { subs.delete(cb); };
        },

        /** The slice names this store owns. @returns {(keyof AppState)[]} */
        keys() {
            return /** @type {(keyof AppState)[]} */ (Object.keys(state));
        },
    };
}

/**
 * Migration shim: expose store slices as accessor properties on a global
 * object, so pre-split code that says bare `albumPages` transparently
 * reads/writes the store. Every accessor is `configurable`, so the split can
 * delete them file-by-file as references move to explicit store access.
 *
 * @param {Store} store
 * @param {(keyof AppState)[]} keys
 * @param {object} [target] defaults to globalThis
 */
function exposeOnGlobal(store, keys, target = globalThis) {
    for (const key of keys) {
        Object.defineProperty(target, key, {
            configurable: true,
            enumerable: false,
            get: () => store.get(key),
            set: (value) => { store.set(key, value); },
        });
    }
}

module.exports = { createStore, exposeOnGlobal, defaultState };
