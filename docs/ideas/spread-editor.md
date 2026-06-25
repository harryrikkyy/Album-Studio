# Spread Editor ("mini Photoshop") — Design One-Pager

**Status:** Proposed — building incrementally, measure-first.
**Builds on:** `docs/ideas/live-design-engine.md` (validated preview==final + edit round-trip), `proof_renderer.js`, template frame geometry, `imageAdjustments`.

---

## Problem Statement

**How might we let the photographer directly manipulate a spread — select on the image, reposition/zoom within frames, swap photos, colour-grade — with Photoshop-like immediacy, while keeping every edit non-destructive and faithful to the final PSD export?**

---

## The architecture-defining decision

Direct manipulation needs ~60fps feedback. libvips composites a page in ~100–300ms — far too slow per mouse-move. Resolution: a **two-layer model**.

- **Interaction layer = DOM/CSS scene.** Render the template backdrop once; place each photo as an `<img>` inside a clip-box positioned at its frame rectangle (`template._frames` = `{x,y,w,h}` + canvas size). Pan/zoom/drag mutate CSS `transform` — instant, GPU-accelerated.
- **Truth layer = libvips.** On gesture-release, persist the gesture as non-destructive params and composite the real thing (the engine already validated to match the PSD export).

"DOM for feel, libvips for truth" — the same split that made the live preview work, extended from viewing to manipulating.

---

## What's reused vs. new

**Reused:** libvips composite, frame geometry extraction, `imageAdjustments` + the export bake/round-trip, the separate-window pattern (Renamer), the `colormatch` harness.

**New core capability — a per-photo placement transform** `{ scale, ox, oy }` within its frame:
- `scale` ≥ 1 (1 = cover-fit, >1 = zoomed in)
- `ox, oy` ∈ [-1, 1] (pan within the available overscan; 0 = centered)

Today photos are auto cover-fit + centered (fixed). On-canvas zoom/pan is just editing this transform. Applied in three places: the DOM scene (live), `buildPhotoLayer` (preview/proof), and the build JSX (final PSD).

---

## The window

```
┌──────────┬─────────────────────────────────┬───────────┐
│ SPREADS  │           WORKSPACE             │  ADJUST   │
│ (thumbs) │  template backdrop + photos     │  Exposure │
│  001 ◀   │  • click a photo to select      │  Contrast │
│  002     │  • drag = pan within frame      │  Satur.   │
│  003     │  • wheel / handles = zoom        │  Warmth   │
│  ...     │  • drag onto another = swap     │  Reset    │
└──────────┴─────────────────────────────────┴───────────┘
```

Color during drag uses a CSS-filter approximation for instant feedback; the authoritative libvips composite renders on release.

---

## Key assumptions to validate (measure-first, in order)

- [ ] **Placement round-trips to the PSD.** The build JSX must reproduce the exact zoom/pan set on canvas. *Test: inject a deliberate off-center zoom, render libvips + export PSD, compare with `colormatch`.* Make-or-break, same as crop/orientation were.
- [ ] **Clip-box geometry == frame geometry** at display scale (what you drag is where it lands).
- [ ] **DOM scene stays smooth** on a dense spread — proxies in the canvas, HR only at export.

---

## Placement transform — the maths (libvips)

Given source `sW×sH`, frame `fW×fH`, transform `{scale, ox, oy}`:

```
coverScale = max(fW/sW, fH/sH)
s          = coverScale * scale            // scale ≥ 1
cropW      = round(fW / s)                 // visible source window
cropH      = round(fH / s)
maxLeft    = sW - cropW                     // overscan slack
maxTop     = sH - cropH
left       = clamp(round(maxLeft/2 + ox*maxLeft/2), 0, maxLeft)
top        = clamp(round(maxTop/2  + oy*maxTop/2 ), 0, maxTop)
extract({left, top, cropW, cropH}).resize(fW, fH, fill)
```

`scale=1, ox=0, oy=0` reduces exactly to today's cover-fit + centered (parity preserved). This generalizes the existing focal-crop branch.

---

## MVP scope (one coherent slice)

An Editor window that, for the **current spread**: renders the DOM scene from frame geometry + proxies; **click-select a photo on the canvas**; **pan + zoom within its frame**; **swap two photos by dragging**; right-panel colour sliders bound to the selection; left-panel spread thumbnails to navigate. Placement + colour persist and apply in the libvips preview.

---

## Not doing (and why)

- **Freeform layers / masks / brush retouch / text** — that's real Photoshop; keep edits *frame-constrained* (photos live in template slots, controlled within). Keeps it shippable and keeps preview==final tractable.
- **Adding/removing/resizing frames** — frames come from the template.
- **HR in the canvas** — proxies for interaction, HR only at export.
- **Per-gesture libvips re-render** — kills the feel; render on release.

---

## Open questions

- Placement key: per (page, frame slot) vs (photo, page). Leaning page+frame (it's about the slot).
- Swap: exchange photo identities only; each frame keeps its own placement transform (matches `Swap_Clipped_Images.jsx`).
- Does the Editor eventually replace the Tab-1 green-box compose flow, or remain the "fine-tune" stage alongside it?

---

## Build order (measure-first)

1. [x] **Placement transform in libvips** (`buildPhotoLayer`) + self-test parity at scale=1.
2. [x] **Placement in the build JSX** (parameterize resize/translate) + `colormatch` round-trip validation.
3. [x] **Editor window shell** (3-pane) + DOM scene render from frame geometry.
4. [x] **On-canvas select + pan/zoom** → writes placement params → libvips preview on release.
5. [x] **Drag-to-swap** (shipped as arm-then-click-two, to avoid colliding with the pan gesture); colour sliders wired to selection.
6. [~] **Export bake** uses placement everywhere; final harness pass (math parity verified; PS-vs-live comparison still to run).
