// @ts-check
// features/proofs.js — the fast proof renderer, live preview, and client
// proof gallery, extracted from main.js (Phase 2 split).
//
// Proofs are composite preview JPEGs rendered per page by the main-process
// sharp pipeline (proof_renderer.js) — no Photoshop in the loop, so a
// 200-page album proofs in seconds, not minutes. Frame geometry is extracted
// once per unique template (extract_frames.jsx) and cached on the template
// object; after that, re-proofing is pure libvips. The live preview (MVP)
// runs the CURRENT page through the same engine at a smaller maxEdge on a
// debounce, with a sequence guard so a stale render never overwrites a newer
// one. The gallery export packages the finished proofs for the client.
//
// DOM-owning module (preview pane, storyboard proof swap, buttons) with
// explicit store access; injected: IPC and status/toast/notify/alert.

/**
 * @typedef {import('../state/store').Store} Store
 * @typedef {import('../shared/domain').Template} Template
 */

const { escapeHtml, _generativePreviewSvg, _proofTemplatePreviewPath } = require('../renderer_pure');

/** @param {unknown} e */
function _errMessage(e) {
    return e instanceof Error ? e.message : String(e);
}

/**
 * Wire the proof system. Binds the live-preview toggle and the Generate
 * Proofs / Export Gallery buttons.
 *
 * @param {Store} store
 * @param {object} deps
 * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke  IPC dispatch
 * @param {(msg: string) => void} deps.setStatus
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.notify
 * @param {(msg: string) => void} deps.showAlert
 */
