# Album Studio project review

Review date: 13 October 2026. Creative Hubb.

**Overall score: 6/10.** The application has a useful architecture, a coherent studio interface and substantial automated testing. Its remaining weaknesses concern the accuracy of delivered files, asset identity, failure recovery, commercial licensing and release reproducibility. I would keep it in a controlled studio pilot until the release blockers below are resolved.

The score measures the current implementation's maturity as a professional Mac album-production tool. It is a judgment based on the findings, rather than a mathematical quality metric or a benchmark against competing companies.

## Scope and limits

The audit covered the root configuration, shared modules, Node helper, Preact interface, native shell integration, authentication, Firestore rules, licence signer, packaging, CI, tests, development documentation and benchmark material. The separate invoice template was identified as an untracked, standalone artifact. Installed packages, generated bundles and the Impeccable design-tool checkout were treated as dependencies and tooling.

Application inventory: 15 shared source files, 27 helper implementation files, 43 interface source/style files, 26 native shell source files and two signer files. The helper and interface tests were reviewed alongside their implementation.

The separate PhotoCraft checkout contains 997 Rust files across its crates and apps. Its shell, document I/O, colour-profile handling, recovery integration and architecture received targeted review. This was not a line-by-line audit of all 997 files, a complete engine corpus run or a penetration test. Live native UI inspection was unavailable; interface and accessibility assessments are based on source and workflow implementation. The deployed Firebase rules, real customer accounts, notarisation and print-lab output were not exercised.

Reviewed revisions: root `81bd5b4` on `native-shell`; PhotoCraft `bdb1f8f`. No application source was changed. The interface's generated bundle was rebuilt and this report was added.

## Scorecard

| Area | Score | Assessment |
|---|---:|---|
| Architecture | 8/10 | Clear interface/helper/engine separation; cohesive modules and centralised actions. |
| UI and workflow implementation | 7.5/10 | Consistent neutral studio themes, sensible navigation, useful empty states, shortcuts and progress. Several promised professional interactions remain incomplete. |
| Data integrity and recovery | 5/10 | Serialised project mutations and backups are good foundations; asset collisions, spread/file identity and failed-operation recovery need attention. |
| Print and delivery correctness | 4/10 | Reproduced profile loss, stale exports and old proofs entering PDFs. A mandatory production preflight is missing. |
| Security and commercial licensing | 4.5/10 | Authenticated Firestore access and Ed25519 support are improvements; legacy licensing, device binding and dependency security remain weak. |
| Performance and scale | 6.5/10 | Small interface bundle, cached proofs and bounded image workers help. The native app lacks current end-to-end scale evidence. |
| Testing and quality gates | 7/10 | 435 passing tests in the tested layers; CI misses native integration, accessibility and the newly reproduced failure cases. |
| Build and distribution | 4/10 | Working local packaging, but no pinned engine bootstrap, complete release pipeline or straightforward customer onboarding. |
| Documentation and consistency | 5/10 | Useful recent development notes coexist with obsolete security, accessibility and benchmark claims. |

## Validation performed

| Check | Result |
|---|---|
| Shared JavaScript tests | 251 passed; no failures or skips. |
| Helper tests | 61 passed; no failures or skips. The two real-engine tests ran locally. |
| Interface logic tests | 27 passed; no failures or skips. |
| Native `album-studio` package tests | 96 passed; no failures or ignored tests. |
| Lint | Passed with three warnings, zero errors. |
| Shared and interface type checking | Passed. The root check is opt-in for JavaScript and excludes the helper. |
| Interface production build | Passed; approximately 166 KB JavaScript and 55 KB CSS before compression. |
| Native package formatting | Passed. |
| Root production dependency audit | Failed: installed `sharp` 0.34.5 has high-severity advisories. |
| Interface production dependency audit | No vulnerabilities reported. |

The first restricted test run could not complete its loopback sign-in tests. Re-running with local network permission passed the entire suite; that initial result was an environment limitation, not a confirmed application failure. Rust tests used the existing build cache and offline dependencies. A complete release package, all engine crates and Rust Clippy were not run.

Additional checks used temporary synthetic albums, mocked account responses, a Display P3 fixture and injected file-operation failure. Real albums, accounts and original photographs were not changed.

## Release blockers and high-priority findings

### 1. Export drops a PSD's source colour profile — P1, reproduced

Evidence: [deliver.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/deliver.js:75).

`sheetPixels()` extracts a PSD composite as raw RGBA without returning its ICC profile. `exportSheet()` later tags those unprofiled values as sRGB. This loses the information needed to convert a wide-gamut sheet correctly. The same composite path feeds proofs made from saved sheets.

