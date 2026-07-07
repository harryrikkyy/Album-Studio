# Todo — Phase 0: Verification foundation & CI

> Tracks the current phase only. When all are done + checkpoint passes, we write
> the Phase 1 list. Legend: [x] done · [~] needs owner input · [ ] pending.

## Tasks

- [x] **Add coverage script**
  - Acceptance: `npm run test:coverage` runs the suite + prints a coverage report.
  - Verify: command exits 0, shows a coverage summary. ✅ 70/70, 75.9% line baseline.
  - Files: `package.json`

- [x] **Add GitHub Actions CI**
  - Acceptance: workflow runs lint + typecheck + test:coverage on push/PR to `main`.
  - Verify: green run once pushed to GitHub (`harryrikkyy/Album-Studio`).
  - Files: `.github/workflows/ci.yml`

- [x] **Developer/verification guide**
  - Acceptance: a cold clone can install, run, and knows the gates + smoke-test.
  - Files: `docs/DEVELOPMENT.md`

- [x] **Push Phase 0 to GitHub to activate CI**
  - Acceptance: CI runs on GitHub. ✅ pushed `abbf43d`.
  - Verify: Actions tab (checking).

- [x] **Commit the sample project as an E2E fixture**
  - Acceptance: a sanitized `.json` (no private paths/emails) in `e2e/fixtures/`.
  - Verify: 0 private markers, valid JSON, 15 pages. ✅ `e2e/fixtures/sample-project.json`.

- [x] **Rotate the leaked credentials (owner action)**
  - Acceptance: Google OAuth client secret + `LICENSE_SECRET_KEY` rotated; old
    `dist/` deleted. ✅ owner reset secret, new `.env`, `dist/` removed.
  - Verify: app still signs in. ✅ confirmed working (`npm start` sign-in).

## Phase 0 checkpoint — ✅ COMPLETE

- [x] CI green on GitHub (run `abbf43d` success).
- [x] `docs/DEVELOPMENT.md` written; sample fixture committed.
- [x] Leaked secret rotated; compromised build removed.

→ Proceeding to Phase 1. See "Phase 1" below.

---

# Todo — Phase 1: Safety net (in progress)

- [x] **Playwright-Electron E2E harness + first boot test**
  - Acceptance: `npm run test:e2e` launches the app and asserts the login window.
  - Verify: green E2E job on macOS CI (Linux can't run it — app quits on non-darwin).
  - Files: `playwright.config.js`, `e2e/boot.spec.js`, `.github/workflows/ci.yml`, `package.json`
- [x] **Guarded test-mode + first real-flow E2E**
  - Acceptance: app skips auth in test-mode (`ALBUMSTUDIO_E2E`, dev-only + double-
    guarded by `!app.isPackaged`); E2E reaches the workspace and drives a real tab
    switch. Companion `ALBUMSTUDIO_E2E_LOGIN` forces the login path deterministically.
  - Verify: `npm run test:e2e` → 2 passed (local ✅; CI pending). Files: app.js,
    e2e/workspace.spec.js, e2e/boot.spec.js
- [x] **Guarded project-load hook + undo/redo E2E**
  - Acceptance: test-mode exposes `window.__E2E__` (loadProject/state/undo/redo,
    via `--e2e` from the non-packaged main process); E2E loads the 15-page fixture
    and proves undo restores all pages, redo re-clears. ✅ local 3/3.
  - Files: app.js, src/main.js, e2e/undo-redo.spec.js
- [ ] **E2E: export flow with the Photoshop bridge mocked**
- [x] **Integration tests for main-process IPC handlers** (real IPC, no Photoshop)
  - Acceptance: real handlers invoked through ipcRenderer via the Electron harness.
    Covers generative-catalog/regen, project-write↔read round-trip, project-read
    error path, library-list. ✅ local 9/9 E2E.
  - Files: e2e/ipc.spec.js
- [x] **Characterization tests for the render-queue dirty-tracking**
  - Acceptance: extracted the skip/fresh decision to a pure `partitionByRenderCache`
    (renderer_pure), wired into `_renderWorker` behavior-identically; 6 tests pin
    the cache-key + hash-match rules. ✅ 76 unit + 9 E2E green.
  - Files: src/renderer_pure.js, src/main.js, test/render_cache.test.js
- [x] **Integration tests for main-process IPC handlers** (real IPC, no Photoshop)
  - Acceptance: real handlers invoked through ipcRenderer via the Electron harness.
    Covers generative-catalog/regen, project-write↔read round-trip, project-read
    error path, library-list. ✅ local 9/9 E2E.
  - Files: e2e/ipc.spec.js
  - Likely needs handler logic extracted from `ipcMain.handle(...)` registration
    (dovetails with the Phase 2 module split).
- [ ] **Characterization tests for the stateful core** (history, render-queue)
  - Captures current outputs before the Phase 2 refactor touches them.

---

# Todo — Phase 2: TypeScript + state store + module split (in progress)

- [x] **TypeScript foundation (no runtime change)**
  - Acceptance: `typescript` + `@types/node` added; strict `tsconfig.json`
    (allowJs, checkJs off = opt-in per file, noEmit); `typecheck` is now
    `tsc --noEmit` and green over the whole codebase. App still runs the same .js.
  - Files: tsconfig.json, package.json
- [ ] **Type the first module** (`renderer_pure.js` → `// @ts-check` + JSDoc)
- [ ] **Define `src/shared/` types + the IPC channel contract**
- [ ] **Build the state store** (single source of truth; retire reassigned globals)
- [ ] **Split `main.js`** into `renderer/features/*`, `renderer/state/*` (≤~400 lines each)
- [ ] **Extract `PhotoshopBridge` interface** + macOS impl (Windows impl in Phase 7)
- [ ] **Extract fs/paths service** replacing the UXP stubs
