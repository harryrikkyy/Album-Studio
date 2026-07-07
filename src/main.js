const fs = require("./stubs/uxp").storage.localFileSystem;
const { app, core } = require("./stubs/photoshop");
const { batchPlay } = require("./stubs/photoshop").action;

// Pure, testable helpers extracted from this file (no DOM / no shared state).
// See src/renderer_pure.js. Destructured here so every existing call site
// (escapeHtml(...), _generativePreviewSvg(...), etc.) resolves unchanged.
const {
    escapeHtml,
    _generativePreviewSvg,
    getPanelHeaderHTML,
    getDisplayName,
    _hashPage,
    _parseExifDateFromBuffer,
    _proofTemplatePreviewPath,
    _isEditingTarget,
    _compactPage,
    _hydratePage,
} = require("./renderer_pure");

// ⚡ PERFORMANCE NOTE: All CSS that was previously injected here as a JS string
// has been moved to style.css. This removes a render-blocking JS-to-CSSOM path.

// ==========================================
// --- TAB SWITCHING LOGIC ---
// ==========================================
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

// ⚡ Lazy Tab 6 flag — photosGrid is only built when the user first opens Tab 6
let tab6Rendered = false;

tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        tabButtons.forEach(b => b.classList.remove('active'));
        tabPanes.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const targetId = btn.getAttribute('data-target');
        const targetPane = document.getElementById(targetId);
        if (targetPane) targetPane.classList.add('active');

        if (targetId === 'tab-export') renderStoryboard();

        // ⚡ Lazy render: build Tab 6 grid only on first visit
        if (targetId === 'tab-photos' && !tab6Rendered) {
            tab6Rendered = true;
            renderPhotosGrid();
        }
    });
});

// ==========================================
// --- GLOBAL VARIABLES & MEMORY ---
// ==========================================
let albumPages = {}, templateLibrary = [], filteredTemplates = [];
let previewIndex = 0, currentPage = 1, totalActivePages = 1;
// Slice 4 (A1/B2): template sync state. Sync ON = match templates to whichever
// panel you're working in; OFF = always show all. `_activeMatchPanel` is sticky
// ('source' | 'pages' | null) — it remembers the last panel you worked in so
// moving the pointer to the Templates panel keeps the match instead of resetting.
let _syncTemplates = (() => { try { return localStorage.getItem('adt_template_sync') !== '0'; } catch (_) { return true; } })();
let _activeMatchPanel = null;
// J1: render colour as editable clipped adjustment layers instead of baking
// pixels. EXPERIMENTAL — off by default (the bake path stays the safe default).
let _useAdjLayers = (() => { try { return localStorage.getItem('adt_adj_layers') === '1'; } catch (_) { return false; } })();
let photoCache = {}, wallpaperCache = {}, pngCache = {}, maskedCache = {};
let outputFolder = null;

let projectData = {
    imageTokens: [], templateTokens: [], wallpaperTokens: [],
    pngTokens: [], maskTokens: [], highResTokens: [], wpHighResTokens: [],
    outputToken: null, imageRotations: {}, imageAdjustments: {}, imagePlacements: {}
};

let activeImageFolders = new Set(), activeTemplateFolders = new Set();
let activeWallpaperFolders = new Set(), activePngFolders = new Set(), activeMaskedFolders = new Set();

let autoHighResFolder = null;
let globalHighResMap = {};
let globalWpHighResMap = {};

// ⚡ Reverse lookup: photoId → Set<pageNumber>
// Eliminates the O(n×m) scan in applyGlobalRotation and other places.
const photoPageMap = {};
function addToPageMap(photoId, pageNum) {
    if (!photoPageMap[photoId]) photoPageMap[photoId] = new Set();
    photoPageMap[photoId].add(pageNum);
}
function removeFromPageMap(photoId, pageNum) {
    if (photoPageMap[photoId]) photoPageMap[photoId].delete(pageNum);
}
function rebuildPhotoPageMap() {
    Object.keys(photoPageMap).forEach(k => delete photoPageMap[k]);
    Object.entries(albumPages).forEach(([pageNum, page]) => {
        if (page && page.photos) {
            page.photos.forEach(p => addToPageMap(p.id, parseInt(pageNum)));
        }
    });
}

// ⚡ Task 2.3: single idempotent "apply album state → view" function.
// Rebuilds the `.used` markers (and clears stale opacity) on Tab 1 source
// thumbnails and Tab 6 photo cards purely from albumPages. Previously this
// 6-line loop was copy-pasted at ~6 call sites (history apply, refreshTab,
// clear-album, restore, etc.) and the partial copies drifted, causing
// stale-marker bugs. Every mutation path now funnels through this.
function syncViewToState() {
    // 1. Clear every source thumbnail (Tab 1) + photo card (Tab 6).
    document.querySelectorAll('.thumb-red').forEach(img => {
        img.classList.remove('used');
        img.style.opacity = '1';
    });
    document.querySelectorAll('#photosGrid .wp-card').forEach(c => c.classList.remove('used'));

    // 2. Re-mark everything currently placed in the album.
    Object.values(albumPages).forEach(page => {
        if (!page || !page.photos) return;
        page.photos.forEach(p => {
            const r = document.getElementById(p.id); if (r) r.classList.add('used');
            const c = document.getElementById('pt_' + p.id); if (c) c.classList.add('used');
        });
    });
}

const redBox = document.getElementById("redBox"), greenBox = document.getElementById("greenBox");
const whiteBox = document.getElementById("whiteBox"), yellowPreviewArea = document.getElementById("yellowPreviewArea");
const pageSelect = document.getElementById("pageSelect"), teleportSelect = document.getElementById("teleportTargetPage");
const statusText = document.getElementById("statusText"), wallpaperGrid = document.getElementById("wallpaperGrid");
const pngGrid = document.getElementById("pngGrid"), maskedGrid = document.getElementById("maskedGrid");
const photosGrid = document.getElementById("photosGrid");
const photosSlider = document.getElementById("photosSlider");
const btnLoadPhotosTab = document.getElementById("btnLoadPhotosTab");
const storyboardGrid = document.getElementById("storyboardGrid");

// ── Live preview state (MVP) ───────────────────────────────────
// When ON, the Preview pane shows a real libvips composite of the current
// page instead of the bare template. Declared up top so setPreview() and
// renderGreenBox() can reference it without TDZ concerns.
let _livePreviewOn = false;
let _liveTimer = null;
let _liveSeq = 0;

// ⚡ FIX: Debounced save — coalesces rapid calls (rotation spam, slider drag)
// into a single write 800ms after the last call. Eliminates repeated JSON.stringify.
let _saveTimer;
// Build a compact album for persistence: strip re-derivable fields (photo
// url, full template object) so localStorage stays well under quota even for
// 200-page albums. url is re-added by processImageFolder on load; templates
// relink by id in restoreWorkspace.
function _compactAlbumForStorage() {
    const out = {};
    for (const [num, page] of Object.entries(albumPages)) {
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
            localStorage.setItem("adt_workspace", JSON.stringify(projectData));
            localStorage.setItem("adt_album", JSON.stringify({
                albumPages: _compactAlbumForStorage(),
                totalActivePages
            }));
        } catch (e) { console.error('saveStateToStorage failed:', e); }
    }, 800);
}

// escapeHtml + _generativePreviewSvg moved to src/renderer_pure.js (required above).

// ─── HISTORY (undo / redo) ─────────────────────────────────────
// Every mutation that should be undoable is wrapped in mutate(label, fn).
// We snapshot the relevant slices BEFORE the mutation and push the snapshot
// onto an undo stack. Cmd+Z / Cmd+Shift+Z replay snapshots.
//
// What's tracked: albumPages (photo placement, templates), totalActivePages,
// projectData.imageRotations, currentPage. NOT tracked: folder loads, file
// IPC, ephemeral UI state — those have explicit re-do paths.
const _HISTORY_CAP = 80;
const _historyUndo = [];
const _historyRedo = [];
let _historyMuted = 0; // mutate() calls inside undo/redo must not push history

// ⚡ Task 3.2: COMPACT snapshots. The old version did
// structuredClone(albumPages) on every mutation — for a 200-page album with
// embedded thumbnail `url` strings per photo, each snapshot was multiple MB,
// and the 80-entry cap could hold hundreds of MB of deep clones.
//
// A snapshot now stores only the structural skeleton: per page the template
// id (+ generative spec) and an ordered list of photo refs WITHOUT the url
// or any other re-derivable field. On apply we re-hydrate full photo objects
// from photoCache (url) and re-link templates from templateLibrary. This
// shrinks each snapshot by ~10–50× with identical restore fidelity.
// _compactPage + _hydratePage moved to src/renderer_pure.js (required at top).
// _hydratePage now takes (cpage, templateLibrary, photoCache) — the caller in
// _historyApply passes the renderer's live collections.

function _historySnapshot(label) {
    const compactPages = {};
    for (const [num, page] of Object.entries(albumPages)) compactPages[num] = _compactPage(page);
    return {
        label,
        albumPages: compactPages,
        totalActivePages,
        imageRotations: structuredClone(projectData.imageRotations || {}),
        currentPage
    };
}

function _historyApply(snap) {
    const hydrated = {};
    for (const [num, cpage] of Object.entries(snap.albumPages)) hydrated[num] = _hydratePage(cpage, templateLibrary, photoCache);
    albumPages = hydrated;
    totalActivePages = snap.totalActivePages;
    projectData.imageRotations = structuredClone(snap.imageRotations);
    currentPage = snap.currentPage || 1;

    rebuildPhotoPageMap();
    if (typeof updatePageDropdowns === 'function') updatePageDropdowns();
    if (typeof renderGreenBox === 'function') renderGreenBox();
    if (typeof scheduleFilterUpdate === 'function') scheduleFilterUpdate();
    if (typeof renderStoryboard === 'function') renderStoryboard();

    // Refresh the .used markers on source thumbnails (single owner).
    syncViewToState();

    saveStateToStorage();
}

/**
 * Run a mutating function with undo support. Snapshots state before the call,
 * pushes onto the undo stack, clears the redo stack, runs the mutator, and
 * persists.
 *
 * Usage:
 *   mutate('Add page', () => { albumPages[N+1] = {...}; totalActivePages++; });
 *
 * If you call mutate() from inside another mutate(), only the outermost
 * snapshot is pushed (atomic transactions). Inside undo()/redo(), mutate()
 * does not push at all (_historyMuted guard).
 */
function mutate(label, fn) {
    if (_historyMuted > 0) {
        // Already inside a history apply — don't snapshot, just run.
        const r = fn();
        return r;
    }
    const snap = _historySnapshot(label);
    let result;
    try {
        result = fn();
    } catch (e) {
        // Rollback on throw so we don't leave partial state behind.
        _historyMuted++;
        try { _historyApply(snap); } finally { _historyMuted--; }
        throw e;
    }
    _historyUndo.push(snap);
    if (_historyUndo.length > _HISTORY_CAP) _historyUndo.shift();
    _historyRedo.length = 0; // any new mutation invalidates redo stack
    saveStateToStorage();
    return result;
}

function undo() {
    if (_historyUndo.length === 0) { toast('Nothing to undo', 'info', { duration: 1500 }); return; }
    const current = _historySnapshot('redo');
    const prev = _historyUndo.pop();
    _historyRedo.push(current);
    _historyMuted++;
    try { _historyApply(prev); } finally { _historyMuted--; }
    toast('Undo: ' + (prev.label || 'change'), 'info', { duration: 1400 });
}

function redo() {
    if (_historyRedo.length === 0) { toast('Nothing to redo', 'info', { duration: 1500 }); return; }
    const current = _historySnapshot('undo');
    const next = _historyRedo.pop();
    _historyUndo.push(current);
    _historyMuted++;
    try { _historyApply(next); } finally { _historyMuted--; }
    toast('Redo', 'info', { duration: 1200 });
}

// ─── TOAST + STATUS SYSTEM ─────────────────────────────────────
// Replaces the previous pattern of writing every state change into
// the 10px footer #statusText label that nobody reads. Now:
//   setStatus(msg)              → footer only (transient progress)
//   toast(msg, kind, opts)      → ephemeral toast in the corner
//   notify(msg, kind, opts)     → BOTH: toast + footer
//
// kind ∈ 'info' | 'success' | 'warning' | 'error'.
// `duration: 0` makes a toast sticky (user must close).
const _toastIcons = { info: 'ℹ', success: '✓', warning: '⚠', error: '✕' };

function _ensureToastStack() {
    let stack = document.getElementById('toastStack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'toastStack';
        stack.className = 'toast-stack';
        stack.setAttribute('role', 'status');
        stack.setAttribute('aria-live', 'polite');
        document.body.appendChild(stack);
    }
    return stack;
}

function toast(message, kind = 'info', { duration = 3500 } = {}) {
    const stack = _ensureToastStack();
    const el = document.createElement('div');
    el.className = `toast toast--${kind}`;
    if (kind === 'error') el.setAttribute('aria-live', 'assertive');

    const icon = document.createElement('span');
    icon.className = 'toast__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = _toastIcons[kind] || _toastIcons.info;

    const body = document.createElement('div');
    body.className = 'toast__body';
    body.textContent = message;

    const close = document.createElement('button');
    close.className = 'toast__close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';

    el.appendChild(icon);
    el.appendChild(body);
    el.appendChild(close);
    stack.appendChild(el);

    let timer = null;
    const dismiss = () => {
        if (!el.parentNode) return;
        el.classList.add('is-leaving');
        el.addEventListener('animationend', () => el.remove(), { once: true });
        if (timer) clearTimeout(timer);
    };
    close.addEventListener('click', dismiss);
    if (duration > 0) timer = setTimeout(dismiss, duration);

    return { dismiss };
}

function setStatus(message) {
    if (statusText) statusText.innerText = message || '';
}

// Both: surface to the toast stack AND keep the footer in sync. Use this
// for any state change a user genuinely needs to know about.
function notify(message, kind = 'info', opts = {}) {
    setStatus(message);
    toast(message, kind, opts);
}

// getPanelHeaderHTML moved to src/renderer_pure.js (required at top).

// ⚡ Single source of truth for the per-folder row that lives inside a
// .folder-rail__panel. The 5 processXxxFolder() functions used to inline
// 4–5 lines of nearly-identical HTML each — this returns the fully-built
// element so they all share the same DOM contract.
function createFolderRow(displayName, folderId, token, count) {
    const row = document.createElement('div');
    row.className = 'folder-rail__row';

    const label = document.createElement('label');
    label.className = 'folder-rail__label';
    label.title = displayName;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.value = folderId;
    cb.dataset.token = token || '';

    // Full name (was truncated to 10 chars, which made similarly-named source
    // folders impossible to tell apart). CSS ellipsis handles overflow, and
    // the label `title` shows the full path on hover.
    const name = document.createElement('span');
    name.className = 'folder-rail__name';
    name.textContent = '📁 ' + displayName;

    // Optional count badge (e.g. number of photos in the folder).
    const countEl = document.createElement('span');
    countEl.className = 'folder-rail__count';
    if (typeof count === 'number') countEl.textContent = String(count);
    else countEl.style.display = 'none';

    label.appendChild(cb);
    label.appendChild(name);
    label.appendChild(countEl);
    row.appendChild(label);

    return { row, checkbox: cb, countEl };
}

// getDisplayName moved to src/renderer_pure.js (required at top).

// ⚡ FIX: Rotation only triggers renderGreenBox on orientation flip (h↔v).
// Non-flip rotations (0→90→180→270 within same axis) update the CSS transform
// directly and skip the full green box DOM rebuild entirely.
// Uses photoPageMap reverse lookup instead of scanning all pages.
function applyGlobalRotation(safeId, newRot) {
    mutate('Rotate photo', () => {
        const oldRot = projectData.imageRotations[safeId] || 0;
        projectData.imageRotations[safeId] = newRot;
        const isFlip = (Math.abs(newRot - oldRot) % 180) === 90;

        // Update Tab 1 (redBox) thumbnail in-place
        const img1 = document.getElementById(safeId);
        if (img1) {
            img1.style.transform = `rotate(${newRot}deg)`;
            const badge1 = img1.parentElement && img1.parentElement.querySelector('.rot-badge');
            if (badge1) { badge1.style.display = newRot === 0 ? "none" : "block"; badge1.innerText = newRot + "°"; }
        }

        if (tab6Rendered) {
            const card6 = document.getElementById("pt_" + safeId);
            if (card6) {
                const img6 = card6.querySelector(".tab6-photo-img");
                if (img6) img6.style.transform = `rotate(${newRot}deg)`;
                const badge6 = card6.querySelector('.rot-badge');
                if (badge6) { badge6.style.display = newRot === 0 ? "none" : "block"; badge6.innerText = newRot + "°"; }
            }
        }

        if (isFlip) {
            const pages = photoPageMap[safeId];
            if (pages) {
                pages.forEach(pageNum => {
                    const page = albumPages[pageNum];
                    if (page && page.photos) {
                        const p = page.photos.find(x => x.id === safeId);
                        if (p) p.orient = p.orient === 'h' ? 'v' : 'h';
                    }
                });
            }
            renderGreenBox();
            scheduleFilterUpdate();
        }

    saveStateToStorage();
    });
}

async function forceEmbed() {
    try { await batchPlay([{ "_obj": "placedLayerConvertToEmbedded" }], {}); } catch(e) {}
}

// ⚡ PERF (Task 1.3): cache each HR folder's entry list keyed on the folder
// object so repeated getTrueFile() calls (double-click placement, export)
// don't re-scan the directory once per photo. A UXP folder object is stable
// for the session, so a WeakMap keyed on it is a safe, self-evicting cache.
const _hrEntriesCache = new WeakMap();
async function _getHrEntriesIndexed(hrFolder) {
    if (_hrEntriesCache.has(hrFolder)) return _hrEntriesCache.get(hrFolder);
    // Build baseNameLower -> entry[] once. Multiple extensions can share a
    // basename (img_001.cr2 + img_001.jpg), so the value is an array.
    const idx = new Map();
    try {
        const entries = await hrFolder.getEntries();
        for (const e of entries) {
            if (!e.isFile) continue;
            const base = e.name.replace(/\.[^/.]+$/, '').toLowerCase();
            if (!idx.has(base)) idx.set(base, []);
            idx.get(base).push(e);
        }
    } catch (_) {}
    _hrEntriesCache.set(hrFolder, idx);
    return idx;
}

async function getTrueFile(cacheData) {
    let result = { file: cacheData.proxy, isHr: false };
    if (!cacheData.hrFolder) return result;
    try {
        const idx = await _getHrEntriesIndexed(cacheData.hrFolder);
        const matches = idx.get(cacheData.baseName) || [];
        if (matches.length > 0) {
            const best = matches.find(e => e.name.match(/\.(tif|tiff|cr2|raw|nef|arw|dng|rw2|psd|psb)$/i)) || matches[0];
            result.file = best; result.isHr = true;
        }
    } catch(e) {}
    return result;
}

// ─── EXIF DateTimeOriginal reader ──────────────────────────────
// Tiny, dependency-free JPEG EXIF parser. Reads the first ~256 KB of the
// file (more than enough — EXIF lives in the APP1 marker right after SOI),
// finds tag 0x9003 (DateTimeOriginal), parses "YYYY:MM:DD HH:MM:SS".
//
// Cached by photoId because we re-call this from auto-fill and curation.
const _exifCache = new Map();

// _parseExifDateFromBuffer moved to src/renderer_pure.js (required at top).

async function readExifDate(filePath) {
    if (_exifCache.has(filePath)) return _exifCache.get(filePath);
    try {
        const nodefs = require('fs').promises;
        // Read up to 256 KB — covers the APP1 marker comfortably.
        const handle = await nodefs.open(filePath, 'r');
        try {
            const buf = Buffer.alloc(256 * 1024);
            const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
            const slice = buf.subarray(0, bytesRead);
            const ts = _parseExifDateFromBuffer(slice);
            _exifCache.set(filePath, ts);
            return ts;
        } finally {
            await handle.close();
        }
    } catch (_) {
        _exifCache.set(filePath, null);
        return null;
    }
}

/**
 * Sort a photos array (each item must have a .id matching photoCache key) by
 * EXIF DateTimeOriginal in place. Photos without EXIF dates are sorted by
 * filename as a deterministic fallback (mirrors the previous order). Reads
 * EXIF concurrently, capped at 16 inflight to avoid syscall storms.
 */
async function sortPhotosByExif(items) {
    const CONCURRENCY = 16;
    const dates = new Map();
    // Track which path each photo's date came from so we can decide when to
    // fall back to the proxy. Without this, RAW or TIFF HR files (which our
    // bare-bones JPEG EXIF parser can't read) silently produce null dates
    // and the photos get sorted by filename — exactly the symptom that
    // looked like "it's using the thumbnail values".
    const sources = new Map();

    // Extensions our bare-bones JPEG EXIF parser can decode. JPEG and HEIC
    // both ship EXIF in an APP1 marker; TIFF/RAW have a different layout
    // and would need a real parser. The proxy thumbnail (which is always
    // a JPEG) inherits the source's EXIF so it's the safe fallback.
    const JPEG_LIKE = /\.(jpe?g|heic|heif)$/i;

    // ⚡ PERF (Tasks 1.1–1.2): build each HR folder's directory listing ONCE,
    // up front, instead of calling fs.readdirSync inside every worker. The old
    // code did one synchronous readdir PER PHOTO (O(n²) syscalls on the same
    // directory) AND blocked the event loop from inside the "async" worker.
    // Now we do one async readdir per UNIQUE folder and share an index map.
    const nfs = require('fs');
    const nfsp = require('fs').promises;
    const np = require('path');

    // hrFolderPath -> Map<baseNameLower, filename> of JPEG-like HR files only.
    const hrIndexByFolder = new Map();
    const uniqueHrFolders = new Set();
    for (const item of items) {
        const cache = photoCache[item.id];
        const hr = cache?.hrFolder?.nativePath;
        if (hr) uniqueHrFolders.add(hr);
    }
    await Promise.all([...uniqueHrFolders].map(async (folderPath) => {
        try {
            const files = await nfsp.readdir(folderPath);
            const idx = new Map();
            for (const f of files) {
                if (!JPEG_LIKE.test(f)) continue;
                // Key on the basename minus extension (lowercased). First
                // JPEG-like match wins — deterministic since readdir order
                // is stable per call.
                const base = f.replace(/\.[^/.]+$/, '').toLowerCase();
                if (!idx.has(base)) idx.set(base, f);
            }
            hrIndexByFolder.set(folderPath, idx);
        } catch (_) {
            hrIndexByFolder.set(folderPath, new Map());
        }
    }));

    let i = 0;
    async function worker() {
        while (i < items.length) {
            const idx = i++;
            const item = items[idx];
            const cache = photoCache[item.id];
            const proxyPath = (cache && (cache.file?.nativePath || cache.proxy?.nativePath)) || null;

            // Pass 1: try the high-res file when one is reachable AND its
            // extension is one our EXIF parser can read. O(1) index lookup —
            // no per-photo directory scan.
            let ts = null, usedPath = null;
            const hrFolder = cache?.hrFolder?.nativePath;
            if (hrFolder && cache.baseName) {
                const folderIdx = hrIndexByFolder.get(hrFolder);
                const hrName = folderIdx && folderIdx.get(cache.baseName.toLowerCase());
                if (hrName) {
                    const hrPath = np.join(hrFolder, hrName);
                    ts = await readExifDate(hrPath);
                    if (ts != null) usedPath = hrPath;
                }
            }

            // Pass 2: fall back to the proxy / loaded thumbnail. Proxies
            // generated by the Tab 5 thumbnail tool preserve EXIF from the
            // source, so this is a faithful timestamp.
            if (ts == null && proxyPath) {
                ts = await readExifDate(proxyPath);
                if (ts != null) usedPath = proxyPath;
            }

            dates.set(item.id, ts);
            sources.set(item.id, usedPath);
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    items.sort((a, b) => {
        const da = dates.get(a.id);
        const db = dates.get(b.id);
        if (da != null && db != null) return da - db;
        if (da != null) return -1;
        if (db != null) return 1;
        return a.id.localeCompare(b.id, undefined, { numeric: true });
    });

    // Diagnostic counts so the user can see at a glance whether the sort
    // was based on real capture times or had to fall back to filenames.
    let datedFromHr = 0, datedFromProxy = 0, undated = 0;
    for (const it of items) {
        const ts = dates.get(it.id);
        if (ts == null) { undated++; continue; }
        const cache = photoCache[it.id];
        const used = sources.get(it.id);
        const hrFolder = cache?.hrFolder?.nativePath;
        if (used && hrFolder && used.startsWith(hrFolder)) datedFromHr++;
        else datedFromProxy++;
    }
    if (typeof setStatus === 'function') {
        setStatus(`Sorted by capture time · ${datedFromHr} from HR, ${datedFromProxy} from proxy${undated ? `, ${undated} by filename` : ''}`);
    }
    try {
        require('electron').ipcRenderer.invoke('telemetry-event', 'exif_sort', {
            total: items.length,
            datedFromHr,
            datedFromProxy,
            undated,
        });
    } catch (_) {}

    return items;
}

// ⚡ FIX: Concurrent subfolder recursion — subfolders are scanned in parallel
// instead of one at a time. Significantly faster for deep folder trees.
async function buildHighResMap(parentFolder, mapObj) {
    try {
        const entries = await parentFolder.getEntries();
        const files = entries.filter(e => e.isFile);
        const subFolders = entries.filter(e => e.isFolder && e.name.toLowerCase() !== "_thumbnails");

        for (const entry of files) {
            const ext = entry.name.split('.').pop().toLowerCase();
            if (ext.match(/^(jpg|jpeg|png|tif|tiff|raw|cr2|nef)$/)) {
                const baseName = entry.name.replace(/\.[^/.]+$/, "").toLowerCase();
                if (!mapObj[baseName]) mapObj[baseName] = entry;
                else if (ext.match(/^(tif|tiff|cr2|raw)$/)) mapObj[baseName] = entry;
            }
        }
        await Promise.all(subFolders.map(f => buildHighResMap(f, mapObj)));
    } catch(e) { console.error("HighRes Map Build Error", e); }
}

// ==========================================
// --- 1. SETUP & PAGE NAVIGATION ---
// ==========================================
function updatePageDropdowns() {
    if (pageSelect) pageSelect.innerHTML = "";
    if (teleportSelect) teleportSelect.innerHTML = "";
    for (let i = 1; i <= totalActivePages; i++) {
        if (pageSelect) { const opt = document.createElement("option"); opt.value = i; opt.innerText = "Page " + String(i).padStart(3, '0'); if (i === currentPage) opt.selected = true; pageSelect.appendChild(opt); }
        if (teleportSelect) { const opt2 = document.createElement("option"); opt2.value = i; opt2.innerText = "To Pg " + i; teleportSelect.appendChild(opt2); }
    }
    if (teleportSelect) { const optPlus1 = document.createElement("option"); optPlus1.value = totalActivePages + 1; optPlus1.innerText = "To Pg " + (totalActivePages + 1); teleportSelect.appendChild(optPlus1); }
    const trackerText = document.getElementById("pageTrackerText"); if (trackerText) trackerText.innerText = `Total: ${totalActivePages}`;
}
updatePageDropdowns();

function changePage(newPage) {
    if (newPage < 1 || newPage > totalActivePages) return;
    currentPage = newPage;
    previewIndex = 0; // ⚡ FIX: reset stale preview index on every page switch
    if (pageSelect) pageSelect.value = currentPage;
    const greenTitle = document.getElementById("greenBoxTitle"); if (greenTitle) greenTitle.innerText = `Page ${String(currentPage).padStart(3, '0')}`;
    if (!albumPages[currentPage]) albumPages[currentPage] = { photos: [], template: null };
    renderGreenBox(); scheduleFilterUpdate();
}

if (pageSelect) pageSelect.onchange = (e) => changePage(parseInt(e.target.value));
const btnPrev = document.getElementById("btnPrev"); if (btnPrev) btnPrev.onclick = () => changePage(currentPage - 1);
const btnNext = document.getElementById("btnNext"); if (btnNext) btnNext.onclick = () => changePage(currentPage + 1);
const btnAddPage = document.getElementById("btnAddPage");
if (btnAddPage) {
    btnAddPage.onclick = () => mutate('Add page', () => {
        for (let i = totalActivePages; i > currentPage; i--) albumPages[i + 1] = albumPages[i];
        albumPages[currentPage + 1] = { photos: [], template: null };
        totalActivePages++;
        updatePageDropdowns();
        changePage(currentPage + 1);
    });
}
const btnRemovePage = document.getElementById("btnRemovePage");
if (btnRemovePage) {
    btnRemovePage.onclick = () => {
        if (totalActivePages === 1) return app.showAlert("Cannot delete the only page!");
        mutate('Delete page', () => {
            const pageData = albumPages[currentPage];
            if (pageData && pageData.photos) {
                pageData.photos.forEach(p => {
                    removeFromPageMap(p.id, currentPage);
                    const red = document.getElementById(p.id);
                    if (red) { red.classList.remove("used"); red.style.opacity = "1"; }
                });
            }
            for (let i = currentPage; i < totalActivePages; i++) albumPages[i] = albumPages[i + 1];
            delete albumPages[totalActivePages];
            totalActivePages--;
            if (currentPage > totalActivePages) currentPage = totalActivePages;
            updatePageDropdowns();
            changePage(currentPage);
        });
    };
}

// ─── CLEAR ALBUM ─────────────────────────────────────────────
// Wipes every page's template + photos, leaves a single empty page, and
// clears the "used" markers on Tab 1 and Tab 6 thumbnails. Wrapped in
// mutate() so a misclick is one Cmd+Z away. Folders, library, and project
// path are intentionally left intact — this only resets the layout itself.
const btnClearAlbum = document.getElementById("btnClearAlbum");
// ⚡ B.2: command-bar overflow menu (houses Clear album away from Auto Fill).
const btnCmdOverflow = document.getElementById("btnCmdOverflow");
const cmdOverflowMenu = document.getElementById("cmdOverflowMenu");
if (btnCmdOverflow && cmdOverflowMenu) {
    const closeOverflow = () => {
        cmdOverflowMenu.classList.remove('open');
        btnCmdOverflow.setAttribute('aria-expanded', 'false');
    };
    btnCmdOverflow.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = cmdOverflowMenu.classList.toggle('open');
        btnCmdOverflow.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.cmd-overflow')) closeOverflow();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeOverflow();
    });
    // Selecting Clear album should also dismiss the menu.
    if (btnClearAlbum) btnClearAlbum.addEventListener('click', closeOverflow);
}
if (btnClearAlbum) {
    btnClearAlbum.addEventListener("click", () => {
        const pageCount = Object.keys(albumPages).length;
        const photoCount = Object.values(albumPages).reduce(
            (sum, p) => sum + (p?.photos?.length || 0), 0
        );
        if (pageCount === 0 || (pageCount === 1 && photoCount === 0)) {
            toast('Album is already empty', 'info');
            return;
        }
        const ok = confirm(
            `Clear all ${pageCount} page${pageCount > 1 ? 's' : ''} and ${photoCount} photo placement${photoCount === 1 ? '' : 's'}?\n\n` +
            `Folders, photos on disk, and library assets stay loaded — only the page layout is reset. ` +
            `You can undo this with Cmd+Z.`
        );
        if (!ok) return;

        mutate('Clear album', () => {
            albumPages = {};
            totalActivePages = 1;
            albumPages[1] = { photos: [], template: null };
            currentPage = 1;

            // Clear Tab 1 red thumbnails and Tab 6 photo cards "used" badges
            // via the single state→view owner (albumPages is now empty so
            // this clears everything).
            syncViewToState();

            // Clear the photo→page reverse map; rebuilt empty since albumPages is empty.
            Object.keys(photoPageMap).forEach(k => delete photoPageMap[k]);

            // Drop render hashes — every page is now empty, so cached final
            // renders for those page numbers no longer correspond to anything.
            // Without this, a future render at the same page numbers would
            // skip rather than re-render.
            try {
                _renderHashes = {};
                _saveRenderHashes();
            } catch (_) {}

            // Drop cached proof paths so Tab 7 doesn't show stale composites.
            if (typeof _proofPaths === 'object') {
                Object.keys(_proofPaths).forEach(k => delete _proofPaths[k]);
                Object.keys(_proofHashes).forEach(k => delete _proofHashes[k]);
            }

            updatePageDropdowns();
            changePage(1);
            if (typeof renderStoryboard === 'function') renderStoryboard();
        });

        notify('Album cleared · Cmd+Z to restore', 'success', { duration: 5000 });
    });
}

