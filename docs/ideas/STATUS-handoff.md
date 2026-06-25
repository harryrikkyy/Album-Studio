# Project Status & Handoff — Album Toolkit

A running record so work can resume in a fresh session without losing context.
Last updated at the end of the Spread Editor placement-bug fix.

---

## How the app is built / run

- **Run in dev:** `npm start` (Electron). The user works in dev, NOT from the DMG.
- **Build DMG:** `npm run build:mac` → `dist/Creative Hubb Album Toolkit Pro-1.0.0-arm64.dmg` (ad-hoc signed, arm64). Only build when the user wants to test the packaged app.
- **Validate:** `node --check <file>` and `npx eslint <files>`. Build runs typecheck+lint first.
- **sharp is built for Electron's ABI** → standalone scripts must run as:
  `ELECTRON_RUN_AS_NODE=1 npx electron <script.js>`
- **App log:** `~/Library/Logs/Creative Hubb Album Toolkit Pro/app.log` (electron-log).
  Telemetry events go here via the `telemetry-event` IPC.

---

## Major features shipped this engagement

1. **DMG packaging** + bundled `.env` (credentials ship in-app), automation
   entitlements (`build/entitlements.mac.plist`) + `NSAppleEventsUsageDescription`,
   and `build/Uninstall.command` (trashes app + resets TCC perms via `tccutil`).
2. **Bug fixes:** Swap-2-Images asar path (read jsx → temp file in
   `photoshop.js`); Clear-album dropdown in glass themes (`.row:not(.cmd-bar)`);
   Tools Bar docking (removed unreliable `visible` flag; multi-display clamp;
   NOAX detection; AX permission prompt); app dock-dot/Cmd-Tab (removed
   `skipTaskbar`, re-assert `regular` activation policy).
3. **Renamer** feature (`src/renamer*.{js,html}`, `renamer_naming.js`).
4. **Perf/UI pass:** proof-path readdir→cached HR index; unified selection
   tokens; folder-rail full names+counts; empty states w/ action buttons;
   drop-zone highlight; source→page drag; parallel proof batch (pool of 4).
5. **Live Design Engine** (`docs/ideas/live-design-engine.md`) — VALIDATED
   preview==final via `scripts/colormatch.js`. Live current-spread composite
   preview (🪄 Live toggle in Preview pane). Non-destructive **adjustments**
   (exposure/contrast/saturation/warmth) keyed per-photo-id in
   `projectData.imageAdjustments`, applied in `proof_renderer.buildPhotoLayer`
   via `applyAdjust`, baked into the PSD export (`bake-adjusted-source` IPC +
   `bakeExportAdjustments`).
6. **Spread Editor** (`docs/ideas/spread-editor.md`) — IN PROGRESS, see below.

---

## Spread Editor — current state

A separate "mini Photoshop" window: left = spread thumb, center = workspace
(click a photo on the page, drag to pan, scroll to zoom), right = sliders.

**Files:** `src/editor.html`, `src/editor_renderer.js`. Opened via the
**🎨 EDIT SPREAD** button (green-box toolbar). IPC in `app.js`:
`editor-open` (caches payload + opens window), `editor-get-spread`,
`editor-apply` (relays edits to main window as `editor-changes`).
`main.js` builds the payload (`buildSpreadPayload`) and persists edits
(`editor-changes` listener → `projectData.imagePlacements` / `imageAdjustments`).

**Placement transform** `{ scale≥1, ox∈[-1,1], oy∈[-1,1] }` per photo id:
- Renders in `buildPhotoLayer` (libvips) — validated: scale=1 is pixel-identical
  to cover-fit-centered; zoom/pan work.
- Round-trips to Photoshop via parameterized `placeAndFit` in
  `scripts/build_page.jsx` AND `scripts/build_pages_batch.jsx` (math matches
  libvips; signs verified by hand).
- Threaded through `buildSpreadPayload`, `buildExportData`, `_generateProofForPage`,
  the proof hash, and `_hashPage` (dirty-tracking).

### Build order (from spread-editor.md)
- [x] 1. Placement transform in libvips (+ parity self-test)
- [x] 2. Placement → Photoshop round-trip (both JSX builders)
- [x] 3–4. Editor window shell + DOM scene + select + pan/zoom + color sliders + apply-back
- [x] 5a. **Swap** two photos — arm-then-click-two gesture (⇄ Swap photos button
      in the header; Esc cancels). Swaps photo identities between two
      same-orientation frames; each photo keeps its own per-id placement +
      colour. Local DOM swap for instant feedback + `editor-swap` IPC →
      `app.js` relay → `main.js` reorders `albumPages[page].photos` (via
      `mutate`, so it's undoable) and refreshes the live preview.
- [x] 5b. **Spread navigation** in the left rail — `buildSpreadPayload` now emits
      a lightweight `spreads[]` (every editable page + backdrop thumb); the rail
      renders all spreads, clicking a non-current one flushes pending edits then
      fires `editor-goto` → `main.js` rebuilds that page's payload and pushes it
      back via `editor-open`/`editor-spread-updated` → editor reloads.
- [~] 6. Final `colormatch` round-trip pass. Math parity **verified statically**:
      the libvips crop-window overscan × scale `s` equals the PS display-space
      overscan (`pb.w − fb.w`), signs match (`ox=+1` reveals the right part in
      both), and `scale=1,ox=0,oy=0` reduces to cover-fit+centered in all three
      renderers. `build_page.jsx` and `build_pages_batch.jsx` `placeAndFit` are
      identical. Harness smoke-tested OK under Electron. **Still pending:** the
      real PS-vs-live comparison (needs Photoshop) — build a page with a
      deliberate off-center zoom, then:
      `ELECTRON_RUN_AS_NODE=1 npx electron scripts/colormatch.js <PS_export.jpg> "$TMPDIR/albumstudio_proofs/live_page_NNN.jpg" --out /tmp/cm`

### Placement build-fix — CONFIRMED
`buildExportData` now includes `placement: projectData.imagePlacements?.[photo.id] || null`
(main.js ~3442), alongside `adjust`, so the PS build applies zoom/pan (not just
colour). Verified present in code. Temporary diagnostics REMOVED:
`app.js` `editor-apply` telemetry and `main.js` `btnAutoThis` `build_page_edits`
block are both gone.

---

## Known naming wart
The **"Auto Fill This Page"** button (`btnAutoThis`) actually **builds the
current page in Photoshop** (`build-page`) — it does not re-fill/arrange.
Consider renaming to "Build This Page". (`btnAutoAll` is the real all-pages flow.)

---

## Key data model (per photo id, in projectData, persisted with project)
- `imageRotations[id]` = degrees (existing)
- `imageAdjustments[id]` = `{ exposure, contrast, saturation, warmth }` (−100..100)
- `imagePlacements[id]` = `{ scale, ox, oy }`
All three are read by: preview (`_generateProofForPage`), export (`buildExportData`),
and applied in `proof_renderer.buildPhotoLayer` (libvips) + the build JSX (Photoshop).

---

## Honest caveats
- DMG is ad-hoc signed: Gatekeeper right-click→Open; TCC perms may need re-granting per rebuild.
- Editor canvas **warmth** is a CSS approximation; exposure/contrast/saturation are accurate; libvips is the source of truth.
- Editor rotation 90/270 placement handled but less tested than 0/180.
- Swap is implemented (arm-then-click two same-shape photos). It swaps which
  frame each photo occupies by reordering `albumPages[page].photos`; placement +
  colour are keyed per photo id, so they travel with the photo into its new slot.
- Final colormatch PS round-trip not yet run with a live Photoshop build (math
  parity verified statically; harness ready).
