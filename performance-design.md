# Performance & Architecture Audit — Creative Hubb Album Toolkit Pro

**Author:** Principal Performance Architect (audit)
**Status:** Proposed — awaiting approval
**Scope:** Whole-workspace performance, resource efficiency, and architectural quality, with emphasis on image processing, batch thumbnail generation, rotation synchronization, and RAW (`.cr2`) handling.

---

## 1. System Map

The app is a three-process Electron + UXP-style stack:

| Layer | File(s) | Role | Threading model |
|-------|---------|------|-----------------|
| Main (Node) | `app.js` | IPC hub, window mgmt, OAuth, license, JSX dispatch | Single event loop |
| Photoshop bridge | `src/photoshop.js` | Serializes JSX → `osascript` → Photoshop | FIFO queue, 1 in-flight |
| JSX (ExtendScript) | `scripts/*.jsx` | In-Photoshop document work | Single-threaded per PS doc |
| Native image | `src/proof_renderer.js`, `src/curation.js` | sharp/libvips compositing & analysis | libvips threadpool (capped 4) |
| Renderer (UI) | `src/main.js` (2k LOC), `index.html`, `style.css` | All UI, album state, DOM | Single DOM thread |
| Floating dock | `src/tools_bar.js` + `tools_bar.html` | AppleScript-tracked PS dock | 5 Hz poll |

The data flow that matters for performance:

```
Folder load ──▶ processImageFolder (DOM build) ──▶ photoCache{}
                                   │
Auto-Fill ─────▶ querySelectorAll('.thumb-red') ──▶ sortPhotosByExif ──▶ allocate ──▶ albumPages{}
                                   │
Render ────────▶ buildExportData ──▶ renderQueue ──▶ build_pages_batch.jsx (Photoshop)
Proofs ────────▶ ensureTemplateFrames ──▶ renderProofBatch (sharp)
```

Three state stores drift in parallel and are the root of most fragility: **`albumPages`** (truth), **DOM `.used` classes** (view), and **`photoCache`** (index). Several bugs in this audit trace back to these three being synchronized by hand at call sites instead of through one owner.

---

## 2. Critical Findings (ranked by impact × likelihood)

### C1 — Thumbnail generation opens every RAW through Photoshop, one at a time `[HIGH]`
**Location:** `scripts/batch_thumbnails.jsx`
**Symptom:** Generating thumbnails for a 2,000-file `.cr2` shoot is a 30–90 *minute* operation that blocks the entire Photoshop bridge (and therefore every other JSX feature) for its full duration.

**Why it's slow:**
- `app.open()` on a `.cr2` invokes Camera Raw — 1–4 s per file before any work happens.
- Each file is flattened, bit-depth converted, resized, and `saveAs`-ed sequentially.
- The whole loop runs inside a single `osascript` call, so the `PhotoshopQueue` in `photoshop.js` is held for the entire batch. No proofs, no page builds, no swaps can run meanwhile.
- There is **no progress reporting** — the user sees a frozen UI and a single `alert()` at the very end. (Contrast with `jpeg_export.jsx`, which already writes a progress file.)

**Architectural flaw:** The fastest tool we own for decoding images (sharp/libvips, already a dependency) is *bypassed entirely* for thumbnails. libvips decodes JPEG/PNG/TIFF/HEIC at ~10–50 ms each and runs in the main process off the Photoshop bridge. Only true RAW (`.cr2/.nef/.arw/.dng`) genuinely needs Photoshop/Camera Raw.

**Proposed strategy (Clean Code: single responsibility + right tool per type):**
1. Split thumbnail generation into two lanes by extension:
   - **Non-RAW (jpg/png/tif/heic/webp):** sharp pipeline in the main process. Parallel (libvips threadpool), no Photoshop. ~50–100× faster.
   - **RAW (cr2/nef/arw/dng/raw/rw2):** keep the Photoshop path, but stream progress via the same progress-file pattern `jpeg_export.jsx` uses.
2. Emit incremental progress to the renderer for both lanes.
3. Make output dimensions and JPEG quality named constants, not magic `400` / `6`.

**Expected gain:** For a typical wedding folder (mostly JPEG, some RAW), thumbnail time drops from tens of minutes to seconds for the JPEG majority; RAW files process with visible progress and no UI freeze.

---

### C2 — Auto-Fill orientation is read from the DOM, not the image `[HIGH]`
**Location:** `src/main.js`, auto-fill block (~line 1591) + placement loop (~1652)
**Symptom:** `availablePhotos` is built from `document.querySelectorAll('.thumb-red:not(.used)')`, and orientation (`h`/`v`) is derived later from rendered thumbnail dimensions. This couples a core data operation to DOM layout state.

**Problems:**
- **Correctness:** orientation derived from a CSS-transformed thumbnail can disagree with the real pixel dimensions, and a rotated photo's `h`/`v` is computed from the proxy, not the HR source.
- **Big-O:** `querySelectorAll` over hundreds of nodes + `.parentElement.dataset` access per node forces layout reads (forced reflow) on a hot path.
- **Coupling:** auto-fill cannot run headless (e.g., from a saved layout or a future CLI) because it requires the redBox DOM to exist.

