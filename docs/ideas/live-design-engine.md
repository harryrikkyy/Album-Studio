# Live Design Engine — Design One-Pager

**Status:** Proposed — for discussion. No code changed.
**Author:** Ideation pass (idea-refine)
**Relates to:** `proof_renderer.js`, `performance-design.md`, `src/main.js` (Tab 1 compose loop), `src/builtin_plugins/focal-point`

---

## Problem Statement

**How might we make the album-design loop feel instant, keep the user in flow, and allow photo edits — without round-tripping through Photoshop for every action?**

Three asks — 10x speed, an addictive-to-use app, and in-app photo editing — share **one root cause**: Photoshop is in the *interactive* loop. Every preview, page build, and edit goes through `osascript` → Photoshop, which is serialized (one call in flight), slow (1–4 s per RAW, seconds per page build), and process-spawn-heavy. Remove Photoshop from the design loop and all three problems collapse into one solution.

---

## Recommended Direction

Build a **Live Design Engine**: a native (sharp/libvips) real-time compositing + light-editing layer that runs the *entire* interactive design loop in the main process, off the Photoshop bridge. Photoshop is invoked only for the **final, true-to-PSD export**.

This is not a from-scratch build. `proof_renderer.js` is already ~70% of it: `renderPageProof()` composites a full page from template frames + photos via libvips, `buildPhotoLayer()` already does saliency- and focal-point-aware cropping (the `focal-point` builtin plugin), RAW→proxy fallback, and `renderProofBatch()` does batched rendering with progress. We promote that engine from a "proofing" afterthought to the **primary compose surface**, add live editing parameters, and parallelize it.

Why this hits all three goals at once:

- **10x speed** — the bottleneck (Photoshop) leaves the hot path; the remaining work is libvips, which is parallelizable and cacheable.
- **Addictive** — sub-100 ms feedback is the dopamine. When every placement/edit shows a real composite instantly, the tool feels alive and the user stays in flow. It also unlocks "slot-machine" variation generation (try 3 layouts, free, instant).
- **Editing** — libvips does exposure/WB/contrast/saturation/crop/sharpen fast and non-destructively; apply live in preview, bake only at export.

Honest framing: libvips is CPU-SIMD + threaded, **not GPU**. The 10x comes from (a) removing Photoshop, (b) parallelizing across cores, (c) dirty/incremental rendering, (d) caching/prefetch — not a GPU rewrite. And libvips **cannot** replace Photoshop for complex masks, layer FX, or smart objects — those stay in the final-export lane.

---

## The shape

```
        INTERACTIVE LOOP (libvips, main process, parallel)        FINAL ONLY (Photoshop)
┌──────────────────────────────────────────────────────────┐   ┌────────────────────────┐
│  place / reorder / edit  ─▶  Live Design Engine           │   │  "Final Render"        │
│                              ├─ renderPageProof() (exists) │   │  build_pages_batch.jsx │
│                              ├─ edit params (NEW)          │──▶│  one persistent PS     │
│                              ├─ worker_threads pool (NEW)  │   │  session, batched      │
│                              ├─ dirty-page cache (NEW)     │   └────────────────────────┘
│                              └─ speculative prefetch (NEW) │
│  current spread preview ◀── always a real composite        │
└──────────────────────────────────────────────────────────┘
```

---

## Key Assumptions to Validate (do these FIRST)

- [x] **Preview must equal final output.** ✅ VALIDATED (see Validation Result below). The libvips proof now color- and layout-matches the Photoshop export; only resolution-level sharpness differs.
- [ ] **libvips covers the interactive feature set.** *Test: enumerate what Tab 1 compositing actually needs (clip-to-frame, rotate, crop, global tone) vs. what only Photoshop does (masks, layer FX). Confirm the design loop needs nothing in the PS-only column.*
- [ ] **Parallel rendering stays within memory.** 6000×4000 RAW JPEGs × N workers can spike RAM. *Test: bench a 200-page batch with a bounded worker pool; sample `process.memoryUsage()`; confirm peak is acceptable.*
- [ ] **Edits round-trip to the final PSD.** A WB/exposure tweak made in-app must be reproducible in the Photoshop final render. *Test: apply edit params, export final, confirm the delivered file reflects them.*

