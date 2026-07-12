# Phase 4 — performance baselines & targets

Measured on the developer Mac (Apple Silicon) against the synthetic
fixture (`node bench/make_fixture.js 200` → 400 photos + 600px thumbnails
+ a 200-page project). Regenerate the fixture before re-running; it is
gitignored.

## Harness

| Command | Measures |
| --- | --- |
| `node bench/make_fixture.js [pages=200]` | Builds the fixture (photos, thumbs, project JSON). |
| `node bench/proof_bench.js [pages=30]` | Fast proof renderer latency + peak RSS (standalone node). |
| `node bench/app_bench.js [pages=200]` | Startup, project load, page nav, storyboard build, per-process memory (Playwright-Electron, isolated profile). |

## Baseline (2026-07-12)

| Metric | Baseline | Target | Status |
| --- | --- | --- | --- |
| Cold startup → workspace visible | **1.08 s** | < 2.5 s | ✅ |
| Load 200-page project (into store) | **3 ms** | < 250 ms | ✅ |
| Page navigation (changePage) | **0.1 ms** median | < 16 ms | ✅ |
| Storyboard build (200 pages) | **6 ms** | < 100 ms | ✅ |
| Proof render, per page | **106 ms** median, 114 ms p95 | < 250 ms | ✅ |
| Proof throughput | **9.2 pages/s** | — | — |
| Peak RSS, proof bench (30 pages) | **133 MB** | < 1 GB | ✅ |
| Total app memory, 200-page album loaded | **685 MB** | < 1.5 GB | ✅ |

## Notes / findings

- **The "startup takes ~4 s" symptom was a measurement/robustness bug, not
  module cost.** A second app instance sharing the developer's userData
  profile blocks ~3.7 s on its first synchronous `localStorage` read,
  waiting on the DOM-storage LevelDB lock held by the first instance.
  Fixed by (a) a single-instance lock in `app.js` (a second launch focuses
  the running window instead of fighting over the profile) and (b) an
  isolated userData profile for tests/benches (`ALBUMSTUDIO_USER_DATA`,
  guarded by `!app.isPackaged`). Side effect: the E2E suite went from ~20 s
  to ~5 s.
- Store/DOM operations (load, nav, storyboard) are already well inside
  frame budget on 200 pages — no virtualization needed at this size.
- The proof renderer is the one real compute cost (~22 s for 200 pages).

## Scale test (500 pages / 5000 source photos)

| Metric | Value |
| --- | --- |
| 500-page project load | 4 ms |
| 500-page storyboard build | 12 ms |
| 500-page total app memory | 688 MB |
| 5000 source-pool wrappers, DOM build | 14 ms |
| 5000 source-pool wrappers, renderer mem | 321 MB (684 MB total) |

## Decisions (evidence-based)

- **Worker-thread sharp offload — NOT done.** During a 20-page proof batch,
  a 20 ms interval fired at 21 ms median / 21.5 ms p95 / 48.7 ms max, with
  **zero gaps over 50 ms**. `sharp` already runs its pixel work on the
  libvips threadpool, off the main JS thread, and the JS orchestration
  between ops does not block the event loop. A `worker_thread` would add
  serialization overhead for no measured responsiveness gain.
- **Grid virtualization — NOT needed at the target scale.** Pages/storyboard
  handle 500 pages in single-digit ms; Tab 6 (Photos) is already virtualized
  with an IntersectionObserver; the Tab 1 source pool builds 5000 wrappers in
  14 ms and stays within memory budget. (Caveat: the 5000-photo test cycles
  ~400 unique thumbnails, so Chromium dedupes decodes — with fully-unique
  images the decode-cache working set is larger but bounded by Chromium's
  off-screen LRU eviction. If a real large shoot ever shows memory pressure,
  the source pool is the place to add the same IntersectionObserver pattern
  Tab 6 uses.)
- **Finer proof invalidation / thumbnail-cache reuse — NOT pursued.** The
  render cache already skips unchanged pages (Phase 1 `partitionByRenderCache`),
  and proof latency (106 ms/page) is well inside target, so there is no
  measured problem to solve here.
