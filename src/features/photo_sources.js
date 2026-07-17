// @ts-check
// features/photo_sources.js — high-res source resolution + EXIF capture-time
// ordering, extracted from main.js (Phase 2 split).
//
// getTrueFile resolves a photo's "true" file: the best high-res original in
// the linked HR folder (RAW/TIFF preferred over JPEG) or the proxy when no
// HR match exists. buildHighResMap walks a master folder tree into a
// baseName -> entry map with the same RAW/TIFF preference. sortPhotosByExif
// orders a photo array chronologically by EXIF DateTimeOriginal, reading
// dates from HR files when parseable and falling back to proxies.
//
// No DOM ownership here — the only UI seam is the injected setStatus used to
// report the sort's HR/proxy/filename diagnostic counts.

/**
 * @typedef {import('../state/store').Store} Store
 */

const { _parseExifDateFromBuffer } = require('../renderer_pure');

/**
 * Wire the photo-source resolvers to the store.
 *
 * @param {Store} store
 * @param {object} deps
 * @param {(msg: string) => void} deps.setStatus
 */
function createPhotoSources(store, deps) {
    // ⚡ PERF (Task 1.3): cache each HR folder's entry list keyed on the folder
    // object so repeated getTrueFile() calls (double-click placement, export)
    // don't re-scan the directory once per photo. A UXP folder object is stable
    // for the session, so a WeakMap keyed on it is a safe, self-evicting cache.
    const _hrEntriesCache = new WeakMap();
    /** @param {any} hrFolder */
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
        } catch (e) {
            // A failed listing leaves the index EMPTY, which silently downgrades
            // every placement/export for this folder to the low-res proxy — a
            // quality bug the user only notices in the delivered album. Leave a
            // breadcrumb (once per folder — the empty index is cached below).
            console.warn('HR folder listing failed — exports will use proxies:', e instanceof Error ? e.message : String(e));
        }
        _hrEntriesCache.set(hrFolder, idx);
        return idx;
    }

    /**
     * @param {any} cacheData
     * @returns {Promise<{ file: any, isHr: boolean }>}
     */
    async function getTrueFile(cacheData) {
        let result = { file: cacheData.proxy, isHr: false };
        if (!cacheData.hrFolder) return result;
        try {
            const idx = await _getHrEntriesIndexed(cacheData.hrFolder);
            const matches = /** @type {any[]} */ (idx.get(cacheData.baseName) || []);
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

    /** @param {string} filePath */
    async function readExifDate(filePath) {
        if (_exifCache.has(filePath)) return _exifCache.get(filePath);
        try {
            // Read up to 256 KB — covers the APP1 marker comfortably. In the
            // bundled renderer `fs` is the preload-bridge shim, which exposes
            // readFileSlice directly; under node (unit tests) fall back to
            // open/read/close.
            const nodefs = require('fs').promises;
            let slice;
            if (/** @type {any} */ (nodefs).readFileSlice) {
                slice = await /** @type {any} */ (nodefs).readFileSlice(filePath, 256 * 1024);
            } else {
                const handle = await nodefs.open(filePath, 'r');
                try {
                    const buf = Buffer.alloc(256 * 1024);
                    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
                    slice = buf.subarray(0, bytesRead);
                } finally {
                    await handle.close();
                }
            }
            const ts = _parseExifDateFromBuffer(slice);
            _exifCache.set(filePath, ts);
            return ts;
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
     * @param {any[]} items
     */
    async function sortPhotosByExif(items) {
        const photoCache = /** @type {Record<string, any>} */ (store.get('photoCache'));
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
            const used = sources.get(it.id);
            const cache = photoCache[it.id];
            const hrFolder = cache?.hrFolder?.nativePath;
            if (used && hrFolder && used.startsWith(hrFolder)) datedFromHr++;
            else datedFromProxy++;
        }
        if (typeof deps.setStatus === 'function') {
            deps.setStatus(`Sorted by capture time · ${datedFromHr} from HR, ${datedFromProxy} from proxy${undated ? `, ${undated} by filename` : ''}`);
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
    /**
     * @param {any} parentFolder
     * @param {Record<string, any>} mapObj
     */
    async function buildHighResMap(parentFolder, mapObj) {
        try {
            const entries = /** @type {any[]} */ (await parentFolder.getEntries());
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

    return { getTrueFile, sortPhotosByExif, buildHighResMap };
}

module.exports = { createPhotoSources };
