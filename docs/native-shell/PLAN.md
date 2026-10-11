# Native shell: status and remaining plan (2026-10-11)

## Done (branch `native-shell`; fork `native/photocraft` branch `album-studio`)

- `shell` — native Rust app on PhotoCraft 0.6.0: PhotoCraft editor + WKWebView in one window,
  album ↔ editor switching, `as://` protocol (app files, local images), Node helper bridge with
  restart, window drag/zoom, folder picker. 3 Rust tests; fmt + clippy clean.
- `backend` — Node helper: `album.open`, `album.recent`, `render.start|cancel|status|plan`.
  11 tests (one builds a real sheet with the engine).
- `render` — sheets built by PhotoCraft (no Photoshop): Wedding album 23 sheets in 3 min 49 s,
  cache + deleted-file re-render, RAW via macOS `sips`, frame-resolution embedding.
- `ui` — new interface: Albums, Plan, Review, Deliver (render with live progress),
  dark + light themes, error boundary. 10 tests.
- **Plan editing (step 1, done 2026-10-11)** — every edit is one undo step (⌘Z / ⇧⌘Z, top-bar
  buttons), saved at once in the Electron format (atomic, `project.json.bak`):
  - drag photos (one or a selection) from the pool onto the spread, a frame (replace/swap) or a
    spread in the strip; ⌥ copies; double-click or "Add to spread N" adds; drag off to the pool
    or ⌫ takes off; inspector rows reorder and accept drops;
  - templates: browser under the spread (fits / all, collection, search), Shuffle (S), and
    "Follow photos": a fitting template is picked when photos change (same collection first);
  - spreads: add before/after/end, move (strip drag, ⌥←/⌥→), clear, delete; Auto-fill dialog
    (exact count or min–max, capture-time order);
  - live proofs in the background after each edit (only changed spreads; moved ones keep their
    picture): PSD composite backdrop, real frame shapes/opacity/strokes, layer order, RAW via
    the camera's embedded preview. 20 spreads in 13 s, one spread 0.3–1 s;
  - print-sheet status from the render cache ("Changed since render").
  Backend 27 tests, UI 10 tests; interactions checked in the real web view through the
  debug-build script hook (`ALBUM_STUDIO_DEBUG_SOCKET`); browser preview: `node native/ui/dev/serve.mjs`.

Reusable from the Electron app without changes (checked): `src/proof_renderer.js`,
`src/psd_layers.js`, `src/overlay_render.js`, `src/renderer_pure.js`, `src/curation.js`,
`src/thumbnailer.js`, `src/sharp_config.js`. Need an `app.getPath` adapter: `src/library.js`,
`src/renamer.js`, `src/plugins.js`, `src/telemetry.js`.

## Next, in order

1. ~~Plan editing~~ (done, above). Open: per-photo crop/zoom and colour on the spread; the undo
   history is per helper session (it starts empty when the app restarts).
2. ~~New album flow~~ (done 2026-10-11): Albums → New album: photo folders (several, surveyed:
   photos, RAW, thumbnails to make), template collections suggested from earlier albums, name and
   place suggested ("Wedding Album" next to the shoot), print-sheet folder, plan N spreads now or
   start empty. Thumbnails are made only where missing (`_Thumbnails`, 400 px, sharp; RAW from
   the camera's embedded preview, `sips` fallback; same sizes as the Photoshop-made ones, 6 in
   0.1 s), then the project (Electron format) and the first plan; progress shown live.
3. ~~Deliver~~ (done 2026-10-11): step 2 under the render, "Files for the lab and the client":
   JPEG-High-Res (print height × ppi, default 12 in at 300 ppi = 10800 × 3600, quality 97, 4:4:4,
   sRGB, ppi set), JPEG-Low-Res (mozjpeg 25), "<Album> - Low Res.pdf" (JPEGs embedded as they are)
   — same folders and names as the Electron export, next to the sheets' folder. From the PSD's
   stored composite (engine export when it has none); unchanged sheets skipped. 23 sheets in 27 s,
   PDF 26 MB (Photoshop flow: 114 MB). Output folder change (undoable), Show in Finder.
   Not done: an HTML client gallery (the PDF covers proofing for now).
4. ~~Render parity~~ (done 2026-10-11): sheets carry the Electron spread editor's edits —
   template layer overrides (shown/hidden, opacity, moved/resized, retyped and resized/recoloured
   text; matched by PSD order and name, a renamed layer is skipped and reported), text as live
   type layers (family/weight/italic, size, leading, tracking, rotation about the box centre),
   shapes as one layer under the text, colour adjustments baked into a copy of the photo (same
   code as the previews). Checked on a real template and photos: sheet and preview agree.
   Same as before: page backgrounds don't apply to template spreads; a vignette is preview-only.
   Open: a font chosen for a template text layer (warned; the template's font is kept); the
   preview of a spread with template overrides loses frame strokes (the sheet is right).
5. **Editor**: merge the "← Album" strip into PhotoCraft's title bar, remove ArtCraft brand
   and Discord link (licence), colour-profile policy, Album Studio menu bar, actions on the
   open sheet (place photo, swap, wallpaper/PNG/mask) via `PhotocraftApp::run`.
6. **Library, Tools** (renamer, curation, retouch), settings, licence/sign-in.
7. **Packaging**: .app with bundled Node runtime, `photocraft-cli`, built UI; icon; signing.
8. **Retire Electron**.

## Known behaviour (not a bug)

WebKit stops painting a window that other windows cover, so a screenshot of a covered Album
Studio window is blank; the window repaints as soon as it shows. Tests verify through the page
(debug script hook) and capture only while the window is visible.
