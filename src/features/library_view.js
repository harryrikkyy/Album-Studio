// @ts-check
// features/library_view.js — the persistent user library (Tier 3.B),
// extracted from main.js (Phase 2 split). A per-user library of templates /
// wallpapers / pngs / masks / saved layouts that lives outside any single
// project, so the user can drop their go-to assets in once and pull them
// into every new wedding.
//
// "Save current layout" snapshots the current album's structural shape
// (which template each page uses + photo orientation slot counts) without
// the actual photos, so the same layout can be replayed on a new shoot.
// applySavedLayout re-attaches templates by id (PSD-backed) or re-creates
// them from their spec via generative-regen IPC.
//
// DOM-owning (#libraryView + the library buttons). The four processXxxFolder
// engines are injected; library folders are fed to them through a
// UXP-Folder-shaped synthetic object backed by node fs.

/**
 * @typedef {import('../state/store').Store} Store
 */

/**
 * Wire the library view and the save/apply-layout flows.
 *
 * @param {Store} store
 * @param {object} deps
 * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke  IPC dispatch
 * @param {(label: string, fn: () => void) => void} deps.mutate
 * @param {() => void} deps.rebuildPhotoPageMap
 * @param {() => void} deps.updatePageDropdowns
 * @param {() => void} deps.renderGreenBox
 * @param {() => void} deps.scheduleFilterUpdate
 * @param {() => void} deps.renderStoryboard
 * @param {() => void} deps.saveState  debounced workspace autosave
 * @param {() => Promise<any>} deps.pickFolder  fs.getFolder dialog (null on cancel)
 * @param {(folder: any, token: unknown, existingFolderId?: string | null) => Promise<void>} deps.processTemplateFolder
 * @param {(folder: any, hrFolder: any, displayName: string, token: unknown, existingFolderId?: string | null) => Promise<void>} deps.processWallpaperFolder
 * @param {(folder: any, token: unknown, existingFolderId?: string | null) => Promise<void>} deps.processPngFolder
 * @param {(folder: any, token: unknown, existingFolderId?: string | null) => Promise<void>} deps.processMaskedFolder
 * @param {string} deps.generativeFolderId  folderId generative templates carry
 * @param {() => Promise<void>} deps.ensureGenerativeLoaded  load the generative set if not already
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.notify
 */
