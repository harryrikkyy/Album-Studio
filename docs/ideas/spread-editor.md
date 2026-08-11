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

- ~~**Freeform layers / masks / brush retouch / text**~~ — **text and shapes now ship** (see "Overlay layers" below). Masks and brush retouch remain out: that's real Photoshop, and Tab 8's Retouch panel already drives PS directly for those.
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
7. [x] **Overlay layers** — text + shapes on the page (below).

---

## Overlay layers (text & shapes)

The window is now the **Page Editor**: it edits the page, not just the photos in it.

### The decision that makes this safe: one SVG generator

`src/overlay_render.js` turns a page's layer list into an SVG. It has exactly one implementation and three consumers:

| Consumer | How it loads it | What it does |
|---|---|---|
| Page Editor | plain `<script>` → `window.OverlayRender` | injects the SVG into the stage as the live preview |
| `proof_renderer` | `require` | composites it over the proof / generative HR export |
| Photoshop build | `require` → `resolveTextLayout()` | rebuilds text as **native, editable** PS text layers; shapes go through `rasterizeOverlays()` as one PNG |

The preview is not a lookalike of the export — it is **the same document** (or, on the Photoshop leg, built from the same resolved layout). WYSIWYG is structural rather than two code paths kept in sync by hand.

Two consequences worth stating:

- **Geometry is normalized** (fractions of canvas; font size is a fraction of canvas *height*). A layer renders identically on a 1500px proof and a 7000px final composite. This is what lets the editor trust its own preview.
- **Wrapping is computed in the generator**, not delegated to the renderer. SVG has no auto-wrap, and librsvg and Chrome would otherwise break lines differently. `estimateAdvance` is a deterministic width table — its job is for both sides to agree with *each other*, not to match a font spec.

### Editable PSD text without losing the guarantee

The delivered PSD must stay editable — a client should be able to retype a name in Photoshop. The obvious risk is that Photoshop re-flows the copy against its own font metrics and the delivered page quietly stops matching the approved proof.

The way out is that **the app has already decided where the lines break**. `resolveTextLayout` returns the wrapped lines; `overlay_ps.js` hands each one to Photoshop as a hard line (`\r`) inside a **POINT** text layer. Photoshop is therefore never asked to make a wrapping decision and cannot make a different one. `test/overlay_ps.test.js` asserts the PS lines equal the `<tspan>` lines the SVG renders — if that ever drifts, the suite fails.

What still differs, and is accepted:

- **Line widths**, slightly. Our advance-width estimate is not the real font's, so a centred line can sit a pixel or two off, and a line tuned to kiss a photo edge deserves one look. (Both paths share the estimate, so the *proof* has the same offset — the PSD matches the proof, and both may be a hair off the ideal.)
- **Shapes are still raster.** Only text is native. The shape PNG is placed below the text layers, so captions sit above rules and boxes; interleaving a shape *above* text isn't reproduced in the PSD.
- **Fonts are mapped by table.** Photoshop wants PostScript names (`Georgia-Italic`), not CSS family + weight. `PS_FONTS` covers the families the editor offers, picks the nearest available weight, and sets `fauxItalic` when a family ships no italic cut. An unmapped name leaves Photoshop's default rather than failing the page.

### Data model

Overlays live on `projectData.pageOverlays[pageNum]` — keyed by **page**, unlike `imageAdjustments`/`imagePlacements` which are keyed by photo id so they follow a photo when it moves between pages. `pageBackgrounds[pageNum]` holds an optional page background colour.

Both are in `_hashPage`, so retyping a caption invalidates the render cache even though no photo changed.