// ==========================================
// --- 2. FOLDER DIALOG & REFRESH ENGINE ---
// ==========================================
document.addEventListener('click', (e) => {
    if (e.target && e.target.classList.contains('btn-remove-fld')) {
        const type = e.target.dataset.type;
        const listDiv = document.getElementById("removeDialogList");
        listDiv.innerHTML = "";
        let panelId = "";
        if (type === "images") panelId = "redFolderPanel";
        else if (type === "templates") panelId = "whiteFolderPanel";
        else if (type === "wallpapers") panelId = "wpFolderPanel";
        else if (type === "pngs") panelId = "pngFolderPanel";
        else if (type === "masks") panelId = "maskedFolderPanel";

        const panel = document.getElementById(panelId);
        if (!panel) return;
        const checkboxes = panel.querySelectorAll("input[type='checkbox']");
        if (checkboxes.length === 0) {
            listDiv.innerHTML = "<div class='dialog-empty'>No folders loaded.</div>";
        } else {
            checkboxes.forEach(cb => {
                const labelText = cb.parentElement.innerText.replace("📁", "").replace("🗑️", "").replace("🔄", "").trim();
                const folderId = cb.value;
                const token = cb.dataset.token || "";
                listDiv.innerHTML += `<label><input type="checkbox" class="dialog-fld-cb" value="${escapeHtml(folderId)}" data-type="${escapeHtml(type)}" data-token="${escapeHtml(token)}"> 📁 ${escapeHtml(labelText)}</label>`;
            });
        }
        document.getElementById("removeFolderDialog").showModal();
    }
});

const btnCancelRemove = document.getElementById("btnCancelRemove");
if (btnCancelRemove) {
    btnCancelRemove.addEventListener("click", (e) => {
        e.preventDefault();
        document.getElementById("removeFolderDialog").close();
    });
}