function createLibraryView(store, deps) {
    async function refreshLibraryView() {
        const res = await deps.invoke('library-list');
        const view = document.getElementById('libraryView');
        if (!view) return;
        if (!res?.ok) { view.innerHTML = `<span class="u-text-secondary">Library unavailable</span>`; return; }
        const lib = res.library;
        /**
         * @param {string} title
         * @param {any[]} items
         * @param {string} kind
         */
        const renderSection = (title, items, kind) => {
            if (!items.length) {
                return `<div style="padding:8px 0;color:var(--txt-secondary);">
                    <strong>${title}</strong> · empty
                </div>`;
            }
            return `<div style="padding:8px 0;">
                <strong>${title}</strong>
                <div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:6px;">
                    ${items.map(s => `
                        <span class="lib-chip">
                            ${s.name} ${s.count != null ? `· ${s.count}` : (s.pages != null ? `· ${s.pages}p` : '')}
                            <button class="lib-chip__action" data-kind="${kind}" data-name="${s.name}" data-file="${s.file || ''}" title="Apply / use">↗</button>
                            <button class="lib-chip__remove" data-kind="${kind}" data-name="${s.name}" data-file="${s.file || ''}" title="Remove">×</button>
                        </span>
                    `).join('')}
                </div>
            </div>`;
        };
        view.innerHTML = `
            ${renderSection('Templates', lib.templates, 'templates')}
            ${renderSection('Wallpapers', lib.wallpapers, 'wallpapers')}
            ${renderSection('PNG Frames', lib.pngs, 'pngs')}
            ${renderSection('Masks', lib.masks, 'masks')}
            ${renderSection('Saved Layouts', lib.layouts, 'layouts')}
            <div style="margin-top:8px;color:var(--txt-secondary);font-size:11px;">
                Stored at: <code>${res.dir}</code>
            </div>
        `;

        // Wire chip actions. Apply for templates/wp/png/masks loads the folder
        // into the live project; for layouts it replays the saved structure.
        view.querySelectorAll('.lib-chip__action').forEach(btn => {
            const b = /** @type {HTMLElement} */ (btn);
            btn.addEventListener('click', () => _applyLibraryItem(b.dataset.kind, b.dataset.name, b.dataset.file));
        });
        view.querySelectorAll('.lib-chip__remove').forEach(btn => {
            const b = /** @type {HTMLElement} */ (btn);
            btn.addEventListener('click', () => _removeLibraryItem(b.dataset.kind, b.dataset.name, b.dataset.file));
        });
    }

    /**
     * @param {string | undefined} kind
     * @param {string | undefined} name
     * @param {string | undefined} file
     */
    async function _applyLibraryItem(kind, name, file) {
        if (kind === 'layouts') {
            const res = await deps.invoke('library-load-layout', file);
            if (!res?.ok) { deps.toast('Failed to load layout: ' + (res?.error || ''), 'error'); return; }
            await applySavedLayout(res.data);
            return;
        }
        // For asset kinds, we re-run the existing folder-loader against the
        // library set folder. The user gets exactly the same result as if they
        // had picked the folder via the OS dialog.
        const libRes = await deps.invoke('library-list');
        if (!libRes?.ok) return;
        const item = (libRes.library[/** @type {string} */ (kind)] || []).find((/** @type {any} */ s) => s.name === name);
        if (!item?.path) { deps.toast('Library set not found', 'error'); return; }

        // The UXP stub doesn't expose getEntryWithUrl; instead we invoke the
        // same processor functions used by the load buttons but with a
        // synthesized folder object that exposes nativePath + name + getEntries.
        const synthFolder = await _syntheticFolder(item.path);
        if (!synthFolder) { deps.toast('Could not read library folder', 'error'); return; }

        if (kind === 'templates') {
            await deps.processTemplateFolder(synthFolder, null);
            deps.notify(`Loaded template set: ${name}`, 'success');
        } else if (kind === 'wallpapers') {
            await deps.processWallpaperFolder(synthFolder, null, /** @type {string} */ (name), null);
            deps.notify(`Loaded wallpaper set: ${name}`, 'success');
        } else if (kind === 'pngs') {
            await deps.processPngFolder(synthFolder, null);
            deps.notify(`Loaded PNG set: ${name}`, 'success');
        } else if (kind === 'masks') {
            await deps.processMaskedFolder(synthFolder, null);
            deps.notify(`Loaded mask set: ${name}`, 'success');
        } else {
            deps.toast(`Don't know how to apply kind: ${kind}`, 'error');
        }
    }

    /** @param {string} absPath */
    async function _syntheticFolder(absPath) {
        // Build a UXP-Folder-shaped object backed by node fs. Lets the existing
        // processXFolder() functions consume library content without changes.
        const nodefs = require('fs');
        const nodepath = require('path');
        if (!nodefs.existsSync(absPath)) return null;
        const stat = nodefs.statSync(absPath);
        if (!stat.isDirectory()) return null;

        /** @param {string} p */
        function fileEntry(p) {
            const base = nodepath.basename(p);
            return {
                isFile: true, isFolder: false,
                name: base,
                nativePath: p,
                url: 'file://' + encodeURI(p),
            };
        }

        return {
            isFile: false, isFolder: true,
            name: nodepath.basename(absPath),
            nativePath: absPath,
            url: 'file://' + encodeURI(absPath),
            async getEntries() {
                /** @type {any[]} */
                const out = [];
                const walk = (/** @type {string} */ dir) => {
                    for (const e of nodefs.readdirSync(dir, { withFileTypes: true })) {
                        const p = nodepath.join(dir, e.name);
                        if (e.isFile()) out.push(fileEntry(p));
                    }
                };
                walk(absPath);
                return out;
            },
            /** @param {string} name */
            async getEntry(name) {
                const p = nodepath.join(absPath, name);
                if (!nodefs.existsSync(p)) throw new Error('not found');
                const s = nodefs.statSync(p);
                if (s.isDirectory()) return _syntheticFolder(p);
                return fileEntry(p);
            },
        };
    }

    /**
     * @param {string | undefined} kind
     * @param {string | undefined} name
     * @param {string | undefined} file
     */
    async function _removeLibraryItem(kind, name, file) {
        if (!confirm(`Remove "${name}" from library?`)) return;
        const res = kind === 'layouts'
            ? await deps.invoke('library-delete-layout', file)
            : await deps.invoke('library-remove', kind, name);
        if (!res?.ok) { deps.toast('Remove failed: ' + (res?.error || ''), 'error'); return; }
        deps.notify(`Removed ${name}`, 'success');
        refreshLibraryView();
    }

    /** @param {string} kind */
    async function _addToLibrary(kind) {
        const folder = await deps.pickFolder();
        if (!folder) return;
        const setName = prompt(`Library set name for "${folder.name}":`, folder.name);
        if (!setName) return;
        const res = await deps.invoke('library-add', kind, setName, folder.nativePath);
        if (!res?.ok) { deps.toast('Add failed: ' + (res?.error || ''), 'error'); return; }
        deps.notify(`Added "${setName}" to library`, 'success');
        refreshLibraryView();
    }

    document.getElementById('btnLibraryRefresh')?.addEventListener('click', refreshLibraryView);
    document.getElementById('btnLibraryAddTemplates')?.addEventListener('click', () => _addToLibrary('templates'));
    document.getElementById('btnLibraryAddWallpapers')?.addEventListener('click', () => _addToLibrary('wallpapers'));
    document.getElementById('btnLibraryAddPngs')?.addEventListener('click', () => _addToLibrary('pngs'));
    document.getElementById('btnLibraryAddMasks')?.addEventListener('click', () => _addToLibrary('masks'));

    document.getElementById('btnOpenLibraryFolder')?.addEventListener('click', async () => {
        const res = await deps.invoke('library-list');
        if (res?.ok) await deps.invoke('open-external', 'file://' + res.dir);
    });

    document.getElementById('btnSaveLayout')?.addEventListener('click', async () => {
        const name = prompt('Save current layout as:', `Standard ${Object.keys(store.get('albumPages')).length}pg`);
        if (!name) return;
        const layout = serializeCurrentLayout(name);
        const res = await deps.invoke('library-save-layout', name, layout);
        if (!res?.ok) { deps.toast('Save layout failed: ' + (res?.error || ''), 'error'); return; }
        deps.notify(`Layout "${name}" saved`, 'success');
        refreshLibraryView();
    });

    /** @param {string} name */
    function serializeCurrentLayout(name) {
        // Strip per-photo identity. Keep template selection + slot orientations
        // so the layout can be re-applied to a different photo folder.
        /** @type {Record<string, any>} */
        const pages = {};
        for (const [pageNum, page] of Object.entries(store.get('albumPages'))) {
            if (!page?.template) continue;
            pages[pageNum] = {
                templateId: page.template.id,
                generative: !!page.template._generative,
                spec: page.template._spec || null, // for generative templates
                templateName: page.template.name,
                templateH: page.template.h,
                templateV: page.template.v,
                photoSlots: (page.photos || []).map((/** @type {any} */ p) => ({ orient: p.orient })),
            };
        }
        return { name, pages, totalActivePages: store.get('totalActivePages') };
    }

    /** @param {any} layoutData */
    async function applySavedLayout(layoutData) {
        if (!layoutData?.pages) { deps.toast('Layout file is empty', 'error'); return; }

        // Re-attach template references. PSD-backed templates are matched by id
        // against the currently loaded library; generative templates are
        // re-created from their spec.
        let attached = 0, missing = 0;
        /** @type {Record<string, any>} */
        const newAlbumPages = {};
        for (const [pageNum, p] of Object.entries(/** @type {Record<string, any>} */ (layoutData.pages))) {
            let tpl = null;
            if (p.generative && p.spec) {
                // Reconstruct via the generative regen IPC.
                const res = await deps.invoke('generative-regen', p.spec);
                if (res?.ok) {
                    tpl = {
                        id: res.template.id,
                        folderId: deps.generativeFolderId,
                        name: res.template.name,
                        h: res.template.h,
                        v: res.template.v,
                        url: '',
                        _generative: true,
                        _spec: { generator: res.template.generator, params: res.template.params },
                        _frames: res.template.frames,
                        _canvas: { w: res.template.canvasWidth, h: res.template.canvasHeight },
                    };
                    await deps.ensureGenerativeLoaded();
                }
            } else {
                const templateLibrary = store.get('templateLibrary');
                tpl = templateLibrary.find((/** @type {any} */ t) => t.id === p.templateId)
                    || templateLibrary.find((/** @type {any} */ t) => t.name === p.templateName && t.h === p.templateH && t.v === p.templateV);
            }
            if (tpl) {
                attached++;
                newAlbumPages[pageNum] = {
                    template: tpl,
                    photos: [], // pages start empty; auto-fill repopulates
                };
            } else {
                missing++;
            }
        }

        deps.mutate(`Apply layout · ${layoutData.name}`, () => {
            store.set('albumPages', newAlbumPages);
            store.set('totalActivePages', Math.max(layoutData.totalActivePages || Object.keys(newAlbumPages).length, 1));
        });

        deps.rebuildPhotoPageMap();
        deps.updatePageDropdowns();
        deps.renderGreenBox();
        deps.scheduleFilterUpdate();
        deps.renderStoryboard();
        deps.saveState();

        deps.notify(`Applied layout · ${attached} pages${missing ? ` · ${missing} missing` : ''}`,
            missing ? 'warning' : 'success', { duration: 6000 });
        if (missing) {
            deps.toast(`${missing} pages couldn't find their template — re-load the matching template folder and try again.`, 'warning', { duration: 9000 });
        }
    }

    return { refreshLibraryView };
}

module.exports = { createLibraryView };
