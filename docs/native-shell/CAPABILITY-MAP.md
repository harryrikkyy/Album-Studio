# Capability Map: Album Studio native shell (Option 3)

Status: **APPROVED 2026-10-10** with these decisions:

- Background logic runs as a bundled Node.js helper first, ported to Rust piece by piece later.
- Rust toolchain installed on this Mac; Rust shell, not Swift.
- Mac only for now.
- **A new UI** for the whole app, designed from scratch (owner gave a free hand on design and
  on any change needed for production grade). Added as module `ui` below.

## Goal

Replace Electron and Photoshop with a native Mac app that hosts the full PhotoCraft
editor natively (Metal, all of the Mac's memory, the Mac's fonts, full control), renders
album sheets with PhotoCraft, and keeps every Album Studio feature working.

## Measured basis (10 Oct 2026, PhotoCraft 0.6.0, this Mac)

- PhotoCraft reproduces all 23 Wedding templates within 0.1/255 of Photoshop's render.
- PhotoCraft builds a sheet in ~10 s (Photoshop 13–15 s), files 190–320 MB.
- Native PhotoCraft opens a 1.58 GB sheet in 1.8 s; the web build crashes on it.
- Known gaps found in testing: RAW needs macOS development (sips), fill-layer frames
  need mask bounds, photos must be embedded at frame resolution, headless automation
  refuses `file.placeEmbedded` (use open + `layer.copyToDocument`).

## Modules

| Module id | Responsibility | Depends on |
|---|---|---|
| `shell` | Native Rust app built on PhotoCraft's crates (pinned source): main window, menus, app lifecycle, settings, signing/notarising, DMG | — |
| `web-host` | Embedded web view (WKWebView via `wry`) running Album Studio's existing screens unchanged; a new JS↔native bridge replacing Electron's preload/IPC and `src/shims/*`; a local-file protocol for thumbnails; the extra windows (login, Page Editor, Renamer) | `shell` |
| `backend` | Album Studio's non-Photoshop background logic (project read/write, folders, thumbnails and proofs via libvips, PSD layer reading, library, curation, renamer, licence and sign-in, telemetry, plugins, gallery export). Runs first as a bundled Node.js helper process with no Electron, then is ported to Rust piece by piece where it pays | `web-host` |
| `render` | Album sheets built by the PhotoCraft engine in-process: replaces `build_page`, `build_pages_batch` and `export_album` (JSX), template frame extraction, RAW development via macOS, frame-resolution embedding | `shell` |
| `ui` | The new Album Studio interface: design system (tokens, type, components), new layouts for every screen, built in the web view against an async bridge. Replaces today's screens; reuses their tested logic modules (`src/state`, `src/renderer_pure.js`, feature logic) | `web-host`, `backend` |
| `editor` | The full PhotoCraft editor inside the main window: open a sheet, edit, save back; Album Studio actions on the open sheet (place photo, swap two photos, wallpaper, PNG frame, masked frame) | `shell`, `web-host` |
| `tools` | The remaining Photoshop features rebuilt on PhotoCraft or macOS: JPEG export, PSD resize, export open documents, RAW thumbnails, Retouch, Actions (PhotoCraft's own; Photoshop `.atn` files cannot run) | `render`, `editor` |
| `retire-electron` | Remove Electron, the Photoshop bridge, every JSX script and the Tools Bar; migrate saved settings and caches; final installer | all of the above |

Dependency direction is one-way; no cycles.

## Build order

1. **Feasibility spike** (before any module work): one Rust binary showing PhotoCraft's
   editor and Album Studio's current main screen in the same window, switching between
   them, and opening one Wedding sheet. Proves the two riskiest assumptions below.
2. `shell` → `web-host` → `backend`
3. `render` (can run in parallel with `backend` once `shell` exists)
4. `ui` (design direction is drafted and reviewed alongside step 2, built after `backend`)
5. `editor`
6. `tools`
7. `retire-electron`

The existing Electron app in `/Volumes/Harry/works/albumStudio` stays untouched and usable
for real work throughout. All work happens in this copy, on branch `native-shell`.

## Riskiest assumptions (the spike tests these first)

1. PhotoCraft's editor (an `egui` app) can run inside our own Rust app with a web view in
   the same window. Its desktop app currently owns its window and event loop.
2. Album Studio's screens run in WKWebView through a new bridge. Today they make some
   synchronous file calls (`existsSync`, `readdirSync`, `statSync`) and load `file://`
   images, which WKWebView does not allow as-is.

## Assumptions (correct any before approval)

1. Mac only for now; the Rust and `wry` stack keeps a Windows port possible later.
2. Rust, not Swift: PhotoCraft is Rust, so a Rust shell links it directly. A Swift shell
   would need the same hard bridge as Option 2.
3. Album Studio's current screens are kept as they are (HTML/JS in the web view), not
   redesigned as native UI.
4. Photoshop is removed completely, including the Tools Bar; Photoshop `.atn` actions are
   not supported.
5. Our PhotoCraft build removes the ArtCraft name and logos, as its licence requires for
   modified versions.
6. The Rust toolchain (rustup, about 1.5–2 GB under `~/.rustup` and `~/.cargo`) is
   installed on this Mac to build it.

## Open questions

1. Background logic: keep it as a bundled Node.js helper first (recommended: lower risk,
   the app works sooner), or rewrite all of it in Rust from the start?
2. OK to install the Rust toolchain on this Mac?
3. Is Windows support needed, now or later?
