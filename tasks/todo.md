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
- [x] **Characterization tests for the stateful core** (history, render-queue)
  - Satisfied by the Phase 2 module extraction, which pinned behaviour as it
    moved each core out of main.js: `test/history.test.js` (8 — mutate/undo/redo,
    redo invalidation, nested-mutate snapshot semantics, 80-entry cap,
    throw-rollback, empty-stack no-ops) and `test/render_queue.test.js` (7 —
    empty-range, same-template chunking, template-change splits, cache hits,
    batch→per-page fallback, per-page failure handling, cancellation).
  - Files: test/history.test.js, test/render_queue.test.js

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
- [x] **Split `main.js`** into `features/*`, `state/*`, `ui/*`
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
    split-menu + New Project flow; 5 tests). Final two logic residuals
    extracted: `src/state/photo_page_map.js` (photoId→Set<page> reverse
    index; 9 unit tests) and `src/ui_view_sync.js` (idempotent album→view
    `.used`-marker sync; DOM-owning, undo-redo + workspace E2E-covered).
    **main.js is now 639 lines (from 5,229) — a pure composition root:**
    store setup, DOM refs, module wiring with injected DOM/IPC seams, boot
    registration, shortcut wiring, and the guarded E2E hook. No extractable
    logic remains. tsc clean, lint 0 errors, 196 unit + 13 E2E green.
  - Files: src/state/photo_page_map.js, src/ui_view_sync.js, src/main.js,
    test/photo_page_map.test.js
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
- [x] **License signing — wired end-to-end (fully local, macOS-only)** —
  src/license_signing.js signs canonical fields activatedOn/email/expiresOn/name
  (machineId intentionally UNSIGNED: the device binds after activation, so the
  signer can't know it; machine-lock stays enforced separately). server/index.js
  runs the signer LOCALLY (127.0.0.1:8791, loopback-only, CORS for the local
  panel). Keys generated + public key bundled/committed. app.js reads sig +
  exact signed strings (licExpiresOn/licActivatedOn) so Firestore timestamp
  formatting can't drift the signature. The admin panel (~/Desktop/admin-panel)
  Activate + Extend now call the signer and store sig + lic* on each user doc.
  Round-trip test proves panel-signed → app-verify; forged expiry/email rejected.
  8 tests. No cloud/Blaze. Hosting the signer online = future, if ever.
- [x] **Real Firebase Auth in the app + per-user read rules (privacy gap CLOSED)** —
  the desktop app now exchanges its Google id_token for a Firebase session
  (src/firebase_auth.js: signInWithIdp → idToken/refreshToken, hourly refresh via
  securetoken, refresh token persisted to ~/.ch_toolkit_session) and sends it as a
  Bearer on every Firestore call (app.js). Boot/offline with no session degrades to
  the offline license instead of firing an unauthed request. firestore.rules
  tightened OFF `read: if true`: get = own doc or owner, list = owner only (kills
  bulk customer-list harvesting), create/update require auth + email match and
  cannot touch activated/expiresOn/sig/lic*. FIREBASE_API_KEY set (public web key).
  Deployed + validated end-to-end 2026-07-16 (deactivate → login shows
  not-activated → owner activates → retry → opens). 7 auth unit tests; 187 total.
- [x] **Migrate the main window off nodeIntegration** — esbuild bundle
  (src/dist/renderer.bundle.js via prestart/pretest:e2e) + allowlisted
  `native` bridge in src/main_preload.js; electron/fs/os/path aliased to
  src/shims/* so existing require() sites work unchanged. EXIF parser is
  byte-math (Uint8Array) now; ipc.spec invokes via window.native. All 10
  E2E flows run through the isolated bundle.
- [x] **Phase 3 checkpoint — COMPLETE 2026-07-16** — manual smoke-test PASSED
  with isolation+CSP on: real Photoshop export renders + outputs correctly, and
  the renamer + tools-bar windows work. 13/13 E2E green alongside. firestore.rules
  deployed 2026-07-14 and tightened to per-user auth 2026-07-16 ✅; the
  `read: if true` privacy gap is CLOSED.

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
- [x] **Phase 4 checkpoint — SIGNED OFF 2026-07-16** — every metric meets target
  (startup 1.08s/<2.5s, load 3ms, nav 0.1ms, proof 106ms/page, mem 685MB); 500-page
  scale test holds; evidence-based no-op decisions recorded. See bench/RESULTS.md.

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
- [x] **Multi-theme a11y scan — all 5 themes gated** — e2e/a11y.spec.js now
  iterates every shipped theme on the main window (via `window.ADTTheme.apply`),
  not just the nebula default. Freezes CSS transitions/animations before each
  scan so axe samples steady-state colours (the `.tab-btn` 0.2s colour fade was
  producing phantom mid-transition contrast failures). The all-theme scan caught
  real steady-state WCAG-AA failures the nebula-only gate missed, all now fixed:
  - obsidian `.btn--destructive` outline text (#8A3B2E → #D2694A; was 2.2:1)
  - synthwave `.chip--accent` text (theme-scoped → --accent-hover; was 3.7:1)
  - glass (light theme) accent-blue text everywhere (--accent #0A84FF → #0057C7)
    + active-tab tokens, chip, page title, template-match, sign-out
  - glass license-badge status colours (green/amber/red) — hoisted to theme-aware
    `--status-ok/warn/danger` tokens (:root defaults; glass darkens to clear AA)
  - glass-dark active-tab (used --accent #409CFF on its dark pill = 3.7:1 →
    switched to --tab-active-color #64B0FF)
  - Files: e2e/a11y.spec.js, src/style.css, src/ui_license_badge.js
- [x] **Phase 5 checkpoint — SIGNED OFF 2026-07-17** — a11y gate runs green in
  CI (e2e job, macos-latest, via `npm run test:e2e`); muted-contrast bump plus
  all accent/status colours now reviewed AND auto-gated across all 5 themes, not
  just nebula. 13/13 E2E + 187/187 unit green; typecheck clean; lint 0 errors.

## Scope note (2026-07-13)
- **Product is macOS-only for now.** Windows support (the "Phase 7 — Windows
  PhotoshopBridge impl" referenced in the Phase 2 bridge item) is **deferred
  indefinitely** by owner decision. Do not start it without a fresh go-ahead.
- **There is no Phase 6.** The "Phase 7" label was a forward reference written
  into the PhotoshopBridge item before phases 4/5 were planned; the numbering
  simply skipped 6. No work is hiding behind that gap.

## Review follow-ups (2026-07-17 whole-app review, rated 8.5/10)
- [x] **Remove unused headroom-ai production dependency** — never required
  anywhere; pure supply-chain surface. Prod deps now exactly the four in use:
  electron-log, exifr, node-machine-id, sharp. (commit 5742944)
- [x] **Split app.js (main process) into src/main/* modules** — app.js was a
  1,907-line monolith (71 IPC handlers + windows + auth/license + gallery
  HTML inline). Now a **190-line composition root** (.env loader, service
  init, profile/single-instance setup, registrar wiring, boot flow), mirroring
  the renderer's src/main.js pattern. Modules (each owns its ipcMain
  registrations; all ≤~400 lines):
  - `session.js` — window refs + currentUser/currentLicense accessors
  - `firestore_rest.js` — Firestore REST helpers; env read lazily per call so
    require-order vs. the .env loader can never yield an empty API key
  - `auth_flow.js` — Google OAuth loopback flow (port 9842) + Firestore upsert
  - `license_flow.js` — verifyLicense (exported for boot re-verify) +
    check-license/launch-app/get-license/sign-out/quit-app
  - `file_handlers.js` — shell/pickers/project folder I/O/native drag-out
  - `ps_place_handlers.js` — direct bridge calls (place/swap/build/export)
  - `ps_jobs_handlers.js` — temp-file JSX jobs (extract-frames, actions,
    jpeg-export, resize-psds, inject, export-open-docs, hybrid thumbnails)
  - `proof_handlers.js` — sharp/libvips lane (proofs, final composite, bake)
  - `gallery_export.js` — client proof gallery + inline HTML template
  - `service_handlers.js` — telemetry/curation/generative/plugins/library
  - `aux_windows.js` — tools-bar/renamer delegates + Spread Editor relay
  - Mechanical moves only (no behaviour rewrites); __dirname-relative asset/
    script/preload paths corrected for the new location. Verified: 196 unit,
    13/13 E2E (boots the real split main process; ipc.spec drives handlers
    directly), typecheck clean, lint 0 errors.
- [x] **Audit the bare `catch (_) {}` swallows in src/** — reviewed all ~90
  sites by category. The overwhelming majority are legitimate best-effort:
  temp-file/fd cleanup, localStorage probes, pointer-capture/dataTransfer,
  progress/telemetry sends, window-lifecycle teardown, sharp tuning knobs.
  Five were hiding real user-visible failures and now warn:
  - photo_sources: HR folder listing failure silently downgraded every
    export to low-res proxies (quality bug in the delivered album)
  - render_hashes: localStorage quota failure silently dropped dirty-
    tracking → next export re-renders all pages (warn-once)
  - proofs: failed re-proof left a stale storyboard proof after an edit
  - spread_editor ×2: silent autosave failure after editor apply; silent
    dead nav arrows on editor-goto payload-build failure
  - Verified: 196 unit, 13/13 E2E, typecheck clean, lint 0 errors.
- [ ] **style.css cleanup** — single ~3k-line file; known design-hook findings
  (side-tab borders, layout-property transitions) pending owner decision.
