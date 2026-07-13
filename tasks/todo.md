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
    retired), `src/features/album_pages.js` (page navigation + green-box
    composer + Smart Auto-Fill — largest module of the split),
    `src/ui_feedback.js` (setStatus/toast/notify — DOM-owning, no
    store/IPC deps; still injected into feature modules),
    `src/features/photo_sources.js` (getTrueFile + HR-entries cache,
    readExifDate, sortPhotosByExif, buildHighResMap; photoCache via
    store), `src/features/spread_editor.js` (buildSpreadPayload +
    Edit Spread button + editor-changes/swap/goto handlers; also
    deleted the dead buildDocumentLayers/forceEmbed placement engine
    — never called since the initial commit),
    `src/features/folder_refresh.js` (createFolderRow +
    applyGlobalRotation + remove-folders dialog + refreshTab; the
    processXxxFolder engines injected late-bound),
    `src/ui_resizers.js` (setupResizer/setupHorizontalResizer + all
    nine divider bindings; pure DOM), `src/features/library_view.js`
    (library view + apply/remove/add + serializeCurrentLayout/
    applySavedLayout; generative seam injected),
    `src/features/generative_ui.js` (catalog load/unload + checkbox +
    generative-aware invoke interceptor; loaded-flag module-local),
    `src/features/curation_ui.js` (analyze/apply/export panel;
    store-free), `src/features/plugins_view.js` (plugins panel;
    store-free), `src/ui_shortcuts.js` (global keydown dispatcher +
    "?" help dialog; undo/redo/changePage/setPreview/renderStoryboard
    injected, currentPage/filteredTemplates via store, Cmd+S/O/E click
    the real buttons; 8 unit tests with a document stub),
    `src/ui_tabs.js` (tab bar + lazy Tab 5/6 first paints + thumb-size
    sliders + empty-state forwarder; owns the tab6Rendered flag,
    isTab6Rendered/invalidateTab6 seams; 6 tests),
    `src/state/render_hashes.js` + `src/ui_render_badge.js` (hash
    seed/save + DOM progress badge; render-slice global accessors
    retired — export E2E now uses __E2E__ resetRenderCache/renderState
    seams; 7 tests), `src/ui_source_drag.js` (source-pool select/
    double-click + native drag-out; dead in-app drag seams removed
    from album_pages; 7 tests), `src/features/export_actions.js`
    (build/export buttons + output pickers + J1 toggle, render queue
    reads useAdjLayers() live; 7 tests),
    `src/features/workspace_actions.js` (save/load buttons + save
    split-menu + New Project flow; 5 tests). main.js is at ~669 lines
    (from 5,229) — near-pure composition root; residual: store setup,
    photoPageMap + syncViewToState, DOM refs, module wiring, project
    save/load orchestration glue, E2E hook.