const btnConfirmRemove = document.getElementById("btnConfirmRemove");
if (btnConfirmRemove) {
    btnConfirmRemove.addEventListener("click", (e) => {
        e.preventDefault();
        const checkboxes = document.querySelectorAll(".dialog-fld-cb:checked");
        checkboxes.forEach(cb => {
            const folderId = cb.value, type = cb.dataset.type, token = cb.dataset.token;
            document.querySelectorAll(`input[value="${folderId}"]:not(.dialog-fld-cb)`).forEach(input => {
                if (input.parentElement && input.parentElement.parentElement) input.parentElement.parentElement.remove();
            });
            if (type === "images") {
                activeImageFolders.delete(folderId);
                if (projectData.imageTokens) projectData.imageTokens = projectData.imageTokens.filter(t => t !== token);
                if (projectData.highResTokens) projectData.highResTokens = projectData.highResTokens.filter(t => t !== token);
                Array.from(redBox.querySelectorAll(`.img-wrapper-red[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
                Array.from(photosGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
            } else if (type === "templates") {
                activeTemplateFolders.delete(folderId);
                if (projectData.templateTokens) projectData.templateTokens = projectData.templateTokens.filter(t => t !== token);
                templateLibrary = templateLibrary.filter(t => t.folderId !== folderId);
                scheduleFilterUpdate();
            } else if (type === "wallpapers") {
                activeWallpaperFolders.delete(folderId);
                if (projectData.wallpaperTokens) projectData.wallpaperTokens = projectData.wallpaperTokens.filter(t => t !== token);
                if (projectData.wpHighResTokens) projectData.wpHighResTokens = projectData.wpHighResTokens.filter(t => t !== token);
                Array.from(wallpaperGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
            } else if (type === "pngs") {
                activePngFolders.delete(folderId);
                if (projectData.pngTokens) projectData.pngTokens = projectData.pngTokens.filter(t => t !== token);
                Array.from(pngGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
            } else if (type === "masks") {
                activeMaskedFolders.delete(folderId);
                if (projectData.maskTokens) projectData.maskTokens = projectData.maskTokens.filter(t => t !== token);
                Array.from(maskedGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
            }
        });
        document.getElementById("removeFolderDialog").close();
        saveStateToStorage();
    });
}

async function refreshTab(type) {
    setStatus("Refreshing checked folders…");
    let panelId = "";
    if (type === "images") panelId = "redFolderPanel";
    else if (type === "templates") panelId = "whiteFolderPanel";
    else if (type === "wallpapers") panelId = "wpFolderPanel";
    else if (type === "pngs") panelId = "pngFolderPanel";
    else if (type === "masks") panelId = "maskedFolderPanel";

    const panel = document.getElementById(panelId); if (!panel) return;
    const checkedBoxes = panel.querySelectorAll("input[type='checkbox']:checked");

    for (const cb of checkedBoxes) {
        const folderId = cb.value, token = cb.dataset.token;
        if (!token) continue;
        try {
            const masterFolder = await fs.getEntryForPersistentToken(token);
            let targetFolder = masterFolder, hrFolder = null;
            if (type === "images" || type === "wallpapers") {
                try { const thumbFolder = await masterFolder.getEntry("_Thumbnails"); if(thumbFolder.isFolder) { targetFolder = thumbFolder; hrFolder = masterFolder; } } catch(e){}
                if (type === "images") {
                    await buildHighResMap(masterFolder, globalHighResMap);
                    await processImageFolder(targetFolder, hrFolder, token, folderId);
                } else {
                    await buildHighResMap(masterFolder, globalWpHighResMap);
                    await processWallpaperFolder(targetFolder, hrFolder, getDisplayName(masterFolder), token, folderId);
                }
            } else if (type === "templates") {
                await processTemplateFolder(masterFolder, token, folderId);
            } else if (type === "pngs") {
                await processPngFolder(masterFolder, token, folderId);
            } else if (type === "masks") {
                await processMaskedFolder(masterFolder, token, folderId);
            }
        } catch(e) { console.error("Failed to refresh folder", e); }
    }

    if (type === "images") {
        syncViewToState();
    } else if (type === "templates") {
        Object.values(albumPages).forEach(page => { if (page.template) { const matchedTemp = templateLibrary.find(t => t.id === page.template.id); if (matchedTemp) page.template = matchedTemp; } });
        scheduleFilterUpdate();
    }
    notify("Refresh complete!", "success");
}

document.addEventListener('click', async (e) => {
    if (e.target && e.target.classList.contains('btn-reload-fld')) {
        await refreshTab(e.target.dataset.type);
    }
});

// ==========================================
// --- 3. FILE LOADING (PHOTOS / TAB 6) ---
// ==========================================

// ⚡ FIX: Concurrent subfolder scan — subfolders resolved in parallel, not sequentially
async function scanFolderRecursive(folder) {
    const entries = await folder.getEntries();
    const files = entries.filter(e => e.isFile);
    const subFolders = entries.filter(e => e.isFolder);
    const subResults = await Promise.all(subFolders.map(f => scanFolderRecursive(f)));
    return files.concat(...subResults);
}

// ⚡ Per-image click state map for event-delegated double-click detection
const _redClickState = {};

// ⚡ FIX: Single event-delegated listener on redBox instead of one listener per image.
// With 500+ images this eliminates 500+ live event listeners and their memory overhead.
redBox.addEventListener('pointerup', (e) => {
    if (e.target.closest('.btn-rotate-red')) return;
    const wrapper = e.target.closest('.img-wrapper-red');
    if (!wrapper) return;
    const img = wrapper.querySelector('.thumb-red');
    if (!img) return;
    const safeId = img.id;

    if (!_redClickState[safeId]) _redClickState[safeId] = { count: 0, timer: null };
    const state = _redClickState[safeId];
    state.count++;

    if (state.count === 1) {
        state.timer = setTimeout(() => {
            state.count = 0;
            img.classList.toggle("selected");
            _activeMatchPanel = 'source'; // B2: working in the source panel
            scheduleFilterUpdate(); // selection drives template matching
        }, 300);
    } else if (state.count === 2) {
        clearTimeout(state.timer);
        state.count = 0;
        prepareAndMove([{ id: img.id, url: img.src }]);
    }
});

// ── Source → Photoshop native drag-out ──────────────────────────────────
// Dragging a source thumbnail now starts a NATIVE OS file drag carrying the
// ORIGINAL high-res file, so dropping onto Photoshop (or Finder) behaves just
// like dragging from Finder. Multi-selection drags the whole selected set.
// (In-app placement still works via double-click and Auto-Fill.)
let _sourceDragItems = null;
redBox.addEventListener('dragstart', (e) => {
    const img = e.target.closest('.thumb-red');
    if (!img) return;
    const selected = Array.from(redBox.querySelectorAll('.thumb-red.selected'));
    const ids = (img.classList.contains('selected') && selected.length > 0)
        ? selected.map(el => el.id)
        : [img.id];
    const paths = ids.map(id => _photoNativePath(id)).filter(Boolean);
    if (paths.length === 0) return;
    e.preventDefault(); // cancel the default thumbnail (proxy) drag
    require('electron').ipcRenderer.send('start-native-drag', paths);
});

// Photos tab (Tab 6) → Photoshop native drag-out (original file).
if (photosGrid) {
    photosGrid.addEventListener('dragstart', (e) => {
        const card = e.target.closest('.wp-card');
        if (!card) return;
        const id = card.dataset.photoId;
        const p = id ? _photoNativePath(id) : null;
        if (!p) return;
        e.preventDefault();
        require('electron').ipcRenderer.send('start-native-drag', [p]);
    });
}

// ⚡ FIX: processImageFolder only builds Tab 1 (redBox) DOM now.
// Tab 6 is built lazily via renderPhotosGrid() the first time the user opens that tab.
// photoCache entries now carry extra fields needed for lazy Tab 6 rendering.
async function processImageFolder(folder, hrFolder, token, existingFolderId = null) {
    const displayName = getDisplayName(folder);
    const folderId = existingFolderId || ("imgFld_" + displayName.replace(/[^a-zA-Z0-9]/g, '_') + Date.now());
    activeImageFolders.add(folderId);

    if (existingFolderId) {
        Array.from(redBox.querySelectorAll(`.img-wrapper-red[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
        Array.from(photosGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());
        // Force Tab 6 re-render on next open if it had previously been rendered
        if (tab6Rendered) tab6Rendered = false;
    }

    const entries = await folder.getEntries();
    const imgs = entries.filter(e => e.isFile && e.name.match(/\.(jpg|jpeg|png|tif)$/i));
    imgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    // ⚡ Build all redBox wrappers into a DocumentFragment — single DOM append at the end
    const frag = document.createDocumentFragment();

    imgs.forEach((file) => {
        const baseName = file.name.replace(/\.[^/.]+$/, "").toLowerCase();
        const safeId = "img_" + (displayName + "_" + file.name).replace(/[^a-zA-Z0-9]/g, '_');
        const savedRotation = projectData.imageRotations[safeId] || 0;

        // Store extra fields so lazy Tab 6 render doesn't need to re-scan
        photoCache[safeId] = {
            proxy: file, hrFolder: hrFolder, baseName: baseName,
            folderId: folderId, displayName: displayName,
            fileName: file.name, url: file.url,
            orient: null  // ⚡ Task 2.1: cached on first thumbnail load below
        };

        Object.values(albumPages).forEach(page => {
            if (page.photos) page.photos.forEach(p => { if (p.id === safeId) p.url = file.url; });
        });

        // --- Build Tab 1 (redBox) wrapper ---
        const wrapper = document.createElement("div");
        wrapper.className = "img-wrapper-red";
        wrapper.dataset.folderId = folderId;

        const img = document.createElement("img");
        img.src = file.url; img.className = "thumb-red"; img.id = safeId; img.draggable = true;
        if (savedRotation !== 0) img.style.transform = `rotate(${savedRotation}deg)`;
        // ⚡ Task 2.1: capture true pixel orientation once the proxy decodes,
        // so auto-fill can read photoCache[id].orient instead of creating a
        // throwaway off-DOM <img> per photo to measure naturalWidth/Height.
        img.addEventListener('load', () => {
            const c = photoCache[safeId];
            if (c) c.orient = img.naturalWidth >= img.naturalHeight ? 'h' : 'v';
        }, { once: true });

        const badge = document.createElement("div");
        badge.className = "rot-badge";
        if (savedRotation !== 0) { badge.style.display = "block"; badge.innerText = savedRotation + "°"; }

        const btnRotate = document.createElement("button");
        btnRotate.className = "btn-rotate-red"; btnRotate.innerHTML = "🔄";
        btnRotate.title = "Rotate image (Syncs with UI & High-Res)";
        // Inline onclick — rotate buttons are few, inline is fine
        btnRotate.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            applyGlobalRotation(safeId, ((projectData.imageRotations[safeId] || 0) + 90) % 360);
        };
        btnRotate.addEventListener('pointerup', e => e.stopPropagation());

        wrapper.appendChild(badge); wrapper.appendChild(img); wrapper.appendChild(btnRotate);
        frag.appendChild(wrapper);
        // ⚡ No Tab 6 DOM built here — deferred to renderPhotosGrid()
    });

    // Remove the initial empty-state placeholder on first load (appending,
    // not clearing, so other already-loaded folders' thumbnails survive).
    const _redEmpty = redBox.querySelector('.empty-state');
    if (_redEmpty) _redEmpty.remove();
    redBox.appendChild(frag); // ⚡ Single live DOM insertion for all images

    if (!existingFolderId) {
        const r1 = createFolderRow(displayName, folderId, token, imgs.length);
        const r6 = createFolderRow(displayName, folderId, token, imgs.length);
        const pnl1 = document.getElementById("redFolderPanel");
        const pnl6 = document.getElementById("photosFolderPanel");

        function handleToggle(e) {
            if (e.target.checked) activeImageFolders.add(folderId); else activeImageFolders.delete(folderId);
            r1.checkbox.checked = e.target.checked;
            r6.checkbox.checked = e.target.checked;
            Array.from(redBox.querySelectorAll('.img-wrapper-red')).forEach(wrp => {
                if (wrp.dataset.folderId === folderId) {
                    wrp.style.display = e.target.checked ? "inline-flex" : "none";
                    if (!e.target.checked) wrp.querySelector('.thumb-red') && wrp.querySelector('.thumb-red').classList.remove("selected");
                }
            });
            Array.from(photosGrid.querySelectorAll('.wp-card')).forEach(card => {
                if (card.dataset.folderId === folderId) card.style.display = e.target.checked ? "inline-block" : "none";
            });
        }
        r1.checkbox.onchange = handleToggle;
        r6.checkbox.onchange = handleToggle;
        pnl1.appendChild(r1.row); pnl6.appendChild(r6.row);
    }
}

// ⚡ FIX: Lazy Tab 6 renderer — called once when user first opens Tab 6.
// Reads from photoCache (already populated) instead of re-scanning folders.
// ⚡ Task 4.1: NO per-card listeners (single delegated handler below).
// ⚡ Task 4.2: VIRTUALIZED. Cards are always built (so layout + scroll height
// are stable), but each <img> starts with NO src — only `data-src`. An
// IntersectionObserver attaches the real src when a card scrolls within ~1
// viewport of view, and detaches it when it scrolls far away. This caps the
// number of decoded thumbnails held in host/GPU memory at ~the visible window
// instead of all N (a 2,000-photo folder previously decoded 2,000 images at
// once). Card dimensions are fixed via CSS so detaching doesn't shift layout.
let _tab6Observer = null;
function _ensureTab6Observer() {
    if (_tab6Observer) return _tab6Observer;
    _tab6Observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const img = entry.target.querySelector('.tab6-photo-img');
            if (!img) continue;
            const wrap = img.parentElement;
            if (entry.isIntersecting) {
                // Attach the real source as the card nears the viewport. Show
                // a skeleton shimmer on the wrapper until the image decodes.
                if (!img.src && img.dataset.src) {
                    if (wrap) wrap.classList.add('skeleton');
                    img.addEventListener('load', () => {
                        if (wrap) wrap.classList.remove('skeleton');
                    }, { once: true });
                    img.addEventListener('error', () => {
                        if (wrap) wrap.classList.remove('skeleton');
                    }, { once: true });
                    img.src = img.dataset.src;
                }
            } else {
                // Far off-screen: release the decoded image to reclaim memory.
                // Keep data-src so it re-attaches instantly when scrolled back.
                if (img.src) { img.removeAttribute('src'); if (wrap) wrap.classList.remove('skeleton'); }
            }
        }
    }, {
        root: photosGrid,
        // Pre-load a viewport's worth above/below so scrolling feels instant.
        rootMargin: '300px 0px 300px 0px',
        threshold: 0,
    });
    return _tab6Observer;
}

function renderPhotosGrid() {
    const _ph = photosGrid.querySelector('.placeholder-text, .empty-state');
    if (_ph) photosGrid.innerHTML = "";

    // Disconnect any prior observation — we're rebuilding the card set.
    if (_tab6Observer) { _tab6Observer.disconnect(); }
    const observer = _ensureTab6Observer();

    const usedIds = new Set();
    Object.values(albumPages).forEach(page => {
        if (page && page.photos) page.photos.forEach(p => usedIds.add(p.id));
    });

    const frag = document.createDocumentFragment();
    const cardsToObserve = [];

    Object.entries(photoCache).forEach(([safeId, cacheData]) => {
        const savedRotation = projectData.imageRotations[safeId] || 0;

        const photoCard = document.createElement("div");
        photoCard.className = "wp-card";
        photoCard.dataset.folderId = cacheData.folderId;
        photoCard.dataset.photoId = safeId;
        photoCard.id = "pt_" + safeId;
        photoCard.draggable = true; // native drag-out to Photoshop (original file)

        const photoImgWrapper = document.createElement("div");
        photoImgWrapper.className = "wp-card-img-wrapper";

        const photoImg = document.createElement("img");
        // Virtualized: store the source in data-src; the observer attaches the
        // real src only when the card is near the viewport.
        photoImg.dataset.src = cacheData.url;
        photoImg.className = "tab6-photo-img"; photoImg.draggable = false;
        if (savedRotation !== 0) photoImg.style.transform = `rotate(${savedRotation}deg)`;

        const badge6 = document.createElement("div"); badge6.className = "rot-badge";
        if (savedRotation !== 0) { badge6.style.display = "block"; badge6.innerText = savedRotation + "°"; }

        const btnRotate6 = document.createElement("button");
        btnRotate6.className = "btn-rotate-red"; btnRotate6.innerHTML = "🔄"; btnRotate6.title = "Rotate image";

        photoImgWrapper.appendChild(badge6); photoImgWrapper.appendChild(photoImg); photoImgWrapper.appendChild(btnRotate6);

        const photoLabel = document.createElement("div");
        photoLabel.className = "label"; photoLabel.innerText = cacheData.fileName.substring(0, 15); photoLabel.style.pointerEvents = "none";

        if (usedIds.has(safeId)) photoCard.classList.add("used");

        photoCard.appendChild(photoImgWrapper); photoCard.appendChild(photoLabel);
        frag.appendChild(photoCard);
        cardsToObserve.push(photoCard);
    });

    photosGrid.appendChild(frag); // ⚡ Single live DOM insertion
    // Observe after insertion so the observer has real layout rects.
    cardsToObserve.forEach(c => observer.observe(c));
}

// Heavy "inject this photo into the active Photoshop layer" routine, lifted
// out of the per-card closure so the delegated handler can call it by id.
// Runs through the JSX bridge (IPC) — NOT the UXP stub, whose app.activeDocument
// is a fake that only tracks docs this app opened (the cause of the spurious
// "Please open a PSD document first!" when a doc was open in Photoshop).
async function _tab6InjectPhoto(safeId) {
    const cacheData = photoCache[safeId];
    if (!cacheData) return;
    const ipc = require('electron').ipcRenderer;
    try {
        setStatus('Injecting photo into active layer…');
        // Resolve the best file (HR original when available, else proxy).
        const fetchResult = await getTrueFile(cacheData);
        const filePath = fetchResult.file?.nativePath;
        if (!filePath) { toast('Could not resolve photo file', 'error'); return; }
        const layerName = (fetchResult.isHr ? cacheData.baseName + '_HighRes' : cacheData.baseName);

        const res = await ipc.invoke('inject-photo', { filePath, layerName });
        if (res?.ok) {
            // Mark used in both tabs.
            const redImg = document.getElementById(safeId); if (redImg) redImg.classList.add('used');
            const card = document.getElementById('pt_' + safeId); if (card) card.classList.add('used');
            notify('Photo injected into active layer', 'success', { duration: 2500 });
        } else if (res?.reason === 'no_document') {
            app.showAlert('Please open a PSD document in Photoshop first!');
        } else if (res?.reason === 'no_layer') {
            app.showAlert('Select exactly one frame or layer on the Photoshop canvas first!');
        } else {
            toast('Inject failed: ' + (res?.error || 'unknown'), 'error');
        }
    } catch (e) {
        toast('Inject error: ' + e.message, 'error');
    }
}

// ⚡ Task 4.1: ONE delegated handler for the whole Tab 6 grid. Handles rotate
// button clicks and double-click-to-inject via a small per-target click
// counter keyed off the card id (mirrors the redBox delegation pattern).
;(function _tab6InitDelegation() {
    if (!photosGrid) return;
    const clickState = {};
    photosGrid.addEventListener('pointerup', (e) => {
        const rotateBtn = e.target.closest('.btn-rotate-red');
        if (rotateBtn) {
            e.preventDefault(); e.stopPropagation();
            const card = rotateBtn.closest('.wp-card');
            const safeId = card && card.dataset.photoId;
            if (safeId) applyGlobalRotation(safeId, ((projectData.imageRotations[safeId] || 0) + 90) % 360);
            return;
        }
        const card = e.target.closest('.wp-card');
        if (!card) return;
        const safeId = card.dataset.photoId;
        if (!safeId) return;
        if (!clickState[safeId]) clickState[safeId] = { count: 0, timer: null };
        const st = clickState[safeId];
        st.count++;
        if (st.count === 1) {
            st.timer = setTimeout(() => { st.count = 0; }, 350);
        } else if (st.count === 2) {
            clearTimeout(st.timer); st.count = 0;
            _tab6InjectPhoto(safeId);
        }
    });
})();

const btnLoadPhotos = document.getElementById("btnLoadPhotos");
if (btnLoadPhotos) {
    btnLoadPhotos.addEventListener("click", async () => {
        const folder = await fs.getFolder(); if (!folder) return;
        if (folder.name.toLowerCase() === "_thumbnails") {
            return app.showAlert("🛑 UXP SANDBOX BLOCK!\n\nYou selected the '_Thumbnails' folder directly. Adobe security prevents plugins from reading 'backwards' into the previous folder to get your high-res files.\n\nPlease click Load again and select the MASTER FOLDER instead. The plugin will automatically grab the thumbnails for you!");
        }
        setStatus("Scanning folder…");
        await new Promise(resolve => setTimeout(resolve, 50));

        let targetFolderToLoad = folder, hrFolder = null;
        let thumbFolder = null;
        try {
            const tf = await folder.getEntry("_Thumbnails");
            if (tf && tf.isFolder) thumbFolder = tf;
        } catch (e) { /* no _Thumbnails yet */ }

        // Auto-cache: no _Thumbnails subfolder → generate one now (slow on the
        // first load, instant on every load after), then Smart-Load from it.
        if (!thumbFolder) {
            try {
                setStatus("First load — generating thumbnails (this folder will open fast next time)…");
                const genRes = await require('electron').ipcRenderer.invoke('thumbnails-generate', folder.nativePath);
                if (genRes && genRes.ok && genRes.processed > 0) {
                    try { const tf2 = await folder.getEntry("_Thumbnails"); if (tf2 && tf2.isFolder) thumbFolder = tf2; } catch (e2) {}
                } else if (genRes && genRes.error) {
                    toast('Thumbnail cache skipped: ' + genRes.error + ' — loading originals.', 'warning');
                }
            } catch (genErr) {
                console.error('Auto thumbnail generation failed:', genErr);
                // Fall through and load the master folder directly (originals).
            }
        }

        if (thumbFolder) {
            targetFolderToLoad = thumbFolder; hrFolder = folder;
            const hrToken = await fs.createPersistentToken(folder);
            if (!projectData.highResTokens) projectData.highResTokens = [];
            if (!projectData.highResTokens.includes(hrToken)) projectData.highResTokens.push(hrToken);
            toast("Smart Load active — high-res master folder linked", "info");
        }

        const token = await fs.createPersistentToken(folder);
        if (!projectData.imageTokens.includes(token)) projectData.imageTokens.push(token);
        await processImageFolder(targetFolderToLoad, hrFolder, token);
        saveStateToStorage(); renderGreenBox();
    });
}
if (btnLoadPhotosTab) { btnLoadPhotosTab.addEventListener("click", () => { if (btnLoadPhotos) btnLoadPhotos.click(); }); }

// Empty-state action buttons: a single delegated listener forwards a click on
// any `.empty-state__action[data-load]` to the real load button it names, so
// the empty states are actionable without duplicating the load handlers.
document.addEventListener('click', (e) => {
    const btn = e.target.closest('.empty-state__action[data-load]');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.load);
    if (target) target.click();
});

// ==========================================
// --- 4. TEMPLATES ENGINE ---
// ==========================================
async function processTemplateFolder(folder, token, existingFolderId = null) {
    const displayName = getDisplayName(folder);
    const folderId = existingFolderId || ("tplFld_" + displayName.replace(/[^a-zA-Z0-9]/g, '_') + Date.now());
    activeTemplateFolders.add(folderId);

    if (existingFolderId) templateLibrary = templateLibrary.filter(t => t.folderId !== folderId);

    const allFiles = await scanFolderRecursive(folder);
    const psdFiles = allFiles.filter(e => e.name.toLowerCase().endsWith(".psd"));
    const jpgFiles = allFiles.filter(e => e.name.match(/\.(jpg|jpeg|png)$/i));

    const newTemplates = psdFiles.map(psd => {
        const match = psd.name.toLowerCase().match(/(\d+)h(\d+)v/);
        const base = psd.name.toLowerCase().replace(".psd", "");
        const preview = jpgFiles.find(img => img.name.toLowerCase().includes(base));
        const safeId = "tpl_" + (displayName + "_" + psd.name).replace(/[^a-zA-Z0-9]/g, '_');
        return { id: safeId, folderId: folderId, name: psd.name, file: psd, h: match ? parseInt(match[1]) : 0, v: match ? parseInt(match[2]) : 0, url: preview ? preview.url : "" };
    });
    templateLibrary = templateLibrary.concat(newTemplates);

    if (!existingFolderId) {
        const pnl = document.getElementById("whiteFolderPanel");
        const { row, checkbox } = createFolderRow(displayName, folderId, token);
        checkbox.onchange = (e) => { if (e.target.checked) activeTemplateFolders.add(folderId); else activeTemplateFolders.delete(folderId); scheduleFilterUpdate(); };
        pnl.appendChild(row);
    }
    scheduleFilterUpdate();
}

const btnLPT = document.getElementById("btnLPT");
if (btnLPT) {
    btnLPT.addEventListener("click", async () => {
        const folder = await fs.getFolder(); if (!folder) return;
        const token = await fs.createPersistentToken(folder);
        if (!projectData.templateTokens.includes(token)) projectData.templateTokens.push(token);
        await processTemplateFolder(folder, token); saveStateToStorage();
    });
}

// ==========================================
// --- 5. FILTERING & TEMPLATE SAFE OPENER ---
// ==========================================

// ⚡ FIX: scheduleFilterUpdate — coalesces multiple autoFilterTemplates() calls
// within the same frame into a single execution via requestAnimationFrame.
// Prevents redundant full renderWhiteBox() rebuilds on rapid state changes.
let _filterPending = false;
function scheduleFilterUpdate() {
    if (_filterPending) return;
    _filterPending = true;
    requestAnimationFrame(() => {
        _filterPending = false;
        autoFilterTemplates();
    });
}

// Slice 4 wiring: sticky active-panel tracking + the template Sync switch.
;(function _initTemplateSync() {
    // Entering a panel makes it the active match context. It's STICKY — we
    // never clear it on pointerleave, so moving to the Templates panel to pick
    // a layout keeps showing matches for the panel you were just working in.
    const setActive = (panel) => {
        if (_activeMatchPanel !== panel) { _activeMatchPanel = panel; scheduleFilterUpdate(); }
    };
    if (redBox) redBox.addEventListener('pointerenter', () => setActive('source'));
    const greenWrapper = document.getElementById('greenWrapper');
    if (greenWrapper) greenWrapper.addEventListener('pointerenter', () => setActive('pages'));
    else if (greenBox) greenBox.addEventListener('pointerenter', () => setActive('pages'));

    const chk = document.getElementById('chkTemplateSync');
    if (chk) {
        chk.checked = _syncTemplates;
        chk.addEventListener('change', () => {
            _syncTemplates = chk.checked;
            try { localStorage.setItem('adt_template_sync', _syncTemplates ? '1' : '0'); } catch (_) {}
            scheduleFilterUpdate();
        });
    }
})();

// Count the orientation signature (H/V) of the currently selected source
// thumbnails, accounting for any per-photo rotation (matches prepareAndMove).
function _selectedSourceHV() {
    const sel = Array.from(redBox.querySelectorAll('.thumb-red.selected'));
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

// C1: build the SELECTED source photos into a chosen template. Reuses the
// build-page bridge, which assigns photos to frames by orientation, drops
// extras, and leaves surplus frames empty — exactly the requested behaviour.
function _selectedSourcePhotosForBuild() {
    const sel = Array.from(redBox.querySelectorAll('.thumb-red.selected'));
    return sel.map(img => {
        const id = img.id;
        const c = photoCache[id];
        const fp = _photoNativePath(id);
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

async function buildTemplateWithSelection(temp) {
    if (!temp) return;
    const photos = _selectedSourcePhotosForBuild();
    // No source selection → just open the template in Photoshop for editing.
    if (photos.length === 0) {
        const p = temp.file && temp.file.nativePath;
        if (p) _openInPS(p);
        else toast('Select photos in the Source panel first', 'info');
        return;
    }
    if (temp._generative || !temp.file?.nativePath) {
        toast('Quick-build needs a PSD template (generative layouts build via Render)', 'info');
        return;
    }
    setStatus(`Building ${temp.name} with ${photos.length} photo${photos.length === 1 ? '' : 's'}…`);
    try {
        const r = await require('electron').ipcRenderer.invoke('build-page', {
            templatePath: temp.file.nativePath,
            pageName: 'Quick',
            photos,
        });
        if (typeof r === 'string' && r && r.indexOf('success') === -1 && r.toLowerCase().indexOf('fail') !== -1) {
            toast('Build: ' + r, 'error');
        } else {
            notify(`Built ${temp.name} — review it in Photoshop`, 'success');
        }
    } catch (e) {
        toast('Build failed: ' + (e.message || e), 'error');
    }
    setStatus('');
}

function autoFilterTemplates() {
    if (!albumPages[currentPage]) albumPages[currentPage] = { photos: [], template: null };
    const photos = albumPages[currentPage].photos || [];
    const hCount = photos.filter(p => p.orient === 'h').length;
    const vCount = photos.filter(p => p.orient === 'v').length;
    const activeLibrary = templateLibrary.filter(t => activeTemplateFolders.has(t.folderId));

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
        filteredTemplates = activeLibrary.filter(t => t.h === target.h && t.v === target.v);
        if (filteredTemplates.length === 0) filteredTemplates = [...activeLibrary]; // graceful fallback
    } else {
        filteredTemplates = [...activeLibrary];
    }
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
        else yellowPreviewArea.innerHTML = savedTemplate.url ? `<img src="${escapeHtml(savedTemplate.url)}">` : `<div style="color:#aaa;">${escapeHtml(savedTemplate.name)}</div>`;
    } else {
        if (filteredTemplates.length > 0) setPreview(0, false); else yellowPreviewArea.innerHTML = "";
    }
}

// ⚡ FIX: renderWhiteBox uses DocumentFragment — all cards built off-DOM,
// then inserted in a single operation. Eliminates N reflows for N templates.
function renderWhiteBox() {
    const frag = document.createDocumentFragment();
    const savedId = albumPages[currentPage] && albumPages[currentPage].template && albumPages[currentPage].template.id;

    filteredTemplates.forEach((temp, idx) => {
        const card = document.createElement("div"); card.className = "thumb-card";
        card.dataset.tplId = temp.id;
        const isSelected = (previewIndex === idx) || (savedId && savedId === temp.id);
        if (isSelected) card.classList.add("is-selected");
        // Generative templates synthesize a quick SVG preview from their frame
        // geometry so the user can see the layout without authoring a PSD.
        if (temp._generative) {
            card.innerHTML = `${_generativePreviewSvg(temp)}<div class="thumb-card__label">${escapeHtml(temp.name)}</div>`;
            card.classList.add('thumb-card--generative');
        } else {
            card.innerHTML = `<img src="${escapeHtml(temp.url)}"><div class="thumb-card__label">${escapeHtml(temp.name)}</div>`;
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
function _photoNativePath(id) {
    const c = photoCache[id];
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

let _appCtxEl = null;
function _hideAppCtx() { if (_appCtxEl) { _appCtxEl.remove(); _appCtxEl = null; } }
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

async function _openInPS(filePath) {
    if (!filePath) { toast('Could not resolve the file path', 'error'); return; }
    setStatus('Opening in Photoshop…');
    try { await require('electron').ipcRenderer.invoke('open-in-photoshop', filePath); notify('Opened in Photoshop', 'success'); }
    catch (e) { toast('Open in Photoshop failed: ' + (e.message || e), 'error'); }
    setStatus('');
}
async function _placeClippedPS(filePath) {
    if (!filePath) { toast('Could not resolve the file path', 'error'); return; }
    setStatus('Placing in Photoshop…');
    try {
        const r = await require('electron').ipcRenderer.invoke('place-clipped', filePath);
        if (typeof r === 'string' && r.indexOf('success') === -1) toast('Place: ' + r, 'error');
        else notify('Placed & clipped in Photoshop', 'success');
    } catch (e) { toast('Place failed: ' + (e.message || e), 'error'); }
    setStatus('');
}

if (whiteBox) {
    whiteBox.addEventListener('contextmenu', (e) => {
        const card = e.target.closest('.thumb-card'); if (!card) return;
        const id = card.dataset.tplId; if (!id) return;
        const tpl = filteredTemplates.find(t => t.id === id) || templateLibrary.find(t => t.id === id);
        const tplPath = tpl && tpl.file && tpl.file.nativePath;
        if (!tplPath) return; // generative templates have no PSD on disk
        e.preventDefault();
        _showAppCtx(e.clientX, e.clientY, [
            { label: '🎨 Open template in Photoshop', fn: () => _openInPS(tplPath) },
        ]);
    });
}
if (redBox) {
    redBox.addEventListener('contextmenu', (e) => {
        const img = e.target.closest('.thumb-red'); if (!img) return;
        const p = _photoNativePath(img.id);
        e.preventDefault();
        _showAppCtx(e.clientX, e.clientY, [
            { label: '🎨 Open in Photoshop', disabled: !p, fn: () => _openInPS(p) },
            { label: '📌 Place on selected layer (clipped)', disabled: !p, fn: () => _placeClippedPS(p) },
        ]);
    });
}

function setPreview(idx, saveToMemory = true) {
    if (!filteredTemplates[idx]) return;
    previewIndex = idx;
    const temp = filteredTemplates[idx];
    // When live preview is on, the Preview pane is owned by the live composite
    // — don't flash the bare template over it. (Selecting a template still
    // saves it below and triggers a re-composite.)
    if (!_livePreviewOn) {
        if (temp._generative) {
            yellowPreviewArea.innerHTML = _generativePreviewSvg(temp, /*large*/ true);
        } else {
            yellowPreviewArea.innerHTML = temp.url ? `<img src="${escapeHtml(temp.url)}">` : `<div style="color:#aaa;">${escapeHtml(temp.name)}</div>`;
        }
    }
    if (saveToMemory) {
        if (!albumPages[currentPage]) albumPages[currentPage] = { photos: [], template: null };
        albumPages[currentPage].template = temp;
        scheduleLivePreview(); // template changed → re-composite if live
    }
    renderWhiteBox();
}

// ── Live preview (MVP) ─────────────────────────────────────────
// Renders the current page through the same libvips engine + centered crop as
// the final export, shown in the Preview pane. Debounced so rapid edits
// coalesce; a sequence guard prevents a stale render from overwriting a newer
// one. Reverts to the bare template thumbnail when off or when the page can't
// be composited (no template/photos yet).
const chkLivePreview = document.getElementById('chkLivePreview');

function scheduleLivePreview() {
    if (!_livePreviewOn) return;
    clearTimeout(_liveTimer);
    _liveTimer = setTimeout(renderLivePreview, 280);
}

function _showTemplateThumb() {
    const t = albumPages[currentPage] && albumPages[currentPage].template;
    if (!t) { yellowPreviewArea.innerHTML = ''; return; }
    if (t._generative) yellowPreviewArea.innerHTML = _generativePreviewSvg(t, true);
    else yellowPreviewArea.innerHTML = t.url ? `<img src="${escapeHtml(t.url)}">` : `<div style="color:#aaa;">${escapeHtml(t.name || '')}</div>`;
}

async function renderLivePreview() {
    if (!_livePreviewOn) return;
    const page = albumPages[currentPage];
    if (!page || !page.template || !(page.photos && page.photos.length)) {
        _showTemplateThumb(); // nothing to composite yet
        return;
    }
    const seq = ++_liveSeq;
    yellowPreviewArea.classList.add('is-rendering');
    try {
        // Smaller maxEdge than batch proofs — the Preview pane is small and we
        // want it snappy on every edit.
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

if (chkLivePreview) {
    chkLivePreview.addEventListener('change', () => {
        _livePreviewOn = chkLivePreview.checked;
        if (_livePreviewOn) renderLivePreview();
        else _showTemplateThumb();
    });
}

// ── Per-photo adjustments ──────────────────────────────────────
// The inline Pages adjust panel (H1) was removed — per-photo colour grading
// now lives solely in the Spread Editor. `updateAdjustPanel` is kept as a
// no-op so existing call sites stay valid. The adjustment *data model*
// (projectData.imageAdjustments) is unchanged and still drives the preview,
// the export, and the editor.
function updateAdjustPanel() { /* no-op: adjust UI moved to the Spread Editor */ }
// Initialise (no-op).
updateAdjustPanel();


// ── Spread Editor bridge ───────────────────────────────────────
// Builds the payload the editor window needs (frame geometry + photo proxies
// + current placement/adjust), opens the editor, and applies edits back.
async function buildSpreadPayload(pageNum) {
    const page = albumPages[pageNum];
    if (!page || !page.template) return null;
    const tpl = await ensureTemplateFrames(page.template);
    if (!tpl || !tpl._frames || !tpl._canvas) return null;

    // Same partition + ordering the renderer/JSX use: h photos → h frames,
    // v photos → v frames, each sorted by frame name.
    const hFrames = tpl._frames.filter(f => /toolkithframe/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    const vFrames = tpl._frames.filter(f => /toolkitvframe/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    const hPhotos = page.photos.filter(p => p.orient === 'h');
    const vPhotos = page.photos.filter(p => p.orient === 'v');
    const items = [];
    const assign = (photos, frames, orient) => {
        for (let i = 0; i < photos.length && i < frames.length; i++) {
            const p = photos[i];
            const c = photoCache[p.id];
            items.push({
                id: p.id,
                url: (c && c.url) || p.url,
                orient,
                frame: frames[i],
                rotation: projectData.imageRotations?.[p.id] || 0,
                placement: projectData.imagePlacements?.[p.id] || null,
                adjust: projectData.imageAdjustments?.[p.id] || null,
            });
        }
    };
    assign(hPhotos, hFrames, 'h');
    assign(vPhotos, vFrames, 'v');

    // Lightweight list of every editable spread so the editor's left rail can
    // navigate between pages (full payload is fetched lazily per page).
    const spreads = [];
    for (let i = 1; i <= totalActivePages; i++) {
        const pg = albumPages[i];
        if (!pg || !pg.template || !(pg.photos && pg.photos.length)) continue;
        spreads.push({ pageNum: i, backdropUrl: pg.template.url || null });
    }

    return {
        pageNum,
        canvasW: tpl._canvas.w,
        canvasH: tpl._canvas.h,
        backdropUrl: tpl.url || null,
        items,
        spreads,
    };
}

const btnEditSpread = document.getElementById('btnEditSpread');
if (btnEditSpread) {
    btnEditSpread.addEventListener('click', async () => {
        const page = albumPages[currentPage];
        if (!page || !page.template || !(page.photos && page.photos.length)) {
            toast('Add a template and photos to this page first', 'info');
            return;
        }
        setStatus('Opening Spread Editor…');
        const payload = await buildSpreadPayload(currentPage);
        if (!payload) { toast('Could not read this page for editing', 'error'); return; }
        try { await require('electron').ipcRenderer.invoke('editor-open', payload); }
        catch (e) { toast('Could not open editor: ' + (e.message || e), 'error'); }
        setStatus('');
    });
}

// Editor → here: persist placement/adjustment edits and refresh the preview.
require('electron').ipcRenderer.on('editor-changes', (_e, changes) => {
    if (!changes) return;
    if (!projectData.imagePlacements) projectData.imagePlacements = {};
    if (!projectData.imageAdjustments) projectData.imageAdjustments = {};
    if (changes.placements) {
        for (const [id, pl] of Object.entries(changes.placements)) {
            if (pl) projectData.imagePlacements[id] = pl; else delete projectData.imagePlacements[id];
        }
    }
    if (changes.adjustments) {
        for (const [id, adj] of Object.entries(changes.adjustments)) {
            if (adj) projectData.imageAdjustments[id] = adj; else delete projectData.imageAdjustments[id];
        }
    }
    try { saveStateToStorage(); } catch (_) {}
    // Refresh the on-app live preview if the edited page is the current one.
    if (!changes.pageNum || changes.pageNum === currentPage) {
        if (typeof scheduleLivePreview === 'function') scheduleLivePreview();
        updateAdjustPanel();
    }
    // The edited page's storyboard proof (Tab 7 / page_NNN.jpg) is now stale.
    // Invalidate its cache and re-render it in the background (debounced) so
    // the proof reflects the edit without a manual "Generate Proofs" pass.
    if (changes.pageNum) _scheduleEditedPageReproof(changes.pageNum);
});

// Debounced per-page storyboard re-proof after a Spread Editor edit.
const _reproofTimers = {};
function _scheduleEditedPageReproof(pageNum) {
    const page = albumPages[pageNum];
    if (!page || !page.template || !(page.photos && page.photos.length)) return;
    if (typeof _proofHashes === 'object') delete _proofHashes[pageNum]; // mark stale
    clearTimeout(_reproofTimers[pageNum]);
    _reproofTimers[pageNum] = setTimeout(async () => {
        try {
            if (typeof _generateProofForPage !== 'function') return;
            const r = await _generateProofForPage(pageNum);
            if (r && r.ok && typeof _swapProofIntoStoryboard === 'function') {
                _swapProofIntoStoryboard(pageNum);
            }
        } catch (_) {}
    }, 450);
}

// Editor → here: swap two photos between frames on a page. Photos keep their
// own per-id placement/adjust (keyed by photo id), so each photo's crop and
// colour travel with it into the new slot. We swap the two photos' positions
// in albumPages[page].photos; since frames are assigned by orientation+order,
// swapping two same-orientation photos swaps which frame each lands in.
require('electron').ipcRenderer.on('editor-swap', (_e, msg) => {
    if (!msg || !msg.aId || !msg.bId) return;
    const page = albumPages[msg.pageNum];
    if (!page || !page.photos) return;
    const ia = page.photos.findIndex(p => p.id === msg.aId);
    const ib = page.photos.findIndex(p => p.id === msg.bId);
    if (ia === -1 || ib === -1 || ia === ib) return;
    mutate('Swap photos', () => {
        const a = page.photos[ia];
        const b = page.photos[ib];
        // Swap orientation too so cross-shape swaps re-derive the right frame
        // assignment (frames are assigned by orientation + order). For
        // same-orientation swaps this is a no-op and only the positions matter.
        const ao = a.orient; a.orient = b.orient; b.orient = ao;
        page.photos[ia] = b;
        page.photos[ib] = a;
    });
    if (msg.pageNum === currentPage) {
        if (typeof renderGreenBox === 'function') renderGreenBox();
        if (typeof scheduleLivePreview === 'function') scheduleLivePreview();
    }
    // The swapped page's storyboard proof is now stale — refresh it too.
    _scheduleEditedPageReproof(msg.pageNum);
});

// Editor → here: navigate the editor to a different page. Rebuild that page's
// payload and push it to the editor window (single source of truth).
require('electron').ipcRenderer.on('editor-goto', async (_e, msg) => {
    if (!msg || !msg.pageNum) return;
    try {
        const payload = await buildSpreadPayload(msg.pageNum);
        if (payload) await require('electron').ipcRenderer.invoke('editor-open', payload);
    } catch (_) {}
});

// ==========================================
// --- 6. GREEN BOX & TOOLBAR ACTIONS ---
// ==========================================
const btnPull = document.getElementById("btnPull");
if (btnPull) { btnPull.onclick = () => { const selected = Array.from(redBox.querySelectorAll(".selected")).map(el => ({id: el.id, url: el.src})); if (selected.length > 0) prepareAndMove(selected); }; }

async function prepareAndMove(items) {
    if (!albumPages[currentPage]) albumPages[currentPage] = { photos: [], template: null };
    items.forEach(item => { const redImg = document.getElementById(item.id); if (redImg) { redImg.classList.add("used"); redImg.classList.remove("selected"); } });
    const analysisPromises = items.map(item => new Promise((resolve) => {
        const img = document.createElement("img"); img.style.cssText = "position: absolute; top: -9999px; left: -9999px; visibility: hidden;";
        img.onload = () => { const isH = img.naturalWidth >= img.naturalHeight; document.body.removeChild(img); resolve({ ...item, orient: isH ? 'h' : 'v' }); };
        img.onerror = () => { if(img.parentNode) document.body.removeChild(img); resolve({ ...item, orient: 'h' }); };
        document.body.appendChild(img); img.src = item.url;
    }));
    const analyzedResults = await Promise.all(analysisPromises);
    const finalResults = analyzedResults.map(res => {
        const rotation = projectData.imageRotations[res.id] || 0;
        if (rotation === 90 || rotation === 270) res.orient = (res.orient === 'h') ? 'v' : 'h';
        return res;
    });
    mutate(`Pull ${finalResults.length} photo${finalResults.length === 1 ? '' : 's'}`, () => {
        albumPages[currentPage].photos = albumPages[currentPage].photos.concat(finalResults);
        finalResults.forEach(p => addToPageMap(p.id, currentPage));
        renderGreenBox(); scheduleFilterUpdate();
    });
}

// ⚡ FIX: renderGreenBox uses DocumentFragment + caches the CSS var read outside
// the loop (getComputedStyle inside a loop forces repeated layout recalculations).

// Tracks the last container the user clicked so Shift+click can extend a
// range. Reset on every render because container indexes are unstable
// across re-renders.
let _greenLastClickedIdx = null;

function renderGreenBox() {
    const pageData = albumPages[currentPage];
    if (!pageData || pageData.photos.length === 0) {
        greenBox.innerHTML = `<div class="empty-state">
            <div class="empty-state__icon">🗂️</div>
            <div class="empty-state__title">This page is empty</div>
            <div class="empty-state__hint">Drag photos here from the Source pool (or double-click them), or use Auto-Fill to populate the album.</div>
        </div>`;
        scheduleLivePreview(); // empty page → live preview reverts to template
        return;
    }

    // Container sizing now lives entirely in style.css so the slider
    // (which sets --green-thumb-size on :root) controls both width and
    // height in lockstep. Inline width/height previously fought the CSS
    // and produced "fit-to-height" stretching where the slider only grew
    // the cell horizontally.
    const containerStyle = '';

    const frag = document.createDocumentFragment();

    pageData.photos.forEach((p, idx) => {
        const wrapperW = document.createElement("div");
        wrapperW.className = "greenbox-wrapper";

        const container = document.createElement("div");
        container.className = "img-container";
        // Selection lives on the CONTAINER (was on the img before). Outlining
        // the whole tile is visually obvious; the previous img-border approach
        // collided with the inline `border: 2px solid transparent` set below
        // and produced an invisible "selected" state.
        container.dataset.photoId = p.id;
        container.dataset.photoIdx = idx;
        container.draggable = true;
        if (containerStyle) container.style.cssText = containerStyle;

        const savedRotation = projectData.imageRotations[p.id] || 0;
        // No more inline `border` here — selection is conveyed via the
        // container's outline ring.
        const cssRotation = `transform: rotate(${savedRotation}deg); transform-origin: center; transition: transform 0.2s ease; max-height:100%; max-width:100%; object-fit:contain; cursor:pointer;`;
        container.innerHTML = `<img src="${escapeHtml(p.url)}" class="thumb-green" style="${cssRotation}" draggable="false"><div class="orient-label">${escapeHtml(p.orient).toUpperCase()}</div>`;

        const imgEl = container.querySelector('.thumb-green');

        // Single click toggles selection. Shift+click extends selection from
        // the last clicked tile to this one. Cmd/Ctrl+click toggles a single
        // tile without affecting others — same model as Finder / VS Code.
        container.addEventListener('click', (e) => {
            // Ignore clicks on overlay buttons inside the container.
            if (e.target.closest('button')) return;
            const all = Array.from(greenBox.querySelectorAll('.img-container'));
            const here = all.indexOf(container);
            if (e.shiftKey && _greenLastClickedIdx != null) {
                const [a, b] = [_greenLastClickedIdx, here].sort((x, y) => x - y);
                for (let i = a; i <= b; i++) all[i].classList.add('selected');
            } else if (e.metaKey || e.ctrlKey) {
                container.classList.toggle('selected');
            } else {
                const wasSelected = container.classList.contains('selected');
                all.forEach(el => el.classList.remove('selected'));
                if (!wasSelected) container.classList.add('selected');
            }
            _greenLastClickedIdx = here;
            updateAdjustPanel();
        });

        imgEl.ondblclick = () => mutate('Remove photo from page', () => {
            albumPages[currentPage].photos = albumPages[currentPage].photos.filter(x => x.id !== p.id);
            removeFromPageMap(p.id, currentPage);
            const red = document.getElementById(p.id);
            if (red) { red.classList.remove("used"); red.style.opacity = "1"; }
            renderGreenBox(); scheduleFilterUpdate();
        });

        wrapperW.appendChild(container);
        frag.appendChild(wrapperW);
    });

    greenBox.innerHTML = "";
    greenBox.appendChild(frag);
    _greenLastClickedIdx = null;
    scheduleLivePreview(); // page composition changed → re-composite if live
    if (typeof updateAdjustPanel === 'function') updateAdjustPanel(); // selection cleared on rebuild
}

// ─── DRAG-AND-DROP REORDER (greenBox) ─────────────────────────────────────
// Single delegated handler — listeners stay attached to the stable greenBox
// node and survive every renderGreenBox() innerHTML rebuild.
;(function _greenInitDnd() {
    if (!greenBox) return;
    let dragging = null;        // .img-container being dragged
    let dragSrcId = null;
    let lastDropTarget = null;

    function clearDropMarkers() {
        greenBox.querySelectorAll('.drop-before, .drop-after').forEach(el =>
            el.classList.remove('drop-before', 'drop-after'));
    }

    greenBox.addEventListener('dragstart', (e) => {
        const c = e.target.closest('.img-container');
        if (!c) return;
        dragging = c;
        dragSrcId = c.dataset.photoId;
        c.classList.add('is-dragging');
        // C.3: highlight the green box as the active drop zone for the drag.
        greenBox.classList.add('dropzone--active');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragSrcId); } catch (_) {}
    });

    greenBox.addEventListener('dragover', (e) => {
        if (!dragging) {
            // Source-pool photo being dragged in: accept a drop anywhere on
            // the page (it appends, like double-click / PULL).
            if (_sourceDragItems) {
                e.preventDefault();
                try { e.dataTransfer.dropEffect = 'copy'; } catch (_) {}
            }
            return;
        }
        const c = e.target.closest('.img-container');
        if (!c || c === dragging) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
        // Decide drop side based on horizontal position relative to the
        // hovered tile's center.
        const rect = c.getBoundingClientRect();
        const before = (e.clientX - rect.left) < rect.width / 2;
        if (lastDropTarget && lastDropTarget !== c) {
            lastDropTarget.classList.remove('drop-before', 'drop-after');
        }
        c.classList.toggle('drop-before', before);
        c.classList.toggle('drop-after', !before);
        lastDropTarget = c;
    });

    greenBox.addEventListener('dragleave', (e) => {
        // Only clear when actually leaving a tile, not when transitioning
        // between child elements of the same tile.
        const c = e.target.closest('.img-container');
        if (!c) return;
        // If relatedTarget is inside the same tile, ignore.
        if (e.relatedTarget && c.contains(e.relatedTarget)) return;
        c.classList.remove('drop-before', 'drop-after');
    });

    greenBox.addEventListener('drop', (e) => {
        if (!dragging) {
            // Source-pool drop → add the dragged photo(s) to the current page.
            if (_sourceDragItems) {
                e.preventDefault();
                const items = _sourceDragItems;
                _sourceDragItems = null;
                greenBox.classList.remove('dropzone--active');
                prepareAndMove(items);
            }
            return;
        }
        e.preventDefault();
        const target = e.target.closest('.img-container');
        if (!target || target === dragging) {
            clearDropMarkers();
            dragging.classList.remove('is-dragging');
            greenBox.classList.remove('dropzone--active');
            dragging = null; lastDropTarget = null;
            return;
        }
        const before = target.classList.contains('drop-before');
        clearDropMarkers();

        // Reorder albumPages[currentPage].photos using the source / target ids.
        mutate('Reorder photos', () => {
            const photos = albumPages[currentPage].photos;
            const srcIdx = photos.findIndex(p => p.id === dragSrcId);
            const dstIdx = photos.findIndex(p => p.id === target.dataset.photoId);
            if (srcIdx === -1 || dstIdx === -1) return;
            const [moved] = photos.splice(srcIdx, 1);
            // After removal, the destination index may have shifted by one.
            let insertAt = photos.findIndex(p => p.id === target.dataset.photoId);
            if (!before) insertAt += 1;
            photos.splice(insertAt, 0, moved);
            renderGreenBox();
            scheduleFilterUpdate();
        });

        dragging.classList.remove('is-dragging');
        greenBox.classList.remove('dropzone--active');
        dragging = null; lastDropTarget = null;
    });

    greenBox.addEventListener('dragend', () => {
        if (dragging) dragging.classList.remove('is-dragging');
        greenBox.classList.remove('dropzone--active');
        clearDropMarkers();
        dragging = null; lastDropTarget = null;
    });
})();

const btnRemoveSelected = document.getElementById("btnRemoveSelected");
if (btnRemoveSelected) {
    btnRemoveSelected.onclick = () => {
        const pageData = albumPages[currentPage]; if (!pageData) return;
        // Selection now lives on the .img-container, not the inner img.
        const selectedContainers = Array.from(greenBox.querySelectorAll('.img-container.selected'));
        if (selectedContainers.length === 0) return;
        const selectedIds = selectedContainers.map(c => c.dataset.photoId).filter(Boolean);
        mutate(`Remove ${selectedIds.length} photo${selectedIds.length === 1 ? '' : 's'}`, () => {
            for (const photoId of selectedIds) {
                const photoObj = pageData.photos.find(p => p.id === photoId);
                if (!photoObj) continue;
                pageData.photos = pageData.photos.filter(p => p.id !== photoObj.id);
                removeFromPageMap(photoObj.id, currentPage);
                const red = document.getElementById(photoObj.id);
                if (red) { red.classList.remove("used"); red.style.opacity = "1"; }
            }
            renderGreenBox(); scheduleFilterUpdate();
        });
    };
}

// ─── SORT THIS PAGE ──────────────────────────────────────────
// Sorts only the current page's photos chronologically by EXIF capture
// time. Uses the same resolver the global Auto-Fill uses, so it benefits
// from the HR-then-proxy fallback that handles RAW/TIFF cases.
const btnSortPage = document.getElementById('btnSortPage');
if (btnSortPage) {
    btnSortPage.addEventListener('click', async () => {
        const pageData = albumPages[currentPage];
        if (!pageData?.photos?.length) {
            toast('Nothing on this page to sort', 'info');
            return;
        }
        if (pageData.photos.length === 1) {
            toast('Only one photo — nothing to sort', 'info');
            return;
        }
        btnSortPage.disabled = true;
        try {
            // Snapshot a copy so we can detect "no change" and skip the
            // mutate() entry (keeps the undo history clean).
            const beforeOrder = pageData.photos.map(p => p.id);
            // sortPhotosByExif sorts the array in place by EXIF date with
            // filename fallback. Run on a clone first so we can compare.
            const clone = pageData.photos.slice();
            await sortPhotosByExif(clone);
            const changed = clone.some((p, i) => p.id !== beforeOrder[i]);
            if (!changed) {
                toast('Page is already in chronological order', 'info');
                return;
            }
            mutate('Sort page by capture time', () => {
                albumPages[currentPage].photos = clone;
                renderGreenBox();
                scheduleFilterUpdate();
            });
            notify('Page sorted by capture time · Cmd+Z to undo', 'success', { duration: 4000 });
        } catch (e) {
            toast('Sort failed: ' + e.message, 'error');
        } finally {
            btnSortPage.disabled = false;
        }
    });
}

const btnTeleportGlobal = document.getElementById("btnTeleportGlobal");
if (btnTeleportGlobal) {
    btnTeleportGlobal.onclick = () => {
        const targetPage = parseInt(teleportSelect.value); if (targetPage === currentPage) return;
        const pageData = albumPages[currentPage];
        // Selection lives on .img-container now — same model as remove.
        const selectedContainers = Array.from(greenBox.querySelectorAll('.img-container.selected'));
        if (selectedContainers.length === 0) return app.showAlert("Select photos in the Green Box to teleport!");
        const selectedIds = selectedContainers.map(c => c.dataset.photoId).filter(Boolean);
        mutate(`Teleport ${selectedIds.length} photo${selectedIds.length === 1 ? '' : 's'} to page ${targetPage}`, () => {
            if (targetPage > totalActivePages) { totalActivePages = targetPage; updatePageDropdowns(); }
            if (!albumPages[targetPage]) albumPages[targetPage] = { photos: [], template: null };
            for (const photoId of selectedIds) {
                const photoObj = pageData.photos.find(p => p.id === photoId);
                if (!photoObj) continue;
                pageData.photos = pageData.photos.filter(p => p.id !== photoObj.id);
                removeFromPageMap(photoObj.id, currentPage);
                albumPages[targetPage].photos.push(photoObj);
                addToPageMap(photoObj.id, targetPage);
            }
            renderGreenBox(); scheduleFilterUpdate();
        });
    };
}

// ==========================================
// --- 7. SMART AUTO-FILL (ALL PAGES) ---
// ==========================================
const btnAutoAll = document.getElementById("btnAutoAll");
if (btnAutoAll) {
    btnAutoAll.addEventListener("click", async () => {
        const useDesired = document.getElementById('chkDesiredSheets')?.checked;
        const minVal = parseInt(document.getElementById("minImgs").value);
        const maxVal = parseInt(document.getElementById("maxImgs").value);
        const desiredVal = parseInt(document.getElementById("desiredSheetsCount").value);

        if (useDesired) {
            if (isNaN(desiredVal) || desiredVal < 1) return app.showAlert("Enter a valid number of desired sheets (1 or more).");
        } else {
            if (isNaN(minVal) || isNaN(maxVal) || minVal > maxVal) return app.showAlert("Invalid Min/Max values.");
        }

        const activeLibrary = templateLibrary.filter(t => activeTemplateFolders.has(t.folderId));
        if (activeLibrary.length === 0) return app.showAlert("Load and check at least one Template folder first!");

        // ⚡ PERF (Task 2.2): build the available-photo list from photoCache +
        // a usedIds Set instead of querySelectorAll('.thumb-red:not(.used)').
        // The DOM query forced a layout reflow and read .parentElement.dataset
        // per node on a hot path; this is a pure in-memory pass and lets
        // auto-fill run without depending on rendered DOM state.
        const usedIdSet = new Set();
        Object.values(albumPages).forEach(pg => {
            if (pg && pg.photos) pg.photos.forEach(p => usedIdSet.add(p.id));
        });
        let availablePhotos = Object.entries(photoCache)
            .filter(([id, c]) => activeImageFolders.has(c.folderId) && !usedIdSet.has(id))
            .map(([id, c]) => ({ id, url: c.url }));
        if (availablePhotos.length === 0) return app.showAlert("No unused photos left in active folders!");

        // ⚡ EXIF chronological order — most weddings flow ceremony→reception
        // and benefit hugely from time-ordered auto-fill. The user can opt out
        // for pre-sorted folders via the #chkExifOrder checkbox.
        const exifToggle = document.getElementById('chkExifOrder');
        if (!exifToggle || exifToggle.checked) {
            setStatus('Reading capture times…');
            await sortPhotosByExif(availablePhotos);
        }

        setStatus("Processing Auto-Fill…");

        // Build the list of "pull counts" per page up front. Two modes:
        //
        //   Desired-sheets ON  → distribute ALL available photos across
        //                        exactly desiredVal sheets. base = floor(N/D);
        //                        the remainder is spread by handing out a +1
        //                        to a randomly-shuffled subset of sheets so
        //                        the heavy pages aren't always front-loaded.
        //
        //   Desired-sheets OFF → original behavior. Pull a random number in
        //                        [min, max] per page until photos run out.
        const pullCounts = [];
        if (useDesired) {
            const N = availablePhotos.length;
            const D = Math.min(desiredVal, N); // can't make more pages than photos
            const base = Math.floor(N / D);
            let remainder = N - base * D;
            // Sheets that receive the +1
            const bonusIdx = new Set();
            const order = Array.from({ length: D }, (_, i) => i);
            // Shuffle (Fisher–Yates)
            for (let i = order.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [order[i], order[j]] = [order[j], order[i]];
            }
            for (let i = 0; i < remainder; i++) bonusIdx.add(order[i]);
            for (let i = 0; i < D; i++) pullCounts.push(base + (bonusIdx.has(i) ? 1 : 0));
            if (D < desiredVal) {
                toast(`Only ${N} photos available — capping at ${D} sheets`, 'warning', { duration: 4000 });
            }
        } else {
            // Original Min/Max random walk
            let remaining = availablePhotos.length;
            while (remaining > 0) {
                let n = Math.floor(Math.random() * (maxVal - minVal + 1)) + minVal;
                if (n > remaining) n = remaining;
                pullCounts.push(n);
                remaining -= n;
            }
        }

        // Build all page assignments off-DOM first, THEN commit in a single
        // mutate() so undo restores the entire pre-auto-fill state in one shot.
        const newPages = {};
        const usedIds = [];
        for (let pageIdx = 0; pageIdx < pullCounts.length; pageIdx++) {
            const pullCount = pullCounts[pageIdx];
            const selectedForPage = availablePhotos.splice(0, pullCount);
            if (selectedForPage.length === 0) break;

            // ⚡ Task 2.1: prefer the orientation cached on photoCache (set
            // when the thumbnail decoded). Only fall back to an off-DOM probe
            // for the rare photo whose proxy hasn't loaded yet.
            const analysisPromises = selectedForPage.map(item => {
                const cached = photoCache[item.id]?.orient;
                if (cached) return Promise.resolve({ ...item, orient: cached });
                return new Promise((resolve) => {
                    const img = document.createElement("img"); img.style.cssText = "position: absolute; top: -9999px; left: -9999px; visibility: hidden;";
                    img.onload = () => {
                        const isH = img.naturalWidth >= img.naturalHeight;
                        if (photoCache[item.id]) photoCache[item.id].orient = isH ? 'h' : 'v';
                        document.body.removeChild(img);
                        resolve({ ...item, orient: isH ? 'h' : 'v' });
                    };
                    img.onerror = () => { if(img.parentNode) document.body.removeChild(img); resolve({ ...item, orient: 'h' }); };
                    document.body.appendChild(img); img.src = item.url;
                });
            });
            const analyzedPhotos = await Promise.all(analysisPromises);
            const syncedPhotos = analyzedPhotos.map(res => {
                const rotation = projectData.imageRotations[res.id] || 0;
                if (rotation === 90 || rotation === 270) res.orient = (res.orient === 'h') ? 'v' : 'h';
                return res;
            });

            const hCount = syncedPhotos.filter(p => p.orient === 'h').length;
            const vCount = syncedPhotos.filter(p => p.orient === 'v').length;
            const matchingTemplates = activeLibrary.filter(t => t.h === hCount && t.v === vCount);
            const tpl = matchingTemplates.length > 0
                ? matchingTemplates[Math.floor(Math.random() * matchingTemplates.length)]
                : null;
            newPages[pageIdx + 1] = { photos: syncedPhotos, template: tpl };
            syncedPhotos.forEach(p => usedIds.push(p.id));
        }

        const totalNewPages = Math.max(Object.keys(newPages).length, 1);

        mutate(useDesired ? `Auto-Fill (desired ${totalNewPages} sheets)` : 'Auto-Fill all pages', () => {
            albumPages = newPages;
            totalActivePages = totalNewPages;
            rebuildPhotoPageMap();
            updatePageDropdowns(); changePage(1);
            usedIds.forEach(id => { const r = document.getElementById(id); if (r) r.classList.add('used'); });
        });

        notify(`Auto-Fill complete — ${totalNewPages} pages allocated. Open Tab 7 (Export Studio) to review.`, "success", { duration: 6000 });
    });
}

// Cross-disable Min/Max ↔ Desired sheets so the user always sees which
// inputs are active. Updated reactively on toggle and on initial load.
function _syncAutoFillModeUI() {
    const desiredOn = document.getElementById('chkDesiredSheets')?.checked;
    const minEl = document.getElementById('minImgs');
    const maxEl = document.getElementById('maxImgs');
    const cntEl = document.getElementById('desiredSheetsCount');
    if (minEl) minEl.disabled = desiredOn;
    if (maxEl) maxEl.disabled = desiredOn;
    if (cntEl) cntEl.disabled = !desiredOn;
}
document.getElementById('chkDesiredSheets')?.addEventListener('change', _syncAutoFillModeUI);
_syncAutoFillModeUI();

// ==========================================
// --- 8. THE MASTER PLACEMENT ENGINE ---
// ==========================================
async function buildDocumentLayers(doc, pageData) {
    let hPhotos = pageData.photos.filter(p => p.orient === 'h');
    let vPhotos = pageData.photos.filter(p => p.orient === 'v');
    let hFramesData = [], vFramesData = [];

    function findFrames(parent) { parent.layers.forEach(l => { const lowerName = l.name.toLowerCase(); if (lowerName.includes("toolkithframe")) hFramesData.push({id: l.id, name: l.name}); else if (lowerName.includes("toolkitvframe")) vFramesData.push({id: l.id, name: l.name}); if (l.layers && l.layers.length > 0) findFrames(l); }); }
    findFrames(doc);
    hFramesData.sort((a,b) => a.name.localeCompare(b.name));
    vFramesData.sort((a,b) => a.name.localeCompare(b.name));

    function getLayerById(id, parent=doc) { for(let l of parent.layers) { if (l.id === id) return l; if (l.layers && l.layers.length > 0) { let found = getLayerById(id, l); if (found) return found; } } return null; }

    async function placeAndFit(photoObj, frameData) {
        const cacheData = photoCache[photoObj.id]; if (!cacheData) return;
        const fetchResult = await getTrueFile(cacheData);
        const frameLayer = getLayerById(frameData.id); if (!frameLayer) return;
        doc.activeLayers = [frameLayer];
        const token = await fs.createSessionToken(fetchResult.file);
        await batchPlay([{ "_obj": "placeEvent", "null": { "_path": token, "_kind": "local" }, "linked": false, "freeTransformCenterState": { "_enum": "quadCenterState", "_value": "QCSAverage" }, "offset": { "_obj": "offset", "horizontal": { "_unit": "pixelsUnit", "_value": 0 }, "vertical": { "_unit": "pixelsUnit", "_value": 0 } } }], {});
        await forceEmbed();
        const placedLayer = doc.activeLayers[0];
        placedLayer.name = fetchResult.isHr ? cacheData.baseName + "_HighRes" : cacheData.baseName;
        placedLayer.moveAbove(frameLayer);
        await batchPlay([{ "_obj": "groupEvent", "_target": [{ "_ref": "layer", "_enum": "ordinal", "_value": "targetEnum" }] }], {});
        const rotation = projectData.imageRotations[photoObj.id] || 0;
        if (rotation !== 0) {
            await core.executeAsModal(async () => {
                await batchPlay([{ "_obj": "rotate", "_target": [{"_ref": "layer", "_id": placedLayer.id}], "angle": {"_unit": "angleUnit", "_value": rotation}, "freeTransformCenterState": {"_enum": "quadCenterState", "_value": "QCSAverage"} }], {});
            }, {"commandName": "Apply Saved Rotation to High-Res"});
        }
        const fBounds = frameLayer.boundsNoEffects; const fWidth = fBounds.right - fBounds.left; const fHeight = fBounds.bottom - fBounds.top;
        const pBounds = placedLayer.boundsNoEffects; const pWidth = pBounds.right - pBounds.left; const pHeight = pBounds.bottom - pBounds.top;
        const scale = Math.max(fWidth / pWidth, fHeight / pHeight) * 100; await placedLayer.scale(scale, scale);
        const newBounds = placedLayer.boundsNoEffects;
        const frameCenterX = fBounds.left + (fWidth / 2); const frameCenterY = fBounds.top + (fHeight / 2);
        const photoCenterX = newBounds.left + ((newBounds.right - newBounds.left) / 2);
        const photoCenterY = newBounds.top + ((newBounds.bottom - newBounds.top) / 2);
        await placedLayer.translate(frameCenterX - photoCenterX, frameCenterY - photoCenterY);
    }

    for (let i = 0; i < hPhotos.length && i < hFramesData.length; i++) await placeAndFit(hPhotos[i], hFramesData[i]);
    for (let i = 0; i < vPhotos.length && i < vFramesData.length; i++) await placeAndFit(vPhotos[i], vFramesData[i]);
    doc.activeLayers = [];
}

const btnAutoThis = document.getElementById("btnAutoThis");
if (btnAutoThis) {
    btnAutoThis.addEventListener("click", async () => {
        const pageData = albumPages[currentPage];
        if (!pageData || pageData.photos.length === 0) return app.showAlert("Pull photos into Green Box first!");
        if (!pageData.template) return app.showAlert("Select a template from PSD Library!");
        try {
            setStatus(`Building Page ${currentPage}…`);
            const exportData = buildExportData(currentPage, currentPage);
            const pageEntry = exportData.pages[currentPage];
            if (!pageEntry) return app.showAlert("Could not resolve page data!");
            // Bake per-photo adjustments so the built PSD reflects the preview —
            // UNLESS J1 (editable adjustment layers) is on, which places
            // originals + adds clipped adjustment layers in the JSX instead.
            if (!_useAdjLayers) await bakeExportAdjustments(exportData);
            const payload = {
                templatePath: pageEntry.templatePath,
                pageName: String(currentPage).padStart(3, '0'),
                photos: pageEntry.photos,
                useAdjustmentLayers: _useAdjLayers
            };
            await require('electron').ipcRenderer.invoke('build-page', payload);
            notify(`Page ${currentPage} built successfully`, "success");
        } catch(err) { app.showAlert("Build Error: " + err.message); }
    });
}

// ==========================================
// --- 9. UI SLIDERS & RESIZERS ---
// ==========================================
const redSlider = document.getElementById("redSlider"); if (redSlider) redSlider.oninput = (e) => document.documentElement.style.setProperty('--red-thumb-size', e.target.value + "px");
const greenSlider = document.getElementById("greenSlider"); if (greenSlider) greenSlider.oninput = (e) => document.documentElement.style.setProperty('--green-thumb-size', e.target.value + "px");
const whiteSlider = document.getElementById("whiteSlider"); if (whiteSlider) whiteSlider.oninput = (e) => document.documentElement.style.setProperty('--white-thumb-size', e.target.value + "px");
const yellowSlider = document.getElementById("yellowSlider"); if (yellowSlider) yellowSlider.oninput = (e) => document.documentElement.style.setProperty('--yellow-thumb-size', e.target.value + "px");
const wallpaperSlider = document.getElementById("wallpaperSlider"); if (wallpaperSlider) wallpaperSlider.oninput = (e) => document.documentElement.style.setProperty('--wp-thumb-size', e.target.value + "px");
const pngSlider = document.getElementById("pngSlider"); if (pngSlider) pngSlider.oninput = (e) => document.documentElement.style.setProperty('--wp-thumb-size', e.target.value + "px");
const maskedSlider = document.getElementById("maskedSlider"); if (maskedSlider) maskedSlider.oninput = (e) => document.documentElement.style.setProperty('--wp-thumb-size', e.target.value + "px");
if (photosSlider) photosSlider.oninput = (e) => document.documentElement.style.setProperty('--wp-thumb-size', e.target.value + "px");
const storyboardSlider = document.getElementById("storyboardSlider");
if (storyboardSlider) storyboardSlider.oninput = (e) => document.documentElement.style.setProperty('--sb-thumb-size', e.target.value + "px");

function setupResizer(resizerId, leftBoxId, rowContainerId, minW = 150, maxWOffset = 150) {
    const resizer = document.getElementById(resizerId); const leftBox = document.getElementById(leftBoxId); const rowContainer = document.getElementById(rowContainerId);
    if (!resizer || !leftBox || !rowContainer) return;
    resizer.style.cursor = "col-resize";
    resizer.addEventListener("pointerdown", (e) => {
        resizer.setPointerCapture(e.pointerId); document.body.style.cursor = "col-resize";
        const onMove = (ev) => { const rect = rowContainer.getBoundingClientRect(); let w = ev.clientX - rect.left; if (w > minW && w < rect.width - maxWOffset) { leftBox.style.width = w + "px"; leftBox.style.flex = "none"; } };
        const onUp = (ev) => { resizer.releasePointerCapture(ev.pointerId); resizer.removeEventListener("pointermove", onMove); resizer.removeEventListener("pointerup", onUp); document.body.style.cursor = "default"; };
        resizer.addEventListener("pointermove", onMove); resizer.addEventListener("pointerup", onUp);
    });
}
function setupHorizontalResizer(resizerId, topRowId) {
    const resizer = document.getElementById(resizerId); const topRow = document.getElementById(topRowId);
    if (!resizer || !topRow) return; let isResizing = false;
    resizer.addEventListener("pointerdown", (e) => { isResizing = true; resizer.setPointerCapture(e.pointerId); document.body.style.cursor = "row-resize"; e.preventDefault(); });
    resizer.addEventListener("pointermove", (e) => { if (!isResizing) return; const containerTop = topRow.getBoundingClientRect().top; let newHeight = e.clientY - containerTop; if (newHeight > 100 && newHeight < window.innerHeight - 150) { topRow.style.flex = "none"; topRow.style.height = newHeight + "px"; } });
    resizer.addEventListener("pointerup", (e) => { if (isResizing) { isResizing = false; resizer.releasePointerCapture(e.pointerId); document.body.style.cursor = "default"; } });
}

setupResizer("topResizer", "greenWrapper", "topRow", 150, 150); setupResizer("bottomResizer", "redWrapper", "bottomRow", 150, 150);
setupResizer("redFolderResizer", "redFolderPanel", "redFolderContainer", 40, 50); setupResizer("whiteFolderResizer", "whiteFolderPanel", "whiteFolderContainer", 40, 50);
setupResizer("wpResizer", "wpFolderContainer", "wpRow", 100, 150); setupHorizontalResizer("resizerHorizontal", "topRow");
setupResizer("pngResizer", "pngFolderContainer", "pngRow", 100, 150); setupResizer("maskedResizer", "maskedFolderContainer", "maskedRow", 100, 150);
setupResizer("photosResizer", "photosFolderContainer", "photosRow", 100, 150);

// ==========================================
// --- 10. TAB 2: WALLPAPERS ENGINE ---
// ==========================================
async function placeWallpaper(wallpaperId) {
    const wpData = wallpaperCache[wallpaperId]; if (!wpData) return;
    const fetchResult = await getTrueFile(wpData);
    try {
        setStatus('Placing wallpaper…');
        const filePath = fetchResult.file.nativePath;
        const result = await require('electron').ipcRenderer.invoke('place-wallpaper', filePath, fetchResult.isHr);
        if (result && (result.startsWith('Error') || result.startsWith('Failed'))) {
            toast('Wallpaper error: ' + result, 'error');
        } else {
            notify('Wallpaper placed', 'success');
        }
    } catch(err) { toast('Wallpaper error: ' + err.message, 'error'); }
}

// ⚡ FIX: Uses DocumentFragment for wallpaper card batch insert
async function processWallpaperFolder(uiFolder, hrFolder, displayName, token, existingFolderId = null) {
    if (wallpaperGrid.querySelector('.placeholder-text, .empty-state')) wallpaperGrid.innerHTML = "";
    const folderId = existingFolderId || ("wpFld_" + displayName.replace(/[^a-zA-Z0-9]/g, '_') + Date.now());
    activeWallpaperFolders.add(folderId);
    if (existingFolderId) Array.from(wallpaperGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());

    const entries = await uiFolder.getEntries();
    const imgs = entries.filter(e => e.isFile && e.name.match(/\.(jpg|jpeg|png|tif)$/i));
    imgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const frag = document.createDocumentFragment();
    imgs.forEach((file) => {
        const baseName = file.name.replace(/\.[^/.]+$/, "").toLowerCase();
        const safeId = "wp_" + (displayName + "_" + file.name).replace(/[^a-zA-Z0-9]/g, '_');
        wallpaperCache[safeId] = { proxy: file, hrFolder: hrFolder, baseName: baseName };
        const card = document.createElement("div"); card.className = "wp-card"; card.dataset.folderId = folderId;
        const img = document.createElement("img"); img.src = file.url;
        const label = document.createElement("div"); label.className = "label"; label.innerText = file.name.substring(0, 15);
        card.appendChild(img); card.appendChild(label);
        card.ondblclick = () => placeWallpaper(safeId);
        frag.appendChild(card);
    });
    wallpaperGrid.appendChild(frag); // ⚡ Single insertion

    if (!existingFolderId) {
        const pnl = document.getElementById("wpFolderPanel");
        const { row, checkbox } = createFolderRow(displayName, folderId, token);
        checkbox.onchange = (e) => { if (e.target.checked) activeWallpaperFolders.add(folderId); else activeWallpaperFolders.delete(folderId); Array.from(wallpaperGrid.querySelectorAll('.wp-card')).forEach(c => { if (c.dataset.folderId === folderId) c.style.display = e.target.checked ? "inline-block" : "none"; }); };
        pnl.appendChild(row);
    }
}

const btnLoadWallpapers = document.getElementById("btnLoadWallpapers");
if (btnLoadWallpapers) {
    btnLoadWallpapers.addEventListener("click", async () => {
        const folder = await fs.getFolder(); if (!folder) return;
        if (folder.name.toLowerCase() === "_thumbnails") {
            return app.showAlert("🛑 UXP SANDBOX BLOCK!\n\nYou selected the '_Thumbnails' folder directly. Please select the MASTER FOLDER instead.");
        }
        setStatus("Scanning Wallpapers…");
        await new Promise(resolve => setTimeout(resolve, 50));
        let uiFolder = folder, hrFolder = null, displayName = folder.name;
        let wpThumb = null;
        try {
            const tf = await folder.getEntry("_Thumbnails");
            if (tf && tf.isFolder) wpThumb = tf;
        } catch (e) { /* no _Thumbnails yet */ }
        if (!wpThumb) {
            try {
                setStatus("First load — generating wallpaper thumbnails (faster next time)…");
                const genRes = await require('electron').ipcRenderer.invoke('thumbnails-generate', folder.nativePath);
                if (genRes && genRes.ok && genRes.processed > 0) {
                    try { const tf2 = await folder.getEntry("_Thumbnails"); if (tf2 && tf2.isFolder) wpThumb = tf2; } catch (e2) {}
                }
            } catch (genErr) { console.error('Auto wallpaper thumbnail generation failed:', genErr); }
        }
        if (wpThumb) { uiFolder = wpThumb; hrFolder = folder; toast('Smart Wallpaper Load active — high-res master folder linked', 'info'); }
        const token = await fs.createPersistentToken(folder);
        if (!projectData.wallpaperTokens.includes(token)) projectData.wallpaperTokens.push(token);
        await processWallpaperFolder(uiFolder, hrFolder, displayName, token);
        saveStateToStorage();
    });
}

// ==========================================
// --- 11. TAB 3: PNG FRAMES & MASKED ---
// ==========================================
async function placePngFrame(pngId) {
    const fileObj = pngCache[pngId]; if (!fileObj) return;
    try {
        setStatus('Placing PNG frame…');
        const layerName = fileObj.name.replace(/\.[^/.]+$/, '');
        const result = await require('electron').ipcRenderer.invoke('place-png-frame', fileObj.nativePath, layerName);
        if (result && result.startsWith('Failed')) toast('PNG error: ' + result, 'error');
        else notify('PNG frame placed', 'success');
    } catch(err) { toast('PNG placement error: ' + err.message, 'error'); }
}

// ⚡ FIX: DocumentFragment for PNG cards
async function processPngFolder(folder, token, existingFolderId = null) {
    if (pngGrid.querySelector('.placeholder-text, .empty-state')) pngGrid.innerHTML = "";
    const displayName = getDisplayName(folder);
    const folderId = existingFolderId || ("pngFld_" + displayName.replace(/[^a-zA-Z0-9]/g, '_') + Date.now());
    activePngFolders.add(folderId);
    if (existingFolderId) Array.from(pngGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());

    const entries = await folder.getEntries();
    const imgs = entries.filter(e => e.isFile && e.name.match(/\.(png)$/i));
    imgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const frag = document.createDocumentFragment();
    imgs.forEach((file) => {
        const safeId = "png_" + (displayName + "_" + file.name).replace(/[^a-zA-Z0-9]/g, '_'); pngCache[safeId] = file;
        const card = document.createElement("div"); card.className = "wp-card"; card.dataset.folderId = folderId;
        const img = document.createElement("img"); img.src = file.url;
        const label = document.createElement("div"); label.className = "label"; label.innerText = file.name.substring(0, 15);
        card.appendChild(img); card.appendChild(label);
        card.ondblclick = () => placePngFrame(safeId);
        frag.appendChild(card);
    });
    pngGrid.appendChild(frag); // ⚡

    if (!existingFolderId) {
        const pnl = document.getElementById("pngFolderPanel");
        const { row, checkbox } = createFolderRow(displayName, folderId, token);
        checkbox.onchange = (e) => { if (e.target.checked) activePngFolders.add(folderId); else activePngFolders.delete(folderId); Array.from(pngGrid.querySelectorAll('.wp-card')).forEach(c => { if (c.dataset.folderId === folderId) c.style.display = e.target.checked ? "inline-block" : "none"; }); };
        pnl.appendChild(row);
    }
}
const btnLoadPng = document.getElementById("btnLoadPng");
if (btnLoadPng) { btnLoadPng.addEventListener("click", async () => { const folder = await fs.getFolder(); if (!folder) return; const token = await fs.createPersistentToken(folder); if (!projectData.pngTokens.includes(token)) projectData.pngTokens.push(token); await processPngFolder(folder, token); saveStateToStorage(); }); }

async function placeMaskedFrame(maskId) {
    const fileObj = maskedCache[maskId]; if (!fileObj) return;
    try {
        setStatus('Placing masked frame…');
        const layerName = 'MaskBase_' + fileObj.name.replace(/\.[^/.]+$/, '');
        const isJpg = !!fileObj.name.match(/\.(jpg|jpeg)$/i);
        const result = await require('electron').ipcRenderer.invoke('place-masked-frame', fileObj.nativePath, layerName, isJpg);
        if (result && result.startsWith('Failed')) toast('Mask error: ' + result, 'error');
        else notify('Masked frame placed', 'success');
    } catch(err) { toast('Mask generation error: ' + err.message, 'error'); }
}

// ⚡ FIX: DocumentFragment for masked cards
async function processMaskedFolder(folder, token, existingFolderId = null) {
    if (maskedGrid.querySelector('.placeholder-text, .empty-state')) maskedGrid.innerHTML = "";
    const displayName = getDisplayName(folder);
    const folderId = existingFolderId || ("maskFld_" + displayName.replace(/[^a-zA-Z0-9]/g, '_') + Date.now());
    activeMaskedFolders.add(folderId);
    if (existingFolderId) Array.from(maskedGrid.querySelectorAll(`.wp-card[data-folder-id="${folderId}"]`)).forEach(el => el.remove());

    const entries = await folder.getEntries();
    const imgs = entries.filter(e => e.isFile && e.name.match(/\.(jpg|jpeg|png)$/i));
    imgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const frag = document.createDocumentFragment();
    imgs.forEach((file) => {
        const safeId = "mask_" + (displayName + "_" + file.name).replace(/[^a-zA-Z0-9]/g, '_'); maskedCache[safeId] = file;
        const card = document.createElement("div"); card.className = "wp-card"; card.dataset.folderId = folderId;
        const img = document.createElement("img"); img.src = file.url;
        const label = document.createElement("div"); label.className = "label"; label.innerText = file.name.substring(0, 15);
        card.appendChild(img); card.appendChild(label);
        card.ondblclick = () => placeMaskedFrame(safeId);
        frag.appendChild(card);
    });
    maskedGrid.appendChild(frag); // ⚡

    if (!existingFolderId) {
        const pnl = document.getElementById("maskedFolderPanel");
        const { row, checkbox } = createFolderRow(displayName, folderId, token);
        checkbox.onchange = (e) => { if (e.target.checked) activeMaskedFolders.add(folderId); else activeMaskedFolders.delete(folderId); Array.from(maskedGrid.querySelectorAll('.wp-card')).forEach(c => { if (c.dataset.folderId === folderId) c.style.display = e.target.checked ? "inline-block" : "none"; }); };
        pnl.appendChild(row);
    }
}
const btnLoadMasked = document.getElementById("btnLoadMasked");
if (btnLoadMasked) { btnLoadMasked.addEventListener("click", async () => { const folder = await fs.getFolder(); if (!folder) return; const token = await fs.createPersistentToken(folder); if (!projectData.maskTokens.includes(token)) projectData.maskTokens.push(token); await processMaskedFolder(folder, token); saveStateToStorage(); }); }

// ==========================================
// --- 12. TAB 5: TOOLS (SWAP & THUMBS) ---
// ==========================================
const btnSwapImages = document.getElementById("btnSwapImages");
if (btnSwapImages) {
    btnSwapImages.addEventListener("click", async () => {
        try {
            setStatus('Swapping images…');
            const result = await require('electron').ipcRenderer.invoke('swap-images');
            if (result && result.startsWith('ALERT:')) {
                app.showAlert(result.replace('ALERT:', ''));
            } else if (result && result.startsWith('ERROR:')) {
                toast('Swap error: ' + result.replace('ERROR:', ''), 'error');
            } else {
                notify('Swap complete', 'success');
            }
        } catch(err) { toast('Swap error: ' + err.message, 'error'); }
    });
}

// J1 toggle: editable adjustment layers on render (experimental, persisted).
const chkAdjLayers = document.getElementById('chkAdjLayers');
if (chkAdjLayers) {
    chkAdjLayers.checked = _useAdjLayers;
    chkAdjLayers.addEventListener('change', () => {
        _useAdjLayers = chkAdjLayers.checked;
        try { localStorage.setItem('adt_adj_layers', _useAdjLayers ? '1' : '0'); } catch (_) {}
        toast(_useAdjLayers
            ? 'Renders will use editable adjustment layers (experimental)'
            : 'Renders will bake colour into pixels (exact preview match)', 'info');
    });
}

const btnGenerateThumbs = document.getElementById("btnGenerateThumbs");
if (btnGenerateThumbs) {
    const ipcT = require('electron').ipcRenderer;
    // Live progress from both lanes (fast sharp + RAW Photoshop).
    ipcT.on('thumbs-progress', (_e, p) => {
        const laneLabel = p.lane === 'raw' ? 'RAW' : 'fast';
        if (p.total > 0) setStatus(`Thumbnails (${laneLabel}) ${p.done}/${p.total}…`);
    });
    btnGenerateThumbs.addEventListener("click", async () => {
        try {
            const folder = await fs.getFolder();
            if (!folder) return;
            btnGenerateThumbs.disabled = true;
            setStatus('Generating thumbnails…');
            const res = await ipcT.invoke('thumbnails-generate', folder.nativePath);
            if (!res?.ok) {
                toast('Thumbnail error: ' + (res?.error || 'unknown'), 'error');
                return;
            }
            const secs = (res.durationMs / 1000).toFixed(1);
            const parts = [`${res.fastProcessed} fast`];
            if (res.rawTotal > 0) parts.push(`${res.rawProcessed} RAW`);
            if (res.failed) parts.push(`${res.failed} failed`);
            notify(`Thumbnails done · ${parts.join(' · ')} in ${secs}s`,
                res.failed ? 'warning' : 'success', { duration: 6000 });
            if (res.failed && res.errors?.length) {
                for (const msg of res.errors.slice(0, 3)) toast('Thumbnail: ' + msg, 'error', { duration: 8000 });
            }
        } catch(err) {
            toast("Thumbnail error: " + err.message, 'error');
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
const btnJpegExport = document.getElementById('btnJpegExport');
const jpegProgressEl  = document.getElementById('jpegProgress');
const jpegProgressFill = document.getElementById('jpegProgressFill');
const jpegProgressText = document.getElementById('jpegProgressText');
const jpegStatusEl    = document.getElementById('jpegExportStatus');

if (btnJpegExport) {
    const ipc = require('electron').ipcRenderer;

    // Single delegated progress listener — registered once at module load
    // so the renderer never accumulates duplicate listeners across runs.
    ipc.on('jpeg-export-progress', (_e, p) => {
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
            const folder = await fs.getFolder();
            if (!folder) return;
            btnJpegExport.disabled = true;
            jpegProgressEl.style.display = 'flex';
            if (jpegProgressFill) jpegProgressFill.style.width = '0%';
            if (jpegProgressText) jpegProgressText.textContent = 'Starting…';
            if (jpegStatusEl) jpegStatusEl.textContent = 'Scanning PSDs…';
            setStatus('Exporting JPEGs from ' + folder.name + '…');

            const res = await ipc.invoke('jpeg-export', folder.nativePath);
            if (!res?.ok) {
                toast('JPEG export failed: ' + (res?.error || 'unknown'), 'error');
                if (jpegStatusEl) jpegStatusEl.textContent = 'Failed';
                return;
            }
            if (res.total === 0) {
                toast('No PSDs found in that folder', 'info');
                if (jpegStatusEl) jpegStatusEl.textContent = 'No PSDs found';
                jpegProgressEl.style.display = 'none';
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
            notify(summary, res.failed ? 'warning' : 'success', { duration: 6000 });

            // If any PSDs failed, surface the first few error messages so
            // the user knows what to look at instead of just a count.
            if (res.failed && res.errors?.length) {
                for (const msg of res.errors.slice(0, 3)) {
                    toast('JPEG export error: ' + msg, 'error', { duration: 8000 });
                }
            }

            // Open the parent folder in Finder so the new JPEG-High-Res /
            // JPEG-Low-Res folders are immediately visible.
            try {
                const parent = res.hiResFolder.replace(/\/JPEG-High-Res$/, '');
                await ipc.invoke('open-external', 'file://' + parent);
            } catch (_) {}
        } catch (e) {
            toast('JPEG export error: ' + e.message, 'error');
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
const btnResizePsds = document.getElementById('btnResizePsds');
const resizeProgressEl = document.getElementById('resizeProgress');
const resizeProgressFill = document.getElementById('resizeProgressFill');
const resizeProgressText = document.getElementById('resizeProgressText');
const resizeStatusEl = document.getElementById('resizeStatus');
if (btnResizePsds) {
    const ipc = require('electron').ipcRenderer;
    ipc.on('resize-psds-progress', (_e, p) => {
        if (!resizeProgressEl) return;
        resizeProgressEl.style.display = 'flex';
        const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
        if (resizeProgressFill) resizeProgressFill.style.width = pct + '%';
        if (resizeProgressText) resizeProgressText.textContent = `${p.done}/${p.total}`;
        if (resizeStatusEl) resizeStatusEl.textContent = p.current ? `Now: ${p.current}` : '';
    });

    btnResizePsds.addEventListener('click', async () => {
        try {
            const folder = await fs.getFolder();
            if (!folder) return;
            const overwrite = !!document.getElementById('chkResizeOverwrite')?.checked;
            if (overwrite) {
                const ok = confirm('Overwrite the original PSDs in "' + folder.name + '"?\n\nThis replaces each file in place. Turn the toggle off to save copies into a Resized/ subfolder instead.');
                if (!ok) return;
            }
            btnResizePsds.disabled = true;
            resizeProgressEl.style.display = 'flex';
            if (resizeProgressFill) resizeProgressFill.style.width = '0%';
            if (resizeProgressText) resizeProgressText.textContent = 'Starting…';
            if (resizeStatusEl) resizeStatusEl.textContent = 'Scanning PSDs…';
            setStatus('Resizing PSDs in ' + folder.name + '…');

            const res = await ipc.invoke('resize-psds', folder.nativePath, overwrite ? 'overwrite' : 'copy');
            if (!res?.ok) {
                toast('PSD resize failed: ' + (res?.error || 'unknown'), 'error');
                if (resizeStatusEl) resizeStatusEl.textContent = 'Failed';
                return;
            }
            if (res.total === 0) {
                toast('No PSDs found in that folder', 'info');
                if (resizeStatusEl) resizeStatusEl.textContent = 'No PSDs found';
                resizeProgressEl.style.display = 'none';
                return;
            }
            if (resizeProgressFill) resizeProgressFill.style.width = '100%';
            if (resizeProgressText) resizeProgressText.textContent = `${res.processed}/${res.total}`;
            const seconds = (res.durationMs / 1000).toFixed(1);
            const dest = overwrite ? 'overwritten in place' : 'saved to Resized/';
            const summary = `Resized ${res.processed} of ${res.total} (${dest})` +
                (res.failed ? ` · ${res.failed} failed` : '') + ` in ${seconds}s`;
            if (resizeStatusEl) resizeStatusEl.textContent = summary;
            notify(summary, res.failed ? 'warning' : 'success', { duration: 6000 });
            if (res.failed && res.errors?.length) {
                for (const msg of res.errors.slice(0, 3)) toast('Resize error: ' + msg, 'error', { duration: 8000 });
            }
        } catch (e) {
            toast('PSD resize error: ' + e.message, 'error');
        } finally {
            btnResizePsds.disabled = false;
            setTimeout(() => { if (resizeProgressEl) resizeProgressEl.style.display = 'none'; }, 5000);
        }
    });
}

// ─── FLOATING TOOLS BAR LAUNCHER ─────────────────────────────
// Opens (or focuses) the thin frameless window that docks itself to
// Photoshop's bottom edge. Status pill on the card mirrors open/closed.
const btnOpenToolsBar = document.getElementById('btnOpenToolsBar');
const toolsBarStatusEl = document.getElementById('toolsBarStatus');

async function refreshToolsBarStatus() {
    if (!toolsBarStatusEl) return;
    try {
        const ipc = require('electron').ipcRenderer;
        const r = await ipc.invoke('tools-bar-status');
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
        const ipc = require('electron').ipcRenderer;
        const r = await ipc.invoke('tools-bar-open');
        if (!r?.ok) {
            toast('Could not open Tools Bar: ' + (r?.error || 'unknown'), 'error');
            return;
        }
        notify('Tools Bar attached to Photoshop', 'success', { duration: 4000 });
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
        const ipc = require('electron').ipcRenderer;
        try {
            const r = await ipc.invoke('renamer-open');
            if (!r?.ok) {
                toast('Could not open Renamer: ' + (r?.error || 'unknown'), 'error');
            }
        } catch (e) {
            toast('Could not open Renamer: ' + (e.message || e), 'error');
        }
    });
}


// Generative templates are virtual layouts (no PSD on disk). They appear in
// the same template grid as PSD-backed entries and are flagged with
// `_generative: true` so the export queue can route them through the JS-only
// HR composite pipeline instead of Photoshop. Loading is idempotent — toggling
// the checkbox off removes them from templateLibrary, on re-adds them.
const _GENERATIVE_FOLDER_ID = '__generative__';
let _generativeLoaded = false;

async function loadGenerativeTemplates() {
    if (_generativeLoaded) return;
    const ipc = require('electron').ipcRenderer;
    const res = await ipc.invoke('generative-catalog');
    if (!res?.ok) { toast('Could not load generative templates: ' + (res?.error || ''), 'error'); return; }

    // Each generative template gets a fake folderId so it shows up in the
    // existing folder filter logic, plus a flag the export queue picks up.
    activeTemplateFolders.add(_GENERATIVE_FOLDER_ID);
    const wrapped = res.templates.map(t => ({
        id: t.id,
        folderId: _GENERATIVE_FOLDER_ID,
        name: t.name,
        // No `file` property — that's how downstream code knows this is virtual.
        h: t.h,
        v: t.v,
        url: '', // we'll build a synthetic preview tile via CSS
        _generative: true,
        _spec: { generator: t.generator, params: t.params },
        // Pre-bake frames + canvas so the proof renderer doesn't need to
        // round-trip through Photoshop frame extraction.
        _frames: t.frames,
        _canvas: { w: t.canvasWidth, h: t.canvasHeight },
    }));
    templateLibrary = templateLibrary.concat(wrapped);
    _generativeLoaded = true;

    const status = document.getElementById('generativeStatus');
    if (status) status.textContent = `${wrapped.length} layouts available in template grid`;
    scheduleFilterUpdate();
}

function unloadGenerativeTemplates() {
    if (!_generativeLoaded) return;
    templateLibrary = templateLibrary.filter(t => t.folderId !== _GENERATIVE_FOLDER_ID);
    activeTemplateFolders.delete(_GENERATIVE_FOLDER_ID);
    _generativeLoaded = false;
    const status = document.getElementById('generativeStatus');
    if (status) status.textContent = '';
    scheduleFilterUpdate();
}

const chkGenerativeTemplates = document.getElementById('chkGenerativeTemplates');
if (chkGenerativeTemplates) {
    chkGenerativeTemplates.addEventListener('change', (e) => {
        if (e.target.checked) loadGenerativeTemplates();
        else unloadGenerativeTemplates();
    });
}

// ─── Generative-aware proof rendering ─────────────────────────────────────
// `ensureTemplateFrames` already short-circuits for templates with pre-baked
// frames (which generative templates always have), so proofs Just Work. The
// only remaining piece is HR rendering — see the IPC interceptor below.

// ─── Generative-aware HR rendering ────────────────────────────────────────
// The render queue's worker calls IPC `build-pages-batch` for every chunk.
// We monkey-patch ipcRenderer.invoke for that one channel so generative pages
// get diverted to the JS-only HR composite, while PSD-backed pages flow
// through the existing Photoshop bridge unchanged.
;(function _interceptHrRenderForGenerative() {
    const ipc = require('electron').ipcRenderer;
    const realInvoke = ipc.invoke.bind(ipc);
    ipc.invoke = async function (channel, ...args) {
        if (channel !== 'build-pages-batch' && channel !== 'build-page') {
            return realInvoke(channel, ...args);
        }
        // Inspect the payload — if its templatePath references a generative
        // template, dispatch it to render-final-composite instead.
        const payload = args[0];
        const isBatch = channel === 'build-pages-batch';
        const pages = isBatch ? payload.pages : [payload];
        const tpl = _findTemplateByPath(payload.templatePath);
        if (!tpl?._generative) {
            return realInvoke(channel, ...args);
        }

        // Run each page through the HR composite. Sequential so libvips
        // doesn't oversaturate memory.
        let successes = 0, failures = 0;
        for (const p of pages) {
            const rawPhotos = p.photos || payload.photos || [];
            // Carry per-photo adjustments into the libvips final composite so
            // the delivered output matches the live preview.
            const photos = rawPhotos.map(ph => (
                ph && ph.id && projectData.imageAdjustments?.[ph.id]
                    ? { ...ph, adjust: projectData.imageAdjustments[ph.id] }
                    : ph
            ));
            const outDir = isBatch ? payload.outputPath : null;
            const pageName = isBatch ? p.pageName : payload.pageName;
            const outputPath = (outDir
                ? outDir + '/Page_' + pageName + '.jpg'
                : (payload.outputPath || (require('os').tmpdir() + '/Page_' + pageName + '.jpg'))
            );
            const job = {
                templatePath: 'generative://' + tpl.id,
                templatePreviewPath: null, // no backdrop — fully synthesized
                frames: tpl._frames,
                canvasWidth: tpl._canvas.w,
                canvasHeight: tpl._canvas.h,
                photos,
                outputPath,
                smartCrop: false, // HR exports stay deterministic
            };
            const r = await realInvoke('render-final-composite', job);
            if (r?.ok) successes++; else failures++;
        }
        return `OK ${successes}/${successes + failures}`;
    };
})();

function _findTemplateByPath(p) {
    if (!p) return null;
    return templateLibrary.find(t =>
        (t._generative && p.startsWith && p.startsWith('generative://') && p.endsWith(t.id)) ||
        (t.file?.nativePath === p)
    ) || null;
}

// ==========================================
// --- TIER 3: PHOTO CURATION ---
// ==========================================
// Drop a folder, get a curated subset. Three-step UX:
//   1. ANALYZE — extracts features (sharpness, exposure, perceptual hash) for
//      every photo. Streams progress.
//   2. APPLY  — slide thresholds, see live counts of kept / dropped / dups.
//   3. EXPORT — copies keepers to <folder>/_Selected.

const _curationState = {
    folderPath: null,    // absolute path of last analyzed folder
    features: null,      // last analysis result
    lastCurate: null,    // last curate() result for export
};

const _curateBtnAnalyze = document.getElementById('btnCurateAnalyze');
const _curateControls = document.getElementById('curateControls');
const _curateStatus = document.getElementById('curateStatus');
const _curateSummary = document.getElementById('curateSummary');
const _curateBtnApply = document.getElementById('btnCurateApply');
const _curateBtnExport = document.getElementById('btnCurateExport');

function _curateOpts() {
    const sharpness = parseInt(document.getElementById('curateSharpness').value, 10);
    const exposure = parseInt(document.getElementById('curateExposure').value, 10) / 100;
    const dup = parseInt(document.getElementById('curateDup').value, 10);
    const targetH = parseInt(document.getElementById('curateTargetH').value, 10);
    const targetV = parseInt(document.getElementById('curateTargetV').value, 10);
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
    const el = document.getElementById(id);
    if (!el) return;
    const lbl = document.getElementById(id + 'Val');
    el.addEventListener('input', () => {
        if (id === 'curateExposure') lbl.textContent = (el.value / 100).toFixed(2);
        else lbl.textContent = el.value;
    });
});

if (_curateBtnAnalyze) {
    _curateBtnAnalyze.addEventListener('click', async () => {
        try {
            const folder = await fs.getFolder();
            if (!folder) return;
            _curationState.folderPath = folder.nativePath;
            _curateBtnAnalyze.disabled = true;
            _curateStatus.textContent = 'Analyzing…';
            const ipc = require('electron').ipcRenderer;

            // Subscribe to progress events from main.
            const onProgress = (_e, p) => {
                _curateStatus.textContent = `Analyzing ${p.done}/${p.total}…`;
            };
            ipc.on('curation-progress', onProgress);

            const t0 = performance.now();
            const res = await ipc.invoke('curation-analyze', folder.nativePath);
            ipc.removeListener('curation-progress', onProgress);
            if (!res?.ok) {
                _curateStatus.textContent = 'Analysis failed: ' + (res?.error || 'unknown');
                return;
            }
            _curationState.features = res.features;
            const ms = Math.round(performance.now() - t0);
            _curateStatus.textContent = `Analyzed ${res.features.length} photos in ${(ms / 1000).toFixed(1)}s`;
            _curateControls.style.display = 'flex';
            await _runCurate();
        } catch (e) {
            _curateStatus.textContent = 'Error: ' + e.message;
        } finally {
            _curateBtnAnalyze.disabled = false;
        }
    });
}

async function _runCurate() {
    if (!_curationState.features) return;
    const ipc = require('electron').ipcRenderer;
    const res = await ipc.invoke('curation-curate', _curationState.features, _curateOpts());
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
        const ipc = require('electron').ipcRenderer;
        const res = await ipc.invoke(
            'curation-export',
            _curationState.lastCurate.keepers,
            _curationState.folderPath
        );
        _curateBtnExport.disabled = false;
        if (!res?.ok) {
            toast('Export failed: ' + (res?.error || 'unknown'), 'error');
            return;
        }
        notify(`Copied ${res.copied} photos → ${res.dest.split('/').pop()}/`, 'success', { duration: 6000 });
        await ipc.invoke('open-external', 'file://' + res.dest);
    });
}

// ==========================================
// --- TIER 3.B: LIBRARY ---
// ==========================================
// Persistent per-user library of templates / wallpapers / pngs / masks /
// saved layouts. The library lives outside any single project so the user
// can drop their go-to assets in once and pull them into every new wedding.
//
// "Save current layout" snapshots the current album's structural shape
// (which template each page uses + photo orientation slot counts) without
// the actual photos, so the same layout can be replayed on a new shoot.

async function refreshLibraryView() {
    const ipc = require('electron').ipcRenderer;
    const res = await ipc.invoke('library-list');
    const view = document.getElementById('libraryView');
    if (!view) return;
    if (!res?.ok) { view.innerHTML = `<span class="u-text-secondary">Library unavailable</span>`; return; }
    const lib = res.library;
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
        btn.addEventListener('click', () => _applyLibraryItem(btn.dataset.kind, btn.dataset.name, btn.dataset.file));
    });
    view.querySelectorAll('.lib-chip__remove').forEach(btn => {
        btn.addEventListener('click', () => _removeLibraryItem(btn.dataset.kind, btn.dataset.name, btn.dataset.file));
    });
}

async function _applyLibraryItem(kind, name, file) {
    const ipc = require('electron').ipcRenderer;
    if (kind === 'layouts') {
        const res = await ipc.invoke('library-load-layout', file);
        if (!res?.ok) { toast('Failed to load layout: ' + (res?.error || ''), 'error'); return; }
        await applySavedLayout(res.data);
        return;
    }
    // For asset kinds, we re-run the existing folder-loader against the
    // library set folder. The user gets exactly the same result as if they
    // had picked the folder via the OS dialog.
    const libRes = await ipc.invoke('library-list');
    if (!libRes?.ok) return;
    const item = (libRes.library[kind] || []).find(s => s.name === name);
    if (!item?.path) { toast('Library set not found', 'error'); return; }

    const folder = await fs.getEntryWithUrl?.(item.path);
    // The UXP stub doesn't expose getEntryWithUrl directly; instead we
    // invoke the same processor functions used by the load buttons but with
    // a synthesized folder object that exposes nativePath + name + getEntries.
    const synthFolder = await _syntheticFolder(item.path);
    if (!synthFolder) { toast('Could not read library folder', 'error'); return; }

    if (kind === 'templates' && typeof processTemplateFolder === 'function') {
        await processTemplateFolder(synthFolder, null);
        notify(`Loaded template set: ${name}`, 'success');
    } else if (kind === 'wallpapers' && typeof processWallpaperFolder === 'function') {
        await processWallpaperFolder(synthFolder, null, name, null);
        notify(`Loaded wallpaper set: ${name}`, 'success');
    } else if (kind === 'pngs' && typeof processPngFolder === 'function') {
        await processPngFolder(synthFolder, null);
        notify(`Loaded PNG set: ${name}`, 'success');
    } else if (kind === 'masks' && typeof processMaskedFolder === 'function') {
        await processMaskedFolder(synthFolder, null);
        notify(`Loaded mask set: ${name}`, 'success');
    } else {
        toast(`Don't know how to apply kind: ${kind}`, 'error');
    }
    folder; // silence unused
}

async function _syntheticFolder(absPath) {
    // Build a UXP-Folder-shaped object backed by node fs. Lets the existing
    // processXFolder() functions consume library content without changes.
    const nodefs = require('fs');
    const nodepath = require('path');
    if (!nodefs.existsSync(absPath)) return null;
    const stat = nodefs.statSync(absPath);
    if (!stat.isDirectory()) return null;

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
            const out = [];
            const walk = (dir) => {
                for (const e of nodefs.readdirSync(dir, { withFileTypes: true })) {
                    const p = nodepath.join(dir, e.name);
                    if (e.isFile()) out.push(fileEntry(p));
                }
            };
            walk(absPath);
            return out;
        },
        async getEntry(name) {
            const p = nodepath.join(absPath, name);
            if (!nodefs.existsSync(p)) throw new Error('not found');
            const s = nodefs.statSync(p);
            if (s.isDirectory()) return _syntheticFolder(p);
            return fileEntry(p);
        },
    };
}

async function _removeLibraryItem(kind, name, file) {
    if (!confirm(`Remove "${name}" from library?`)) return;
    const ipc = require('electron').ipcRenderer;
    const res = kind === 'layouts'
        ? await ipc.invoke('library-delete-layout', file)
        : await ipc.invoke('library-remove', kind, name);
    if (!res?.ok) { toast('Remove failed: ' + (res?.error || ''), 'error'); return; }
    notify(`Removed ${name}`, 'success');
    refreshLibraryView();
}

async function _addToLibrary(kind) {
    const folder = await fs.getFolder();
    if (!folder) return;
    const setName = prompt(`Library set name for "${folder.name}":`, folder.name);
    if (!setName) return;
    const ipc = require('electron').ipcRenderer;
    const res = await ipc.invoke('library-add', kind, setName, folder.nativePath);
    if (!res?.ok) { toast('Add failed: ' + (res?.error || ''), 'error'); return; }
    notify(`Added "${setName}" to library`, 'success');
    refreshLibraryView();
}

document.getElementById('btnLibraryRefresh')?.addEventListener('click', refreshLibraryView);
document.getElementById('btnLibraryAddTemplates')?.addEventListener('click', () => _addToLibrary('templates'));
document.getElementById('btnLibraryAddWallpapers')?.addEventListener('click', () => _addToLibrary('wallpapers'));
document.getElementById('btnLibraryAddPngs')?.addEventListener('click', () => _addToLibrary('pngs'));
document.getElementById('btnLibraryAddMasks')?.addEventListener('click', () => _addToLibrary('masks'));

document.getElementById('btnOpenLibraryFolder')?.addEventListener('click', async () => {
    const ipc = require('electron').ipcRenderer;
    const res = await ipc.invoke('library-list');
    if (res?.ok) await ipc.invoke('open-external', 'file://' + res.dir);
});

document.getElementById('btnSaveLayout')?.addEventListener('click', async () => {
    const name = prompt('Save current layout as:', `Standard ${Object.keys(albumPages).length}pg`);
    if (!name) return;
    const layout = serializeCurrentLayout(name);
    const ipc = require('electron').ipcRenderer;
    const res = await ipc.invoke('library-save-layout', name, layout);
    if (!res?.ok) { toast('Save layout failed: ' + (res?.error || ''), 'error'); return; }
    notify(`Layout "${name}" saved`, 'success');
    refreshLibraryView();
});

function serializeCurrentLayout(name) {
    // Strip per-photo identity. Keep template selection + slot orientations
    // so the layout can be re-applied to a different photo folder.
    const pages = {};
    for (const [pageNum, page] of Object.entries(albumPages)) {
        if (!page?.template) continue;
        pages[pageNum] = {
            templateId: page.template.id,
            generative: !!page.template._generative,
            spec: page.template._spec || null, // for generative templates
            templateName: page.template.name,
            templateH: page.template.h,
            templateV: page.template.v,
            photoSlots: (page.photos || []).map(p => ({ orient: p.orient })),
        };
    }
    return { name, pages, totalActivePages };
}

async function applySavedLayout(layoutData) {
    if (!layoutData?.pages) { toast('Layout file is empty', 'error'); return; }

    // Re-attach template references. PSD-backed templates are matched by id
    // against the currently loaded library; generative templates are
    // re-created from their spec.
    let attached = 0, missing = 0;
    const newAlbumPages = {};
    for (const [pageNum, p] of Object.entries(layoutData.pages)) {
        let tpl = null;
        if (p.generative && p.spec) {
            // Reconstruct via the generative regen IPC.
            const ipc = require('electron').ipcRenderer;
            const res = await ipc.invoke('generative-regen', p.spec);
            if (res?.ok) {
                tpl = {
                    id: res.template.id,
                    folderId: _GENERATIVE_FOLDER_ID,
                    name: res.template.name,
                    h: res.template.h,
                    v: res.template.v,
                    url: '',
                    _generative: true,
                    _spec: { generator: res.template.generator, params: res.template.params },
                    _frames: res.template.frames,
                    _canvas: { w: res.template.canvasWidth, h: res.template.canvasHeight },
                };
                if (!_generativeLoaded) await loadGenerativeTemplates();
            }
        } else {
            tpl = templateLibrary.find(t => t.id === p.templateId)
                || templateLibrary.find(t => t.name === p.templateName && t.h === p.templateH && t.v === p.templateV);
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

    if (typeof mutate === 'function') {
        mutate(`Apply layout · ${layoutData.name}`, () => {
            albumPages = newAlbumPages;
            totalActivePages = Math.max(layoutData.totalActivePages || Object.keys(newAlbumPages).length, 1);
        });
    } else {
        albumPages = newAlbumPages;
        totalActivePages = Math.max(layoutData.totalActivePages || Object.keys(newAlbumPages).length, 1);
    }

    rebuildPhotoPageMap();
    if (typeof updatePageDropdowns === 'function') updatePageDropdowns();
    if (typeof renderGreenBox === 'function') renderGreenBox();
    if (typeof scheduleFilterUpdate === 'function') scheduleFilterUpdate();
    if (typeof renderStoryboard === 'function') renderStoryboard();
    saveStateToStorage();

    notify(`Applied layout · ${attached} pages${missing ? ` · ${missing} missing` : ''}`,
        missing ? 'warning' : 'success', { duration: 6000 });
    if (missing) {
        toast(`${missing} pages couldn't find their template — re-load the matching template folder and try again.`, 'warning', { duration: 9000 });
    }
}

// ==========================================
// --- TIER 3.B: PLUGINS UI ---
// ==========================================
async function refreshPluginsView() {
    const ipc = require('electron').ipcRenderer;
    const res = await ipc.invoke('plugins-list');
    const view = document.getElementById('pluginsView');
    if (!view) return;
    if (!res?.ok) { view.innerHTML = `<span class="u-text-secondary">Plugins unavailable</span>`; return; }
    const list = res.plugins;
    if (list.length === 0) {
        view.innerHTML = `<div style="padding:8px 0;color:var(--txt-secondary);">
            No plugins installed. Drop a plugin folder into <code>${res.dir}</code> and click Refresh.
        </div>`;
        return;
    }
    view.innerHTML = `
        <table style="width:100%; border-collapse: collapse; font-size:12px;">
            <thead><tr style="text-align:left; border-bottom:1px solid var(--border-main);">
                <th style="padding:6px;">Plugin</th>
                <th style="padding:6px;">Hooks</th>
                <th style="padding:6px;">Source</th>
                <th style="padding:6px;">Status</th>
                <th style="padding:6px;"></th>
            </tr></thead>
            <tbody>
                ${list.map(p => `
                    <tr style="border-bottom:1px solid var(--border-main);">
                        <td style="padding:6px;"><strong>${p.id}</strong> <span class="u-text-secondary">v${p.manifest?.version || '?'}</span></td>
                        <td style="padding:6px;">${(p.manifest?.hooks || []).join(', ') || '—'}</td>
                        <td style="padding:6px;">${p.builtin ? 'built-in' : 'user'}</td>
                        <td style="padding:6px;">${p.error
                            ? `<span style="color:var(--btn-red-bg)">error: ${p.error}</span>`
                            : (p.disabled ? '<span class="u-text-secondary">disabled</span>' : '<span style="color:#4caf50;">active</span>')}</td>
                        <td style="padding:6px;">${p.builtin
                            ? '<span class="u-text-secondary">built-in</span>'
                            : `<button class="btn btn--ghost" data-plugin="${p.id}" data-enable="${p.disabled ? 'true' : 'false'}">${p.disabled ? 'Enable' : 'Disable'}</button>`}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
    view.querySelectorAll('button[data-plugin]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.plugin;
            const enable = btn.dataset.enable === 'true';
            const r = await ipc.invoke('plugins-set-enabled', id, enable);
            if (!r?.ok) { toast('Plugin toggle failed: ' + (r?.error || ''), 'error'); return; }
            refreshPluginsView();
        });
    });
}

document.getElementById('btnPluginsRefresh')?.addEventListener('click', async () => {
    const ipc = require('electron').ipcRenderer;
    await ipc.invoke('plugins-reload');
    refreshPluginsView();
});

document.getElementById('btnOpenPluginsFolder')?.addEventListener('click', async () => {
    const ipc = require('electron').ipcRenderer;
    const res = await ipc.invoke('plugins-list');
    if (res?.ok) await ipc.invoke('open-external', 'file://' + res.dir);
});

// First-paint of library + plugins panels when the user first visits Tab 5.
const _origToolsTabBtn = document.querySelector('.tab-btn[data-target="tab-tools"]');
if (_origToolsTabBtn) {
    let _toolsPainted = false;
    _origToolsTabBtn.addEventListener('click', () => {
        // Status pills should always reflect current state, even after the
        // first paint, so refresh tools-bar status on every visit.
        refreshToolsBarStatus();
        if (_toolsPainted) return;
        _toolsPainted = true;
        // Defer to next tick so the tab is visible first.
        setTimeout(() => { refreshLibraryView(); refreshPluginsView(); }, 50);
    });
}

// ==========================================
// --- 13. EXPORT & OUTPUT (TAB 1 FALLBACK) ---
// ==========================================
const btnOutput = document.getElementById("btnOutput");
if (btnOutput) {
    btnOutput.addEventListener("click", async () => {
        const folder = await fs.getFolder(); if (!folder) return;
        outputFolder = folder; projectData.outputToken = await fs.createPersistentToken(folder); saveStateToStorage();
        notify(`Output folder set: ${folder.name}`, 'success');
        const ftxt = document.getElementById("finalOutputText"); if(ftxt) ftxt.innerText = folder.name;
    });
}

function buildExportData(startPage, endPage) {
    // ⚡ Memoize HR folder scans: a 200-page album with 5 photos/page used to
    // do up to 1,000 sync readdirSync calls (one per photo) on the renderer
    // thread before the export even started. Now we do one per unique HR folder.
    const _hrDirCache = new Map();
    const nodefs = require('fs');
    const nodepath = require('path');
    function listHrDir(p) {
        if (!_hrDirCache.has(p)) {
            try { _hrDirCache.set(p, nodefs.readdirSync(p)); }
            catch (_) { _hrDirCache.set(p, []); }
        }
        return _hrDirCache.get(p);
    }

    const exportData = { outputPath: outputFolder.nativePath, pages: {} };
    for (let i = startPage; i <= endPage; i++) {
        const pageData = albumPages[i];
        if (!pageData || !pageData.template || pageData.photos.length === 0) continue;
        const photos = [];
        for (const photo of pageData.photos) {
            const cacheData = photoCache[photo.id];
            if (!cacheData) continue;
            let filePath = cacheData.file?.nativePath || cacheData.proxy?.nativePath || null;
            if (!filePath) continue;
            if (cacheData.hrFolder && cacheData.hrFolder.nativePath) {
                const files = listHrDir(cacheData.hrFolder.nativePath);
                const lower = cacheData.baseName.toLowerCase();
                const hrFile = files.find(f => f.toLowerCase().startsWith(lower));
                if (hrFile) filePath = nodepath.join(cacheData.hrFolder.nativePath, hrFile);
            }
            photos.push({
                filePath,
                orient: photo.orient,
                rotation: projectData.imageRotations?.[photo.id] || 0,
                baseName: cacheData.baseName || photo.id,
                id: photo.id,
                adjust: projectData.imageAdjustments?.[photo.id] || null,
                placement: projectData.imagePlacements?.[photo.id] || null,
            });
        }
        if (photos.length > 0) {
            // Generative templates have no PSD on disk. We synthesize a
            // sentinel templatePath that the IPC interceptor recognizes and
            // dispatches to the JS-only HR composite renderer.
            const templatePath = pageData.template._generative
                ? 'generative://' + pageData.template.id
                : pageData.template.file.nativePath;
            exportData.pages[i] = { templatePath, photos };
        }
    }
    return exportData;
}

// Bake per-photo adjustments into full-res copies before the Photoshop build,
// then point the export data at those copies. Closes the "edits round-trip to
// the final PSD" loop: PS places an already-adjusted file (same libvips math
// as the preview), so the delivered PSD matches the on-screen preview.
// Returns the number of baked photos. Baked files live in a dedicated temp
// dir that is wiped at the start of each export so they don't accumulate.
async function bakeExportAdjustments(exportData) {
    const ipc = require('electron').ipcRenderer;
    const nodepath = require('path');
    const nodeos = require('os');
    const outDir = nodepath.join(nodeos.tmpdir(), 'albumstudio_baked');
    // Wipe previous bake so temp files stay bounded.
    try { require('fs').rmSync(outDir, { recursive: true, force: true }); } catch (_) {}
    let baked = 0;
    for (const pageNum of Object.keys(exportData.pages)) {
        const page = exportData.pages[pageNum];
        // Generative pages render via the libvips final composite, which
        // applies `adjust` from the param directly — baking the source too
        // would double-apply. Only bake for PSD (Photoshop) pages.
        if (typeof page.templatePath === 'string' && page.templatePath.startsWith('generative://')) continue;
        for (const photo of page.photos) {
            if (!photo.adjust) continue;
            try {
                const r = await ipc.invoke('bake-adjusted-source', {
                    srcPath: photo.filePath,
                    adjust: photo.adjust,
                    outDir,
                });
                if (r?.ok && r.path) { photo.filePath = r.path; baked++; }
            } catch (_) { /* on failure, fall back to the unadjusted original */ }
        }
    }
    return baked;
}

// ─── RENDER QUEUE + DIRTY TRACKING ─────────────────────────────
// Ships render jobs to Photoshop one page at a time so the renderer thread
// stays responsive (the user can keep editing while pages render). Caches a
// hash of each page's inputs in localStorage so re-rendering an unchanged
// page is a no-op — this is the difference between "render took 4 minutes"
// and "render took 4 seconds" on iterative work where the user changes 5
// pages out of 200.

const _RENDER_HASH_KEY = 'adt_render_hashes';
let _renderHashes = (() => {
    try { return JSON.parse(localStorage.getItem(_RENDER_HASH_KEY) || '{}'); }
    catch (_) { return {}; }
})();
function _saveRenderHashes() {
    try { localStorage.setItem(_RENDER_HASH_KEY, JSON.stringify(_renderHashes)); }
    catch (_) {}
}
// _hashPage moved to src/renderer_pure.js (required at top).

const _renderQueue = []; // [{ pageNum, pageData, outputPath }]
let _renderActive = false;
let _renderStats = { total: 0, done: 0, skipped: 0, failed: 0, cancelled: false };

function _updateRenderBadge() {
    let badge = document.getElementById('renderBadge');
    if (!_renderQueue.length && !_renderActive) {
        if (badge) badge.remove();
        return;
    }
    if (!badge) {
        badge = document.createElement('div');
        badge.id = 'renderBadge';
        badge.className = 'render-badge';
        const exportTb = document.querySelector('#tab-export .export-toolbar');
        if (exportTb) exportTb.appendChild(badge);
        else document.body.appendChild(badge);
    }
    const remaining = _renderQueue.length + (_renderActive ? 1 : 0);
    const pct = _renderStats.total > 0
        ? Math.round((_renderStats.done + _renderStats.skipped) / _renderStats.total * 100)
        : 0;
    badge.innerHTML = `
        <div class="render-badge__bar"><div class="render-badge__fill" style="width:${pct}%"></div></div>
        <div class="render-badge__text">
            ${_renderStats.done + _renderStats.skipped} / ${_renderStats.total}
            ${_renderStats.skipped ? `· <span class="u-text-secondary">${_renderStats.skipped} cached</span>` : ''}
            ${_renderStats.failed ? `· <span style="color:var(--btn-red-bg)">${_renderStats.failed} failed</span>` : ''}
            <button class="render-badge__cancel" title="Cancel queue">×</button>
        </div>`;
    badge.querySelector('.render-badge__cancel').onclick = () => {
        _renderStats.cancelled = true;
        _renderQueue.length = 0;
    };
}

async function _renderWorker() {
    if (_renderActive) return; // one worker only — Photoshop is single-threaded
    _renderActive = true;
    while (_renderQueue.length > 0) {
        if (_renderStats.cancelled) break;

        // Chunk consecutive jobs that share a template path. The warm-process
        // batch JSX opens the template once for the whole chunk, saving the
        // ~1–4s app.open() cost per page when many pages share a template.
        const chunk = [_renderQueue.shift()];
        while (
            _renderQueue.length > 0 &&
            _renderQueue[0].pageData.templatePath === chunk[0].pageData.templatePath &&
            _renderQueue[0].outputPath === chunk[0].outputPath
        ) {
            chunk.push(_renderQueue.shift());
        }
        _updateRenderBadge();

        // Filter out pages whose hash matches the previous successful render.
        const fresh = [];
        for (const job of chunk) {
            const hash = _hashPage(job.pageData);
            const cacheKey = `${job.outputPath}|${job.pageNum}`;
            if (_renderHashes[cacheKey] === hash) {
                _renderStats.skipped++;
            } else {
                fresh.push({ ...job, hash, cacheKey });
            }
        }
        _updateRenderBadge();
        if (fresh.length === 0) continue;

        const tplName = (chunk[0].pageData.templatePath || '').split('/').pop();
        if (fresh.length === 1) {
            setStatus(`Rendering page ${fresh[0].pageNum}…`);
        } else {
            setStatus(`Rendering pages ${fresh[0].pageNum}–${fresh[fresh.length - 1].pageNum} (${tplName})…`);
        }

        try {
            await require('electron').ipcRenderer.invoke('build-pages-batch', {
                templatePath: chunk[0].pageData.templatePath,
                outputPath: chunk[0].outputPath,
                useAdjustmentLayers: _useAdjLayers,
                pages: fresh.map(j => ({
                    pageName: String(j.pageNum).padStart(3, '0'),
                    photos: j.pageData.photos
                }))
            });
            for (const j of fresh) {
                _renderHashes[j.cacheKey] = j.hash;
                _renderStats.done++;
            }
            _saveRenderHashes();
        } catch (err) {
            // Batch failed wholesale — fall back to per-page renders so we
            // don't lose the entire chunk to one bad page.
            for (const j of fresh) {
                if (_renderStats.cancelled) break;
                try {
                    await require('electron').ipcRenderer.invoke('build-page', {
                        templatePath: j.pageData.templatePath,
                        pageName: String(j.pageNum).padStart(3, '0'),
                        photos: j.pageData.photos,
                        useAdjustmentLayers: _useAdjLayers
                    });
                    _renderHashes[j.cacheKey] = j.hash;
                    _saveRenderHashes();
                    _renderStats.done++;
                } catch (e2) {
                    _renderStats.failed++;
                    toast(`Page ${j.pageNum} failed: ${e2.message}`, 'error');
                }
            }
            if (!_renderStats.cancelled) {
                console.warn('Batch render failed, fell back to per-page:', err.message);
            }
        }
        _updateRenderBadge();
    }
    _renderActive = false;
    _updateRenderBadge();

    if (_renderStats.cancelled) {
        notify(`Render cancelled (${_renderStats.done} of ${_renderStats.total} done)`, 'warning');
    } else if (_renderStats.failed > 0) {
        notify(`Render finished with ${_renderStats.failed} failures`, 'warning', { duration: 6000 });
    } else if (_renderStats.total > 0) {
        notify(
            `Render complete · ${_renderStats.done} fresh${_renderStats.skipped ? `, ${_renderStats.skipped} cached` : ''}`,
            'success',
            { duration: 5000 }
        );
    }
    _renderStats = { total: 0, done: 0, skipped: 0, failed: 0, cancelled: false };
}

/**
 * Public entry: queue up a range of pages for rendering. Returns immediately;
 * the worker drains the queue in the background.
 *
 * @param {object} exportData - Result of buildExportData(start, end)
 */
async function queueRender(exportData) {
    const pages = exportData.pages;
    const numbers = Object.keys(pages).map(n => parseInt(n)).sort((a, b) => a - b);
    if (numbers.length === 0) {
        toast('No complete pages to render in this range', 'info');
        return;
    }
    // Bake per-photo adjustments into the sources before queueing, so every
    // built PSD reflects the live preview. Mutates pages[*].photos[*].filePath
    // in place, which is what the queue holds a reference to. Skipped when J1
    // (editable adjustment layers) is on — the JSX places originals + adds
    // clipped adjustment layers instead.
    try {
        if (!_useAdjLayers) {
            const baked = await bakeExportAdjustments(exportData);
            if (baked > 0) setStatus(`Applied edits to ${baked} photo${baked === 1 ? '' : 's'} before render…`);
        }
    } catch (_) { /* fall back to unadjusted sources */ }
    _renderStats.total += numbers.length;
    numbers.forEach(n => {
        _renderQueue.push({ pageNum: n, pageData: pages[n], outputPath: exportData.outputPath });
    });
    _updateRenderBadge();
    _renderWorker();
}

const btnExport = document.getElementById("btnExport");
if (btnExport) {
    btnExport.addEventListener("click", () => {
        if (!outputFolder) return app.showAlert("Please select an Output Folder first!");
        const start = parseInt(document.getElementById("exportStart").value);
        const end = parseInt(document.getElementById("exportEnd").value);
        if (isNaN(start) || isNaN(end) || start > end) return app.showAlert("Invalid Start/End pages.");
        const exportData = buildExportData(start, end);
        if (Object.keys(exportData.pages).length === 0) return app.showAlert("No complete pages in range!");
        queueRender(exportData);
    });
}

// ==========================================
// --- 14. TAB 7: VIRTUAL STORYBOARD ENGINE ---
// ==========================================

// ─── DRAG STATE ──────────────────────────────────────────────────────────────
let _sbDrag = null; // { sourcePhotoIds: string[], el, ghost, pointerId, ... }
let _sbDrop = null; // { el, before } — last known valid drop target

// ─── SELECTION STATE ─────────────────────────────────────────────────────────
// Multi-select is keyed on photoId (globally unique) rather than (page, idx)
// so it survives moves between pages.
const _sbSelected = new Set();

function _sbClearSelection() {
    _sbSelected.clear();
    document.querySelectorAll('.sb-photo-item.is-selected')
        .forEach(el => el.classList.remove('is-selected'));
}

function _sbSetSelected(photoId, on) {
    if (on) _sbSelected.add(photoId); else _sbSelected.delete(photoId);
    document.querySelectorAll(`.sb-photo-item[data-photo-id="${photoId}"]`)
        .forEach(el => el.classList.toggle('is-selected', on));
}

// Apply current selection state to all rendered tiles. Called from
// renderStoryboard() so a re-render does not lose the visual highlight.
function _sbReapplySelectionToDom() {
    document.querySelectorAll('.sb-photo-item').forEach(el => {
        el.classList.toggle('is-selected', _sbSelected.has(el.dataset.photoId));
    });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function _sbHitTest(x, y) {
    const items = document.querySelectorAll('.sb-photo-item');
    for (const el of items) {
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            return { el, before: x < r.left + r.width / 2 };
        }
    }
    return null;
}
// Forgiving tile lookup for SELECTION clicks. If e.target is the tile or any
// descendant, closest() finds it instantly. Otherwise we look for the visually
// nearest tile within _SB_CLICK_RADIUS px — covers the case where the user's
// click landed in the inter-tile gap, on the selection glow, or on the
// outline that sits outside the actual element box.
const _SB_CLICK_RADIUS = 14; // px — generous, ~quarter of default tile size
function _sbFindClickedTile(e) {
    const direct = e.target.closest('.sb-photo-item');
    if (direct) return direct;
    const x = e.clientX, y = e.clientY;
    let best = null, bestDist = Infinity;
    document.querySelectorAll('.sb-photo-item').forEach(el => {
        const r = el.getBoundingClientRect();
        // Distance from point to rectangle (0 if inside, else perpendicular).
        const cx = Math.max(r.left, Math.min(x, r.right));
        const cy = Math.max(r.top,  Math.min(y, r.bottom));
        const d = Math.hypot(x - cx, y - cy);
        if (d <= _SB_CLICK_RADIUS && d < bestDist) {
            best = el; bestDist = d;
        }
    });
    return best;
}
function _sbClearBars() {
    document.querySelectorAll('.sb-photo-item').forEach(el =>
        el.classList.remove('drop-before', 'drop-after')
    );
}

// ─── DOM BUILDER — pure, no listener management ──────────────────────────────
// renderStoryboard() only builds HTML. The DnD listeners are attached ONCE
// via the IIFE below and survive every innerHTML rebuild because they sit on
// the stable storyboardGrid container (event delegation).
function renderStoryboard() {
    if (!storyboardGrid) return;

    // Abort any drag in progress before wiping the DOM
    if (_sbDrag) {
        try { _sbDrag.ghost.remove(); } catch(e) {}
        _sbDrag = null; _sbDrop = null;
    }

    let hasPages = false;
    const frag = document.createDocumentFragment();

    for (let i = 1; i <= totalActivePages; i++) {
        const pageData = albumPages[i];
        if (!pageData || !pageData.template) continue;
        hasPages = true;

        const card = document.createElement("div");
        card.className = "sb-page-card";

        const header = document.createElement("div");
        header.className = "sb-page-header";
        header.innerText = `Page ${String(i).padStart(3, '0')}`;
        card.appendChild(header);

        const preview = document.createElement("div");
        preview.className = "sb-template-preview";
        if (pageData.template._generative) {
            preview.innerHTML = _generativePreviewSvg(pageData.template);
        } else {
            preview.innerHTML = `<img src="${escapeHtml(pageData.template.url)}" alt="Template">`;
        }
        card.appendChild(preview);

        const pgrid = document.createElement("div");
        pgrid.className = "sb-photo-grid";
        pgrid.dataset.pageIdx = i;

        if (pageData.photos && pageData.photos.length > 0) {
            pageData.photos.forEach((photo, photoIdx) => {
                const pItem = document.createElement("div");
                pItem.className = "sb-photo-item";
                pItem.dataset.pageIdx  = i;
                pItem.dataset.photoId  = photo.id;
                pItem.dataset.photoIdx = photoIdx;
                const rot = projectData.imageRotations[photo.id] || 0;
                pItem.innerHTML = `<img src="${photo.url}" draggable="false"${rot ? ` style="transform:rotate(${rot}deg);"` : ""}>`;
                pgrid.appendChild(pItem);
            });
        } else {
            const empty = document.createElement("div");
            empty.className = "placeholder-row";
            empty.innerText = "No Photos";
            pgrid.appendChild(empty);
        }

        card.appendChild(pgrid);
        frag.appendChild(card);
    }

    storyboardGrid.innerHTML = "";
    storyboardGrid.appendChild(hasPages ? frag
        : Object.assign(document.createElement("div"), {
            className: "empty-state",
            innerHTML: `<div class="empty-state__icon">🎞️</div>
                <div class="empty-state__title">Storyboard is empty</div>
                <div class="empty-state__hint">Run Auto-Fill in the Album tab, then refresh the storyboard to review your spread before rendering.</div>`
        })
    );

    // Re-apply selection rings after the DOM is freshly rebuilt.
    _sbReapplySelectionToDom();

    // Re-apply any cached page proofs so a renderStoryboard() rebuild doesn't
    // wipe the composite previews back to static template thumbnails.
    if (typeof _proofPaths === 'object') {
        for (let i = 1; i <= totalActivePages; i++) {
            if (_proofPaths[i] && typeof _swapProofIntoStoryboard === 'function') {
                _swapProofIntoStoryboard(i);
            }
        }
    }
}

// ─── DnD ENGINE — attached ONCE, never re-attached ───────────────────────────
// WHY ONCE: storyboardGrid is a const pointing to a fixed DOM node.
// Event delegation means bubbled events from any child (including newly
// rendered .sb-photo-item nodes) always reach storyboardGrid.
// The broken "clone-replace + re-attach" approach replaced the DOM node
// while the const kept pointing to the detached original, so renderStoryboard()
// was writing to an element that was no longer in the page — invisible to the user.
;(function _sbInitDnd() {
    if (!storyboardGrid) return;

    // ── Architecture ─────────────────────────────────────────────────────────
    // We split the interaction into two cleanly separated systems:
    //
    //   1. SELECTION  — handled by native `click` events. The browser only
    //      fires a click when pointerdown and pointerup happen on the same
    //      element with negligible movement, so click-vs-drag detection is
    //      effectively free, and hover state on other tiles is never broken.
    //
    //   2. DRAG       — handled by pointerdown/move/up. Pointer capture is
    //      only acquired AFTER the user has moved past _DRAG_THRESHOLD; up
    //      to that point the grid does not steal pointer events from any
    //      other tile so :hover keeps working.
    //
    // The previous implementation captured on every pointerdown and ran a
    // home-grown click detector inside pointerup, which both broke hover and
    // wiped the selection on near-miss shift-clicks.

    const _DRAG_THRESHOLD = 5;

    // Pre-drag state: pointer is down on a tile but threshold not yet crossed
    let _sbPending = null;
    // Set true on pointerup that ENDED a real drag, cleared on next click cycle.
    // Used to suppress the synthetic click event a drag generates on most browsers.
    let _sbSuppressNextClick = false;

    function _sbStartDrag(e) {
        // Promote the pending pointerdown to an actual drag.
        const pItem = _sbPending.el;
        const pointedId = pItem.dataset.photoId;
        const ids = _sbSelected.has(pointedId)
            ? Array.from(_sbSelected)
            : [pointedId];

        const ghost = document.createElement('div');
        ghost.className = 'sb-drag-ghost';
        ghost.style.left = (e.clientX - 30) + 'px';
        ghost.style.top  = (e.clientY - 30) + 'px';
        const srcImg = pItem.querySelector('img');
        if (srcImg) {
            const gi = document.createElement('img');
            gi.src = srcImg.src;
            if (srcImg.style.cssText) gi.style.cssText = srcImg.style.cssText;
            ghost.appendChild(gi);
        }
        if (ids.length > 1) {
            const badge = document.createElement('div');
            badge.className = 'sb-drag-ghost__count';
            badge.textContent = '+' + ids.length;
            ghost.appendChild(badge);
        }
        document.body.appendChild(ghost);

        ids.forEach(id => {
            document.querySelectorAll(`.sb-photo-item[data-photo-id="${id}"]`)
                .forEach(el => el.classList.add('sb-dragging'));
        });

        _sbDrag = {
            ghost,
            ids,
            pointerId: _sbPending.pointerId,
            sourcePhotoId: pointedId
        };
        _sbPending = null;

        // C.3: highlight the storyboard as the active drop zone (same accent
        // dashed outline used by the green box) so the target is unambiguous.
        storyboardGrid.classList.add('dropzone--active');

        // NOW capture — events from any tile route to the grid for the rest
        // of the drag. Before this point, individual tiles still get hover.
        try { storyboardGrid.setPointerCapture(_sbDrag.pointerId); } catch (_) {}
    }

    // ── POINTER DOWN ─────────────────────────────────────────────────────────
    // Just remember the start position. No preventDefault, no capture, no
    // selection mutation — that is the click handler's job.
    storyboardGrid.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        // Use forgiving hit-test so a press that lands in the inter-tile gap
        // (parent .sb-photo-grid) or on the selection glow still snaps to
        // the nearest tile. The previous closest('.sb-photo-item') call
        // returned null in those cases, killing the drag pipeline before it
        // ever started.
        const pItem = _sbFindClickedTile(e);
        if (!pItem) return;

        if (e.shiftKey || e.metaKey || e.ctrlKey) {
            return;
        }

        _sbPending = {
            startX: e.clientX,
            startY: e.clientY,
            pointerId: e.pointerId,
            el: pItem
        };
        _sbDrop = null;
    });

    // ── POINTER MOVE ─────────────────────────────────────────────────────────
    storyboardGrid.addEventListener('pointermove', (e) => {
        // Pre-drag: see whether we've crossed the drag threshold yet.
        if (_sbPending) {
            const dx = e.clientX - _sbPending.startX;
            const dy = e.clientY - _sbPending.startY;
            const dist = Math.hypot(dx, dy);
            if (dist < _DRAG_THRESHOLD) return;
            _sbStartDrag(e);
        }

        if (!_sbDrag) return;

        _sbDrag.ghost.style.left = (e.clientX - 30) + 'px';
        _sbDrag.ghost.style.top  = (e.clientY - 30) + 'px';

        _sbClearBars();
        const hit = _sbHitTest(e.clientX, e.clientY);
        const draggingSet = new Set(_sbDrag.ids);
        if (hit && !draggingSet.has(hit.el.dataset.photoId)) {
            hit.el.classList.add(hit.before ? 'drop-before' : 'drop-after');
            _sbDrop = hit;
        } else {
            _sbDrop = null;
        }
    });

    // ── POINTER UP ────────────────────────────────────────────────────────────
    storyboardGrid.addEventListener('pointerup', (e) => {
        // Pre-drag, never moved enough → leave the click handler to it.
        if (_sbPending && !_sbDrag) {
            _sbPending = null;
            return;
        }
        if (!_sbDrag) return;

        try { storyboardGrid.releasePointerCapture(_sbDrag.pointerId); } catch (_) {}

        // Tear down the drag visuals.
        const ids = _sbDrag.ids;
        ids.forEach(pid => {
            document.querySelectorAll(`.sb-photo-item[data-photo-id="${pid}"]`)
                .forEach(el => el.classList.remove('sb-dragging'));
        });
        try { _sbDrag.ghost.remove(); } catch (_) {}
        _sbClearBars();
        storyboardGrid.classList.remove('dropzone--active');

        const drop = _sbHitTest(e.clientX, e.clientY) || _sbDrop;
        const draggingSet = new Set(ids);
        if (drop && !draggingSet.has(drop.el.dataset.photoId)) {
            const targetPageIdx = parseInt(drop.el.dataset.pageIdx);
            const targetPhotoId = drop.el.dataset.photoId;
            const insertBefore = drop.before;
            const targetPage = albumPages[targetPageIdx];
            if (targetPage) {
                mutate(`Move ${ids.length} photo${ids.length === 1 ? '' : 's'}`, () => {
                    const grabbed = [];
                    Object.entries(albumPages).forEach(([pageNumStr, page]) => {
                        if (!page || !page.photos) return;
                        const pageNum = parseInt(pageNumStr);
                        const stillThere = [];
                        page.photos.forEach((p, idx) => {
                            if (draggingSet.has(p.id)) {
                                grabbed.push({ photo: p, sourcePage: pageNum, sourceIdx: idx });
                                removeFromPageMap(p.id, pageNum);
                            } else {
                                stillThere.push(p);
                            }
                        });
                        page.photos = stillThere;
                    });

                    let tgtIdx = targetPage.photos.findIndex(p => p.id === targetPhotoId);
                    if (tgtIdx === -1) tgtIdx = targetPage.photos.length;
                    else if (!insertBefore) tgtIdx++;

                    grabbed.sort((a, b) => (a.sourcePage - b.sourcePage) || (a.sourceIdx - b.sourceIdx));
                    grabbed.forEach((g, i) => {
                        targetPage.photos.splice(tgtIdx + i, 0, g.photo);
                        addToPageMap(g.photo.id, targetPageIdx);
                    });

                    renderStoryboard();
                    renderGreenBox();
                    scheduleFilterUpdate();
                });
            }
        }

        // Suppress the click event the OS will fire for this gesture so it
        // does not also re-toggle selection on the source tile.
        _sbSuppressNextClick = true;

        _sbDrag = null;
        _sbDrop = null;
    });

    // ── POINTER CANCEL — UXP modal opened mid-drag etc. ──────────────────────
    storyboardGrid.addEventListener('pointercancel', () => {
        if (_sbDrag) {
            try { _sbDrag.ghost.remove(); } catch(e) {}
            (_sbDrag.ids || []).forEach(pid => {
                document.querySelectorAll(`.sb-photo-item[data-photo-id="${pid}"]`)
                    .forEach(el => el.classList.remove('sb-dragging'));
            });
        }
        _sbClearBars();
        storyboardGrid.classList.remove('dropzone--active');
        _sbPending = null;
        _sbDrag = null;
        _sbDrop = null;
    });

    // ── CLICK — selection ────────────────────────────────────────────────────
    // Bound on the grid (event delegation). The browser only fires a click
    // when the gesture stayed effectively in place, so we don't have to
    // re-implement that logic.
    storyboardGrid.addEventListener('click', (e) => {
        if (_sbSuppressNextClick) {
            _sbSuppressNextClick = false;
            return;
        }

        // Forgiving hit-test: tolerate clicks in the gap or on the selection
        // glow by snapping to the nearest tile within _SB_CLICK_RADIUS.
        const pItem = _sbFindClickedTile(e);
        const hasModifier = e.shiftKey || e.metaKey || e.ctrlKey;

        if (!pItem) {
            if (!hasModifier) _sbClearSelection();
            return;
        }

        const id = pItem.dataset.photoId;
        if (hasModifier) {
            _sbSetSelected(id, !_sbSelected.has(id));
        } else {
            const wasOnlySelected = _sbSelected.size === 1 && _sbSelected.has(id);
            _sbClearSelection();
            if (!wasOnlySelected) _sbSetSelected(id, true);
        }
    });

    // ── KEYBOARD: Escape clears selection (only when Tab 7 is active) ───────
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _sbSelected.size > 0) {
            const exportPane = document.getElementById('tab-export');
            if (exportPane && exportPane.classList.contains('active')) {
                _sbClearSelection();
            }
        }
    });
})();

const btnRefreshStoryboard = document.getElementById("btnRefreshStoryboard");
if (btnRefreshStoryboard) btnRefreshStoryboard.addEventListener("click", () => renderStoryboard());

// ─── FAST PROOF RENDERER ─────────────────────────────────────────
// Generates composite preview JPEGs for every page in the storyboard via the
// main-process sharp pipeline (proof_renderer.js). No Photoshop in the loop:
// a 200-page album proofs in seconds, not minutes. Frame geometry is
// extracted once per template (via extract_frames.jsx) and cached on the
// template object so re-proofing the same album is pure libvips.
const _proofPaths = {};        // pageNum -> proof file path on disk (file://)
const _proofHashes = {};       // pageNum -> last successful render hash

function _proofProjectDir() {
    if (!currentProjectPath) return null;
    return require('path').join(currentProjectPath, 'proofs', 'pages');
}

async function ensureTemplateFrames(template) {
    // Lazily extract frame geometry once per template, then cache it on the
    // template object so subsequent proofs are instant.
    if (template._frames && template._canvas) return template;
    // Generative templates carry pre-baked frames — never round-trip through
    // Photoshop frame extraction for them.
    if (template._generative) return template;
    const tplPath = template.file?.nativePath;
    if (!tplPath) {
        toast(`Template ${template.name || '(unnamed)'} has no file path — re-load its folder`, 'error');
        return null;
    }
    setStatus(`Reading frame layout from ${template.name}…`);
    const ipc = require('electron').ipcRenderer;
    let result;
    try {
        result = await ipc.invoke('extract-template-frames', tplPath);
    } catch (e) {
        // IPC-level failure — usually means Photoshop isn't reachable.
        const msg = e?.message || String(e) || 'Photoshop is not responding';
        toast(`Couldn't open ${template.name}: ${msg}`, 'error');
        return null;
    }
    if (!result || !result.ok) {
        const detail = result?.error || 'unknown extension error (is the file inside the album reachable?)';
        toast(`Couldn't read frames from ${template.name}: ${detail}`, 'error', { duration: 8000 });
        return null;
    }
    if (result.warning) {
        toast(`${template.name}: ${result.warning}`, 'warning', { duration: 6000 });
    }
    template._frames = result.frames;
    template._canvas = { w: result.canvasWidth, h: result.canvasHeight };
    return template;
}

function _resolvePhotoFilePath(photo) {
    // Returns { primary, fallback } so the proof renderer can retry with a
    // smaller / known-good source if the HR file is in a format libvips
    // doesn't understand (RAW formats from camera SD cards being the usual
    // suspect — Canon .cr2, Nikon .nef, Sony .arw, generic .dng).
    const cache = photoCache[photo.id];
    if (!cache) return { primary: null, fallback: null };

    const proxyPath = cache.file?.nativePath || cache.proxy?.nativePath || null;

    // Extensions sharp/libvips can decode reliably. JFIF, EXIF JPEG, PNG, TIFF,
    // WebP, HEIC, AVIF, GIF. Everything else (RAW, .psd, .cr2, ...) gets
    // skipped here so we don't waste a sharp call on a guaranteed failure.
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

// Session cache of HR folder listings for proof file resolution, keyed by the
// folder's native path. Mirrors getTrueFile's _hrEntriesCache (session-stable)
// and is cleared at the start of each full proof batch so a folder whose files
// changed between runs is re-scanned. value: Map<baseNameLower, filename[]>
const _proofHrIndexCache = new Map();
function _proofHrIndex(hrFolderPath) {
    let idx = _proofHrIndexCache.get(hrFolderPath);
    if (idx) return idx;
    idx = new Map();
    try {
        const nodefs = require('fs');
        for (const f of nodefs.readdirSync(hrFolderPath)) {
            const base = f.replace(/\.[^/.]+$/, '').toLowerCase();
            if (!idx.has(base)) idx.set(base, []);
            idx.get(base).push(f);
        }
    } catch (_) { /* unreadable HR folder → empty index, proxy is used */ }
    _proofHrIndexCache.set(hrFolderPath, idx);
    return idx;
}

// _proofTemplatePreviewPath moved to src/renderer_pure.js (required at top).

async function _generateProofForPage(pageNum, opts = {}) {
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
            rotation: projectData.imageRotations?.[p.id] || 0,
            adjust: projectData.imageAdjustments?.[p.id] || null,
            placement: projectData.imagePlacements?.[p.id] || null,
        };
    }).filter(Boolean);
    if (photos.length === 0) return null;

    const projectDir = _proofProjectDir();
    // If no project folder is set yet, fall back to the OS temp dir so users
    // can preview before the first save.
    const baseDir = projectDir || require('path').join(require('os').tmpdir(), 'albumstudio_proofs');
    // The live preview writes to a separate file so it never fights the
    // storyboard's page_NNN.jpg (different size, rendered on every edit).
    const fname = opts.live
        ? `live_page_${String(pageNum).padStart(3, '0')}.jpg`
        : `page_${String(pageNum).padStart(3, '0')}.jpg`;
    const outPath = require('path').join(baseDir, fname);

    const job = {
        templatePath: tpl.file.nativePath,
        templatePreviewPath: _proofTemplatePreviewPath(tpl),
        frames: tpl._frames,
        canvasWidth: tpl._canvas.w,
        canvasHeight: tpl._canvas.h,
        photos,
        outputPath: outPath,
        // Live preview renders smaller for speed (the preview pane is small);
        // batch proofs stay at 1500 for the storyboard/gallery.
        maxEdge: opts.maxEdge || 1500,
        // Center cover-fit, matching how Photoshop places photos
        // (build_page.jsx: resize to cover + MIDDLECENTER + center translate)
        // AND how the final libvips composite renders (render-final-composite
        // uses smartCrop:false). Saliency 'attention' crop here would show a
        // crop the user never actually gets — defeating the proof's purpose
        // as a faithful preview.
        smartCrop: false,
    };

    const ipc = require('electron').ipcRenderer;
    const res = await ipc.invoke('render-proof', job);
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
    // Don't let the live preview's separate output overwrite the storyboard's
    // stored proof path/hash for this page.
    if (!opts.live) {
        _proofPaths[pageNum] = res.outputPath;
        _proofHashes[pageNum] = res.hash;
    }
    return res;
}
// Aggregated diagnostics for the current proof run. Cleared by
// generateAllProofs() at the start of each invocation.
const _proofErrorCounts = new Map();
const _proofFailedPages = [];

async function generateAllProofs() {
    // Fresh HR-folder listings for this batch (files may have changed since
    // the last run); the per-photo resolver reuses these within the run.
    _proofHrIndexCache.clear();
    const pages = [];
    for (let i = 1; i <= totalActivePages; i++) {
        if (albumPages[i]?.template && albumPages[i]?.photos?.length) pages.push(i);
    }
    if (pages.length === 0) {
        toast('No complete pages to proof yet', 'info');
        return;
    }

    // Phase 1: extract frame geometry for every UNIQUE template up front.
    // Without this, a 200-page album with 20 templates re-asked Photoshop
    // for the same frame data hundreds of times AND a single failure
    // surfaced as the same toast on every page using that template.
    const uniqueTemplates = new Map();
    for (const n of pages) {
        const tpl = albumPages[n].template;
        const key = tpl.file?.nativePath || tpl.id;
        if (!uniqueTemplates.has(key)) uniqueTemplates.set(key, tpl);
    }
    setStatus(`Reading frame layout from ${uniqueTemplates.size} template${uniqueTemplates.size > 1 ? 's' : ''}…`);
    const failedTemplates = new Set();
    for (const [key, tpl] of uniqueTemplates) {
        const ready = await ensureTemplateFrames(tpl);
        if (!ready) failedTemplates.add(key);
    }
    if (failedTemplates.size === uniqueTemplates.size) {
        // Nothing usable — bail with a single, descriptive toast instead of
        // letting per-page errors flood the screen.
        toast('All templates failed frame extraction. Check that Photoshop is running and the PSD files are reachable.', 'error');
        return;
    }

    // Reset run-level diagnostics so we report only this run's issues.
    _proofErrorCounts.clear();
    _proofFailedPages.length = 0;

    const t0 = performance.now();
    let done = 0, failed = 0, skippedTpl = 0;
    setStatus(`Generating ${pages.length} proofs…`);

    // ⚡ Bounded-concurrency pool. Frames are already extracted (Photoshop,
    // above), so each page render is pure libvips — safe to overlap. Running a
    // few pages at once keeps the libvips threadpool and disk I/O saturated
    // (was strictly one-page-at-a-time). Bounded at 4 so peak memory stays
    // predictable on large albums (the C9 memory-spike guard).
    const PROOF_CONCURRENCY = 4;
    let cursor = 0;
    async function _proofWorker() {
        while (cursor < pages.length) {
            const pageNum = pages[cursor++];
            const tpl = albumPages[pageNum].template;
            const key = tpl.file?.nativePath || tpl.id;
            if (failedTemplates.has(key)) { skippedTpl++; continue; }
            const r = await _generateProofForPage(pageNum);
            if (r?.ok) done++; else failed++;
            // Live update: swap the placeholder for the real proof as it lands.
            _swapProofIntoStoryboard(pageNum);
            if ((done + failed) % 5 === 0 || (done + failed + skippedTpl) === pages.length) {
                setStatus(`Proofing ${done}/${pages.length}…`);
            }
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(PROOF_CONCURRENCY, pages.length || 1) }, _proofWorker)
    );

    const ms = Math.round(performance.now() - t0);
    require('electron').ipcRenderer.invoke('telemetry-event', 'proof_run', {
        pages: pages.length, done, failed, skippedTpl, durationMs: ms,
        templatesFailed: failedTemplates.size,
    });
    const summary = [
        `Proofs ready · ${done} of ${pages.length}`,
        failed ? `${failed} failed` : null,
        skippedTpl ? `${skippedTpl} skipped (template unreadable)` : null,
        `${(ms / 1000).toFixed(1)}s`,
    ].filter(Boolean).join(' · ');
    notify(summary, (failed || skippedTpl) ? 'warning' : 'success', { duration: 6000 });

    // Aggregated error breakdown — one toast per distinct error class, with
    // a count and a sampled page list so the user can act on it instead of
    // dismissing 200 identical messages.
    if (_proofErrorCounts.size > 0) {
        for (const [reason, count] of _proofErrorCounts) {
            const samplePages = _proofFailedPages.slice(0, 5).join(', ');
            const more = _proofFailedPages.length > 5 ? ` (+${_proofFailedPages.length - 5} more)` : '';
            toast(
                `${count} page${count > 1 ? 's' : ''} affected · ${reason}${samplePages ? ` · pages ${samplePages}${more}` : ''}`,
                'error',
                { duration: 9000 }
            );
        }
    }
}

function _swapProofIntoStoryboard(pageNum) {
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
    // refreshes the visible image instead of getting served the cached file.
    const hash = _proofHashes[pageNum] || Date.now();
    img.src = `file://${_proofPaths[pageNum]}?h=${hash}`;
    img.style.opacity = '1';
    wrap.classList.add('sb-template-preview--proofed');
}

const btnGenerateProofs = document.getElementById('btnGenerateProofs');
if (btnGenerateProofs) {
    btnGenerateProofs.addEventListener('click', () => {
        generateAllProofs().catch(e => toast('Proof error: ' + e.message, 'error'));
    });
}

// ─── CLIENT PROOF GALLERY ────────────────────────────────────────
const btnExportGallery = document.getElementById('btnExportGallery');
if (btnExportGallery) {
    btnExportGallery.addEventListener('click', async () => {
        try {
            if (!currentProjectPath) {
                return app.showAlert('Save the project first — the gallery is exported next to project.json.');
            }
            // Make sure proofs exist for every populated page. If something is
            // missing we run a partial proof pass before exporting.
            const missing = [];
            for (let i = 1; i <= totalActivePages; i++) {
                const page = albumPages[i];
                if (!page?.template || !page?.photos?.length) continue;
                if (!_proofPaths[i]) missing.push(i);
            }
            if (missing.length > 0) {
                setStatus(`Proofing ${missing.length} pages before gallery export…`);
                for (const n of missing) {
                    await _generateProofForPage(n);
                    _swapProofIntoStoryboard(n);
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
            if (pages.length === 0) return app.showAlert('No proofs available to export.');

            const albumName = currentProjectPath.split('/').pop() || 'Album';
            const ipc = require('electron').ipcRenderer;
            const result = await ipc.invoke('export-proof-gallery', {
                projectPath: currentProjectPath,
                albumName,
                pages,
            });
            if (!result?.ok) throw new Error('gallery export failed');

            // Open the gallery folder so the photographer can grab it.
            await ipc.invoke('open-external', `file://${result.path}`);
            notify(`Gallery ready · ${result.pages} pages`, 'success', { duration: 6000 });
        } catch (e) {
            toast('Gallery error: ' + e.message, 'error');
        }
    });
}

const btnSetFinalOutput = document.getElementById("btnSetFinalOutput");
if (btnSetFinalOutput) {
    btnSetFinalOutput.addEventListener("click", async () => {
        const folder = await fs.getFolder(); if (!folder) return;
        outputFolder = folder;
        projectData.outputToken = await fs.createPersistentToken(folder);
        saveStateToStorage();
        document.getElementById("finalOutputText").innerText = folder.name;
    });
}

// (buildExportData defined once above — duplicate removed)

const btnRenderFinalAlbum = document.getElementById("btnRenderFinalAlbum");
if (btnRenderFinalAlbum) {
    btnRenderFinalAlbum.addEventListener("click", () => {
        if (!outputFolder) return app.showAlert("Please SET OUTPUT FOLDER first!");
        const exportData = buildExportData(1, totalActivePages);
        if (Object.keys(exportData.pages).length === 0) return app.showAlert("Storyboard is empty!");
        queueRender(exportData);
    });
}

// ==========================================
// --- 15. GLOBAL SAVE / LOAD WORKSPACE ---
// ==========================================

// ─── PROJECT (folder-as-project model) ─────────────────────────
// Replaces the previous single-JSON save with a directory layout:
//   <project>/project.json     ← workspace + albumPages
//   <project>/proofs/          ← fast preview JPEGs (future)
//   <project>/exports/         ← high-res PSDs from the render queue
// Legacy single-file .json projects still load through the same handler.
let currentProjectPath = null;

// Build the serialisable project payload (shared by Save / Save As / New).
function buildProjectPayload() {
    const safeAlbumPages = JSON.parse(JSON.stringify(albumPages, (key, value) => {
        if (key === 'file') return undefined;
        return value;
    }));
    return {
        workspace: projectData,
        albumPages: safeAlbumPages,
        totalActivePages: totalActivePages,
        renderHashes: _renderHashes
    };
}

// Save the project. forceNewPath=true always prompts (Save As); otherwise
// re-saves in place once a path is known.
async function saveProject(forceNewPath) {
    try {
        const payload = buildProjectPayload();
        const ipc = require('electron').ipcRenderer;
        let target = forceNewPath ? null : currentProjectPath;
        if (!target) {
            const suggested = (Object.keys(albumPages).length > 0)
                ? `Album-${new Date().toISOString().slice(0, 10)}`
                : 'New Album Project';
            target = await ipc.invoke('project-pick-save', suggested);
            if (!target) return false;
        }
        const result = await ipc.invoke('project-write', target, payload);
        if (!result || !result.ok) throw new Error('project write failed');
        currentProjectPath = result.path;
        notify(`Project saved · ${result.path.split('/').pop()}`, "success");
        return true;
    } catch (e) {
        toast("Save error: " + e.message, "error");
        console.error("Save error full:", e);
        return false;
    }
}

// New Project: keep the reusable library (templates/wallpapers/assets/output +
// settings); clear the project-specific source photos, Photos tab, and album
// layout; then save to a freshly named/created file. Confirmed first so it's
// never a silent data loss.
async function newProject() {
    const ok = confirm(
        'Start a new project?\n\n' +
        'Your loaded source photos, the Photos tab, and the current album layout will be cleared. ' +
        'Loaded templates, wallpapers, other assets, the output folder, and settings stay. ' +
        'Save your current project first if you need it.'
    );
    if (!ok) return;
    const ipc = require('electron').ipcRenderer;
    const target = await ipc.invoke('project-pick-save', 'New Album Project');
    if (!target) return;
    try {
        // Clear source images + Photos tab.
        photoCache = {};
        activeImageFolders.clear();
        projectData.imageTokens = [];
        if (projectData.highResTokens) projectData.highResTokens = [];
        redBox.innerHTML = `<div class="empty-state">
            <div class="empty-state__icon">🖼️</div>
            <div class="empty-state__title">No photos loaded</div>
            <div class="empty-state__hint">Load a folder of photos to build your source pool, then drag or auto-fill them onto pages.</div>
            <button class="btn btn--primary btn--sm empty-state__action" data-load="btnLoadPhotos">📂 Load photos</button>
        </div>`;
        if (photosGrid) photosGrid.innerHTML = "";
        tab6Rendered = false;
        const rfp = document.getElementById('redFolderPanel'); if (rfp) rfp.innerHTML = getPanelHeaderHTML('images');
        const pfp = document.getElementById('photosFolderPanel'); if (pfp) pfp.innerHTML = getPanelHeaderHTML('images');
        // Reset the album to a single blank page + per-photo edit maps.
        albumPages = { 1: { photos: [], template: null } };
        totalActivePages = 1; currentPage = 1;
        Object.keys(photoPageMap).forEach(k => delete photoPageMap[k]);
        projectData.imageRotations = {};
        projectData.imageAdjustments = {};
        projectData.imagePlacements = {};
        try { _renderHashes = {}; _saveRenderHashes(); } catch (_) {}
        if (typeof _proofPaths === 'object') {
            Object.keys(_proofPaths).forEach(k => delete _proofPaths[k]);
            Object.keys(_proofHashes).forEach(k => delete _proofHashes[k]);
        }
        syncViewToState();
        updatePageDropdowns();
        renderGreenBox();
        changePage(1);
    } catch (e) {
        console.error('New Project clear failed:', e);
        toast('New Project: clearing failed — ' + e.message, 'error');
        return;
    }
    currentProjectPath = target;
    await saveProject(false);
}

const btnSaveWorkspace = document.getElementById("btnSaveWorkspace");
if (btnSaveWorkspace) {
    btnSaveWorkspace.addEventListener("click", () => { saveProject(false); });
}

// Save split-button menu (Save As / New Project). Reparented to <body> and
// fixed-positioned from the button (same approach as the theme dropdown) so it
// can't be clipped or painted under the tab content / stacking contexts.
const btnSaveMenuBtn = document.getElementById("btnSaveMenuBtn");
const saveMenu = document.getElementById("saveMenu");
if (btnSaveMenuBtn && saveMenu) {
    let _saveMenuReparented = false;
    const positionSaveMenu = () => {
        if (!_saveMenuReparented) { document.body.appendChild(saveMenu); _saveMenuReparented = true; }
        const r = btnSaveMenuBtn.getBoundingClientRect();
        saveMenu.style.position = 'fixed';
        saveMenu.style.top = (r.bottom + 4) + 'px';
        saveMenu.style.left = 'auto';
        saveMenu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
        saveMenu.style.zIndex = '100000';
    };
    const closeSaveMenu = () => { saveMenu.classList.remove('open'); btnSaveMenuBtn.setAttribute('aria-expanded', 'false'); };
    btnSaveMenuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (saveMenu.classList.contains('open')) { closeSaveMenu(); return; }
        positionSaveMenu();
        saveMenu.classList.add('open');
        btnSaveMenuBtn.setAttribute('aria-expanded', 'true');
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.save-split') && !e.target.closest('#saveMenu')) closeSaveMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSaveMenu(); });
    window.addEventListener('resize', () => { if (saveMenu.classList.contains('open')) positionSaveMenu(); });
    const btnSaveAs = document.getElementById("btnSaveAs");
    if (btnSaveAs) btnSaveAs.addEventListener("click", () => { closeSaveMenu(); saveProject(true); });
    const btnNewProject = document.getElementById("btnNewProject");
    if (btnNewProject) btnNewProject.addEventListener("click", () => { closeSaveMenu(); newProject(); });
}

async function restoreWorkspace(data) {
    if (!data) return;
    redBox.innerHTML = ""; whiteBox.innerHTML = "";
    // Only wipe asset grids that actually hold cards (not an empty-state).
    if (wallpaperGrid.querySelector('.wp-card')) wallpaperGrid.innerHTML = "";
    if (pngGrid.querySelector('.wp-card')) pngGrid.innerHTML = "";
    if (maskedGrid.querySelector('.wp-card')) maskedGrid.innerHTML = "";

    templateLibrary = []; photoCache = {}; wallpaperCache = {}; pngCache = {}; maskedCache = {};
    activeImageFolders.clear(); activeTemplateFolders.clear(); activeWallpaperFolders.clear(); activePngFolders.clear(); activeMaskedFolders.clear();

    document.getElementById("redFolderPanel").innerHTML = getPanelHeaderHTML("images");
    document.getElementById("photosFolderPanel").innerHTML = getPanelHeaderHTML("images");
    document.getElementById("whiteFolderPanel").innerHTML = getPanelHeaderHTML("templates");
    document.getElementById("wpFolderPanel").innerHTML = getPanelHeaderHTML("wallpapers");
    document.getElementById("pngFolderPanel").innerHTML = getPanelHeaderHTML("pngs");
    document.getElementById("maskedFolderPanel").innerHTML = getPanelHeaderHTML("masks");

    projectData = data.workspace || data;
    if(!projectData.imageTokens) projectData.imageTokens = [];
    if(!projectData.templateTokens) projectData.templateTokens = [];
    if(!projectData.wallpaperTokens) projectData.wallpaperTokens = [];
    if(!projectData.pngTokens) projectData.pngTokens = [];
    if(!projectData.maskTokens) projectData.maskTokens = [];
    if(!projectData.imageRotations) projectData.imageRotations = {};
    if(!projectData.imageAdjustments) projectData.imageAdjustments = {};
    if(!projectData.imagePlacements) projectData.imagePlacements = {};

    albumPages = data.albumPages || {};
    totalActivePages = data.totalActivePages || 1;
    setStatus("Restoring workspace folders…");

    if (projectData.outputToken) {
        try {
            outputFolder = await fs.getEntryForPersistentToken(projectData.outputToken);
            const ftxt = document.getElementById("finalOutputText"); if (ftxt) ftxt.innerText = outputFolder.name;
        } catch (e) {
            // The saved output folder is gone (moved / unmounted). Don't fail
            // silently — the user would hit a confusing error at Render time.
            outputFolder = null;
            const ftxt = document.getElementById("finalOutputText");
            if (ftxt) ftxt.innerText = "Output folder missing — re-select";
            try { require('electron').ipcRenderer.invoke('telemetry-event', 'output_folder_restore_failed', { error: e.message }); } catch (_) {}
        }
    }

    // ⚡ Task 5.2: track folder-restore failures so a moved/renamed/unmounted
    // source folder produces a clear, aggregated warning instead of photos
    // and templates silently vanishing. The inner _Thumbnails probes stay
    // silent — they're EXPECTED to fail when a folder has no thumbnails and
    // have an explicit fallback. Only outer token-resolution failures (the
    // "this folder is gone" case) are recorded.
    const _restoreFailures = [];

    // ⚡ FIX: Restore ALL folder types in parallel instead of sequentially.
    // Startup with 5 folder types × multiple folders each goes from fully sequential
    // to the time of the slowest single folder — often a 5–10x improvement.
    await Promise.all([
        // Image folders
        ...projectData.imageTokens.map(async t => {
            try {
                const masterFolder = await fs.getEntryForPersistentToken(t);
                let targetFolder = masterFolder, hrFolder = null;
                try { const thumbFolder = await masterFolder.getEntry("_Thumbnails"); if (thumbFolder.isFolder) { targetFolder = thumbFolder; hrFolder = masterFolder; } } catch(e) {}
                await processImageFolder(targetFolder, hrFolder, t);
            } catch (e) { _restoreFailures.push({ kind: 'images', error: e.message }); }
        }),
        // Template folders
        ...projectData.templateTokens.map(async t => {
            try { const folder = await fs.getEntryForPersistentToken(t); await processTemplateFolder(folder, t); }
            catch (e) { _restoreFailures.push({ kind: 'templates', error: e.message }); }
        }),
        // Wallpaper folders
        ...projectData.wallpaperTokens.map(async t => {
            try {
                const masterFolder = await fs.getEntryForPersistentToken(t);
                let targetFolder = masterFolder, hrFolder = null;
                try { const thumbFolder = await masterFolder.getEntry("_Thumbnails"); if (thumbFolder.isFolder) { targetFolder = thumbFolder; hrFolder = masterFolder; } } catch(e) {}
                await processWallpaperFolder(targetFolder, hrFolder, getDisplayName(masterFolder), t);
            } catch (e) { _restoreFailures.push({ kind: 'wallpapers', error: e.message }); }
        }),
        // PNG folders
        ...projectData.pngTokens.map(async t => {
            try { const folder = await fs.getEntryForPersistentToken(t); await processPngFolder(folder, t); }
            catch (e) { _restoreFailures.push({ kind: 'pngs', error: e.message }); }
        }),
        // Mask folders
        ...projectData.maskTokens.map(async t => {
            try { const folder = await fs.getEntryForPersistentToken(t); await processMaskedFolder(folder, t); }
            catch (e) { _restoreFailures.push({ kind: 'masks', error: e.message }); }
        })
    ]);

    // Surface restore failures: one telemetry event + one aggregated toast,
    // grouped by folder kind, instead of N silent swallows.
    if (_restoreFailures.length > 0) {
        const byKind = {};
        for (const f of _restoreFailures) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
        const summary = Object.entries(byKind)
            .map(([k, n]) => `${n} ${k}`).join(', ');
        try {
            require('electron').ipcRenderer.invoke('telemetry-event', 'workspace_restore_failures', {
                total: _restoreFailures.length,
                byKind,
                sample: _restoreFailures.slice(0, 5).map(f => f.error),
            });
        } catch (_) {}
        toast(
            `${_restoreFailures.length} folder${_restoreFailures.length === 1 ? '' : 's'} couldn't be restored (${summary}). They may have been moved, renamed, or are on a disconnected drive — re-load them from their tab.`,
            'warning',
            { duration: 9000 }
        );
    }

    // Auto-enable generative templates if the project references any —
    // otherwise the relink below silently fails and pages with generative
    // layouts come back blank. The toggle stays in sync via the checkbox.
    const needsGenerative = Object.values(albumPages).some(p => p?.template?._generative || p?.template?.id?.startsWith?.('gen_'));
    if (needsGenerative) {
        const chk = document.getElementById('chkGenerativeTemplates');
        if (chk && !chk.checked) chk.checked = true;
        await loadGenerativeTemplates();
    }

    // Post-restore: re-link template objects and mark used photos
    Object.values(albumPages).forEach(page => {
        if (page.template) { const matchedTemp = templateLibrary.find(t => t.id === page.template.id); if (matchedTemp) page.template = matchedTemp; }
    });
    syncViewToState();

    rebuildPhotoPageMap(); // ⚡ Initialize reverse lookup from loaded album state
    tab6Rendered = false;  // ⚡ Force Tab 6 rebuild with fresh data on next visit
    updatePageDropdowns(); changePage(1);
    notify("Workspace ready", "success");
}

const btnLoadWorkspace = document.getElementById("btnLoadWorkspace");
if (btnLoadWorkspace) {
    btnLoadWorkspace.addEventListener("click", async () => {
        try {
            const ipc = require('electron').ipcRenderer;
            // Try the folder picker first; if the user cancels, fall back to
            // opening a single legacy .json file.
            let pathPicked = await ipc.invoke('project-pick-open');
            if (!pathPicked) {
                const legacy = await ipc.invoke('pick-file-open');
                if (!legacy) return;
                pathPicked = legacy;
            }
            const res = await ipc.invoke('project-read', pathPicked);
            if (!res || !res.ok) throw new Error(res?.error || 'unable to read project');
            currentProjectPath = res.projectPath || null;
            const data = res.data;
            // Re-hydrate render hash cache from the project payload (newer
            // saves) — older projects don't have it; that's fine, queue will
            // just re-render everything once.
            if (data.renderHashes) {
                _renderHashes = data.renderHashes;
                _saveRenderHashes();
            }
            await restoreWorkspace(data);
            notify("Project loaded", "success");
        } catch (e) {
            toast("Load error: " + e.message, "error");
            console.error("Load error", e);
        }
    });
}

window.addEventListener("DOMContentLoaded", async () => {
    const cachedWorkspace = localStorage.getItem("adt_workspace");
    const cachedAlbum     = localStorage.getItem("adt_album");
    if (cachedWorkspace) {
        try {
            const data = { workspace: JSON.parse(cachedWorkspace) };
            if (cachedAlbum) {
                const a = JSON.parse(cachedAlbum);
                if (a && a.albumPages) data.albumPages = a.albumPages;
                if (a && a.totalActivePages) data.totalActivePages = a.totalActivePages;
            }
            await restoreWorkspace(data);
        } catch (e) { console.error("Invisible Boot-Up Error", e); }
    }
});

// ─── KEYBOARD SHORTCUTS ────────────────────────────────────────
// Single delegated handler. Ignores keystrokes when the user is editing
// a form field. Modifier-aware: Cmd/Ctrl keys for power actions, plain
// keys (J/K/?) for navigation. Designed to be discoverable through "?".
const _shortcutHelp = [
    ['J  /  ←',          'Previous page'],
    ['K  /  →',          'Next page'],
    ['1 — 5',            'Pick template 1–5 from filtered'],
    ['Space',            'Refresh storyboard (Tab 7)'],
    ['Cmd/Ctrl + Z',     'Undo'],
    ['Cmd/Ctrl + Shift + Z',     'Redo'],
    ['Cmd/Ctrl + S',     'Save workspace'],
    ['Cmd/Ctrl + O',     'Load workspace'],
    ['Cmd/Ctrl + E',     'Export current page'],
    ['Cmd/Ctrl + Shift + E', 'Render full album'],
    ['Tab 1 — 7',        'Switch to tab N (Cmd/Ctrl + 1..7)'],
    ['Esc',              'Clear storyboard selection / close dialogs'],
    ['?',                'Show this help'],
];

function showShortcutHelp() {
    let dlg = document.getElementById('shortcutHelpDialog');
    if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.id = 'shortcutHelpDialog';
        dlg.innerHTML = `
            <div class="dialog-body">
                <h3 class="dialog-title">Keyboard Shortcuts</h3>
                <div class="dialog-list" style="max-height: 400px;">
                    ${_shortcutHelp.map(([k, v]) =>
                        `<div style="display:flex;justify-content:space-between;gap:var(--space-7);padding:var(--space-1) 0;">
                            <kbd style="font-family:'JetBrains Mono',monospace;color:var(--accent);">${k}</kbd>
                            <span class="u-text-secondary">${v}</span>
                        </div>`
                    ).join('')}
                </div>
                <div class="dialog-actions">
                    <button class="btn btn--ghost" onclick="this.closest('dialog').close()">Close</button>
                </div>
            </div>`;
        document.body.appendChild(dlg);
    }
    dlg.showModal();
}

// _isEditingTarget moved to src/renderer_pure.js (required at top).

document.addEventListener('keydown', (e) => {
    // Don't hijack typing.
    if (_isEditingTarget(e.target)) {
        // Allow undo/redo even when an input is focused.
        if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            if (e.shiftKey) redo(); else undo();
        }
        return;
    }

    const cmd = e.metaKey || e.ctrlKey;

    // Undo / Redo
    if (cmd && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
    }

    // Tab switching: Cmd/Ctrl + 1..7
    if (cmd && /^[1-7]$/.test(e.key)) {
        e.preventDefault();
        const targets = ['tab-album','tab-wallpapers','tab-png','tab-masked','tab-tools','tab-photos','tab-export'];
        const btn = document.querySelector(`.tab-btn[data-target="${targets[parseInt(e.key) - 1]}"]`);
        if (btn) btn.click();
        return;
    }

    // Save / Load workspace
    if (cmd && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        const b = document.getElementById('btnSaveWorkspace'); if (b) b.click();
        return;
    }
    if (cmd && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        const b = document.getElementById('btnLoadWorkspace'); if (b) b.click();
        return;
    }

    // Export current page / full album
    if (cmd && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        if (e.shiftKey) {
            const b = document.getElementById('btnRenderFinalAlbum'); if (b) b.click();
        } else {
            const b = document.getElementById('btnAutoThis'); if (b) b.click();
        }
        return;
    }

    // Page nav: J/← prev, K/→ next
    if (e.key === 'j' || e.key === 'ArrowLeft') {
        e.preventDefault();
        if (typeof changePage === 'function') changePage(currentPage - 1);
        return;
    }
    if (e.key === 'k' || e.key === 'ArrowRight') {
        e.preventDefault();
        if (typeof changePage === 'function') changePage(currentPage + 1);
        return;
    }

    // Template hotpicks: 1..5 selects from current filteredTemplates
    if (/^[1-5]$/.test(e.key)) {
        const idx = parseInt(e.key) - 1;
        if (filteredTemplates && filteredTemplates[idx]) {
            e.preventDefault();
            setPreview(idx, true);
        }
        return;
    }

    // Space refreshes storyboard if Tab 7 is active
    if (e.key === ' ' || e.code === 'Space') {
        const exportPane = document.getElementById('tab-export');
        if (exportPane && exportPane.classList.contains('active')) {
            e.preventDefault();
            renderStoryboard();
        }
        return;
    }

    // Esc closes any open dialog
    if (e.key === 'Escape') {
        document.querySelectorAll('dialog[open]').forEach(d => d.close());
        return;
    }

    // ? help
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        showShortcutHelp();
    }
});


// ── E2E test hook (guarded) ──────────────────────────────────────────────────
// Present ONLY when the (non-packaged) main process launched us with --e2e; it
// never exists in a shipped build. Gives the Playwright suite a dialog-free way
// to load a project and to inspect + drive the real undo/redo history system,
// so the stateful core is covered before the Phase 2 refactor touches it.
if (process.argv.includes('--e2e')) {
    window.__E2E__ = {
        loadProject: (data) => restoreWorkspace(data),
        state: () => ({
            totalActivePages,
            pageCount: Object.keys(albumPages).length,
            currentPage,
        }),
        // A real, undoable mutation routed through the history system.
        clearAlbum: () => mutate('e2e-clear', () => {
            albumPages = { 1: { photos: [], template: null } };
            totalActivePages = 1;
            currentPage = 1;
        }),
        undo: () => undo(),
        redo: () => redo(),
    };
}