function createProofs(store, deps) {
    const yellowPreviewArea = /** @type {HTMLElement} */ (document.getElementById("yellowPreviewArea"));
    const storyboardGrid = document.getElementById("storyboardGrid");

    /** @type {Record<number, string>} */
    const _proofPaths = {};        // pageNum -> proof file path on disk (file://)
    /** @type {Record<number, string | number>} */
    const _proofHashes = {};       // pageNum -> last successful render hash

    // ── Live preview state (MVP) ────────────────────────────────────────────
    // When ON, the Preview pane shows a real libvips composite of the current
    // page instead of the bare template.
    let _livePreviewOn = false;
    /** @type {any} */
    let _liveTimer = null;
    let _liveSeq = 0;

    function isLivePreviewOn() { return _livePreviewOn; }

    function scheduleLivePreview() {
        if (!_livePreviewOn) return;
        clearTimeout(_liveTimer);
        _liveTimer = setTimeout(renderLivePreview, 280);
    }

    function _showTemplateThumb() {
        const albumPages = store.get('albumPages');
        const currentPage = store.get('currentPage');
        const t = albumPages[currentPage] && albumPages[currentPage].template;
        if (!t) { yellowPreviewArea.innerHTML = ''; return; }
        if (t._generative) yellowPreviewArea.innerHTML = _generativePreviewSvg(t, true);
        else yellowPreviewArea.innerHTML = t.url ? `<img src="${escapeHtml(t.url)}">` : `<div style="color:#aaa;">${escapeHtml(t.name || '')}</div>`;
    }

    async function renderLivePreview() {
        if (!_livePreviewOn) return;
        const currentPage = store.get('currentPage');
        const page = store.get('albumPages')[currentPage];
        if (!page || !page.template || !(page.photos && page.photos.length)) {
            _showTemplateThumb(); // nothing to composite yet
            return;
        }
        const seq = ++_liveSeq;
        yellowPreviewArea.classList.add('is-rendering');
        try {
            // Smaller maxEdge than batch proofs — the Preview pane is small and
            // we want it snappy on every edit.
            const res = await _generateProofForPage(currentPage, { live: true, maxEdge: 1000 });
            if (seq !== _liveSeq) return; // superseded by a newer render
            if (res && res.ok && res.outputPath) {
                yellowPreviewArea.innerHTML = `<img src="file://${encodeURI(res.outputPath)}?h=${res.hash || Date.now()}">`;
            } else {
                _showTemplateThumb();
            }
        } catch (_) {
            if (seq === _liveSeq) _showTemplateThumb();
        } finally {
            if (seq === _liveSeq) yellowPreviewArea.classList.remove('is-rendering');
        }
    }

    const chkLivePreview = /** @type {HTMLInputElement | null} */ (document.getElementById('chkLivePreview'));
    if (chkLivePreview) {
        chkLivePreview.addEventListener('change', () => {
            _livePreviewOn = chkLivePreview.checked;
            if (_livePreviewOn) renderLivePreview();
            else _showTemplateThumb();
        });
    }

    // ── Proof plumbing ──────────────────────────────────────────────────────

    function _proofProjectDir() {
        const currentProjectPath = store.get('currentProjectPath');
        if (!currentProjectPath) return null;
        return require('path').join(currentProjectPath, 'proofs', 'pages');
    }

    /**
     * Lazily extract frame geometry once per template, then cache it on the
     * template object so subsequent proofs are instant.
     * @param {Template} template
     */
    async function ensureTemplateFrames(template) {
        if (template._frames && template._canvas) return template;
        // Generative templates carry pre-baked frames — never round-trip
        // through Photoshop frame extraction for them.
        if (template._generative) return template;
        const tplPath = /** @type {any} */ (template.file)?.nativePath;
        if (!tplPath) {
            deps.toast(`Template ${template.name || '(unnamed)'} has no file path — re-load its folder`, 'error');
            return null;
        }
        deps.setStatus(`Reading frame layout from ${template.name}…`);
        let result;
        try {
            result = await deps.invoke('extract-template-frames', tplPath);
        } catch (e) {
            // IPC-level failure — usually means Photoshop isn't reachable.
            const msg = _errMessage(e) || 'Photoshop is not responding';
            deps.toast(`Couldn't open ${template.name}: ${msg}`, 'error');
            return null;
        }
        if (!result || !result.ok) {
            const detail = result?.error || 'unknown extension error (is the file inside the album reachable?)';
            deps.toast(`Couldn't read frames from ${template.name}: ${detail}`, 'error', { duration: 8000 });
            return null;
        }
        if (result.warning) {
            deps.toast(`${template.name}: ${result.warning}`, 'warning', { duration: 6000 });
        }
        template._frames = result.frames;
        template._canvas = { w: result.canvasWidth, h: result.canvasHeight };
        return template;
    }

    /** @param {any} photo */
    function _resolvePhotoFilePath(photo) {
        // Returns { primary, fallback } so the proof renderer can retry with a
        // smaller / known-good source if the HR file is in a format libvips
        // doesn't understand (RAW formats from camera SD cards being the usual
        // suspects — Canon .cr2, Nikon .nef, Sony .arw, generic .dng).
        const cache = /** @type {Record<string, any>} */ (store.get('photoCache'))[photo.id];
        if (!cache) return { primary: null, fallback: null };

        const proxyPath = cache.file?.nativePath || cache.proxy?.nativePath || null;

        // Extensions sharp/libvips can decode reliably. JFIF, EXIF JPEG, PNG,
        // TIFF, WebP, HEIC, AVIF, GIF. Everything else (RAW, .psd, .cr2, ...)
        // gets skipped here so we don't waste a sharp call on a guaranteed
        // failure.
        const READABLE = /\.(jpe?g|png|tiff?|webp|heic|heif|avif|gif)$/i;

        let hrPath = null;
        if (cache.hrFolder?.nativePath && cache.baseName) {
            const nodepath = require('path');
            // ⚡ PERF: was readdirSync PER PHOTO here — on a 200-page proof run
            // that's hundreds of synchronous directory scans on the renderer
            // thread. Reuse a session-cached, path-keyed HR index so it's one
            // read per unique HR folder. Exact-base match avoids the old greedy
            // bug (baseName "img_001" must not match "img_0010.cr2").
            const idx = _proofHrIndex(cache.hrFolder.nativePath);
            const candidates = idx.get(cache.baseName.toLowerCase()) || [];
            const exactReadable = candidates.find((f) => READABLE.test(f));
            if (exactReadable) {
                hrPath = nodepath.join(cache.hrFolder.nativePath, exactReadable);
            }
        }

        return {
            primary: hrPath || proxyPath,
            fallback: hrPath ? proxyPath : null,
        };
    }

    // Session cache of HR folder listings for proof file resolution, keyed by
    // the folder's native path. Mirrors getTrueFile's _hrEntriesCache
    // (session-stable) and is cleared at the start of each full proof batch so
    // a folder whose files changed between runs is re-scanned.
    // value: Map<baseNameLower, filename[]>
    /** @type {Map<string, Map<string, string[]>>} */
    const _proofHrIndexCache = new Map();
    /** @param {string} hrFolderPath */
    function _proofHrIndex(hrFolderPath) {
        let idx = _proofHrIndexCache.get(hrFolderPath);
        if (idx) return idx;
        idx = new Map();
        try {
            const nodefs = require('fs');
            for (const f of nodefs.readdirSync(hrFolderPath)) {
                const base = f.replace(/\.[^/.]+$/, '').toLowerCase();
                if (!idx.has(base)) idx.set(base, []);
                /** @type {string[]} */ (idx.get(base)).push(f);
            }
        } catch (_) { /* unreadable HR folder → empty index, proxy is used */ }
        _proofHrIndexCache.set(hrFolderPath, idx);
        return idx;
    }

    /**
     * @param {number} pageNum
     * @param {{ live?: boolean, maxEdge?: number }} [opts]
     */
    async function _generateProofForPage(pageNum, opts = {}) {
        const albumPages = store.get('albumPages');
        const projectData = store.get('projectData');
        const page = albumPages[pageNum];
        if (!page || !page.template || !page.photos?.length) return null;
        const tpl = await ensureTemplateFrames(page.template);
        if (!tpl) return null;

        const photos = page.photos.map(p => {
            const fp = _resolvePhotoFilePath(p);
            if (!fp.primary) return null;
            return {
                filePath: fp.primary,
                fallbackPath: fp.fallback || null,
                orient: p.orient,
                rotation: projectData.imageRotations?.[/** @type {string} */ (p.id)] || 0,
                adjust: projectData.imageAdjustments?.[/** @type {string} */ (p.id)] || null,
                placement: projectData.imagePlacements?.[/** @type {string} */ (p.id)] || null,
            };
        }).filter(Boolean);
        if (photos.length === 0) return null;

        const projectDir = _proofProjectDir();
        // If no project folder is set yet, fall back to the OS temp dir so
        // users can preview before the first save.
        const baseDir = projectDir || require('path').join(require('os').tmpdir(), 'albumstudio_proofs');
        // The live preview writes to a separate file so it never fights the
        // storyboard's page_NNN.jpg (different size, rendered on every edit).
        const fname = opts.live
            ? `live_page_${String(pageNum).padStart(3, '0')}.jpg`
            : `page_${String(pageNum).padStart(3, '0')}.jpg`;
        const outPath = require('path').join(baseDir, fname);

        const job = {
            templatePath: /** @type {any} */ (tpl.file).nativePath,
            templatePreviewPath: _proofTemplatePreviewPath(tpl),
            frames: tpl._frames,
            canvasWidth: /** @type {{ w: number, h: number }} */ (tpl._canvas).w,
            canvasHeight: /** @type {{ w: number, h: number }} */ (tpl._canvas).h,
            photos,
            outputPath: outPath,
            // Live preview renders smaller for speed (the preview pane is
            // small); batch proofs stay at 1500 for the storyboard/gallery.
            maxEdge: opts.maxEdge || 1500,
            // Center cover-fit, matching how Photoshop places photos
            // (build_page.jsx: resize to cover + MIDDLECENTER + center
            // translate) AND how the final libvips composite renders
            // (render-final-composite uses smartCrop:false). Saliency
            // 'attention' crop here would show a crop the user never actually
            // gets — defeating the proof's purpose as a faithful preview.
            smartCrop: false,
        };

        const res = await deps.invoke('render-proof', job);
        if (!res?.ok) {
            // Aggregate identical failures across the run so a 200-page album
            // with one bad source folder doesn't fire 200 toasts.
            const key = res?.error || 'unknown';
            _proofErrorCounts.set(key, (_proofErrorCounts.get(key) || 0) + 1);
            _proofFailedPages.push(pageNum);
            return null;
        }
        if (res.skipped?.length) {
            // Page composed but with missing photos (RAW etc.). Surface as a
            // single warning per run, not per page.
            for (const s of res.skipped) {
                const key = `skipped: ${s.error}`;
                _proofErrorCounts.set(key, (_proofErrorCounts.get(key) || 0) + 1);
            }
        }
        // Don't let the live preview's separate output overwrite the
        // storyboard's stored proof path/hash for this page.
        if (!opts.live) {
            _proofPaths[pageNum] = res.outputPath;
            _proofHashes[pageNum] = res.hash;
        }
        return res;
    }
    // Aggregated diagnostics for the current proof run. Cleared by
    // generateAllProofs() at the start of each invocation.
    /** @type {Map<string, number>} */
    const _proofErrorCounts = new Map();
    /** @type {number[]} */
    const _proofFailedPages = [];

    async function generateAllProofs() {
        // Fresh HR-folder listings for this batch (files may have changed
        // since the last run); the per-photo resolver reuses these within the
        // run.
        _proofHrIndexCache.clear();
        const albumPages = store.get('albumPages');
        const totalActivePages = store.get('totalActivePages');
        /** @type {number[]} */
        const pages = [];
        for (let i = 1; i <= totalActivePages; i++) {
            if (albumPages[i]?.template && albumPages[i]?.photos?.length) pages.push(i);
        }
        if (pages.length === 0) {
            deps.toast('No complete pages to proof yet', 'info');
            return;
        }

        // Phase 1: extract frame geometry for every UNIQUE template up front.
        // Without this, a 200-page album with 20 templates re-asked Photoshop
        // for the same frame data hundreds of times AND a single failure
        // surfaced as the same toast on every page using that template.
        const uniqueTemplates = new Map();
        for (const n of pages) {
            const tpl = /** @type {Template} */ (albumPages[n].template);
            const key = /** @type {any} */ (tpl.file)?.nativePath || tpl.id;
            if (!uniqueTemplates.has(key)) uniqueTemplates.set(key, tpl);
        }
        deps.setStatus(`Reading frame layout from ${uniqueTemplates.size} template${uniqueTemplates.size > 1 ? 's' : ''}…`);
        const failedTemplates = new Set();
        for (const [key, tpl] of uniqueTemplates) {
            const ready = await ensureTemplateFrames(tpl);
            if (!ready) failedTemplates.add(key);
        }
        if (failedTemplates.size === uniqueTemplates.size) {
            // Nothing usable — bail with a single, descriptive toast instead
            // of letting per-page errors flood the screen.
            deps.toast('All templates failed frame extraction. Check that Photoshop is running and the PSD files are reachable.', 'error');
            return;
        }

        // Reset run-level diagnostics so we report only this run's issues.
        _proofErrorCounts.clear();
        _proofFailedPages.length = 0;

        const t0 = performance.now();
        let done = 0, failed = 0, skippedTpl = 0;
        deps.setStatus(`Generating ${pages.length} proofs…`);

        // ⚡ Bounded-concurrency pool. Frames are already extracted (Photoshop,
        // above), so each page render is pure libvips — safe to overlap.
        // Running a few pages at once keeps the libvips threadpool and disk
        // I/O saturated (was strictly one-page-at-a-time). Bounded at 4 so
        // peak memory stays predictable on large albums (the C9 memory-spike
        // guard).
        const PROOF_CONCURRENCY = 4;
        let cursor = 0;
        async function _proofWorker() {
            while (cursor < pages.length) {
                const pageNum = pages[cursor++];
                const tpl = /** @type {Template} */ (albumPages[pageNum].template);
                const key = /** @type {any} */ (tpl.file)?.nativePath || tpl.id;
                if (failedTemplates.has(key)) { skippedTpl++; continue; }
                const r = await _generateProofForPage(pageNum);
                if (r?.ok) done++; else failed++;
                // Live update: swap the placeholder for the real proof as it lands.
                swapProofIntoStoryboard(pageNum);
                if ((done + failed) % 5 === 0 || (done + failed + skippedTpl) === pages.length) {
                    deps.setStatus(`Proofing ${done}/${pages.length}…`);
                }
            }
        }
        await Promise.all(
            Array.from({ length: Math.min(PROOF_CONCURRENCY, pages.length || 1) }, _proofWorker)
        );

        const ms = Math.round(performance.now() - t0);
        deps.invoke('telemetry-event', 'proof_run', {
            pages: pages.length, done, failed, skippedTpl, durationMs: ms,
            templatesFailed: failedTemplates.size,
        });
        const summary = [
            `Proofs ready · ${done} of ${pages.length}`,
            failed ? `${failed} failed` : null,
            skippedTpl ? `${skippedTpl} skipped (template unreadable)` : null,
            `${(ms / 1000).toFixed(1)}s`,
        ].filter(Boolean).join(' · ');
        deps.notify(summary, (failed || skippedTpl) ? 'warning' : 'success', { duration: 6000 });

        // Aggregated error breakdown — one toast per distinct error class,
        // with a count and a sampled page list so the user can act on it
        // instead of dismissing 200 identical messages.
        if (_proofErrorCounts.size > 0) {
            for (const [reason, count] of _proofErrorCounts) {
                const samplePages = _proofFailedPages.slice(0, 5).join(', ');
                const more = _proofFailedPages.length > 5 ? ` (+${_proofFailedPages.length - 5} more)` : '';
                deps.toast(
                    `${count} page${count > 1 ? 's' : ''} affected · ${reason}${samplePages ? ` · pages ${samplePages}${more}` : ''}`,
                    'error',
                    { duration: 9000 }
                );
            }
        }
    }

    /** @param {number} pageNum */
    function swapProofIntoStoryboard(pageNum) {
        // Replace the static template thumbnail in the rendered card with the
        // freshly composited proof. Avoids a full renderStoryboard() re-render
        // for every page and keeps DnD state intact.
        const cards = storyboardGrid?.querySelectorAll('.sb-page-card');
        if (!cards) return;
        const card = cards[pageNum - 1];
        if (!card) return;
        const wrap = card.querySelector('.sb-template-preview');
        if (!wrap) return;
        const img = wrap.querySelector('img');
        if (!img) return;
        // Cache-bust with the hash so a re-proof of the same page actually
        // refreshes the visible image instead of getting served the cached
        // file.
        const hash = _proofHashes[pageNum] || Date.now();
        img.src = `file://${_proofPaths[pageNum]}?h=${hash}`;
        img.style.opacity = '1';
        wrap.classList.add('sb-template-preview--proofed');
    }

    // Re-apply every cached proof after a storyboard rebuild, so a
    // renderStoryboard() doesn't wipe composites back to template thumbnails.
    function reapplyProofs() {
        const totalActivePages = store.get('totalActivePages');
        for (let i = 1; i <= totalActivePages; i++) {
            if (_proofPaths[i]) swapProofIntoStoryboard(i);
        }
    }

    // Drop all cached proof paths/hashes (project switch, folder reload) so
    // Tab 7 doesn't show stale composites.
    function clearProofs() {
        Object.keys(_proofPaths).forEach(k => delete _proofPaths[/** @type {any} */ (k)]);
        Object.keys(_proofHashes).forEach(k => delete _proofHashes[/** @type {any} */ (k)]);
    }

    // Debounced per-page storyboard re-proof after a Spread Editor edit.
    /** @type {Record<number, any>} */
    const _reproofTimers = {};
    /** @param {number} pageNum */
    function scheduleEditedPageReproof(pageNum) {
        const page = store.get('albumPages')[pageNum];
        if (!page || !page.template || !(page.photos && page.photos.length)) return;
        delete _proofHashes[pageNum]; // mark stale
        clearTimeout(_reproofTimers[pageNum]);
        _reproofTimers[pageNum] = setTimeout(async () => {
            try {
                const r = await _generateProofForPage(pageNum);
                if (r && r.ok) swapProofIntoStoryboard(pageNum);
            } catch (e) {
                // Silent failure here leaves a STALE proof in the storyboard
                // after an edit — worth a breadcrumb even though the next full
                // proof pass will heal it.
                console.warn(`Re-proof of page ${pageNum} failed (storyboard shows stale proof):`, _errMessage(e));
            }
        }, 450);
    }

    const btnGenerateProofs = document.getElementById('btnGenerateProofs');
    if (btnGenerateProofs) {
        btnGenerateProofs.addEventListener('click', () => {
            generateAllProofs().catch(e => deps.toast('Proof error: ' + _errMessage(e), 'error'));
        });
    }

    // ─── CLIENT PROOF GALLERY ────────────────────────────────────────
    const btnExportGallery = document.getElementById('btnExportGallery');
    if (btnExportGallery) {
        btnExportGallery.addEventListener('click', async () => {
            try {
                const currentProjectPath = store.get('currentProjectPath');
                if (!currentProjectPath) {
                    return deps.showAlert('Save the project first — the gallery is exported next to project.json.');
                }
                const albumPages = store.get('albumPages');
                const totalActivePages = store.get('totalActivePages');
                // Make sure proofs exist for every populated page. If something
                // is missing we run a partial proof pass before exporting.
                const missing = [];
                for (let i = 1; i <= totalActivePages; i++) {
                    const page = albumPages[i];
                    if (!page?.template || !page?.photos?.length) continue;
                    if (!_proofPaths[i]) missing.push(i);
                }
                if (missing.length > 0) {
                    deps.setStatus(`Proofing ${missing.length} pages before gallery export…`);
                    for (const n of missing) {
                        await _generateProofForPage(n);
                        swapProofIntoStoryboard(n);
                    }
                }

                const pages = [];
                for (let i = 1; i <= totalActivePages; i++) {
                    if (_proofPaths[i]) {
                        pages.push({
                            pageNum: i,
                            proofPath: _proofPaths[i],
                            label: `Page ${String(i).padStart(3, '0')}`
                        });
                    }
                }
                if (pages.length === 0) return deps.showAlert('No proofs available to export.');

                const albumName = currentProjectPath.split('/').pop() || 'Album';
                const result = await deps.invoke('export-proof-gallery', {
                    projectPath: currentProjectPath,
                    albumName,
                    pages,
                });
                if (!result?.ok) throw new Error('gallery export failed');

                // Open the gallery folder so the photographer can grab it.
                await deps.invoke('open-external', `file://${result.path}`);
                deps.notify(`Gallery ready · ${result.pages} pages`, 'success', { duration: 6000 });
            } catch (e) {
                deps.toast('Gallery error: ' + _errMessage(e), 'error');
            }
        });
    }

    return {
        isLivePreviewOn, scheduleLivePreview,
        ensureTemplateFrames, scheduleEditedPageReproof,
        reapplyProofs, clearProofs,
    };
}

module.exports = { createProofs };
