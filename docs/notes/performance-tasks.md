# Performance Refactor — Task Breakdown

Atomic, sequential, prioritized by **impact × stability ÷ risk**. Each task is independently shippable and gated by `npm run typecheck && npm run lint` plus a targeted smoke test. Finding IDs (C1–C10) reference `performance-design.md`.

Legend: 🟥 high impact · 🟧 medium · 🟦 low · ⏱ est. effort · ⚠ risk

---

## Phase 0 — Safety net (do first, no behavior change)

- [ ] **0.1** Add a `sharpConfig.js` central module; route `proof_renderer.js` and `curation.js` through it (`concurrency`, bounded `cache`). 🟦 ⏱S ⚠low — *(C9)*
- [ ] **0.2** Add three benchmark harness scripts under `scripts/_bench_*` (thumbnails, auto-fill, proofs) that log to the telemetry JSONL. Used to prove every later task. Deleted before ship. 🟦 ⏱S ⚠none
- [ ] **0.3** Capture baseline numbers from 0.2 and paste into `performance-design.md` §5. 🟦 ⏱S

## Phase 1 — Highest-impact speed wins (isolated, low risk)

- [ ] **1.1** Build a reusable `hrIndex` (`Map<baseNameLower,{path,ext}[]>`) per HR folder at load time; store on the folder's cache entry. 🟥 ⏱M ⚠low — *(C4)*
- [ ] **1.2** Replace the `fs.readdirSync` inside `sortPhotosByExif`'s worker with an `hrIndex` lookup; make any remaining reads async. 🟥 ⏱S ⚠low — *(C4)* — **fixes event-loop blocking on chronological sort**
- [ ] **1.3** Replace `getTrueFile`'s `getEntries().filter` with the `hrIndex`. 🟥 ⏱S ⚠low — *(C4)*
- [ ] **1.4** Split `batch_thumbnails` into a sharp lane (non-RAW, main process, parallel) + a Photoshop lane (RAW only), with progress streamed to the renderer. New IPC `thumbnails-generate`. Keep old JSX as the RAW lane. 🟥 ⏱L ⚠med — *(C1)* — **biggest wall-clock win**
- [ ] **1.5** Surface thumbnail progress in the Tools card (reuse the JPEG-export progress bar component). 🟧 ⏱S ⚠low — *(C1/C6)*

## Phase 2 — Correctness + decoupling (medium risk, staged)

- [ ] **2.1** Store `orient` + real `width/height` on `photoCache` entries at load (sharp metadata in main, cached). 🟥 ⏱M ⚠low — *(C2)*
- [ ] **2.2** Rewrite auto-fill `availablePhotos` to iterate `photoCache` filtered by `activeImageFolders` + a `usedIds` Set, instead of `querySelectorAll`. Keep DOM as projection. 🟥 ⏱M ⚠med — *(C2)* — validate against current output on a fixed folder.
- [ ] **2.3** Extract `syncViewToState()` — single idempotent function that rebuilds `.used` + rotation transforms from state. 🟧 ⏱M ⚠med — *(C3)*
- [ ] **2.4** Replace the ~6 inline "refresh used class" loops (restore, refreshTab, clear-album, remove, teleport, `_historyApply`) with `syncViewToState()`. 🟧 ⏱M ⚠med — *(C3)* — undo/redo is the correctness oracle.

## Phase 3 — Memory & snapshot footprint

- [ ] **3.1** Introduce `pageFingerprint(page)` shared by proof cache + render queue; remove the duplicate hash schemes; drop `frames` from the hashed payload. 🟧 ⏱S ⚠low — *(C8)*
- [ ] **3.2** Make undo snapshots compact: store template id + ordered photo ids + rotations, not hydrated objects with URLs. Re-hydrate from `photoCache` on apply. 🟥 ⏱L ⚠med — *(C5)* — guard with undo/redo oracle.
- [ ] **3.3** Stop writing the full hydrated album to `localStorage`; persist compact state there, full state to `project.json`. Keep a backward-compatible loader. 🟧 ⏱M ⚠med — *(C5)*

## Phase 4 — UI memory / listener hygiene

- [ ] **4.1** Event-delegate Tab 6 (`renderPhotosGrid`) like redBox — one `pointerup` on `photosGrid`, no per-card closures/timers. 🟧 ⏱M ⚠low — *(C7)*
- [ ] **4.2** Virtualize Tab 6 grid via `IntersectionObserver` (render visible rows only). 🟧 ⏱L ⚠med — *(C7)* — memory-spike fix for 2,000-photo folders.

## Phase 5 — Resilience (silent failures)

- [ ] **5.1** Wrap all `https`/Firestore `JSON.parse` callbacks in try/catch; resolve typed errors. 🟧 ⏱M ⚠low — *(C6)* — **prevents main-process crash on a bad API response.**
- [ ] **5.2** Replace meaningful empty `catch {}` blocks with telemetry + aggregated user summary (adopt the proof-renderer aggregation pattern). 🟦 ⏱M ⚠low — *(C6)*
- [ ] **5.3** Remove all in-loop `alert()` from `build_page.jsx` / `export_album.jsx`; accumulate errors → single result JSON → one renderer toast. 🟧 ⏱S ⚠low — *(C6)* — **unblocks unattended 200-page exports.**

## Phase 6 — Low-priority efficiency

- [ ] **6.1** Adaptive Tools Bar poll interval (200 ms moving → 1 s idle). 🟦 ⏱S ⚠low — *(C10)*
- [ ] **6.2** Make thumbnail dimensions/quality named constants; document the proxy size contract. 🟦 ⏱S ⚠none — *(C1)*

---

## Suggested execution order (highest productivity/stability first)

```
0.1 → 0.2 → 0.3            (safety net + baselines)
1.2 → 1.1 → 1.3            (kill event-loop blocking + O(n²) HR scans)
1.4 → 1.5                  (thumbnail speed — biggest wall-clock win)
5.1 → 5.3                  (stop crashes + unblock unattended exports — cheap, high stability)
2.1 → 2.2                  (decouple auto-fill from DOM)
2.3 → 2.4                  (single state→view owner)
3.1 → 3.2 → 3.3            (snapshot/memory footprint)
4.1 → 4.2                  (Tab 6 listener + virtualization)
5.2 → 6.1 → 6.2            (polish)
```

Rationale: Phase 1's I/O fixes and Phase 5's crash/`alert` fixes are cheap, isolated, and immediately felt. The riskier architectural work (2.x state ownership, 3.x snapshots) comes after the safety net and benchmarks exist to catch regressions, with undo/redo as the built-in correctness oracle.

---

## Definition of done (per task)

1. `npm run typecheck` and `npm run lint` green.
2. Targeted smoke test passes (named per task in the PR).
3. Benchmark delta recorded vs. Phase-0 baseline (for 1.x, 3.x, 4.x).
4. Undo/redo round-trip reproduces identical album state (for 2.x, 3.x).
5. No new `catch {}` that swallows a user-meaningful failure.
