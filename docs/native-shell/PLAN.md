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

Shared with the Electron app and used by the helper today (`src/`): `proof_renderer.js`,
`psd_layers.js`, `overlay_render.js`, `overlay_ps.js`, `editor_geometry.js`, `curation.js`,
`sharp_config.js`, `license.js`, `firebase_auth.js`, `autofill_counts.js` and `exif_date.js`; the
licence issuer uses `license_signing.js`. The other Electron-only modules have been removed.

## Next, in order

1. ~~Plan editing~~ (done, above). Added 2026-10-12, from the owner's first real use:
   - turning photos (corner buttons, the selection bar, the spread's photo tools, ⌘L/⌘R, the
     Photo menu): `imageRotations`, page photos' orientation swapped, templates follow;
   - templates for the photos selected in the pool (the selection bar's Templates button), and a
     click puts them on the spread (empty) or a new one after it;
   - move and zoom a photo in its frame (double-click it): `imagePlacements`;
   - Inspector › Photo: turn, move & zoom, take off, colour (exposure, contrast, saturation,
     warmth, black & white): `imageAdjustments`, previewed live on its thumbnail;
   - Edit spread renders the spread first when its sheet is missing or out of date;
   - one page shape per album: automatic picks keep to it, other sizes are marked; templates
     with a frame parked off the page are skipped by automatic picks.
   Open: the undo history is per helper session (it starts empty when the app restarts); text,
   shapes and template-layer edits made in the Electron spread editor still render but are
   edited in the PhotoCraft editor, not on the spread.
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
5. ~~Editor~~ (done 2026-10-11): "← Album" leads the editor's own title bar; no ArtCraft mark,
   Discord or community links anywhere (brand licence), plain-text credit in About (editor and
   album) and `native/NOTICE`; window title "… — Album Studio". macOS menu bars: the album's
   own (standard Edit items, so web text fields copy and paste; album commands to the page)
   and PhotoCraft's in the editor only; Quit/close go through the editor's unsaved-work prompt.
   Colour policy checked, unchanged: sRGB working space, embedded profiles kept, no prompt for
   profile-less sheets, a prompt on a real mismatch. Sheets saved from the editor: marked
   "Edited in the editor", kept by every render unless chosen one by one (with a warning), and
   their previews redrawn from them on return to the album.
   Open: album actions inside the editor (place photo, swap, wallpaper/PNG/mask) — use Plan for
   now; upstream test `mask_thumbs_ui::a_new_mask_is_targeted…` fails on the fork as received,
   and `gpu_startup::returned_non_graphics_errors…` is flaky (both upstream).
6. ~~Library, Tools, settings~~ (done 2026-10-11):
   - Album settings (click the album name): photo folders and template collections changed
     after creation, thumbnails for new folders, one undo step; removing a folder keeps its
     placed photos (shown missing).
   - Library: the template collections albums use plus added ones, browsable by frame layout and
     name, "for new albums" defaults (New album uses them), use/remove in the open album; it
     only remembers folders.
   - Tools › Lab naming (the Renamer): an order folder or the album's print JPEGs, live names
     (00, zz, "<order> (NN)", custom_NNN, cover pad "ZZZ--…--N+1", special laminations),
     drag to reorder, collision-safe rename with undo; renamed folders open as they were left.
   - Tools › Best picks (curation): scores from thumbnails (RAW included, cached), live limits,
     bursts among nearby frames only, keep/drop by hand, copy picks (RAW + JPEG) to _Selected,
     or plan the album from the picks. Wedding: 176 → 171 picks in seconds.
   - Settings (⌘,, gear): appearance, templates follow photos, default spreads, print size,
     storage per cache with Clear.
   Not ported: Retouch (Photoshop actions; use the editor's own adjustments), the floating Tools
   Bar and image swap (Photoshop-only).
   - Account (done 2026-10-11): Creative Hubb sign-in and subscription check, the Album
     Toolkit's rules and accounts (`native/backend/lib/account.js`): Google sign-in in the
     browser (loopback 127.0.0.1:9842, `state` checked), Firebase session, Firestore record
     (activated, expiry, one machine), signed licence for offline use; it shares
     `~/.ch_toolkit_license` / `~/.ch_toolkit_session` with the Album Toolkit. The helper answers
     only account.* / system.* until the check passes. Sign-in screen, Settings › Account.
7. ~~Packaging~~ (done 2026-10-11, ahead of 6): `native/scripts/package-mac.sh` builds
   `native/dist/Album Studio.app` (124 MB): release shell + PhotoCraft engine, the interface,
   the helper with exactly the Electron modules and packages it needs
   (`collect-backend.mjs`), the Album Studio icon, NOTICE + licence texts (npm, PhotoCraft,
   fonts, icons, every Rust crate), ad-hoc signature. Tested from the bundle: opened an
   album, rendered 3 sheets with the bundled engine, drew the previews.
   Node.js 22.23.3 (nodejs.org, SHA-256 pinned) is bundled (done 2026-10-11), so nothing needs
   installing. Sign-in settings are never built in by default (`ALBUM_STUDIO_SIGNIN_ENV` opts
   in): each Mac supplies its `.env`, as with the Album Toolkit.
   Open: Developer ID signing and notarisation for other Macs (needs Creative Hubb's Apple
   developer certificate; the script signs Node with the hardened runtime when given one).
8. ~~Retire Electron~~ (done 2026-10-11, in this copy; the original folder keeps the Album
   Toolkit): the Electron main process, renderer, Photoshop bridge and JSX scripts, Playwright
   e2e, electron-builder and their tests are gone. `src/` keeps only the 15 shared modules the
   helper uses (planning, proofs, PSD, curation, licence) and their tests; `server/` (licence
   activation) and the Firebase rules stay. `package.json`: `npm run build | start | test |
   lint | typecheck`; CI runs lint, typecheck, audit and all tests on macOS. Albums made by
   the Album Toolkit open unchanged (same `project.json`).

## Known behaviour (not a bug)

WebKit stops painting a window that other windows cover, so a screenshot of a covered Album
Studio window is blank; the window repaints as soon as it shows. Tests verify through the page
(debug script hook) and capture only while the window is visible.
