// @ts-check
// state/store.js
//
// The renderer state store — Phase 2's single source of truth.
//
// Every slice that used to live as a reassigned module `let` in main.js now
// lives here, and the migration is COMPLETE: every module reads and writes
// through explicit store.get/set. The accessor shim that let pre-split code
// keep saying bare `albumPages` during the transition (exposeOnGlobal) is no
// longer called by the app — see the note on that function.
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
 * @typedef {import('../shared/domain').RenderJob} RenderJob
 * @typedef {import('../shared/domain').RenderStats} RenderStats
 * @typedef {import('../shared/domain').Photo} Photo
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
 * @property {RenderJob[]} renderQueue
 * @property {Record<string, string>} renderHashes   cacheKey → page-input hash
 * @property {boolean} renderActive
 * @property {RenderStats} renderStats
 * @property {Record<string, Photo>} photoCache      photoId → loaded source photo
 * @property {Record<string, Photo>} wallpaperCache
 * @property {Record<string, Photo>} pngCache
 * @property {Record<string, Photo>} maskedCache
 * @property {unknown} outputFolder                  UXP folder entry (or null)
 * @property {Set<string>} activeImageFolders        folderIds currently checked
 * @property {Set<string>} activeTemplateFolders
 * @property {Set<string>} activeWallpaperFolders
 * @property {Set<string>} activePngFolders
 * @property {Set<string>} activeMaskedFolders
 * @property {unknown} autoHighResFolder             UXP folder entry (or null)
 * @property {Record<string, unknown>} globalHighResMap
 * @property {Record<string, unknown>} globalWpHighResMap
 * @property {string | null} currentProjectPath
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
            outputToken: null, imageRotations: {}, imageAdjustments: {}, imagePlacements: {},
            // Page-level edits, keyed by page number (photo edits above are
            // keyed by photo id so they travel with the photo between pages;
            // overlays belong to the page, not to any one photo).
            pageOverlays: {}, pageBackgrounds: {}, pageLayerEdits: {}
        },
        historyUndo: [],
        historyRedo: [],
        historyMuted: 0,
        renderQueue: [],
        renderHashes: {},
        renderActive: false,
        renderStats: { total: 0, done: 0, skipped: 0, failed: 0, cancelled: false },
        photoCache: {},
        wallpaperCache: {},
        pngCache: {},
        maskedCache: {},
        outputFolder: null,
        activeImageFolders: new Set(),
        activeTemplateFolders: new Set(),
        activeWallpaperFolders: new Set(),
        activePngFolders: new Set(),
        activeMaskedFolders: new Set(),
        autoHighResFolder: null,
        globalHighResMap: {},
        globalWpHighResMap: {},
        currentProjectPath: null,
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
 * reads/writes the store.
 *
 * NO LONGER USED BY THE APP. The Phase 2 split finished: every module reads
 * and writes through explicit store.get/set, and main.js stopped calling this.
 * Kept because it is small, tested, and the obvious tool if another slice is
 * ever migrated — but nothing should start depending on it again, since its
 * whole cost was giving state a second, invisible way in.
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