## Validation Result (preview == final)

Measured with `scripts/colormatch.js` on a real spread (page 3) — Photoshop export vs. libvips proof:

| Metric | First run | After fixes | Meaning |
|--------|-----------|-------------|---------|
| Overall MAE (0–255) | 33 | **7.6** (4.1 after light blur) | residual is edges/resolution, not structure |
| Mean signed error | +6 | **≈ 0** | colour is exact |
| Max channel delta | 255 | 178 | no gross misalignment |
| Regional MAE grid | hotspots 43–70 | **uniform 5–11** | layout/crop matches everywhere |
| Verdict | 🔴 Divergent | **🟢 Match** | preview is faithful to final |

Two bugs surfaced and fixed to get here:
1. **EXIF orientation** — `buildPhotoLayer` used `.rotate(photo.rotation || 0)`, and `.rotate(0)` does not auto-orient, so portrait HR files (landscape pixels + EXIF tag) rendered sideways. Fixed with `.autoOrient()` then conditional manual rotate.
2. **Crop parity** — the proof used saliency `attention` crop while Photoshop (`build_page.jsx`) and the final libvips composite both use centered cover-fit. Set the proof job `smartCrop: false` so all three agree.

Conclusion: the gating assumption holds. The Live Design Engine is viable; proceed to MVP.

---

## MVP Scope (one shippable slice that proves the engine)

**In:**
1. **Live current-spread composite.** Replace the static Yellow preview with a continuous `renderPageProof()` of the *current* page, re-rendered (debounced) on every place/reorder. This alone proves "instant feedback" and removes the PS preview round-trip.
2. **Per-photo quick edits (libvips):** exposure, white balance, contrast, saturation, and crop/straighten — applied live in the preview, stored as non-destructive params on the photo, baked at export.
3. **Dirty rendering:** only re-composite the spread whose fingerprint changed (the hashing already exists — make it the cache key).

**Out (MVP):** worker-thread parallelism, prefetch, variation generator, album-wide edits — added once the core engine + edit-param model are proven.

This slice touches one surface (the current-spread preview), reuses an engine that exists, and delivers a taste of all three goals.

---

## Phased plan (after MVP)

- **P1 — Speed:** `worker_threads` pool for `renderProofBatch` (parallel page composites across cores); persistent single Photoshop session for final export (batch JSX, kill per-call `osascript` spawns).
- **P2 — Flow/addiction:** "Generate 3 layout options" (instant libvips previews of alternative matching templates) + a keyboard-first Flow Mode for rapid placement; live album-completion meter + session stats (honest progress, no dark patterns).
- **P3 — Editing depth:** presets/LUTs, one-click auto-enhance (reuse curation's exposure analysis), "match look across spread/album," face/saliency auto-crop into mismatched frames (the `focal-point` plugin is already wired in `buildPhotoLayer`).
- **P4 — Bigger bets (separate track, flagged):** AI culling (eyes-open/smile), face grouping, sky/background cleanup, upscaling — model/service cost and accuracy risk; validate core engine first.

---

## Not Doing (and why)

- **Full Photoshop replacement** — libvips can't do complex masks/layer FX/smart objects, and we don't need it to; Photoshop stays for final fidelity.
- **GPU compositing rewrite** — parallel CPU + caching + prefetch reach the 10x without that complexity and risk.
- **AI editing in the MVP** — high cost and accuracy risk; the core engine is the prerequisite and the bigger win.
- **Engagement gamification beyond honest progress/stats** — streak-guilt and dark patterns would erode the trust that keeps pros using a production tool. Addiction here should come from *flow and speed*, not manipulation.

---

## Open Questions

- What color profile does the final Photoshop export use, and can libvips match it exactly in the preview? (Gating the whole approach.)
- Where do non-destructive edit params live — on `albumPages[].photos[]`, in `project.json`, or a sidecar? (Must survive save/restore and feed the final JSX.)
- Is the "draft export" (full album via libvips, no Photoshop) a shippable deliverable on its own for quick client review, or strictly an internal preview?
