// @ts-check
// features/curation_ui.js — the photo curation panel (Tier 3), extracted from
// main.js (Phase 2 split). (The feature extraction / scoring engine lives in
// src/curation.js and runs in the main process.)
//
// Drop a folder, get a curated subset. Three-step UX:
//   1. ANALYZE — extracts features (sharpness, exposure, perceptual hash) for
//      every photo. Streams progress.
//   2. APPLY  — slide thresholds, see live counts of kept / dropped / dups.
//   3. EXPORT — copies keepers to <folder>/_Selected.
//
// DOM-owning and store-free: all state is panel-local (_curationState).

/**
 * Wire the curation panel controls.
 *
 * @param {object} deps
 * @param {(channel: string, ...args: any[]) => Promise<any>} deps.invoke  IPC dispatch
 * @param {(channel: string, listener: (event: any, ...args: any[]) => void) => void} deps.on  IPC push subscribe
 * @param {(channel: string, listener: (event: any, ...args: any[]) => void) => void} deps.off  IPC push unsubscribe
 * @param {() => Promise<any>} deps.pickFolder  fs.getFolder dialog (null on cancel)
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.toast
 * @param {(msg: string, kind?: string, opts?: { duration?: number }) => void} deps.notify
 */
function createCurationUi(deps) {
    /** @type {{ folderPath: string | null, features: any[] | null, lastCurate: any }} */
    const _curationState = {
        folderPath: null,    // absolute path of last analyzed folder
        features: null,      // last analysis result
        lastCurate: null,    // last curate() result for export
    };

    const _curateBtnAnalyze = /** @type {HTMLButtonElement | null} */ (document.getElementById('btnCurateAnalyze'));
    const _curateControls = /** @type {HTMLElement | null} */ (document.getElementById('curateControls'));
    const _curateStatus = /** @type {HTMLElement | null} */ (document.getElementById('curateStatus'));
    const _curateSummary = /** @type {HTMLElement | null} */ (document.getElementById('curateSummary'));
    const _curateBtnApply = /** @type {HTMLButtonElement | null} */ (document.getElementById('btnCurateApply'));
    const _curateBtnExport = /** @type {HTMLButtonElement | null} */ (document.getElementById('btnCurateExport'));

    function _curateOpts() {
        const sharpness = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('curateSharpness')).value, 10);
        const exposure = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('curateExposure')).value, 10) / 100;
        const dup = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('curateDup')).value, 10);
        const targetH = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('curateTargetH')).value, 10);
        const targetV = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('curateTargetV')).value, 10);
        /** @type {any} */
        const opts = {
            minSharpness: sharpness,
            minExposure: exposure,
            dupThreshold: dup,
        };
        if (Number.isFinite(targetH) && targetH > 0) opts.targetH = targetH;
        if (Number.isFinite(targetV) && targetV > 0) opts.targetV = targetV;
        return opts;
    }

    // Live label updates so the user sees what their slider actually means.
    ['curateSharpness', 'curateExposure', 'curateDup'].forEach(id => {
        const el = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
        if (!el) return;
        const lbl = /** @type {HTMLElement} */ (document.getElementById(id + 'Val'));
        el.addEventListener('input', () => {
            if (id === 'curateExposure') lbl.textContent = (Number(el.value) / 100).toFixed(2);
            else lbl.textContent = el.value;
        });
    });

    if (_curateBtnAnalyze) {
        _curateBtnAnalyze.addEventListener('click', async () => {
            try {
                const folder = await deps.pickFolder();
                if (!folder) return;
                _curationState.folderPath = folder.nativePath;
                _curateBtnAnalyze.disabled = true;
                if (_curateStatus) _curateStatus.textContent = 'Analyzing…';

                // Subscribe to progress events from main.
                const onProgress = (/** @type {any} */ _e, /** @type {any} */ p) => {
                    if (_curateStatus) _curateStatus.textContent = `Analyzing ${p.done}/${p.total}…`;
                };
                deps.on('curation-progress', onProgress);

                const t0 = performance.now();
                const res = await deps.invoke('curation-analyze', folder.nativePath);
                deps.off('curation-progress', onProgress);
                if (!res?.ok) {
                    if (_curateStatus) _curateStatus.textContent = 'Analysis failed: ' + (res?.error || 'unknown');
                    return;
                }
                _curationState.features = res.features;
                const ms = Math.round(performance.now() - t0);
                if (_curateStatus) _curateStatus.textContent = `Analyzed ${res.features.length} photos in ${(ms / 1000).toFixed(1)}s`;
                if (_curateControls) _curateControls.style.display = 'flex';
                await _runCurate();
            } catch (e) {
                if (_curateStatus) _curateStatus.textContent = 'Error: ' + (/** @type {any} */ (e)).message;
            } finally {
                _curateBtnAnalyze.disabled = false;
            }
        });
    }

    async function _runCurate() {
        if (!_curationState.features || !_curateSummary || !_curateBtnExport) return;
        const res = await deps.invoke('curation-curate', _curationState.features, _curateOpts());
        if (!res?.ok) {
            _curateSummary.textContent = 'Curation failed: ' + (res?.error || '');
            _curateSummary.style.display = 'block';
            return;
        }
        _curationState.lastCurate = res;
        const s = res.stats;
        _curateSummary.style.display = 'block';
        _curateSummary.innerHTML = `
            <strong>${s.kept}</strong> keepers / ${s.total} total ·
            ${s.droppedBlur} blurry ·
            ${s.droppedExposure} exposure ·
            ${s.droppedDuplicates} duplicates ·
            ${s.droppedError} unreadable ·
            ${s.clusters} unique scenes
        `;
        _curateBtnExport.disabled = s.kept === 0;
    }

    if (_curateBtnApply) _curateBtnApply.addEventListener('click', _runCurate);

    if (_curateBtnExport) {
        _curateBtnExport.addEventListener('click', async () => {
            if (!_curationState.lastCurate || !_curationState.folderPath) return;
            _curateBtnExport.disabled = true;
            const res = await deps.invoke(
                'curation-export',
                _curationState.lastCurate.keepers,
                _curationState.folderPath
            );
            _curateBtnExport.disabled = false;
            if (!res?.ok) {
                deps.toast('Export failed: ' + (res?.error || 'unknown'), 'error');
                return;
            }
            deps.notify(`Copied ${res.copied} photos → ${res.dest.split('/').pop()}/`, 'success', { duration: 6000 });
            await deps.invoke('open-external', 'file://' + res.dest);
        });
    }
}

module.exports = { createCurationUi };
