# Creative Hubb Album Toolkit Pro

Professional photo-album production software for photographers. Design album
spreads with Photoshop-like immediacy while keeping every edit non-destructive
and faithful to the final Photoshop export.

It composites spreads live with **libvips** (via [sharp](https://sharp.pixelplumbing.com/)),
lets you place, zoom, swap, and colour-grade photos in a **Spread Editor**,
batch-renames order folders, and renders true-to-PSD files through Adobe
Photoshop only at the final export step.

> **Platform:** macOS (Apple Silicon / arm64). Final rendering requires a local
> install of Adobe Photoshop.

---

## Features

- **Live Design Engine** — full-page spread previews composited natively with
  libvips, so the design loop never round-trips through Photoshop. The preview
  is validated to match the final PSD export (see `docs/ideas/live-design-engine.md`).
- **Spread Editor** — a focused editing window: click a photo on the page,
  drag to reposition, scroll to zoom, swap two photos, and colour-grade
  (exposure / contrast / saturation / warmth). Edits are non-destructive and
  baked only at export.
- **Non-destructive adjustments** — placement (`scale`, `ox`, `oy`), rotation,
  and colour are stored per photo and applied identically in the preview and
  the Photoshop build.
- **Renamer** — batch-rename order folders with configurable naming schemes.
- **Photoshop bridge** — final, true-to-PSD album export via scripted Photoshop
  automation.

---

## Getting Started

### Prerequisites

- macOS on Apple Silicon (arm64)
- [Node.js](https://nodejs.org/) 18+ and npm
- Adobe Photoshop (only required for final PSD/JPEG rendering, not for the
  live preview workflow)

### Install & run (development)

```bash
git clone https://github.com/<your-org>/<your-repo>.git
cd <your-repo>
npm install

# Create your local environment file from the template and fill in values
cp .env.example .env

npm start
```

`.env` is git-ignored and never committed — each developer/deployment supplies
their own. See `.env.example` for the required keys (Firebase, Google OAuth,
license signing key).

### Useful scripts

| Command | Description |
|---|---|
| `npm start` | Launch the app in development (Electron) |
| `npm run lint` | ESLint over `app.js` and `src/**/*.js` |
| `npm run lint:fix` | ESLint with autofix |
| `npm run typecheck` | `node --check` syntax pass over all source files |
| `npm run build:mac` | Build the signed macOS DMG (runs typecheck + lint first) |

### Building the DMG

```bash
npm run build:mac
# → dist/Creative Hubb Album Toolkit Pro-<version>-arm64.dmg
```

The DMG is ad-hoc signed. On first launch, right-click the app → **Open** to get
past Gatekeeper.

> **Note:** standalone scripts that use `sharp` must run under Electron's ABI:
> `ELECTRON_RUN_AS_NODE=1 npx electron <script.js>`

---

## Project Structure

```
app.js                  Electron main process (windows, IPC, MCP/Photoshop bridge)
src/
  main.js               Renderer: album state, compose loop, export data
  proof_renderer.js     libvips page compositor (the Live Design Engine)
  editor.html / editor_renderer.js   Spread Editor window
  renamer*.{js,html}    Batch renamer feature
  sharp_config.js       Tuned sharp instance
scripts/                Photoshop JSX builders + the colormatch harness
docs/ideas/             Design one-pagers and the running status handoff
assets/                 App icon and DMG artwork
```

---

## Contributing

Contributions are welcome! To get started:

1. Fork the repo and create a feature branch (`git checkout -b feature/my-change`).
2. Make your change. Keep edits non-destructive and frame-constrained where the
   Spread Editor is concerned (see `docs/ideas/spread-editor.md`).
3. Run `npm run typecheck && npm run lint` before committing.
4. Open a pull request describing the change and how you tested it.

A pre-commit hook (husky + lint-staged) runs ESLint and a syntax check on
staged JavaScript.

Please review `SECURITY.md` before reporting security issues.

---

## License

See [LICENSE](LICENSE). _(Add a license file — MIT is recommended for an open,
contributor-friendly project. Without one, default copyright law applies and
others cannot legally reuse or contribute.)_
