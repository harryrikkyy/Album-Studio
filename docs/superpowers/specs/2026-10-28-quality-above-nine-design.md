# Quality above nine: design

Date: 2026-10-28. Status: approved in conversation, awaiting review of this written spec.

## Goal

Raise Album Studio's review score from 7.2 to above 9 out of 10. The work must make the code
genuinely better against measurable limits; nothing is changed only to move the number. The score
is the plain average of the nine areas below, re-scored honestly from measurements after every
phase. An area that misses its target is reported as missing it.

## Baseline (measured 2026-10-27/28, branch `codex/album-quality-improvement` at `3f2fac8`)

| Area | Score | Main gaps |
|---|---:|---|
| Architecture & structure | 8 | About 880 lines of Electron-era modules nothing at runtime uses |
| Testing | 8 | No UI component tests; a plain `npm test` needs manual engine setup; weak coverage in a few shared modules |
| UI code | 7.5 | Strict TypeScript with no `any`, but no component tests and no linting of `native/ui` |
| Tooling & CI | 7.5 | No formatter; minimal ESLint setup; no coverage limits |
| Data integrity & reliability | 8 | Delivery and project history grows with no way to reclaim it |
| Readability | 5.5 | 450 lines over 200 characters; 48 runtime functions above complexity 20; 2 of 53 backend runtime files type-checked |
| Security & licensing | 7.5 | A Google name change breaks a customer's signature; Firestore rules are untested |
| Performance | 7.5 | Only render and file publication are measured and budgeted |
| Docs & repo hygiene | 5 | 19.5 MB tracked under `docs/` (363 `.log` files, 12.1 MB); a 1,368-line quality log; stale `PRODUCT.md` and notes |

Supporting measurements:

- **Readability.** The committed ratchet baseline records 856 lines over 160 characters and 47
  functions above complexity 20. Runtime code has 72 functions above 15, 48 above 20 and 28 above
  30. Type-checking every backend runtime file in strict mode reports 2,123 errors in 52 files;
  with implicit-`any` relaxed, 237 remain.
- **Coverage.** Backend 94.8% of lines, 88.7% of branches; shared 90.0% and 89.5%. Weakest:
  `src/proof_renderer.js` 36–45%, `src/firebase_auth.js` 54%, `src/curation.js` 54–62%,
  `src/overlay_ps.js` 65%, `src/overlay_render.js` and `src/autofill_counts.js` 79%.
- **Dead modules.** `src/renderer_pure.js` (374 lines), `src/editor_geometry.js` (252),
  `src/shortcut_target.js` (141) and `src/ui_icons.js` (113) are used only by each other and by
  tests. Neither the Rust shell nor the UI references them.
- **UI.** 7,154 lines in `native/ui/src`; 14 test files, all logic tests.

## Context

Codex, the agent that wrote the uncommitted edits in the working tree, has stopped for good. Its
pending work (11 tracked files, three new files, a CI step) passed the full suite in place on
2026-10-27. A separate session is fixing the Google-rename licence problem on branch
`claude/gallant-benz-635657`; it changes the licence and account code. Nothing else edits the repo.

## Decisions

1. **Raw evidence leaves git.** All tracked `.log` files under `docs/quality/`, Codex's untracked
   `docs/quality/2026-10-16-iteration-10/` evidence and the 15 MB
   `native/scripts/engine/architecture-publication-20261016.bundle` move to
   `/Volumes/Harry/works/albumStudio-quality-archive/`, outside the repo. Evidence JSON files over
   100 KB, the PDF and the JPGs under `docs/` move too, unless a test, script or CI step reads
   them. Each iteration keeps a short summary in git that points to the archive. Git history is
   not rewritten.
2. **Quality log.** The full log moves to `docs/quality/archive/QUALITY_IMPROVEMENT_LOG-2026-10.md`,
   with Codex's `QUALITY_SCORECARD.json` beside it. `QUALITY_IMPROVEMENT_LOG.md` becomes a one-page
   current status with the scorecard and open items.
3. **`.kiro/`** stops being tracked (`git rm --cached`); the local copy stays.
4. **`invoice-template/`** is not touched and is added to `.gitignore`.
5. **`docs/reviews/2026-10-13-project-review.md`** is committed.
6. **Formatter.** Prettier matching today's style: no semicolons, single quotes, two-space indent,
   120-character lines. One formatting commit, listed in `.git-blame-ignore-revs`.
7. **History retention.** Delivery and project history is never deleted automatically. The
   storage section of Settings, which already lists cache sizes through `storageUsage` and
   `clearStorage`, shows its size and lets the user remove all but the newest three committed
   histories, using the same validated removal as render pruning.
