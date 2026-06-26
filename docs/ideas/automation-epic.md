# Album Automation Epic — Plan & Decisions

Tracking doc for the multi-feature batch requested after the Phase-E layout work.
Each task is an independently shippable, verifiable slice. Locked decisions from
the sync are recorded so nothing drifts.

Legend: 🟥 high impact · 🟧 medium · 🟦 low · ⚠ risk · ⏱ effort

---

## Locked decisions (from sync)

- **Album Automation modes:** `ON` = the **full workspace** (cmd bar + pages +
  preview + source + templates ≈ today's Tab 1, screenshot 2). `OFF` = a
  **stripped Source | Templates–only** view (screenshot 1). Toggle sits below the
  tab bar in OFF mode and **beside the "Stage view" button** in ON mode. One
  boolean, persisted.
- **Template sync (A1):** nothing selected → show **all** templates. Hovering a
  page in the pages panel → templates matching **that page**. Source images
  selected → templates matching the **selection** (count + H/V). Sync OFF →
  always all templates.
- **Place (B1):** place the image into Photoshop's **active layer** as a
  **clipping mask**.
- **Adjustment layers on render (J1):** editable PS adjustment layers, clipped
  per photo: Exposure→**Exposure**, Contrast→**Brightness/Contrast**,
  Saturation→**Hue/Saturation**, Warmth→**Photo Filter (temperature)** +
  **Vibrance**.
- **PSD Resizer (F1):** 12 in height @ 300 ppi, proportional. Offer **both**
  overwrite-in-place and save-copies options.
- **Save As (E1):** write current project to a new file and continue in it.
- **New Project (E1):** clears **only** Source-panel folders + the Photos tab
  (everything else stays). Shows a save browser that allows **creating a new
  folder** and naming the project.
- **Thumbnail cache (add-on):** on loading any folder shown visually, look for a
  `_thumbnails` subfolder and use it; if absent, generate thumbnails into
  `_thumbnails` in the loaded folder (slow once, fast after) and preview from it.
- **Cross-shape swap (I1):** allow swapping two photos of different orientation;
  scale-to-fit into the new frame.

---

## Tasks (ordered: low-risk UI → editor → Photoshop → flow → export)

### Slice 1 — UI only, no Photoshop (verify each)
- [x] **G1** Collapsible folder-structure panel in every tab/view that has one
  (Source, Templates, Wallpapers, PNG, Masked, Photos). Shared mechanism; collapse
  chevron in the folder header; persisted per panel. 🟦 ⚠low — **DONE** (`src/ui_folders.js`).
- [x] **H1** Remove the color-adjust panel under the Pages panel (redundant with
  Edit Spread). 🟦 ⚠low — **DONE:** DOM removed; `updateAdjustPanel` is now a no-op
  stub; the adjustment *data model* is untouched (still used by preview/export/editor).
- [x] **E1** Save split-button → dropdown with **Save**, **Save As**, **New
  Project**. 🟧 ⚠med — **DONE:** `saveProject(forceNewPath)`, `newProject()` (confirmed,
  clears source+photos+album, keeps libraries/output/settings, saves to a new file).
- [x] **D1** Album Automation toggle. 🟥 ⚠med — **DONE:** OFF = Source|Templates-only
  (`.automation-off`), ON = full workspace. "⚡ Automation" button beside Stage view
  enters OFF; the automation bar's "Open full workspace ›" exits. Persisted; drops
  Stage view on entering automation.

### Slice 2 — Spread Editor
- [x] **I1** Right-click → "Swap" on two selected photos; cross-shape allowed
  (scale-to-fit). 🟧 ⚠med — **DONE** (context menu replaces the Swap button; main.js
  swaps orientation too so cross-shape re-derives frame assignment). ⚠ **Cross-shape
  swap persistence through the build pipeline is UNVERIFIED — needs a run + a build.**
- [x] **I2** Multi-select photos on the page; color sliders apply to all selected. 🟧 ⚠med
  — **DONE** (⌘/Shift-click multi-select; zoom/colour/reset apply to all selected).

### Slice 3 — Photoshop integration (higher risk)
- [x] **A2** Right-click template → "Open template" in Photoshop. 🟧 ⚠med — **DONE
  (needs PS verify):** whiteBox `contextmenu` → reuses `open-in-photoshop` IPC with
  `template.file.nativePath`. Generative templates (no PSD) are skipped.
- [x] **B1** Right-click source image → "Open in PS" / "Place" (active layer, clipped).
  🟧 ⚠med — **DONE (needs PS verify):** redBox `contextmenu`; new `placeClipped` JSX
  template + `place-clipped` IPC (Place + `GrpL` clip to the active layer). Opens the
  HR original when resolvable, else the proxy.
- [x] **F1** PSD Resizer tool (12in/300ppi, overwrite-or-copy). 🟧 ⚠med — **DONE
  (needs PS verify):** Tools-tab "PSD Resizer" card (overwrite toggle + folder pick +
  progress bar). New `scripts/resize_psds.jsx` (resizeImage → 3600px tall @ 300ppi,
  proportional; saveAs PSD overwrite-or-`Resized/`) + `resize-psds` IPC with progress
  polling. Overwrite is confirm-gated.
- [ ] **Thumb cache** `_thumbnails` generate/use across folder loaders. 🟥 ⚠med

### Slice 4 — Matching + build flow
- [ ] **A1** Sync on/off toggle gating template matching. 🟧 ⚠med
- [ ] **B2** Selection-driven + page-hover-driven template match. 🟧 ⚠med
- [ ] **C1** Double-click template → open in PS + place images (sync ON =
  matched set; OFF = sequential; drop extras / leave empty frames). 🟥 ⚠high

### Slice 5 — Export
- [ ] **J1** Render with editable clipped adjustment layers instead of baked pixels. 🟥 ⚠high

---

## Definition of done (per task)
`npm run typecheck` + `npm run lint` green · visual check (5 themes / both
automation modes) · no new inline styles or magic numbers · reduced-motion
respected for any motion · no regression to perf-critical grids · Photoshop
round-trips verified with `scripts/colormatch.js` where relevant (J1, C1).
