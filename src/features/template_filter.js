// @ts-check
// features/template_filter.js — the template matching/filtering engine and
// template picker (white box + preview pane), extracted from main.js
// (Phase 2 split).
//
// Owns the sync-driven template matching (A1/B2): with Sync ON, the library
// is filtered to the H/V signature of either the current source SELECTION or
// the CURRENT PAGE, depending on which panel the user last worked in (the
// sticky "active match panel"); Sync OFF always shows all. Also owns the
// white-box card grid, the preview pane (setPreview), the quick-build of
// selected source photos into a chosen template (C1), the right-click
// "Open/Place in Photoshop" context menus (A2/B1), and the HR-original path
// resolver used by native drag-out.
//
// DOM-owning module with explicit store access; injected: IPC, the live-
// preview seam (owned by main.js), and status/toast/notify.

/**
 * @typedef {import('../state/store').Store} Store
 * @typedef {import('../shared/domain').Template} Template
 */

const { escapeHtml, _generativePreviewSvg } = require('../renderer_pure');

/** @param {unknown} e */
function _errMessage(e) {
    return e instanceof Error ? e.message : String(e);
}

/**
 * Wire the filtering engine. Binds panel-enter tracking, the Sync switch,
 * and the context menus.
 *
 * @param {Store} store
 * @param {object} deps
 * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke  IPC dispatch
 * @param {() => boolean} deps.isLivePreviewOn  the Preview pane is owned by the live composite
 * @param {() => void} deps.scheduleLivePreview
 * @param {(msg: string) => void} deps.setStatus
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.notify
 */