- [x] **Extract `PhotoshopBridge` interface** + macOS impl (Windows impl in Phase 7)
  - Acceptance: src/bridge/ owns every JSX call — index.js (interface typedef
    + platform factory + per-process singleton), macos.js (osascript impl
    moved from src/photoshop.js: serializing queue, asar-safe temp round-trip,
    cached app name, runJsxDataJob), mock.js (E2E recorder lifted out of
    app.js; also covers direct executeJSX/File), temp.js (per-call temp
    files). jsxString → src/jsx/escape.js. src/photoshop.js deleted; app.js +
    tools_bar.js route through getBridge(). 5 unit tests; export E2E drives
    the mock. ✅
  - Files: src/bridge/*, src/jsx/escape.js, app.js, src/tools_bar.js
- [x] **Extract fs/paths service** replacing the UXP stubs
  - Acceptance: src/services/fs_paths.js (folderEntry keeps the loader-facing
    entry shape; pickFolder over IPC; tokenForFolder/entryForToken — a token
    stays the absolute path for saved-project compat). Dead stub file pickers
    dropped; showAlert → ui_feedback; src/stubs/ deleted. 3 unit tests. ✅
  - Files: src/services/fs_paths.js, src/ui_feedback.js, src/main.js

## Phase 3 — Security hardening + licensing backend
- [x] **Isolate the small windows** (login, renamer, tools-bar) behind per-window
  contextBridge preloads (login_preload/renamer_preload/tools_bar_preload),
  contextIsolation:true + nodeIntegration:false — same pattern as the editor
  pilot. Renamer preload also exposes the pure naming module.
- [x] **CSP on every renderer HTML** — script-src 'self' (inline scripts moved to
  ui_license_badge.js / login_renderer.js / tools_bar_renderer.js; login's five
  inline onclick handlers → addEventListener; ui_shortcuts' innerHTML onclick →
  listener), img/media allow file:/data:/blob:, login allows Google Fonts.
  Boot + workspace E2E run login/index with CSP active.
- [x] **IPC input validation** — src/ipc_guards.js (reqString/reqAbsPath/
  reqBaseName/reqNumber/reqObject/reqArray/reqEnum) applied across all app.js
  handlers; start-native-drag bails silently (ipcMain.on). 6 tests.
- [x] **CI dependency scanning** — npm audit (prod, high+) gate + Dependabot
  (npm weekly + github-actions, dev deps grouped).
- [x] **License signing** — src/license_signing.js (Ed25519 over canonical
  fields), server/ stateless signer + keygen, license.js verifies sig with the
  bundled public key (legacy HMAC kept for old licenses). 6 tests + server
  smoke. NEEDS OWNER: run keygen, deploy server/, point activation tool at it;
  then Firebase Auth + tighten firestore.rules off `read: if true`.
- [x] **Migrate the main window off nodeIntegration** — esbuild bundle
  (src/dist/renderer.bundle.js via prestart/pretest:e2e) + allowlisted
  `native` bridge in src/main_preload.js; electron/fs/os/path aliased to
  src/shims/* so existing require() sites work unchanged. EXIF parser is
  byte-math (Uint8Array) now; ipc.spec invokes via window.native. All 10
  E2E flows run through the isolated bundle.
- [ ] **Phase 3 checkpoint** — live smoke-test with isolation+CSP on (real
  Photoshop; also renamer + tools-bar manually — no E2E coverage there);
  owner licensing actions (keygen, deploy server/, Firebase Auth + rules).

## Phase 4 — Performance + scalability
- [x] **Benchmark harness + baselines** — bench/ (make_fixture.js, proof_bench.js,
  app_bench.js) + RESULTS.md. Baselines all inside target: startup 1.1s, 200-page
  load 3ms, page nav 0.1ms, storyboard 6ms, proof render 106ms/page, 685MB.
- [x] **Startup/robustness fix** — the "~4s startup" was DOM-storage LevelDB lock
  contention from a second instance sharing the userData profile. Added a
  single-instance lock (app.js) + isolated test/bench profiles
  (ALBUMSTUDIO_USER_DATA). Startup 4.9s→1.1s; E2E suite 20s→5s.
- [x] **Worker-thread offload — assessed, NOT done.** Event loop never blocks
  during a proof batch (0 gaps >50ms); sharp pixel work is already off the main
  JS thread on the libvips pool. A worker would add overhead for no gain.
- [x] **Virtualization — assessed, NOT needed.** 500 pages load/build in
  single-digit ms; Tab 6 already virtualized; source pool builds 5000 wrappers
  in 14ms within memory budget. Documented the source-pool IntersectionObserver
  path as the place to go if a real large-unique-photo shoot ever shows pressure.
- [ ] **Phase 4 checkpoint** — every metric meets target with no regression; the
  large fixture stays responsive and within the RSS bound. ✅ (See bench/RESULTS.md.)

## Phase 5 — Accessibility
- [x] **axe-core a11y gate (WCAG 2.1 A/AA)** — e2e/a11y.spec.js scans the
  workspace + login windows via @axe-core/playwright, gating on serious/critical
  violations only. Electron can't spawn axe's default runPartial assembly page
  (CDP Target.createTarget "Not supported"), so the scan runs in legacyMode.
  Fixed the 3 violations it caught on the main window: missing `<title>` +
  `<html lang>` (src/index.html), and muted-text contrast — lightened
  `--txt-muted` in all 5 themes to ≥4.5:1 (nebula/obsidian/synthwave/glass/
  glass-dark), preserving hue. ✅ local 2/2.
  - Files: e2e/a11y.spec.js, src/index.html, src/style.css, package.json
- [ ] **Phase 5 checkpoint** — a11y gate green in CI; the muted-contrast bump
  reviewed against the design system across all 5 themes (only nebula is
  exercised by the automated scan today).