8. **Firestore rule tests** run in CI, which installs Java. Locally they skip unless Java is present.
9. **New dev-only dependencies**, none of which ship in the app: `prettier`, `happy-dom`,
   `@testing-library/preact`, `axe-core`, `typescript-eslint`, `eslint-plugin-jsx-a11y` and
   `@firebase/rules-unit-testing`, plus an ESLint upgrade if the flat config needs one.
10. **Commits** land on `codex/album-quality-improvement`, phase by phase. Nothing is pushed unless
    the user asks.

## Phases

Each phase is committed only after the verification gate passes, then re-scored. Each phase gets
its own implementation plan, written just before it starts, so later plans build on what earlier
phases found.

### Phase 0: commit Codex's work

- Review the pending diff for correctness and for consistency with the seven earlier fixes, whose
  history loops it switches to its `boundedNames` helper.
- Commit the code, tests, CI step and log entries in one commit whose message says the work came
  from the Codex session. Regenerate the readability baseline for the committed tree.
- Leave out the engine bundle, the raw iteration-10 evidence and `invoice-template/`.
- **Done when** the gate passes on exactly the committed tree.

### Phase 1: docs and repo hygiene (Docs 5 → 9)

- Apply decisions 1–5. Before moving any file, confirm that no code, test, script or CI step reads it.
- Bring `PRODUCT.md` up to date with the native app, remove finished to-dos from
  `server/README.md`, and update `tasks/todo.md` (its `LICENSE_SECRET_KEY` item is obsolete).
- Add `CONTRIBUTING.md`: Node and npm setup, the engine binaries and the
  `ALBUM_STUDIO_PHOTOCRAFT_CLI`/`ALBUM_STUDIO_RENAME_CLI` variables, running each suite, formatting
  and commit conventions.
- Sweep comments that refer to Electron, Photoshop workflows or removed code.
- **Done when** no `.log` file is tracked, tracked `docs/` is at most 3 MB, and every top-level
  doc has been checked against the code.

### Phase 2: architecture (8 → 9)

- Delete the four dead modules. Tests that only exercise them go; any assertion about a live
  module moves to that module's tests.
- Extend `native/scripts/check-architecture.mjs` so every runtime module under `src/`,
  `native/backend` and `native/contracts` must be reachable from an entry point:
  `native/backend/server.js`, `native/ui/src/main.tsx`, `server/index.js`, `server/keygen.js`, or
  a tool under `native/scripts/`, `scripts/` or `bench/`. Tests are not entry points, so a module
  only tests use is a violation.
- Add `docs/ARCHITECTURE.md`: the Rust shell (external checkout), UI, backend helper, shared
  modules, contracts and licence server; the JSON-lines RPC; publication journals.
- **Done when** the gate passes with the reachability rule.

### Phase 3: tooling (7.5 → 9.5)

- Before formatting, the Google-rename fix needs merging; the user is asked first. If it isn't
  ready, its files are formatted after it merges.
- Add Prettier (decision 6), `npm run format` and `npm run format:check`, and a CI step.
- Move ESLint to the flat config, lint `native/ui/src` with `typescript-eslint` and
  `eslint-plugin-jsx-a11y`, and keep the existing rules for JavaScript.
- Add coverage limits to CI with Node's test-runner coverage thresholds, set just below today's
  figures (backend 94% of lines and 88% of branches, shared 89% and 89%) and raised in phase 5.
- **Done when** CI checks formatting, lint covers the UI, coverage limits are enforced, and all
  of them pass.

### Phase 4: readability (5.5 → 9)

- **4a.** Type-check every backend runtime file with implicit-`any` relaxed and fix the 237 errors
  with JSDoc types and null checks. A genuine bug is fixed with a regression test.
- **4b.** Refactor every runtime function above complexity 20 (48 today) to 20 or less by
  extracting named helpers and predicates. Each extracted pure predicate is compared with the
  original on random inputs; every refactored file runs the full backend suite.
- **4c.** Split the lines Prettier leaves over 120 characters (strings, regular expressions,
  comments). Make `max-len` 120 and `complexity` 20 ESLint errors, and retire the readability
  ratchet once its baseline is empty.
- **4d.** Turn on strict checking file by file until all 53 backend runtime files pass strict
  `tsc` (2,123 errors today), and have CI check them.
- **Done when** no line exceeds 120 characters and no function exceeds complexity 20 in any
  JavaScript or TypeScript under `src/`, `test/`, `server/`, `native/backend`, `native/contracts`,
  `native/scripts` and `native/ui`, tests included, and the strict backend typecheck passes in
  CI. Generated files, such as `native/contracts/types.ts`, are still formatted but are exempt
  from both limits and listed as such in the ESLint config.