function createTemplateFilter(store, deps) {
    const redBox = /** @type {HTMLElement} */ (document.getElementById("redBox"));
    const whiteBox = /** @type {HTMLElement} */ (document.getElementById("whiteBox"));
    const greenBox = document.getElementById("greenBox");
    const yellowPreviewArea = /** @type {HTMLElement} */ (document.getElementById("yellowPreviewArea"));

    // Slice 4 (A1/B2): template sync state. Sync ON = match templates to
    // whichever panel you're working in; OFF = always show all.
    // `_activeMatchPanel` is sticky ('source' | 'pages' | null) — it remembers
    // the last panel you worked in so moving the pointer to the Templates
    // panel keeps the match instead of resetting it.
    let _syncTemplates = (() => { try { return localStorage.getItem('adt_template_sync') !== '0'; } catch (_) { return true; } })();
    /** @type {'source' | 'pages' | null} */
    let _activeMatchPanel = null;

    // ⚡ FIX: scheduleFilterUpdate — coalesces multiple autoFilterTemplates()
    // calls within the same frame into a single execution via
    // requestAnimationFrame. Prevents redundant full renderWhiteBox() rebuilds
    // on rapid state changes.
    let _filterPending = false;
    function scheduleFilterUpdate() {
        if (_filterPending) return;
        _filterPending = true;
        requestAnimationFrame(() => {
            _filterPending = false;
            autoFilterTemplates();
        });
    }

    /**
     * Make a panel the active match context (no-op + no refilter if unchanged).
     * @param {'source' | 'pages'} panel
     */
    function setActiveMatchPanel(panel) {
        if (_activeMatchPanel !== panel) { _activeMatchPanel = panel; scheduleFilterUpdate(); }
    }

    // Slice 4 wiring: sticky active-panel tracking + the template Sync switch.
    // Entering a panel makes it the active match context. It's STICKY — we
    // never clear it on pointerleave, so moving to the Templates panel to pick
    // a layout keeps showing matches for the panel you were just working in.
    if (redBox) redBox.addEventListener('pointerenter', () => setActiveMatchPanel('source'));
    const greenWrapper = document.getElementById('greenWrapper');
    if (greenWrapper) greenWrapper.addEventListener('pointerenter', () => setActiveMatchPanel('pages'));
    else if (greenBox) greenBox.addEventListener('pointerenter', () => setActiveMatchPanel('pages'));

    const chkSync = /** @type {HTMLInputElement | null} */ (document.getElementById('chkTemplateSync'));
    if (chkSync) {
        chkSync.checked = _syncTemplates;
        chkSync.addEventListener('change', () => {
            _syncTemplates = chkSync.checked;
            try { localStorage.setItem('adt_template_sync', _syncTemplates ? '1' : '0'); } catch (_) {}
            scheduleFilterUpdate();
        });
    }

    // Count the orientation signature (H/V) of the currently selected source
    // thumbnails, accounting for any per-photo rotation (matches prepareAndMove).
    function _selectedSourceHV() {
        const sel = /** @type {HTMLImageElement[]} */ (Array.from(redBox.querySelectorAll('.thumb-red.selected')));
        const photoCache = /** @type {Record<string, any>} */ (store.get('photoCache'));
        const projectData = store.get('projectData');
        let h = 0, v = 0;
        sel.forEach(img => {
            const c = photoCache[img.id];
            let orient = (c && c.orient) || (img.naturalWidth >= img.naturalHeight ? 'h' : 'v');
            const rot = projectData.imageRotations?.[img.id] || 0;
            if (rot === 90 || rot === 270) orient = orient === 'h' ? 'v' : 'h';
            if (orient === 'v') v++; else h++;
        });
        return { h, v, count: sel.length };
    }

    // ── A2/B1 helper: resolve a photo's best on-disk path (HR original when
    // the folder is linked and a name-match exists, else the proxy).
    /** @param {string} id @returns {string | null} */
    function photoNativePath(id) {
        const c = /** @type {Record<string, any>} */ (store.get('photoCache'))[id];
        if (!c) return null;
        if (c.hrFolder?.nativePath && c.baseName) {
            try {
                const np = require('path'); const nfs = require('fs');
                const base = c.baseName.toLowerCase();
                const match = nfs.readdirSync(c.hrFolder.nativePath)
                    .find(f => f.replace(/\.[^/.]+$/, '').toLowerCase() === base);
                if (match) return np.join(c.hrFolder.nativePath, match);
            } catch (_) {}
        }
        return c.proxy?.nativePath || c.file?.nativePath || null;
    }

    // C1: build the SELECTED source photos into a chosen template. Reuses the
    // build-page bridge, which assigns photos to frames by orientation, drops
    // extras, and leaves surplus frames empty — exactly the requested behaviour.
    function _selectedSourcePhotosForBuild() {
        const sel = /** @type {HTMLImageElement[]} */ (Array.from(redBox.querySelectorAll('.thumb-red.selected')));
        const photoCache = /** @type {Record<string, any>} */ (store.get('photoCache'));
        const projectData = store.get('projectData');
        return sel.map(img => {
            const id = img.id;
            const c = photoCache[id];
            const fp = photoNativePath(id);
            if (!fp) return null;
            let orient = (c && c.orient) || (img.naturalWidth >= img.naturalHeight ? 'h' : 'v');
            const rotation = projectData.imageRotations?.[id] || 0;
            if (rotation === 90 || rotation === 270) orient = orient === 'h' ? 'v' : 'h';
            return {
                id,
                filePath: fp,
                baseName: (c && c.baseName) || id,
                orient,
                rotation,
                placement: projectData.imagePlacements?.[id] || null,
            };
        }).filter(Boolean);
    }

    /** @param {Template} temp */
    async function buildTemplateWithSelection(temp) {
        if (!temp) return;
        const photos = _selectedSourcePhotosForBuild();
        // No source selection → just open the template in Photoshop for editing.
        if (photos.length === 0) {
            const p = /** @type {any} */ (temp.file) && /** @type {any} */ (temp.file).nativePath;
            if (p) _openInPS(p);
            else deps.toast('Select photos in the Source panel first', 'info');
            return;
        }
        if (temp._generative || !(/** @type {any} */ (temp.file)?.nativePath)) {
            deps.toast('Quick-build needs a PSD template (generative layouts build via Render)', 'info');
            return;
        }
        deps.setStatus(`Building ${temp.name} with ${photos.length} photo${photos.length === 1 ? '' : 's'}…`);
        try {
            const r = await deps.invoke('build-page', {
                templatePath: /** @type {any} */ (temp.file).nativePath,
                pageName: 'Quick',
                photos,
            });
            if (typeof r === 'string' && r && r.indexOf('success') === -1 && r.toLowerCase().indexOf('fail') !== -1) {
                deps.toast('Build: ' + r, 'error');
            } else {
                deps.notify(`Built ${temp.name} — review it in Photoshop`, 'success');
            }
        } catch (e) {
            deps.toast('Build failed: ' + _errMessage(e), 'error');
        }
        deps.setStatus('');
    }

    function autoFilterTemplates() {
        const albumPages = store.get('albumPages');
        const currentPage = store.get('currentPage');
        if (!albumPages[currentPage]) albumPages[currentPage] = { photos: [], template: null };
        const photos = albumPages[currentPage].photos || [];
        const hCount = photos.filter(p => p.orient === 'h').length;
        const vCount = photos.filter(p => p.orient === 'v').length;
        const activeTemplateFolders = store.get('activeTemplateFolders');
        const activeLibrary = store.get('templateLibrary').filter(t => activeTemplateFolders.has(/** @type {string} */ (t.folderId)));

        // Sync-driven matching (A1/B2). Sync OFF → always show all. Sync ON →
        // match the source SELECTION if any; else the CURRENT PAGE while the
        // pointer is over the pages panel; else (nothing selected, not hovering)
        // show all.
        let target = null;
        if (_syncTemplates) {
            if (_activeMatchPanel === 'source') {
                const sel = _selectedSourceHV();
                if (sel.count > 0) target = { h: sel.h, v: sel.v }; // else nothing selected → show all
            } else if (_activeMatchPanel === 'pages') {
                if (photos.length > 0) target = { h: hCount, v: vCount };
            }
        }
        if (target) {
            const t = target;
            let filtered = activeLibrary.filter(tp => tp.h === t.h && tp.v === t.v);
            if (filtered.length === 0) filtered = [...activeLibrary]; // graceful fallback
            store.set('filteredTemplates', filtered);
        } else {
            store.set('filteredTemplates', [...activeLibrary]);
        }
        const filteredTemplates = store.get('filteredTemplates');
        // exactMatchCount always reflects the CURRENT PAGE's signature (drives the chip).
        const exactMatchCount = activeLibrary.filter(t => t.h === hCount && t.v === vCount).length;

        const matchText = document.getElementById("templateMatchText");
        if (matchText) matchText.innerText = `Matches: ${filteredTemplates.length} (${hCount}H, ${vCount}V)`;

        // ⚡ B.4: surface the page's H/V signature + exact match count as a chip on
        // the Page header, where the user is actually looking. Green when exact
        // templates exist, amber when none (so the constraint is visible).
        const chip = document.getElementById('pageMatchChip');
        if (chip) {
            chip.textContent = `${hCount}H ${vCount}V · ${exactMatchCount} template${exactMatchCount === 1 ? '' : 's'}`;
            chip.classList.toggle('chip--ok', exactMatchCount > 0);
            chip.classList.toggle('chip--warn', exactMatchCount === 0 && photos.length > 0);
            chip.classList.toggle('chip--accent', photos.length === 0);
        }
        renderWhiteBox();

        const savedTemplate = albumPages[currentPage].template;
        if (savedTemplate) {
            const foundIdx = filteredTemplates.findIndex(t => t.id === savedTemplate.id);
            if (foundIdx !== -1) setPreview(foundIdx, false);
            else yellowPreviewArea.innerHTML = savedTemplate.url ? `<img src="${escapeHtml(savedTemplate.url)}">` : `<div style="color:#aaa;">${escapeHtml(/** @type {string} */ (savedTemplate.name))}</div>`;
        } else {
            if (filteredTemplates.length > 0) setPreview(0, false); else yellowPreviewArea.innerHTML = "";
        }
    }

    // ⚡ FIX: renderWhiteBox uses DocumentFragment — all cards built off-DOM,
    // then inserted in a single operation. Eliminates N reflows for N templates.
    function renderWhiteBox() {
        const frag = document.createDocumentFragment();
        const albumPages = store.get('albumPages');
        const currentPage = store.get('currentPage');
        const previewIndex = store.get('previewIndex');
        const savedId = albumPages[currentPage] && albumPages[currentPage].template && albumPages[currentPage].template.id;

        store.get('filteredTemplates').forEach((temp, idx) => {
            const card = document.createElement("div"); card.className = "thumb-card";
            card.dataset.tplId = temp.id;
            const isSelected = (previewIndex === idx) || (savedId && savedId === temp.id);
            if (isSelected) card.classList.add("is-selected");
            // Generative templates synthesize a quick SVG preview from their frame
            // geometry so the user can see the layout without authoring a PSD.
            if (temp._generative) {
                card.innerHTML = `${_generativePreviewSvg(temp)}<div class="thumb-card__label">${escapeHtml(/** @type {string} */ (temp.name))}</div>`;
                card.classList.add('thumb-card--generative');
            } else {
                card.innerHTML = `<img src="${escapeHtml(/** @type {string} */ (temp.url))}"><div class="thumb-card__label">${escapeHtml(/** @type {string} */ (temp.name))}</div>`;
            }
            card.onclick = () => setPreview(idx, true);
            card.ondblclick = () => buildTemplateWithSelection(temp);
            frag.appendChild(card);
        });

        whiteBox.innerHTML = ""; // Clear once
        whiteBox.appendChild(frag); // ⚡ Single reflow
    }

    // ── A2/B1: right-click context menus → Photoshop ───────────────
    // Templates → "Open in Photoshop"; Source images → "Open in PS" / "Place
    // (clipped to the active layer)". Reuses the osascript bridge IPCs
    // (open-in-photoshop, place-clipped). Opens the HR original when resolvable.
    /** @type {HTMLElement | null} */
    let _appCtxEl = null;
    function _hideAppCtx() { if (_appCtxEl) { _appCtxEl.remove(); _appCtxEl = null; } }
    /**
     * @param {number} x @param {number} y
     * @param {{ label: string, disabled?: boolean, fn: () => void }[]} entries
     */
    function _showAppCtx(x, y, entries) {
        _hideAppCtx();
        const menu = document.createElement('div');
        menu.className = 'app-ctx-menu';
        entries.forEach(en => {
            const b = document.createElement('button');
            b.className = 'app-ctx-menu__item';
            b.textContent = en.label;
            b.disabled = !!en.disabled;
            if (!en.disabled) b.addEventListener('click', () => { _hideAppCtx(); en.fn(); });
            menu.appendChild(b);
        });
        document.body.appendChild(menu);
        const r = menu.getBoundingClientRect();
        menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
        _appCtxEl = menu;
    }
    document.addEventListener('click', _hideAppCtx);
    document.addEventListener('scroll', _hideAppCtx, true);
    window.addEventListener('blur', _hideAppCtx);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _hideAppCtx(); });

    /** @param {string | null} filePath */
    async function _openInPS(filePath) {
        if (!filePath) { deps.toast('Could not resolve the file path', 'error'); return; }
        deps.setStatus('Opening in Photoshop…');
        try { await deps.invoke('open-in-photoshop', filePath); deps.notify('Opened in Photoshop', 'success'); }
        catch (e) { deps.toast('Open in Photoshop failed: ' + _errMessage(e), 'error'); }
        deps.setStatus('');
    }
    /** @param {string | null} filePath */
    async function _placeClippedPS(filePath) {
        if (!filePath) { deps.toast('Could not resolve the file path', 'error'); return; }
        deps.setStatus('Placing in Photoshop…');
        try {
            const r = await deps.invoke('place-clipped', filePath);
            if (typeof r === 'string' && r.indexOf('success') === -1) deps.toast('Place: ' + r, 'error');
            else deps.notify('Placed & clipped in Photoshop', 'success');
        } catch (e) { deps.toast('Place failed: ' + _errMessage(e), 'error'); }
        deps.setStatus('');
    }

    if (whiteBox) {
        whiteBox.addEventListener('contextmenu', (e) => {
            const card = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.thumb-card')); if (!card) return;
            const id = card.dataset.tplId; if (!id) return;
            const tpl = store.get('filteredTemplates').find(t => t.id === id) || store.get('templateLibrary').find(t => t.id === id);
            const tplPath = tpl && /** @type {any} */ (tpl.file) && /** @type {any} */ (tpl.file).nativePath;
            if (!tplPath) return; // generative templates have no PSD on disk
            e.preventDefault();
            _showAppCtx(e.clientX, e.clientY, [
                { label: '🎨 Open template in Photoshop', fn: () => _openInPS(tplPath) },
            ]);
        });
    }
    if (redBox) {
        redBox.addEventListener('contextmenu', (e) => {
            const img = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.thumb-red')); if (!img) return;
            const p = photoNativePath(img.id);
            e.preventDefault();
            _showAppCtx(e.clientX, e.clientY, [
                { label: '🎨 Open in Photoshop', disabled: !p, fn: () => _openInPS(p) },
                { label: '📌 Place on selected layer (clipped)', disabled: !p, fn: () => _placeClippedPS(p) },
            ]);
        });
    }

    /**
     * Show template `idx` (of filteredTemplates) in the Preview pane; when
     * saveToMemory, also assign it to the current page.
     *
     * @param {number} idx
     * @param {boolean} [saveToMemory]
     */
    function setPreview(idx, saveToMemory = true) {
        const filteredTemplates = store.get('filteredTemplates');
        if (!filteredTemplates[idx]) return;
        store.set('previewIndex', idx);
        const temp = filteredTemplates[idx];
        // When live preview is on, the Preview pane is owned by the live composite
        // — don't flash the bare template over it. (Selecting a template still
        // saves it below and triggers a re-composite.)
        if (!deps.isLivePreviewOn()) {
            if (temp._generative) {
                yellowPreviewArea.innerHTML = _generativePreviewSvg(temp, /*large*/ true);
            } else {
                yellowPreviewArea.innerHTML = temp.url ? `<img src="${escapeHtml(temp.url)}">` : `<div style="color:#aaa;">${escapeHtml(/** @type {string} */ (temp.name))}</div>`;
            }
        }
        if (saveToMemory) {
            const albumPages = store.get('albumPages');
            const currentPage = store.get('currentPage');
            if (!albumPages[currentPage]) albumPages[currentPage] = { photos: [], template: null };
            albumPages[currentPage].template = temp;
            deps.scheduleLivePreview(); // template changed → re-composite if live
        }
        renderWhiteBox();
    }

    return { scheduleFilterUpdate, setPreview, setActiveMatchPanel, photoNativePath };
}

module.exports = { createTemplateFilter };
