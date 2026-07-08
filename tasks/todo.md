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
- [x] **E2E: export flow with the Photoshop bridge mocked**
  - Acceptance: real export path (buildExportData → queueRender → worker →
    IPC build-pages-batch) driven end-to-end; runJsxDataJob mocked in test-
    mode (env + !isPackaged double guard) records each job to a manifest.
    Proves batching (3 pages → 1 bridge job), render-cache skip (unchanged
    re-export never reaches the bridge), and selective re-render (rotating
    one photo re-renders exactly that page). ✅ local 10/10 E2E.
  - Files: app.js, src/main.js, e2e/export.spec.js
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
- [x] **Type the first module** (`renderer_pure.js`)
  - Acceptance: `// @ts-check` + JSDoc typedefs (Frame/Template/Photo/Page/…) and
    per-function annotations; `tsc --noEmit` strict-clean. Surfaced + fixed 2
    latent issues (possibly-undefined index + url). Behavior byte-identical
    (76 unit + 9 E2E green). Files: src/renderer_pure.js
- [x] **Define `src/shared/` types + the IPC channel contract**
  - Acceptance: `src/shared/domain.d.ts` (Frame/Template/Photo/Page/…) and
    `src/shared/ipc.d.ts` — the exhaustive registry of all 71 invoke + 1 send + 9
    push channels (typed subset precise, rest `Loose`, tighten as handlers move).
    renderer_pure now imports the shared domain types (de-duped). tsc green.
  - Files: src/shared/domain.d.ts, src/shared/ipc.d.ts, src/renderer_pure.js, tsconfig.json
- [x] **Build the state store** (single source of truth; retire reassigned globals)
  - Acceptance: every reassigned app-state module `let` in main.js lives in
    `src/state/store.js` (sealed slices, get/set/subscribe), exposed back on
    globalThis via configurable accessors until the module split rewrites
    references. Migrated in 4 commits: undoable core → history → render
    queue → library caches/project path. Selection has no module global (it
    lives on DOM `.selected` classes) — nothing to migrate; the remaining
    lets are ephemeral UI (timers/drag/observers), scoped during the split.
  - Verify: tsc clean, lint 0 errors (31→23 warnings), 86 unit + 9 E2E green
    after each commit. ✅
  - Files: src/state/store.js, src/main.js, src/shared/domain.d.ts
- [ ] **Split `main.js`** into `features/*`, `state/*`, `ui/*` (≤~400 lines each)
  - In progress. Pattern established: extract → inject DOM/IPC deps →
    explicit store access → delete the module's exposeOnGlobal accessors →
    unit tests. Done so far: `src/state/history.js` (undo/redo, 8 tests;
    history accessors deleted), `src/features/render_queue.js` (worker +
    queueRender, 7 tests), `src/features/project_io.js` (autosave, save/
    load, restoreWorkspace orchestration, 11 tests), `src/features/
    export_data.js` (buildExportData + adjustment bake, 6 tests),
    `src/features/asset_library.js` (wallpaper/PNG/masked engines +
    template-folder loader — first DOM-owning module; E2E-covered),
    `src/features/photo_library.js` (processImageFolder + virtualized
    Photos tab + Load Photos; DOM-owning, E2E-covered), `src/features/
    template_filter.js` (sync matching, white box, setPreview, quick-
    build, PS context menus; previewIndex accessor retired),
    `src/features/storyboard.js` (Tab 7 cards + delegated DnD/selection +
    undoable cross-page move), `src/features/proofs.js` (fast proof
    renderer + live preview + client gallery; currentProjectPath accessor
    retired). main.js is at ~3,126 lines (from 5,229). Remaining:
    green-box/page engine, tabs/UI glue.
- [ ] **Extract `PhotoshopBridge` interface** + macOS impl (Windows impl in Phase 7)
- [ ] **Extract fs/paths service** replacing the UXP stubs
