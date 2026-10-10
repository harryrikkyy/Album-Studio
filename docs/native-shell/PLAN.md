# Native shell: status and remaining plan (2026-10-10)

## Done (branch `native-shell`; fork `native/photocraft` branch `album-studio`)

- `shell` — native Rust app on PhotoCraft 0.6.0: PhotoCraft editor + WKWebView in one window,
  album ↔ editor switching, `as://` protocol (app files, local images), Node helper bridge with
  restart, window drag/zoom, folder picker. 3 Rust tests; fmt + clippy clean.
- `backend` — Node helper: `album.open`, `album.recent`, `render.start|cancel|status|plan`.
  11 tests (one builds a real sheet with the engine).
- `render` — sheets built by PhotoCraft (no Photoshop): Wedding album 23 sheets in 3 min 49 s,
  cache + deleted-file re-render, RAW via macOS `sips`, frame-resolution embedding.
- `ui` — new interface: Albums, Plan (read-only), Review, Deliver (render with live progress),
  dark + light themes, error boundary. 4 tests.

Reusable from the Electron app without changes (checked): `src/proof_renderer.js`,
`src/psd_layers.js`, `src/overlay_render.js`, `src/renderer_pure.js`, `src/curation.js`,
`src/thumbnailer.js`, `src/sharp_config.js`. Need an `app.getPath` adapter: `src/library.js`,
`src/renamer.js`, `src/plugins.js`, `src/telemetry.js`.

## Next, in order

1. **Plan editing** (album creation): backend `album.update` ops (set spread photos, template,
   add/remove/move spread, auto-fill desired-sheets/min-max with EXIF order via
   `planAutoFillCounts`), atomic project.json writes (Electron-compatible format, `.bak`),
   undo/redo snapshots; `templates.list` (matching H/V); UI drag photo → spread, swap, remove,
   template picker, ⌘Z. Live proofs via `proof_renderer.renderProofBatch`.
2. **New album flow**: photo folders → thumbnails (`thumbnailer.js` + RAW via `sips`),
   template collections, output folder, sheet count.
3. **Deliver**: JPEG high/low (PhotoCraft `doc.save` + sharp), proof PDF (pure-JS writer),
   client gallery; output folder change.
4. **Render parity**: overlays (text/shapes PNG + text layers), template layer edits,
   page backgrounds, colour adjustments (bake via `proof_renderer.applyAdjust`).
5. **Editor**: merge the "← Album" strip into PhotoCraft's title bar, remove ArtCraft brand
   and Discord link (licence), colour-profile policy, Album Studio menu bar, actions on the
   open sheet (place photo, swap, wallpaper/PNG/mask) via `PhotocraftApp::run`.
6. **Library, Tools** (renamer, curation, retouch), settings, licence/sign-in.
7. **Packaging**: .app with bundled Node runtime, `photocraft-cli`, built UI; icon; signing.
8. **Retire Electron**.

## Known issue to watch

A web view left covered by other windows for ~10 minutes was captured blank once; it did
not reproduce in a 2-minute run and no interface error was logged. Recheck during step 1.
