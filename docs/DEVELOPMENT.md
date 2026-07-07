# Development & Verification

How to run, test, and smoke-check Creative Hubb Album Toolkit Pro. This is the
canonical "cold start" doc — a fresh clone should be productive from here.

## Prerequisites

- macOS on Apple Silicon (arm64)
- Node.js 20+ and npm (repo currently developed on Node 22)
- Adobe Photoshop (only needed for real PSD/JPEG rendering + the smoke-tests that
  drive it; the live libvips preview does not need it)

## Install & run

```bash
npm install
cp .env.example .env      # fill in your own Firebase / Google / license values
npm start                 # launches the Electron app
```

> `.env` is git-ignored and is never packaged into a build. Each machine supplies
> its own.

## The quality gates (run before every commit)

| Command | What it checks |
|---|---|
| `npm run lint` | ESLint over `app.js` + `src/**/*.js` |
| `npm run typecheck` | Syntax/type pass over all source (currently `node --check`; becomes `tsc --noEmit` after the TypeScript migration) |
| `npm test` | Unit tests (`node:test`) |
| `npm run test:coverage` | Same tests + a coverage summary |

CI (`.github/workflows/ci.yml`) runs lint + typecheck + test on every push/PR to
`main`. Keep it green.

## Test layout

```
test/           Unit tests (pure logic) — node:test, no GUI, no Photoshop
e2e/            End-to-end tests (Playwright-Electron) — ADDED in Phase 1
e2e/fixtures/   Sample project .json + assets used by E2E + manual smoke-tests
```

## Manual smoke-test (the live verification)

Because the app drives a real GUI + Photoshop, some changes must be verified by
hand against a saved project. Standard pass:

1. **Boot** — app launches, no red errors in the console (⌥⌘I).
2. **Load** the sample project `.json`.
3. **Build a page** into Photoshop.
4. **Spread Editor** — reposition, zoom, adjust sliders, swap, Done.
5. **Undo/redo** several mixed edits — album restores exactly.
6. **Export** — completes.

Report failures with: the step, expected vs. actual, and any console error text.

## Branching

- `main` stays shippable at all times.
- Risky phases (state refactor, security migration) happen on feature branches,
  merged only after their checkpoint passes (CI green + smoke-test).

## Roadmap

The path to 9.5+ lives in `tasks/spec.md` (what/why) and `tasks/plan.md` (how),
executed phase by phase via `tasks/todo.md`.
