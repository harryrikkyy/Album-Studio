# Album Studio

Album Studio by Creative Hubb plans, renders, edits and delivers photo albums on the Mac. You
choose a shoot and template collections, plan the spreads, and the app renders print sheets.
You can then edit any sheet in the built-in PhotoCraft editor and export JPEGs and a PDF for
the lab and the client. Photoshop isn't needed at any step.

> **Platform:** macOS 13+ on Apple silicon.

## What's in it

- **Albums**: open recent albums, or start a new one from photo folders. Thumbnails are made
  where missing, RAW files included. Templates and a name are suggested from earlier albums.
- **Plan**: drag photos onto spreads, frames and the spread strip. Templates that fit come
  first, and every change can be undone. Auto-fill plans the whole album in capture order,
  and live proofs redraw in the background.
- **Review**: the spreads as the client will see them.
- **Edit**: the PhotoCraft editor in the same window. Sheets saved there are kept by later
  renders.
- **Deliver**: renders the print sheets with the PhotoCraft engine, then exports
  JPEG-High-Res, JPEG-Low-Res and the low-res PDF. Delivery checks originals, sheet freshness,
  frame coverage and resolution; missing or stale pages must be resolved first.
- **Library**: template collections across albums, browsable by layout.
- **Tools**:
  - **Lab naming** names an order's sheets the way the print lab wants them.
  - **Best picks** narrows a shoot to its sharpest, best-exposed photos.
- **Account**: sign in with Google to a Creative Hubb subscription. Accounts are the same as
  the Album Toolkit's.

## How it's built

| Part | Where | What |
|---|---|---|
| Shell | `native/photocraft/apps/album-studio` (Rust) | The window: the PhotoCraft editor (egui) and a WKWebView for the interface, and the menus. It starts the helper. |
| Interface | `native/ui` (Preact, TypeScript) | Albums, Plan, Review, Deliver, Library, Tools, Settings, sign-in. |
| Helper | `native/backend` (Node.js) | Projects, plans, proofs, renders, exports, tools, account. Talks to the shell over stdio. |
| Shared modules | `src/` | Planning, proof compositing, PSD reading, curation and licence code, used by the helper. |
| Engine | `native/photocraft` (separate checkout reconstructed from the exact source pin and tracked incremental bundle) | Builds and edits the sheets. |

`docs/native-shell/PLAN.md` has the status and what's still open. `docs/DEVELOPMENT.md`
covers building, running and testing.

Quality status and the improvement programme are in
[QUALITY_IMPROVEMENT_LOG.md](QUALITY_IMPROVEMENT_LOG.md). Earlier verified results and open
production requirements are archived in [docs/quality/archive/](docs/quality/archive/), with
operating and recovery notes in [docs/quality/RECOVERY_AND_VERIFICATION.md](docs/quality/RECOVERY_AND_VERIFICATION.md).

## Quick start

```bash
npm ci
npm ci --prefix native/ui
node native/scripts/engine.mjs setup
npm run build        # → native/dist/Album Studio.app
npm start            # opens it
```

Developer builds require Xcode command-line tools, Node.js 22.23.3 and Rust/Cargo 1.99.0.
See [engine setup and verification](docs/quality/ENGINE_PIN_AND_CI.md) for the exact setup,
test gates and a new review-bundle destination. An existing app is preserved; choose a new
`ALBUM_STUDIO_PACKAGE_PATH` to build another version. Signed/notarised customer installation
is still an unverified release requirement.

Sign-in reads a `.env` with the Firebase and Google OAuth settings; see `.env.example`.
It's never committed, and by default never built into the app. The app looks for it in
`~/Library/Application Support/Album Studio/`, then in the Album Toolkit's folder.

## Licence

See [LICENSE](LICENSE). Open-source notices for everything the app includes are in
`native/NOTICE`, and in the app's About box.
