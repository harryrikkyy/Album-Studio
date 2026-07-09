// @ts-check
// features/tools_tab.js — the Tab 5 tool cards, extracted from main.js
// (Phase 2 split): image swap, thumbnail generation, batch JPEG export, the
// PSD resizer, the floating Tools Bar launcher, and the Renamer opener.
// Each card is a button + an IPC round-trip with progress streamed back over
// a push channel; all heavy lifting happens in the main process.
//
// DOM-owning and store-free. (The J1 adjustment-layers toggle stays in
// main.js — it flips export-flow state the render queue reads.)

/**
 * Wire the Tab 5 tool cards.
 *
 * @param {object} deps
 * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke  IPC dispatch
 * @param {(channel: string, listener: (event: any, ...args: any[]) => void) => void} deps.on  IPC push subscribe
 * @param {() => Promise<any>} deps.pickFolder  fs.getFolder dialog (null on cancel)
 * @param {(msg: string) => void} deps.showAlert
 * @param {(msg: string) => void} deps.setStatus
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.notify
 */
function createToolsTab(deps) {
    const btnSwapImages = /** @type {HTMLButtonElement | null} */ (document.getElementById("btnSwapImages"));
    if (btnSwapImages) {
        btnSwapImages.addEventListener("click", async () => {
            try {
                deps.setStatus('Swapping images…');
                const result = await deps.invoke('swap-images');
                if (result && result.startsWith('ALERT:')) {
                    deps.showAlert(result.replace('ALERT:', ''));
                } else if (result && result.startsWith('ERROR:')) {
                    deps.toast('Swap error: ' + result.replace('ERROR:', ''), 'error');
                } else {
                    deps.notify('Swap complete', 'success');
                }
            } catch(err) { deps.toast('Swap error: ' + (/** @type {any} */ (err)).message, 'error'); }
        });
    }

    const btnGenerateThumbs = /** @type {HTMLButtonElement | null} */ (document.getElementById("btnGenerateThumbs"));
    if (btnGenerateThumbs) {
        // Live progress from both lanes (fast sharp + RAW Photoshop).
        deps.on('thumbs-progress', (_e, p) => {
            const laneLabel = p.lane === 'raw' ? 'RAW' : 'fast';
            if (p.total > 0) deps.setStatus(`Thumbnails (${laneLabel}) ${p.done}/${p.total}…`);
        });
        btnGenerateThumbs.addEventListener("click", async () => {
            try {
                const folder = await deps.pickFolder();
                if (!folder) return;
                btnGenerateThumbs.disabled = true;
                deps.setStatus('Generating thumbnails…');
                const res = await deps.invoke('thumbnails-generate', folder.nativePath);
                if (!res?.ok) {
                    deps.toast('Thumbnail error: ' + (res?.error || 'unknown'), 'error');
                    return;
                }
                const secs = (res.durationMs / 1000).toFixed(1);
                const parts = [`${res.fastProcessed} fast`];
                if (res.rawTotal > 0) parts.push(`${res.rawProcessed} RAW`);
                if (res.failed) parts.push(`${res.failed} failed`);
                deps.notify(`Thumbnails done · ${parts.join(' · ')} in ${secs}s`,
                    res.failed ? 'warning' : 'success', { duration: 6000 });
                if (res.failed && res.errors?.length) {
                    for (const msg of res.errors.slice(0, 3)) deps.toast('Thumbnail: ' + msg, 'error', { duration: 8000 });
                }
            } catch(err) {
                deps.toast("Thumbnail error: " + (/** @type {any} */ (err)).message, 'error');
            } finally {
                btnGenerateThumbs.disabled = false;
            }
        });
    }

    // ─── BATCH JPEG EXPORT ───────────────────────────────────────
    // Pick a PSD folder, get JPEG-High-Res/ (quality 12) and JPEG-Low-Res/
    // (quality 1) created as siblings. Live progress bar driven by an IPC
    // stream from main; poll cadence is 500 ms which feels smooth on a
    // 200-PSD album (~1 PSD per 1–3s on a typical Mac).
    const btnJpegExport = /** @type {HTMLButtonElement | null} */ (document.getElementById('btnJpegExport'));
    const jpegProgressEl  = /** @type {HTMLElement | null} */ (document.getElementById('jpegProgress'));
    const jpegProgressFill = /** @type {HTMLElement | null} */ (document.getElementById('jpegProgressFill'));
    const jpegProgressText = /** @type {HTMLElement | null} */ (document.getElementById('jpegProgressText'));
    const jpegStatusEl    = /** @type {HTMLElement | null} */ (document.getElementById('jpegExportStatus'));

    if (btnJpegExport) {
        // Single delegated progress listener — registered once at module load
        // so the renderer never accumulates duplicate listeners across runs.
        deps.on('jpeg-export-progress', (_e, p) => {
            if (!jpegProgressEl) return;
            jpegProgressEl.style.display = 'flex';
            const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
            if (jpegProgressFill) jpegProgressFill.style.width = pct + '%';
            if (jpegProgressText) {
                jpegProgressText.textContent = `${p.done}/${p.total}`;
            }
            if (jpegStatusEl) {
                jpegStatusEl.textContent = p.current ? `Now: ${p.current}` : '';
            }
        });

        btnJpegExport.addEventListener('click', async () => {
            try {
                const folder = await deps.pickFolder();
                if (!folder) return;
                btnJpegExport.disabled = true;
                if (jpegProgressEl) jpegProgressEl.style.display = 'flex';
                if (jpegProgressFill) jpegProgressFill.style.width = '0%';
                if (jpegProgressText) jpegProgressText.textContent = 'Starting…';
                if (jpegStatusEl) jpegStatusEl.textContent = 'Scanning PSDs…';
                deps.setStatus('Exporting JPEGs from ' + folder.name + '…');

                const res = await deps.invoke('jpeg-export', folder.nativePath);
                if (!res?.ok) {
                    deps.toast('JPEG export failed: ' + (res?.error || 'unknown'), 'error');
                    if (jpegStatusEl) jpegStatusEl.textContent = 'Failed';
                    return;
                }
                if (res.total === 0) {
                    deps.toast('No PSDs found in that folder', 'info');
                    if (jpegStatusEl) jpegStatusEl.textContent = 'No PSDs found';
                    if (jpegProgressEl) jpegProgressEl.style.display = 'none';
                    return;
                }
                // Final "100%" tick in case the last progress write didn't land.
                if (jpegProgressFill) jpegProgressFill.style.width = '100%';
                if (jpegProgressText) jpegProgressText.textContent = `${res.processed}/${res.total}`;
                const seconds = (res.durationMs / 1000).toFixed(1);
                const summary = `Exported ${res.processed} of ${res.total}` +
                    (res.failed ? ` · ${res.failed} failed` : '') +
                    ` in ${seconds}s`;
                if (jpegStatusEl) jpegStatusEl.textContent = summary;
                deps.notify(summary, res.failed ? 'warning' : 'success', { duration: 6000 });

                // If any PSDs failed, surface the first few error messages so
                // the user knows what to look at instead of just a count.
                if (res.failed && res.errors?.length) {
                    for (const msg of res.errors.slice(0, 3)) {
                        deps.toast('JPEG export error: ' + msg, 'error', { duration: 8000 });
                    }
                }

                // Open the parent folder in Finder so the new JPEG-High-Res /
                // JPEG-Low-Res folders are immediately visible.
                try {
                    const parent = res.hiResFolder.replace(/\/JPEG-High-Res$/, '');
                    await deps.invoke('open-external', 'file://' + parent);
                } catch (_) {}
            } catch (e) {
                deps.toast('JPEG export error: ' + (/** @type {any} */ (e)).message, 'error');
            } finally {
                btnJpegExport.disabled = false;
                // Hide the progress bar after a few seconds so it doesn't sit
                // there permanently after a successful run.
                setTimeout(() => {
                    if (jpegProgressEl) jpegProgressEl.style.display = 'none';
                }, 5000);
            }
        });
    }

    // ─── PSD RESIZER (F1) ────────────────────────────────────────
    // Pick a folder of PSDs → resize each to 12in tall @ 300ppi (proportional).
    // Overwrite originals or save copies into a Resized/ subfolder. Live progress
    // via the resize-psds-progress IPC stream, mirroring JPEG export.
    const btnResizePsds = /** @type {HTMLButtonElement | null} */ (document.getElementById('btnResizePsds'));
    const resizeProgressEl = /** @type {HTMLElement | null} */ (document.getElementById('resizeProgress'));
    const resizeProgressFill = /** @type {HTMLElement | null} */ (document.getElementById('resizeProgressFill'));
    const resizeProgressText = /** @type {HTMLElement | null} */ (document.getElementById('resizeProgressText'));
    const resizeStatusEl = /** @type {HTMLElement | null} */ (document.getElementById('resizeStatus'));
    if (btnResizePsds) {
        deps.on('resize-psds-progress', (_e, p) => {
            if (!resizeProgressEl) return;
            resizeProgressEl.style.display = 'flex';
            const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
            if (resizeProgressFill) resizeProgressFill.style.width = pct + '%';
            if (resizeProgressText) resizeProgressText.textContent = `${p.done}/${p.total}`;
            if (resizeStatusEl) resizeStatusEl.textContent = p.current ? `Now: ${p.current}` : '';
        });

        btnResizePsds.addEventListener('click', async () => {
            try {
                const folder = await deps.pickFolder();
                if (!folder) return;
                const overwrite = !!(/** @type {HTMLInputElement | null} */ (document.getElementById('chkResizeOverwrite'))?.checked);
                if (overwrite) {
                    const ok = confirm('Overwrite the original PSDs in "' + folder.name + '"?\n\nThis replaces each file in place. Turn the toggle off to save copies into a Resized/ subfolder instead.');
                    if (!ok) return;
                }
                btnResizePsds.disabled = true;
                if (resizeProgressEl) resizeProgressEl.style.display = 'flex';
                if (resizeProgressFill) resizeProgressFill.style.width = '0%';
                if (resizeProgressText) resizeProgressText.textContent = 'Starting…';
                if (resizeStatusEl) resizeStatusEl.textContent = 'Scanning PSDs…';
                deps.setStatus('Resizing PSDs in ' + folder.name + '…');

                const res = await deps.invoke('resize-psds', folder.nativePath, overwrite ? 'overwrite' : 'copy');
                if (!res?.ok) {
                    deps.toast('PSD resize failed: ' + (res?.error || 'unknown'), 'error');
                    if (resizeStatusEl) resizeStatusEl.textContent = 'Failed';
                    return;
                }
                if (res.total === 0) {
                    deps.toast('No PSDs found in that folder', 'info');
                    if (resizeStatusEl) resizeStatusEl.textContent = 'No PSDs found';
                    if (resizeProgressEl) resizeProgressEl.style.display = 'none';
                    return;
                }
                if (resizeProgressFill) resizeProgressFill.style.width = '100%';
                if (resizeProgressText) resizeProgressText.textContent = `${res.processed}/${res.total}`;
                const seconds = (res.durationMs / 1000).toFixed(1);
                const dest = overwrite ? 'overwritten in place' : 'saved to Resized/';
                const summary = `Resized ${res.processed} of ${res.total} (${dest})` +
                    (res.failed ? ` · ${res.failed} failed` : '') + ` in ${seconds}s`;
                if (resizeStatusEl) resizeStatusEl.textContent = summary;
                deps.notify(summary, res.failed ? 'warning' : 'success', { duration: 6000 });
                if (res.failed && res.errors?.length) {
                    for (const msg of res.errors.slice(0, 3)) deps.toast('Resize error: ' + msg, 'error', { duration: 8000 });
                }
            } catch (e) {
                deps.toast('PSD resize error: ' + (/** @type {any} */ (e)).message, 'error');
            } finally {
                btnResizePsds.disabled = false;
                setTimeout(() => { if (resizeProgressEl) resizeProgressEl.style.display = 'none'; }, 5000);
            }
        });
    }

    // ─── FLOATING TOOLS BAR LAUNCHER ─────────────────────────────
    // Opens (or focuses) the thin frameless window that docks itself to
    // Photoshop's bottom edge. Status pill on the card mirrors open/closed.
    const btnOpenToolsBar = /** @type {HTMLButtonElement | null} */ (document.getElementById('btnOpenToolsBar'));
    const toolsBarStatusEl = /** @type {HTMLElement | null} */ (document.getElementById('toolsBarStatus'));

    async function refreshToolsBarStatus() {
        if (!toolsBarStatusEl) return;
        try {
            const r = await deps.invoke('tools-bar-status');
            const open = !!r?.open;
            toolsBarStatusEl.textContent = open ? 'Active' : 'Closed';
            toolsBarStatusEl.classList.toggle('tools-card__pill--active', open);
            toolsBarStatusEl.classList.toggle('tools-card__pill--neutral', !open);
            if (btnOpenToolsBar) {
                btnOpenToolsBar.textContent = open ? '🪄 TOOLS BAR ACTIVE' : '🪄 OPEN TOOLS BAR';
            }
        } catch (_) {}
    }

    if (btnOpenToolsBar) {
        btnOpenToolsBar.addEventListener('click', async () => {
            const r = await deps.invoke('tools-bar-open');
            if (!r?.ok) {
                deps.toast('Could not open Tools Bar: ' + (r?.error || 'unknown'), 'error');
                return;
            }
            deps.notify('Tools Bar attached to Photoshop', 'success', { duration: 4000 });
            refreshToolsBarStatus();
            // Poll status briefly so the pill updates when PS minimizes/closes.
            setTimeout(refreshToolsBarStatus, 1500);
        });
    }

    // ── RENAMER ───────────────────────────────────────────────
    // Opens the dedicated Renamer window (src/renamer.html). Standalone window
    // so the drag-and-drop workspace has room to breathe.
    const btnOpenRenamer = document.getElementById('btnOpenRenamer');
    if (btnOpenRenamer) {
        btnOpenRenamer.addEventListener('click', async () => {
            try {
                const r = await deps.invoke('renamer-open');
                if (!r?.ok) {
                    deps.toast('Could not open Renamer: ' + (r?.error || 'unknown'), 'error');
                }
            } catch (e) {
                deps.toast('Could not open Renamer: ' + ((/** @type {any} */ (e)).message || e), 'error');
            }
        });
    }

    return { refreshToolsBarStatus };
}

module.exports = { createToolsTab };
