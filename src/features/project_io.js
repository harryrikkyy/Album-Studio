// @ts-check
// features/project_io.js — project persistence, extracted from main.js
// (Phase 2 split).
//
// Owns the four ways album state moves between memory and disk:
//   saveStateToStorage  debounced localStorage autosave (compact album form)
//   saveProject         Save / Save As through the project-write IPC
//   restoreWorkspace    rebuild the whole workspace from a saved payload
//   loadProjectFromDisk / bootRestore  the two entries into restoreWorkspace
//
// Deliberately DOM-free: grid/panel resets, the folder processors (which
// build the source panels), output-folder labelling, the generative-template
// toggle, and the post-restore view re-sync are injected via `deps` — this
// module owns the state orchestration through explicit store access.

/**
 * @typedef {import('../shared/domain').ProjectData} ProjectData
 * @typedef {import('../state/store').Store} Store
 * A UXP-style folder entry (opaque here: only probed for _Thumbnails / name).
 * @typedef {{ name?: string, isFolder?: boolean, getEntry?: (name: string) => Promise<any> }} FsEntry
 */

const { getDisplayName } = require('../renderer_pure');

/** @param {unknown} e */
function _errMessage(e) {
    return e instanceof Error ? e.message : String(e);
}

/**
 * Wire project persistence to a store.
 *
 * @param {Store} store
 * @param {object} deps
 * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke  IPC dispatch
 * @param {{ getItem: (k: string) => string | null, setItem: (k: string, v: string) => void }} deps.storage
 *   localStorage (injected so tests can run in Node)
 * @param {(token: unknown) => Promise<FsEntry>} deps.getEntryForToken
 * @param {object} deps.processors  the folder → source-panel builders
 * @param {(folder: FsEntry, hrFolder: FsEntry | null, token: unknown) => Promise<void>} deps.processors.image
 * @param {(folder: FsEntry, token: unknown) => Promise<void>} deps.processors.template
 * @param {(folder: FsEntry, hrFolder: FsEntry | null, displayName: string, token: unknown) => Promise<void>} deps.processors.wallpaper
 * @param {(folder: FsEntry, token: unknown) => Promise<void>} deps.processors.png
 * @param {(folder: FsEntry, token: unknown) => Promise<void>} deps.processors.masked
 * @param {() => void} deps.resetSourceViews  wipe source grids + panel headers
 * @param {(text: string) => void} deps.setOutputFolderLabel
 * @param {() => Promise<void>} deps.ensureGenerativeTemplates  enable + load generative templates
 * @param {() => void} deps.afterRestore  view re-sync once state is rebuilt
 * @param {() => void} deps.persistHashes  save renderHashes to localStorage
 * @param {(msg: string) => void} deps.setStatus
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.notify
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 */
function createProjectIO(store, deps) {
    // ⚡ Debounced save — coalesces rapid calls (rotation spam, slider drag)
    // into a single write 800ms after the last call. Eliminates repeated
    // JSON.stringify.
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let _saveTimer;

    // Build a compact album for persistence: strip re-derivable fields (photo
    // url, full template object) so localStorage stays well under quota even
    // for 200-page albums. url is re-added by processImageFolder on load;
    // templates relink by id in restoreWorkspace.
    function _compactAlbumForStorage() {
        /** @type {Record<string, object>} */
        const out = {};
        for (const [num, page] of Object.entries(store.get('albumPages'))) {
            if (!page) continue;
            out[num] = {
                template: page.template ? {
                    id: page.template.id,
                    _generative: !!page.template._generative,
                    _spec: page.template._spec || undefined,
                } : null,
                photos: (page.photos || []).map(p => ({ id: p.id, orient: p.orient })),
            };
        }
        return out;
    }

    function saveStateToStorage() {
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => {
            try {
                deps.storage.setItem("adt_workspace", JSON.stringify(store.get('projectData')));
                deps.storage.setItem("adt_album", JSON.stringify({
                    albumPages: _compactAlbumForStorage(),
                    totalActivePages: store.get('totalActivePages')
                }));
            } catch (e) { console.error('saveStateToStorage failed:', e); }
        }, 800);
    }

    // Build the serialisable project payload (shared by Save / Save As / New).
    function buildProjectPayload() {
        const safeAlbumPages = JSON.parse(JSON.stringify(store.get('albumPages'), (key, value) => {
            if (key === 'file') return undefined;
            return value;
        }));
        return {
            workspace: store.get('projectData'),
            albumPages: safeAlbumPages,
            totalActivePages: store.get('totalActivePages'),
            renderHashes: store.get('renderHashes')
        };
    }

    /**
     * Save the project. forceNewPath=true always prompts (Save As); otherwise
     * re-saves in place once a path is known.
     *
     * @param {boolean} forceNewPath
     * @returns {Promise<boolean>}
     */
    async function saveProject(forceNewPath) {
        try {
            const payload = buildProjectPayload();
            let target = forceNewPath ? null : store.get('currentProjectPath');
            if (!target) {
                const suggested = (Object.keys(store.get('albumPages')).length > 0)
                    ? `Album-${new Date().toISOString().slice(0, 10)}`
                    : 'New Album Project';
                target = await deps.invoke('project-pick-save', suggested);
                if (!target) return false;
            }
            const result = await deps.invoke('project-write', target, payload);
            if (!result || !result.ok) throw new Error('project write failed');
            store.set('currentProjectPath', result.path);
            deps.notify(`Project saved · ${result.path.split('/').pop()}`, "success");
            return true;
        } catch (e) {
            deps.toast("Save error: " + _errMessage(e), "error");
            console.error("Save error full:", e);
            return false;
        }
    }

    /** @param {any} data  a saved project payload (or legacy bare workspace) */
    async function restoreWorkspace(data) {
        if (!data) return;
        deps.resetSourceViews();

        store.set('templateLibrary', []);
        store.set('photoCache', {}); store.set('wallpaperCache', {});
        store.set('pngCache', {}); store.set('maskedCache', {});
        store.get('activeImageFolders').clear(); store.get('activeTemplateFolders').clear();
        store.get('activeWallpaperFolders').clear(); store.get('activePngFolders').clear();
        store.get('activeMaskedFolders').clear();

        /** @type {ProjectData} */
        const projectData = data.workspace || data;
        if (!projectData.imageTokens) projectData.imageTokens = [];
        if (!projectData.templateTokens) projectData.templateTokens = [];
        if (!projectData.wallpaperTokens) projectData.wallpaperTokens = [];
        if (!projectData.pngTokens) projectData.pngTokens = [];
        if (!projectData.maskTokens) projectData.maskTokens = [];
        if (!projectData.imageRotations) projectData.imageRotations = {};
        if (!projectData.imageAdjustments) projectData.imageAdjustments = {};
        if (!projectData.imagePlacements) projectData.imagePlacements = {};
        store.set('projectData', projectData);

        store.set('albumPages', data.albumPages || {});
        store.set('totalActivePages', data.totalActivePages || 1);
        deps.setStatus("Restoring workspace folders…");

        if (projectData.outputToken) {
            try {
                const folder = await deps.getEntryForToken(projectData.outputToken);
                store.set('outputFolder', folder);
                deps.setOutputFolderLabel(folder.name || '');
            } catch (e) {
                // The saved output folder is gone (moved / unmounted). Don't fail
                // silently — the user would hit a confusing error at Render time.
                store.set('outputFolder', null);
                deps.setOutputFolderLabel("Output folder missing — re-select");
                try { deps.invoke('telemetry-event', 'output_folder_restore_failed', { error: _errMessage(e) }); } catch (_) {}
            }
        }

        // ⚡ Task 5.2: track folder-restore failures so a moved/renamed/unmounted
        // source folder produces a clear, aggregated warning instead of photos
        // and templates silently vanishing. The inner _Thumbnails probes stay
        // silent — they're EXPECTED to fail when a folder has no thumbnails and
        // have an explicit fallback. Only outer token-resolution failures (the
        // "this folder is gone" case) are recorded.
        /** @type {{ kind: string, error: string }[]} */
        const _restoreFailures = [];

        // ⚡ FIX: Restore ALL folder types in parallel instead of sequentially.
        // Startup with 5 folder types × multiple folders each goes from fully
        // sequential to the time of the slowest single folder — often a 5–10x
        // improvement.
        await Promise.all([
            // Image folders
            ...projectData.imageTokens.map(async t => {
                try {
                    const masterFolder = await deps.getEntryForToken(t);
                    let targetFolder = masterFolder, hrFolder = null;
                    try {
                        const thumbFolder = await /** @type {Required<FsEntry>} */ (masterFolder).getEntry("_Thumbnails");
                        if (thumbFolder.isFolder) { targetFolder = thumbFolder; hrFolder = masterFolder; }
                    } catch (e) { /* no thumbnails — use the folder itself */ }
                    await deps.processors.image(targetFolder, hrFolder, t);
                } catch (e) { _restoreFailures.push({ kind: 'images', error: _errMessage(e) }); }
            }),
            // Template folders
            ...projectData.templateTokens.map(async t => {
                try { const folder = await deps.getEntryForToken(t); await deps.processors.template(folder, t); }
                catch (e) { _restoreFailures.push({ kind: 'templates', error: _errMessage(e) }); }
            }),
            // Wallpaper folders
            ...projectData.wallpaperTokens.map(async t => {
                try {
                    const masterFolder = await deps.getEntryForToken(t);
                    let targetFolder = masterFolder, hrFolder = null;
                    try {
                        const thumbFolder = await /** @type {Required<FsEntry>} */ (masterFolder).getEntry("_Thumbnails");
                        if (thumbFolder.isFolder) { targetFolder = thumbFolder; hrFolder = masterFolder; }
                    } catch (e) { /* no thumbnails — use the folder itself */ }
                    await deps.processors.wallpaper(targetFolder, hrFolder, getDisplayName(/** @type {any} */ (masterFolder)), t);
                } catch (e) { _restoreFailures.push({ kind: 'wallpapers', error: _errMessage(e) }); }
            }),
            // PNG folders
            ...projectData.pngTokens.map(async t => {
                try { const folder = await deps.getEntryForToken(t); await deps.processors.png(folder, t); }
                catch (e) { _restoreFailures.push({ kind: 'pngs', error: _errMessage(e) }); }
            }),
            // Mask folders
            ...projectData.maskTokens.map(async t => {
                try { const folder = await deps.getEntryForToken(t); await deps.processors.masked(folder, t); }
                catch (e) { _restoreFailures.push({ kind: 'masks', error: _errMessage(e) }); }
            })
        ]);

        // Surface restore failures: one telemetry event + one aggregated toast,
        // grouped by folder kind, instead of N silent swallows.
        if (_restoreFailures.length > 0) {
            /** @type {Record<string, number>} */
            const byKind = {};
            for (const f of _restoreFailures) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
            const summary = Object.entries(byKind)
                .map(([k, n]) => `${n} ${k}`).join(', ');
            try {
                deps.invoke('telemetry-event', 'workspace_restore_failures', {
                    total: _restoreFailures.length,
                    byKind,
                    sample: _restoreFailures.slice(0, 5).map(f => f.error),
                });
            } catch (_) {}
            deps.toast(
                `${_restoreFailures.length} folder${_restoreFailures.length === 1 ? '' : 's'} couldn't be restored (${summary}). They may have been moved, renamed, or are on a disconnected drive — re-load them from their tab.`,
                'warning',
                { duration: 9000 }
            );
        }

        // Auto-enable generative templates if the project references any —
        // otherwise the relink below silently fails and pages with generative
        // layouts come back blank. The toggle stays in sync via the checkbox.
        const albumPages = store.get('albumPages');
        const needsGenerative = Object.values(albumPages).some(p => p?.template?._generative || p?.template?.id?.startsWith?.('gen_'));
        if (needsGenerative) await deps.ensureGenerativeTemplates();

        // Post-restore: re-link template objects and mark used photos
        const templateLibrary = store.get('templateLibrary');
        Object.values(albumPages).forEach(page => {
            if (page.template) {
                const matchedTemp = templateLibrary.find(t => t.id === /** @type {NonNullable<typeof page.template>} */ (page.template).id);
                if (matchedTemp) page.template = matchedTemp;
            }
        });

        deps.afterRestore();
        deps.notify("Workspace ready", "success");
    }

    // Load a project from disk: folder picker first; if the user cancels,
    // fall back to opening a single legacy .json file.
    async function loadProjectFromDisk() {
        try {
            let pathPicked = await deps.invoke('project-pick-open');
            if (!pathPicked) {
                const legacy = await deps.invoke('pick-file-open');
                if (!legacy) return;
                pathPicked = legacy;
            }
            const res = await deps.invoke('project-read', pathPicked);
            if (!res || !res.ok) throw new Error(res?.error || 'unable to read project');
            store.set('currentProjectPath', res.projectPath || null);
            const data = res.data;
            // Re-hydrate render hash cache from the project payload (newer
            // saves) — older projects don't have it; that's fine, queue will
            // just re-render everything once.
            if (data.renderHashes) {
                store.set('renderHashes', data.renderHashes);
                deps.persistHashes();
            }
            await restoreWorkspace(data);
            deps.notify("Project loaded", "success");
        } catch (e) {
            deps.toast("Load error: " + _errMessage(e), "error");
            console.error("Load error", e);
        }
    }

    // Boot-time restore of the autosaved workspace (invisible: any failure
    // just means a fresh session).
    async function bootRestore() {
        const cachedWorkspace = deps.storage.getItem("adt_workspace");
        const cachedAlbum = deps.storage.getItem("adt_album");
        if (!cachedWorkspace) return;
        try {
            /** @type {any} */
            const data = { workspace: JSON.parse(cachedWorkspace) };
            if (cachedAlbum) {
                const a = JSON.parse(cachedAlbum);
                if (a && a.albumPages) data.albumPages = a.albumPages;
                if (a && a.totalActivePages) data.totalActivePages = a.totalActivePages;
            }
            await restoreWorkspace(data);
        } catch (e) { console.error("Invisible Boot-Up Error", e); }
    }

    return {
        saveStateToStorage, buildProjectPayload, saveProject,
        restoreWorkspace, loadProjectFromDisk, bootRestore,
    };
}

module.exports = { createProjectIO };