In a Display P3 fixture, a sampled colour should have converted to sRGB `[225, 103, 65]`; the delivered JPEG contained `[210, 110, 76]`. Another colour expected `[0, 142, 205]` but exported `[50, 140, 200]`.

Fix: retain the source profile through composite extraction and explicitly convert from it to the chosen output profile. Use the engine's colour-aware export where needed. Add golden comparisons for sRGB, Display P3, Adobe RGB, CMYK, untagged files and 16-bit sheets, including proofs and PDF inputs.

### 2. Export readiness does not mean the file matches the current plan — P1, reproduced

Evidence: [deliver.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/deliver.js:131), [Deliver.tsx](/Volumes/Harry/works/albumStudio-photocraft/native/ui/src/places/Deliver.tsx:97).

Export freshness checks the existing PSD's timestamp/size and export settings. It does not check whether that PSD matches the album's current photos, template and edits. After moving two spreads, `renderPlan()` correctly reported both sheets as stale while `exportPlan()` reported both JPEG sets as ready. Export can consequently skip the files and deliver the previous plan.

Fix: make delivery depend on the current spread revision and the render revision. Require rendering stale sheets or an explicit, clearly labelled decision to deliver preserved hand edits. Carry this rule into the helper, so every caller receives the same protection.

### 3. Edited sheets stay attached to page numbers when spreads move — P1, reproduced

Evidence: [project.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/project.js:369), [render.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/render.js:124).

Moving, inserting and deleting spreads remaps the plan and page-level edit maps. Rendered PSDs and their cache entries remain indexed by `Page_NNN` and the old spread number. The safety rule that preserves an edited PSD then preserves the wrong spread's file at that number.

The reproduction moved A from spread 1 to spread 2. Spread 1 now contained B, but rendering spread 1 returned `skipped: edited` and retained A's sheet.

Fix: give each spread a persistent identity independent of its position. Associate its edited sheet, proof and render/export records with that identity; derive delivery numbering from the current order. Migrate existing projects and test reorder, insert, delete and undo with hand-edited sheets.

### 4. Photo and template IDs collide — P1, photo case reproduced

Evidence: [album.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/album.js:85), [templates.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/templates.js:102).

A photo ID uses the folder's display name and sanitised filename, rather than an independent asset identity. Two different folders named `DCIM`, each containing `IMG_0001.jpg`, produce the same ID. The photo dictionary silently overwrites one entry while the pool contains the ID twice. Sanitisation introduces further collisions; recursive template collections have the same basename problem.

The fixture contained two distinct photos but the model reported one unique photo and resolved both pool entries to the second folder.

Fix: introduce persistent asset IDs and folder identities, detect collisions during import, and provide a migration that resolves legacy references explicitly. Retain relative paths for portable project packaging and relinking.

### 5. Missing originals and unmatched photos are warnings during production rendering — P1, source-confirmed

Evidence: [render.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/render.js:140), [sheet.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/sheet.js:40).

An absent original can fall back to a 400-pixel thumbnail. A photo missing from the model is skipped. Photos without matching template frames are left out with a warning. These sheets can still finish successfully and enter the print export workflow.

Fix: add a production preflight before rendering/exporting. Block missing originals, unplaced photos, unacceptable effective resolution and invalid templates. Include lab-defined page dimensions, bleed, safe areas and gutter checks. Keep any lower-quality draft workflow visibly labelled throughout the file names and interface.

### 6. Commercial licence enforcement can be bypassed or fail to bind a device — P1

Evidence: [license.js](/Volumes/Harry/works/albumStudio-photocraft/src/license.js:19), [license_signing.js](/Volumes/Harry/works/albumStudio-photocraft/src/license_signing.js:9), [account.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/account.js:139).

Unsigned legacy licences remain accepted using an HMAC secret available to the desktop client; the source also contains a fallback secret. Signed licences deliberately exclude `machineId` from their signed fields, leaving offline device binding editable independently of the signature.

Separately, `verify()` ignores the result of the Firestore device-binding PATCH. A mocked 403 response still produced `allowed` and wrote a local licence. Two devices racing to claim an unbound account can therefore receive access without confirming which device won the binding. The allowed account state is also cached without a periodic expiry/revocation check.

Fix: use server-issued signed entitlements with authenticated, confirmed device binding. Define a bounded legacy migration period, remove acceptance of unsigned client-generated entitlements in commercial releases, and choose an explicit offline renewal/revocation policy. Test rejected writes, concurrent activation, expiry, sign-out races and offline device transfer. Do not interrupt a photographer's unsaved work when enforcing renewal.