**Proposed strategy:** Make `photoCache` the single source of truth. Store `orient` and real `width/height` at folder-load time (sharp `metadata()` in main, or cached from the proxy), and have auto-fill iterate `photoCache` filtered by `activeImageFolders` + a `usedIds` Set. DOM becomes a pure projection of that result.

---

### C3 — Rotation sync and "used" state are hand-synchronized across 3 stores `[HIGH]`
**Location:** `applyGlobalRotation`, `_historyApply`, `restoreWorkspace`, `processImageFolder`, `renderPhotosGrid`, clear-album, remove/teleport.
**Symptom:** Every place that mutates album state must *also* remember to (a) update `albumPages`, (b) toggle DOM `.used`/`transform`, (c) update `photoPageMap`. Miss one and you get the class of bugs already seen this session (invisible selection, stale used-markers, orientation flips not propagating).

**Architectural flaw:** No single owner of "apply state → view." `_historyApply` re-derives the whole view correctly; most other call sites re-implement a subset inline. This is duplicated logic (DRY violation) and the duplication is *partial*, which is worse than full duplication because the variants diverge.

**Proposed strategy:** Introduce one idempotent `syncViewToState()` that rebuilds `.used` flags and rotation transforms from `albumPages` + `projectData.imageRotations`, and one `reconcilePhotoPageMap()` already exists (`rebuildPhotoPageMap`). Every mutation calls `mutate()`, and `mutate()` (plus `_historyApply`) are the *only* things that touch the view. Removes ~6 copies of the "refresh used class" loop.

---

### C4 — `getTrueFile` and EXIF HR resolution do a full `readdir` per photo `[MEDIUM-HIGH]`
**Location:** `getTrueFile` (`main.js`), `sortPhotosByExif` worker (`main.js`)
**Symptom:** Both resolve an HR file by listing the entire HR folder for *each* photo.

- `getTrueFile`: `await cacheData.hrFolder.getEntries()` then `.filter` — O(files) per call, called once per placed photo on double-click and on export.
- `sortPhotosByExif`: `fs.readdirSync(cache.hrFolder.nativePath)` inside the per-photo worker — **synchronous** disk I/O on a function whose entire purpose is to avoid blocking. With 16 concurrent workers each calling `readdirSync` on the same 2,000-file directory, that's up to 2,000 × full-directory scans = O(n²) syscalls, and the sync variant blocks the event loop.

**Proposed strategy:** Build a `hrIndex: Map<baseNameLower, {path, ext}[]>` **once** per HR folder at load time (we already do something similar with `buildHighResMap` for a different purpose — unify them). Resolution becomes O(1) map lookup. Replace all `readdirSync` on hot paths with the prebuilt index. This is the single highest-ratio fix for the `.cr2` workflow: RAW resolution stops scanning the directory repeatedly.

---

### C5 — Whole-album `localStorage` serialization on every mutation `[MEDIUM]`
**Location:** `saveStateToStorage` (debounced 800 ms) + `mutate` + `_historySnapshot`.
**Symptom:** `mutate()` calls `structuredClone(albumPages)` for the undo snapshot *and* schedules a full `JSON.stringify(albumPages)` to localStorage. For a 200-page album with thumbnails URLs embedded, each snapshot is multiple MB. The 80-entry undo cap means up to 80 deep clones of the album held in memory.

**Problems:**
- Memory: 80 × (full album clone) can reach hundreds of MB on large albums.
- CPU: `structuredClone` of a deep object on every photo drag/rotate.
- localStorage has a hard quota (~5–10 MB); a large album can silently exceed it and throw inside the `try` (caught, but state silently stops persisting).

**Proposed strategy:**
- Snapshot *deltas* or a structural-shared subset (template id + photo id list + rotations), not the full hydrated album with URLs. URLs are re-derivable from `photoCache`.
- Move large/at-risk persistence to the project folder (`project.json` already exists) and keep localStorage for small UI state only.
- Cap undo memory by storing compact snapshots (ids, not objects).

---

### C6 — Silent async failures swallow errors across the codebase `[MEDIUM]`
**Locations (representative):**
- `app.js` OAuth/Firestore: `JSON.parse(data)` inside `https` callbacks with no `try/catch` — a non-JSON 500 response throws inside an event emitter and can crash the main process.
- `main.js`: dozens of `catch (e) {}` / `catch (_) {}` empty blocks (folder restore, getTrueFile, EXIF). Failures vanish; the user sees missing photos with no explanation.
- `build_page.jsx` / `export_album.jsx`: per-page failure shows a blocking `alert()` mid-batch, halting an unattended 200-page export until a human clicks OK.

**Proposed strategy:**
- Wrap all `https` JSON parses in try/catch and resolve a typed error.
- Replace empty catches on meaningful paths with a `telemetry.event('..._failed', …)` + a single aggregated user-facing summary (the proof renderer already does this well — adopt that pattern everywhere).
- In JSX batch scripts, never `alert()` inside a loop; accumulate errors into the result JSON and report once (matches `jpeg_export.jsx`).

