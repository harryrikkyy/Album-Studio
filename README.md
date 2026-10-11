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
  JPEG-High-Res, JPEG-Low-Res and the low-res PDF.
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
| Engine | `native/photocraft` (separate checkout of the PhotoCraft fork, branch `album-studio`) | Builds and edits the sheets. |

`docs/native-shell/PLAN.md` has the status and what's still open. `docs/DEVELOPMENT.md`
covers building, running and testing.

## Quick start

```bash
npm install && npm --prefix native/ui install
npm run build        # → native/dist/Album Studio.app
npm start            # opens it
```

Sign-in reads a `.env` with the Firebase and Google OAuth settings; see `.env.example`.
It's never committed, and by default never built into the app. The app looks for it in
`~/Library/Application Support/Album Studio/`, then in the Album Toolkit's folder.

## Licence

See [LICENSE](LICENSE). Open-source notices for everything the app includes are in
`native/NOTICE`, and in the app's About box.