The local Firestore rules now restrict reads by authenticated email, which is good. Their update condition accesses `machineId` directly even though new-user records omit it; add emulator tests for missing fields. The deployed rules were not inspected, and mocked REST tests do not validate rule evaluation.

### 7. A shipped image-processing dependency has high-severity advisories — P1, live audit

Evidence: installed `sharp` 0.34.5, root production audit and [package.json](/Volumes/Harry/works/albumStudio-photocraft/package.json:22).

The audit reported one vulnerable production package with three high-severity advisory entries. These concern bundled libvips, libheif and librsvg dependencies. The audit offered `sharp` 0.35.5 as the remediation version. The application's existing CI audit gate would currently fail.

Primary advisories: [libvips](https://github.com/advisories/GHSA-f88m-g3jw-g9cj), [libheif](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c), [librsvg](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).

Fix: review the upgrade, refresh the lockfile and bundled native binaries, and verify decoding, colour conversion, masks, SVG text/shapes and exports. Avoid a blind forced dependency upgrade. Include the interface dependency tree in CI auditing and Dependabot.

### 8. Job exclusivity has a race — P1, export case reproduced

Evidence: [deliver.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/deliver.js:168), [render.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/render.js:85).

The start methods check the running-job flag and then await preparation before reserving it. Two concurrent starts can both pass the check. Render/export exclusion has the same gap. The interface waits for a started event before becoming busy, leaving a repeated-click opportunity.

Two simultaneous PDF exports were accepted, received the same millisecond-based job ID and wrote the same `.part` path. One then failed with a rename error.

Fix: reserve a shared job coordinator synchronously before the first await, release it on every preparation failure and use unique IDs and temporary paths. Add simultaneous-start and render-versus-export tests; show starting state immediately in the interface.

### 9. PDF export can assemble stale or incomplete proofs — P1, stale case reproduced

Evidence: [deliver.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/deliver.js:228).

PDF construction includes review JPEGs based on their existence, regardless of freshness. A PDF-only export accepted a stale review JPEG after its PSD changed and reported zero failed sheets. A failed JPEG refresh can also leave an older file available for the same PDF pass; missing pages can be omitted.

Fix: build PDFs from a versioned export manifest that confirms the exact album revision, page sequence and successful JPEG set. Refresh stale inputs or block completion. Require an explicit partial-proof choice and label the resulting PDF as partial.

## Further correctness and reliability findings

### 10. Auto-fill retains edits belonging to the old page plan — P2, reproduced

Evidence: [project.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/project.js:384).

Auto-fill replaces the pages but leaves the previous page overlays, layer overrides and backgrounds. A caption that belonged to A stayed on page 2 after a new plan placed B there. Shorter plans can also retain orphaned edit entries.

Fix: make preservation an explicit choice tied to stable spread identity. Clear or deliberately remap page-specific edits when replacing the plan, and keep the operation undoable.

### 11. Lab renaming cannot recover a second-phase failure — P2, reproduced

Evidence: [labnaming.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/labnaming.js:137).

The first move-to-temporary phase rolls back failures. The final move-to-new-names phase does not. An injected failure on the second final rename left one file renamed and another under a hidden temporary name, without returning undo instructions.

Fix: journal both phases before mutating files, roll back when possible, and support recovery after app restart or drive reconnection. Report every original/current name when recovery cannot finish.

### 12. Replacing a source image does not refresh its thumbnail — P2, reproduced

Evidence: [thumbs.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/thumbs.js:54), [autofill.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/autofill.js:44).

Thumbnail surveys check whether a matching filename exists, without comparing source modification time or contents. Replacing a red source JPEG with a blue one under the same filename produced `made: 0`. The pool and curation scores can therefore represent old pixels while a later render uses the new source.

The chronological RAW path has another inconsistency: it falls back to thumbnail EXIF, while newly generated thumbnails do not preserve that metadata. RAW-only shoots can fall back to filename order despite the capture-order promise.

Fix: keep source-version stamps and capture time in a thumbnail manifest, invalidate thumbnails and curation scores together, and read RAW capture metadata explicitly. Add tests for same-name replacements and filenames that disagree with capture time.

### 13. Missing or hung engines can strand render jobs — P2, reproduced startup case

Evidence: [photocraft.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/photocraft.js:30).

The engine's exit promise resolves on `exit`, but a spawn failure reports `error` without that exit event. `close()` then waits for an event that will never arrive. With a nonexistent engine path, close was still unresolved after its five-second kill interval. Engine calls also have no execution deadline, and cancellation waits for a sheet to finish.

Fix: settle lifecycle state on spawn error and process close, reject future calls to a dead session, add bounded command deadlines and implement escalation from cooperative cancellation to termination. Always publish a finished/failed job event.

### 14. Queued interface edits choose their album too late — P2, source-confirmed

Evidence: [edit.ts](/Volumes/Harry/works/albumStudio-photocraft/native/ui/src/edit.ts:75).

An operation captures `album.value` when its queued task executes. Opening another album while earlier operations are pending can route later operations to the new album. Album navigation does not guard against this, and some render/export plan loaders also accept late replies without checking the current album.

Fix: capture project identity and revision when the action is requested, maintain per-project queues, and discard obsolete replies. Add a delayed-request test that switches albums before the reply.

### 15. Project recovery and input validation need a stronger contract — P2, source-confirmed

Evidence: [project.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/project.js:26), [album.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/album.js:150), [raw.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/raw.js:102).

Project writes use temporary files and preserve one backup, but do not flush the file/directory for power-loss durability. Opening a damaged project does not offer recovery from the backup; undo history exists only in memory, and history is mutated before a save succeeds. JSON project data and bridge messages have no shared runtime schema or systematic size limits.

RAW preview extraction allocates the embedded JPEG length taken from the file without first bounding it against the file size and an allocation budget. This is a separate input-handling concern from the native engine's guarded decoders.

Fix: validate and version the project schema, cap counts/dimensions/allocations, fail with actionable messages, retain recoverable checkpoints, and update undo history only after a successful durable save. Add corrupt-file, disk-full, failed-rename and oversized-input tests.

## UI, accessibility and performance

The neutral surrounds, restrained accent, shared button/control vocabulary, labelled icon buttons, lazy image decoding, reduced-motion fallback and generally concise error copy fit professional album work. The interface's separation of Albums, Plan, Review, Deliver, Library and Tools is understandable. These are strengths to preserve.

Accessibility still needs implementation and verification. Spread hit areas are clickable/draggable `div` elements without keyboard focus or activation handling. Frame adjustment supports keyboard zoom but lacks a keyboard panning alternative. Pool options all enter the tab order, and custom radio groups do not implement the standard arrow-key/roving-focus interaction. Global shortcuts do not consistently respect modal or menu context; pressing Space in a pool option selects it without stopping the browser's event propagation. There is no current automated accessibility suite, despite `PRODUCT.md` promising an axe CI gate and `tokens.css` referring to an absent contrast test.

Evidence: [SpreadView.tsx](/Volumes/Harry/works/albumStudio-photocraft/native/ui/src/places/plan/SpreadView.tsx:123), [controls.tsx](/Volumes/Harry/works/albumStudio-photocraft/native/ui/src/ui/controls.tsx:40), [main.tsx](/Volumes/Harry/works/albumStudio-photocraft/native/ui/src/main.tsx:55).

The photo pool renders every filtered tile and subscribes many tiles to global hover state. Review and Deliver also mount their complete spread grids. Lazy image loading helps decoding; it does not bound DOM size or signal subscribers. Folder scans and capture-time reads use unbounded parallel work in some paths. Several maps retain per-album/per-file state for the helper's whole lifetime.

Evidence: [Pool.tsx](/Volumes/Harry/works/albumStudio-photocraft/native/ui/src/places/plan/Pool.tsx:178), [album.js](/Volumes/Harry/works/albumStudio-photocraft/native/backend/lib/album.js:78), [bench/RESULTS.md](/Volumes/Harry/works/albumStudio-photocraft/bench/RESULTS.md:1).

The benchmark document measures the retired Electron application and references a removed app benchmark. Those numbers do not establish WKWebView/Preact performance. Measure the current app with 5,000 distinct photographs, 200–500 spreads, complex PSDs, an external drive, sustained editing and constrained memory. Add virtualisation or bounded work where those measurements show a need, then enforce the relevant budgets.

Workflow gaps include a unified persistent job tray for exports/imports/curation, quick-look at useful inspection resolution, a command palette, robust folder relinking, project packaging for another workstation, and versioned client review/comments/approval. Review currently provides a grid that returns to Plan; it does not implement the richer drag/review/approval flow in the design brief. Prioritise the trust and accessibility work before filling every feature promise.

## Architecture, tests and distribution

The modular structure is a good base. Keep the lightweight Preact interface, explicit helper methods, shared geometry, isolated rendering engine, serialised project writes and versioned derived caches. Improve the seams with a typed method registry and runtime request/result schemas. The frontend's strict TypeScript settings are useful; only seven shared JavaScript implementation files opt into checking, and the helper is excluded from the root type-check configuration. File formats, account state and project migrations deserve the same rigor as UI types.

CI currently runs Node lint, type checking, a root dependency audit and tests. It does not check out/build the PhotoCraft fork, run the native package tests, test an installed bundle, build the interface explicitly, exercise Firestore rules or run UI accessibility/workflow tests. The real-sheet tests skip in CI without the engine. Add a pinned native checkout and an integration job with a small representative template/photo corpus, including the issues above. Passing unit tests should establish that delivered pixels and page order match the approved revision.

Evidence: [CI workflow](/Volumes/Harry/works/albumStudio-photocraft/.github/workflows/ci.yml:46), [tsconfig.json](/Volumes/Harry/works/albumStudio-photocraft/tsconfig.json:20).

The engine is an ignored separate repository, rather than a pinned submodule or reproducible bootstrap dependency. A root clone does not contain the application shell source required by `npm run build`; documentation asks for a branch checkout without providing an automated, verified revision. Record the engine revision alongside every app build and support a fresh-machine bootstrap.

The packaging script bundles a checksum-pinned Node runtime and open-source notices, which is good. Distribution remains ad hoc by default. It has no notarisation/stapling/release artifact pipeline; only Node receives an explicit hardened-runtime signing flag in the Developer ID path. Root and UI versions also differ, and the bundle version is taken from the UI package. Sign-in depends on a settings file supplied to each customer Mac.

Evidence: [package-mac.sh](/Volumes/Harry/works/albumStudio-photocraft/native/scripts/package-mac.sh:153), [DEVELOPMENT.md](/Volumes/Harry/works/albumStudio-photocraft/docs/DEVELOPMENT.md:12).

Finish signing and notarisation validation on another clean Mac, establish one version source, provide setup that customers can complete without editing environment files, and add an update/support flow with reviewable diagnostics. Treat file-format support as a tested matrix; the shell's optional HEIF feature is not requested by the current package build.

PhotoCraft's native recovery integration and layered engine architecture are useful foundations. Its full compatibility and performance claims require the fork's current corpus and acceptance tests. Its committed scorecard is a dated snapshot: sampled text I/O has evolved beyond some entries, so do not use old missing-feature counts as a current assessment or claim Photoshop parity from menu coverage alone.

## Documentation and project organisation

`README.md` and the recent development/native-shell notes describe the new application reasonably well. `SECURITY.md` still says the app does not use Firebase Auth and describes public reads, contrary to current code and rules. `PRODUCT.md` still describes a Photoshop/Electron export path and removed E2E gates. `server/README.md` uses the former signer port and lists already-implemented authentication as unfinished. Benchmark and module comments repeatedly refer to retired code.

Fix these inconsistencies before using the repository to onboard another developer or respond to a security/production issue. Maintain one capability/status matrix, archive obsolete plans, and make documentation assertions testable where possible. Keep the invoice template and design-tool checkouts clearly separate from the shipped application's source and release inputs.

## Creative Hubb product direction

This repository implements a local album-production tool. It does not implement the broader printing/ecommerce business: catalogues, quotations, pricing, customer orders, payments, fulfilment, inventory, shipping or marketing integrations. Their absence is a boundary of this project, rather than a reason to add all of them to the desktop app.

The most valuable next product step is a dependable path from source photos to an approved album revision and traceable lab output. A future client portal or ordering service can connect to that path through explicit project/export manifests. Trying to compete with printing, marketplace and advertising platforms by expanding this app in every direction would dilute the work that can make it valuable to photographers.

## Recommended order of work

1. **Protect production output:** correct ICC handling; enforce current render/export/PDF revisions; resolve spread and asset identity; block missing/low-resolution/unplaced inputs.
2. **Protect work and revenue:** finish signed device-bound entitlements; update the vulnerable dependency; reserve jobs correctly; repair rename rollback, engine lifecycle and failed-save recovery.
3. **Make correctness repeatable:** add the reproduced cases, Firestore emulator tests, native/template corpus checks, actual UI workflows, accessibility and installed-bundle tests to CI.
4. **Make the app shippable:** pin/bootstrap the engine; finish signing/notarisation, setup, versioning, updates and support diagnostics.
5. **Polish sustained studio work:** verify scale, improve keyboard operation and relinking, add the unified jobs view and useful quick-look, then introduce versioned client approval.

The route to 8/10 is to demonstrate that a current, approved album reliably produces correct, recoverable and traceable files on another customer's Mac. That improvement is more valuable than adding decorative UI or broad unrelated functionality.