---

### C7 — `renderPhotosGrid` builds the full Tab 6 grid with per-card closures `[MEDIUM]`
**Location:** `renderPhotosGrid` (`main.js` ~1006)
**Symptom:** One pass over all `photoCache` entries, each creating a card with **two** bound listeners (`btnRotate6.onclick`, `photoCard` pointerup with its own `t6Clicks/t6Timer` closure). With 2,000 photos that's 4,000 live listeners + 2,000 timer closures retained.

**Proposed strategy:** Event-delegate Tab 6 exactly like redBox already does (single `pointerup` on `photosGrid`). Virtualize the grid (render only visible rows via `IntersectionObserver` or a windowing scheme) so a 2,000-photo folder doesn't instantiate 2,000 `<img>` nodes at once. This is also a memory-spike fix: 2,000 decoded thumbnails in the DOM is a large GPU/host memory footprint.

---

### C8 — Proof/render hashing stringifies the whole job including frames `[LOW-MEDIUM]`
**Location:** `proof_renderer.js` `renderPageProof` hash; `main.js` `_hashPage`.
**Symptom:** `crypto.createHash('sha1').update(JSON.stringify({... f: job.frames ...}))` re-serializes the full frame array per page per render. Minor, but on a 200-page batch it's 200 JSON stringifies of nontrivial objects. Also two *different* hash schemes exist (proof vs. queue) that can disagree about whether a page changed.

**Proposed strategy:** Unify on one `pageFingerprint(page)` helper used by both the proof cache and the render queue, hashing only the inputs that affect output (template key, ordered photo id+orient+rotation). Frames are a function of the template key, so they don't need to be in the hash.

---

### C9 — `sharp` instances not always explicitly destroyed under failure `[LOW]`
**Location:** `proof_renderer.js`, `curation.js`
**Symptom:** sharp pipelines that throw mid-chain can leak the underlying libvips image until GC. On a 2,000-photo curation run with some corrupt files, transient memory spikes are possible. libvips also caches operations; `sharp.cache(false)` or a bounded cache is not configured.

**Proposed strategy:** Configure `sharp.cache({ items: … , memory: … })` and `sharp.concurrency()` centrally (one `sharpConfig.js`), and ensure `.destroy()`/buffer release on error paths. Process very large folders in bounded chunks with `await` backpressure (curation is already sequential — good; verify proof batch is too).

---

### C10 — Tools Bar polls Photoshop via `osascript` at 5 Hz indefinitely `[LOW]`
**Location:** `tools_bar.js`
**Symptom:** Every 200 ms a new `osascript` child process is spawned (process create/teardown cost) for as long as the bar is open. Over an 8-hour editing day that's ~144,000 process spawns.

**Proposed strategy:** Back off the poll interval when PS bounds are stable (e.g., 200 ms while moving, 1 s when idle), and reuse a single long-lived AppleScript via a persistent helper if feasible. Low priority — correctness is fine, this is pure efficiency.

---

## 3. Cross-Cutting Architectural Recommendations

1. **One state owner.** Introduce a thin `albumStore` module: all mutations go through it, it emits change events, and the view subscribes. Kills the C3 class of bugs permanently.
2. **One HR index.** Replace every per-photo directory scan with a prebuilt `Map`. Fixes C4 and speeds C1/RAW.
3. **Right tool per file type.** sharp for everything it can decode; Photoshop only for RAW and PSD compositing. Fixes C1, future-proofs the AI/processing roadmap.
4. **Uniform progress + error protocol.** Every long JSX op writes a progress file and an aggregated result JSON; the renderer shows one summary toast. `jpeg_export.jsx` and `proof_renderer.js` already model this — generalize it.
5. **Compact, derivable snapshots.** Persist ids and rotations, re-hydrate URLs from `photoCache`. Fixes C5 memory.

---

## 4. Risk & Sequencing Notes

- C1, C4 are the highest user-visible speed wins and are relatively isolated (new code paths, old paths remain as fallback). Lowest risk-to-reward.
- C3 (state owner) is the highest *architectural* win but touches many call sites — stage it behind a feature flag and migrate call sites incrementally, validating with the existing undo/redo as a correctness oracle.
- C5 changes the save format — must keep a backward-compatible loader for existing `project.json` / localStorage.
- All changes must preserve the existing `PhotoshopQueue` serialization invariant (never run two JSX calls concurrently).

---

## 5. Verification Strategy

- **Micro-benchmarks:** thumbnail of 100 JPEG + 20 CR2; auto-fill of 1,000 photos; proof of 200 pages. Record before/after via the existing `telemetry.event` JSONL stream.
- **Correctness oracle:** undo/redo round-trip must reproduce identical `albumPages` after each refactor (C3/C5).
- **Memory:** sample `process.memoryUsage()` (main) and the renderer heap during a 2,000-photo curation + a 200-page proof, before and after C5/C7/C9.
- **No-regression gate:** `npm run typecheck && npm run lint` must stay green; manual smoke of each tab.