### Phase 5: testing and UI (Testing 8 → 9.5, UI 7.5 → 9)

- Render every view in `native/ui/src/places` and its key components in tests using `happy-dom` and
  `@testing-library/preact`. Assert keyboard operation and labelled controls, and require no
  serious or critical `axe-core` violations.
- Raise each weak module named in the baseline to at least 85% line coverage.
- When the engine variables are unset, tests find the bundled engine in `native/dist`. Without an
  engine, engine-bound tests skip locally with a clear message; CI keeps rejecting skips.
- Raise the coverage limits: backend at least 95% of lines and 90% of branches, shared 92% and 90%,
  and a new UI limit of 85% of lines.
- **Done when** every view renders in a test with no serious accessibility violations and all
  coverage limits pass.

### Phase 6: security (7.5 → 9)

- Firestore rule tests with `@firebase/rules-unit-testing` against the emulator: an allow and deny
  matrix for `get`, `list`, `create`, `update` and `delete` for the owner, a verified user, an
  unverified user, another user and an anonymous caller. CI installs Java and runs them.
- Confirm the Google-rename fix is merged and covered by tests.
- Review the Content Security Policy in `native/ui/index.html`; tighten it or document each
  remaining allowance.
- Add a threat model to `SECURITY.md`: assets, actors and trust boundaries.
- **Done when** the rule matrix passes in CI and `SECURITY.md` holds the threat model.

### Phase 7: performance and reliability (Performance 7.5 → 9, Reliability 8 → 9)

- Measure bytes read per payload byte for delivery publication and project saves, as was done for
  renders. Apply the expected-digest single-pass read and the snapshot cache where they fit, and
  add read-budget tests.
- Build decision 7: a backend method and Settings UI to show delivery and project history size and
  remove all but the newest three committed histories, keeping restored, unknown and modified ones.
- Audit other caches (thumbnails, previews) for unbounded growth; bound them or make them
  reclaimable.
- **Done when** every publish path (renders, files, delivery, projects) has a read-budget test
  and history removal is tested, including an interrupted removal.

## Verification gate (before every commit)

- Shared, backend (with the real engine via the two variables) and UI suites.
- Lint, typecheck, the architecture gate, and, from phase 3, the formatting check.
- From phase 6, the Firestore rule tests whenever Java is present (always in CI).
- The UI production build whenever UI code changes.
- The only accepted local failure is the Poppler test (`pdftoppm` isn't installed on this Mac);
  CI installs Poppler and runs it.
- Each new test is mutation-checked: break the code it protects and confirm it fails.

## Safety rules

- Nothing is permanently deleted. Files leave git by moving; local copies and git history stay.
- Firebase production is never touched. Rule tests run only against the local emulator, and the
  deployed rules don't change without asking.
- Real bugs found along the way are fixed with regression tests and named in the commit and the
  phase report.
- The user can stop after any phase and keep everything committed so far.

## Scoring targets

| Area | Target | Evidence |
|---|---:|---|
| Architecture | 9 | Reachability rule in the gate; architecture map |
| Testing | 9.5 | Component and accessibility tests; coverage limits; out-of-the-box `npm test`; rule tests |
| UI code | 9 | Component tests; UI linting with accessibility rules; no serious axe violations |
| Tooling & CI | 9.5 | Formatting, UI linting, coverage limits and strict typecheck in CI |
| Reliability | 9 | Reclaimable history with validated removal; cache growth audited |
| Readability | 9 | No line over 120, no function over complexity 20, strict backend typecheck clean |
| Security | 9 | Rule matrix in CI; rename fix merged; threat model; CSP reviewed |
| Performance | 9 | Read budgets on every publish path |
| Docs & hygiene | 9 | No raw logs tracked; accurate docs; contributor and architecture guides |

If every target is met exactly, the average is 9.1, so each phase aims to meet its target
without rounding up. Phases 4 and 5 are the largest; phase 4 carries the most risk because it
refactors the publication and locking code.

## Out of scope

- Rewriting git history to shrink the repository.
- Firebase custom claims for the admin (the admin panel lives outside this repo).
- Any change to Firebase production data or rules.
- The Rust shell in `native/photocraft`, a separate checkout.
- Product features other than reclaiming history.

## Needs the user during execution

- Approval to merge the Google-rename fix branch before formatting (phase 3).
- Optionally, installing Java on this Mac to run the rule tests locally.
