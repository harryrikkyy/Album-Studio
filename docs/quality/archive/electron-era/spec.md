# Spec: Road to 9.5+ — Creative Hubb Album Toolkit Pro

> Phase 1 (Specify) artifact. **Do not start implementation until this is approved.**
> Gated workflow: Specify → Plan (`tasks/plan.md`) → Tasks (`tasks/todo.md`) → Implement.

## Objective

Raise overall engineering + product quality from **7/10 to 9.5+/10**, which means
reaching **≈9+ on every axis** (architecture, security, performance, scalability,
readability, maintainability, developer experience, testing, documentation) **and**
a design/UX overhaul to the same bar. This is a multi-phase program (estimated
**8–14 focused weeks** solo), not a single change.

**User:** professional wedding photographers on macOS (Apple Silicon), using
Photoshop as the final-render engine.
**Success = ** the score table in "Success Criteria" is met, verified by CI +
live smoke-tests, and the app remains fully working throughout (no regression
in the shipping tool).

### Decisions locked (from review)
- **Verification:** runnable/observable environment for live verification. The
  owner provides a saved project `.json` + a real Photoshop install as the test
  fixture; CI covers static gates and headless renderer E2E. No large change
  ships unverified.
- **Rewrite appetite:** ALL-IN — state-container refactor, full nodeIntegration→
  preload migration, and a backend for server-side license validation are in scope.
- **Scope:** BOTH engineering quality AND a design/UX + accessibility overhaul.
- **TypeScript:** YES — strict TS migration across app + renderer.
- **Licensing:** YES — server-signed licenses + real Firebase Auth sign-in.
- **Program:** run the WHOLE program (all phases).
- **Platforms:** macOS FIRST — make it full, final, and verified on Mac — THEN
  port to **Windows**. Portability is designed-in during the refactor (platform
  specifics behind interfaces) so the Windows port is an added implementation,
  not a rewrite. Revised estimate with the port: **~11–18 weeks**.
- **Signing:** no Apple Developer account yet. See "Distribution & signing" note.

## Tech Stack (current → target)

| Area | Current | Target |
|---|---|---|
| Runtime | Electron 36, Node | Electron latest LTS, Node 20+ |
| Language | JavaScript (CommonJS) | **TypeScript** (strict) across app + renderer |
| Image | sharp/libvips 0.34 | sharp 0.35+, bounded, worker-thread offload |
| State | reassigned module globals in main.js | dedicated store/module (single source of truth) |
| IPC | ad-hoc `require('electron')` per call | typed, centralized preload bridge (all windows) |
| Auth/License | Google OAuth + Firestore REST, client-side | Firebase Auth + **server-signed licenses** |
| Tests | node:test (70, pure logic) | unit + integration + **E2E (Playwright-Electron)** + visual regression |
| CI/CD | none | GitHub Actions: lint, typecheck, test, build, sign/notarize |
| Packaging | ad-hoc signed DMG, `.env` risk fixed | notarized DMG, secrets via OS keychain/user-supplied |

## Commands (current + to add)

```
Dev:        npm start
Test:       npm test                 # node:test (unit) — exists
Test (cov): npm run test:coverage    # TO ADD (c8/node --experimental-test-coverage)
E2E:        npm run test:e2e         # TO ADD (Playwright for Electron)
Lint:       npm run lint             # exists (eslint)
Typecheck:  npm run typecheck        # exists (node --check) → becomes tsc --noEmit
Build:      npm run build:mac        # exists
CI:         (GitHub Actions)         # TO ADD
```

## Project Structure (target)

```
src/
  main/                 Electron main process (was app.js, split by concern)
    ipc/                one file per IPC domain, typed handlers
    services/           photoshop bridge, license, telemetry, fs abstraction
  renderer/             renderer, split from the 5,200-line main.js
    state/              the store (single source of truth) + actions
    features/           album, render-queue, tabs, editor, renamer, curation
    ui/                 components, design-system tokens
    lib/                pure helpers (renderer_pure.* lives here)
  preload/              contextBridge definitions (one per window)
  shared/               types + channel contracts shared main↔preload↔renderer
tests/                  unit + integration
e2e/                    Playwright-Electron end-to-end + visual regression
server/                 license-signing backend (cloud function)
docs/
  adr/                  architecture decision records
  specs/                this spec + future specs
tasks/                  plan.md, todo.md (skill workflow)
```

## Code Style

TypeScript, strict mode, explicit return types on exported functions. Pure logic
stays free of DOM/IO. Example of the target module shape:

```ts
// renderer/state/history.ts
export interface PageSnapshot { template: TemplateRef | null; photos: PhotoRef[] }

/** Compact a full page into the undo-stack skeleton. Pure. */
export function compactPage(page: Page): PageSnapshot { /* ... */ }

/** Rehydrate a skeleton using injected collections. Pure. */
export function hydratePage(
  snap: PageSnapshot,
  templates: readonly Template[],
  photoCache: Readonly<Record<string, CachedPhoto>>,
): Page { /* ... */ }
```

Conventions: 1 module = 1 responsibility, ≤ ~400 lines; no reassigned shared
module globals (state lives in the store); every IPC channel declared once in
`shared/` and imported by both sides.

## Testing Strategy

Four levels, all run in CI:
1. **Unit** (node:test/vitest) — every pure module. Target ≥ 90% on `lib/` + `state/`.
2. **Integration** — main-process IPC handlers with Photoshop/fs mocked; verifies
   the request→handler→response contract per channel.
3. **E2E** (Playwright for Electron) — real UI drives real flows: sign-in stub,
   build a page, edit a spread, undo/redo, export. Target: the 6 smoke-test flows
   from the review, automated.
4. **Visual regression** — screenshot key screens; fail on unintended pixel drift.
Coverage gate enforced in CI (e.g. ≥ 80% overall, ≥ 90% on logic modules).

## Boundaries

- **Always:** run `lint`+`typecheck`+`test` before each commit; keep the app
  runnable at every step; extract-then-test before moving stateful code; update
  this spec when a decision changes; conventional-commit messages.
- **Ask first:** adding dependencies; DB/Firestore schema or rules changes;
  changing the license/auth model; any change to the JSX↔Photoshop contract;
  TypeScript migration cutover of a module.
- **Never:** commit secrets or ship `.env` in a build; remove/skip a failing test
  to go green; land a stateful-core change that hasn't been smoke-tested live;
  break the shipping tool on `main` (use branches for risky phases).

## Success Criteria — the score targets

| Dimension | Now | Target | What it takes (summary) |
|---|---|---|---|
| Architecture | 6.5 | 9.5 | State store; main.js split into feature modules; typed IPC layer; fs-abstraction replaces UXP stubs; ADRs |
| Security | 6 | 9.5 | Rotate secrets; **all** windows off nodeIntegration; CSP everywhere; **server-signed licenses** + Firebase Auth; IPC input validation; dep scanning; notarized signing |
| Performance | 8 | 9.5 | Profile a 200-page album; finer proof-invalidation; thumb-cache reuse; worker-thread compute; startup + memory targets, benchmarked |
| Scalability | 7 | 9.5 | Virtualized photo/page grids; streamed/paginated state for 500+ pages, 5000+ photos; bounded RSS under load |
| Readability | 7 | 9.5 | TypeScript; small modules; documented invariants |
| Maintainability | 6.5 | 9.5 | TypeScript; ≤400-line modules; ≥80% coverage; stricter lint at zero warnings; enforced pre-commit gates |
| Developer Experience | 7.5 | 9.5 | TS + editor types; fast watch loop; CI feedback; one-command dev; debug config |
| Testing | 5 | 9.5 | Unit+integration+E2E+visual; coverage gate; CI |
| Documentation | 7.5 | 9.5 | ADRs; IPC/API reference; contributor + onboarding guide; user help; TSDoc |
| **Design/UX** (new) | ~7 | 9.5 | Design tokens applied consistently; visual hierarchy pass; motion/micro-interactions; **WCAG AA accessibility** (keyboard, ARIA, contrast, focus); polished empty/error/loading states |
| **Overall** | **7** | **9.5+** | all of the above, verified |

## Phased plan (sequence; each phase gated by review + live smoke-test)

- **Phase 0 — Verification foundation.** Stand up a runnable/observable dev
  environment together; add GitHub Actions CI (lint, typecheck, test, build).
  Rotate the leaked secrets (owner action). *Unblocks everything.*
- **Phase 1 — Safety net.** Characterization + integration tests around the
  current behavior (esp. the stateful core + IPC) before touching it. Playwright-
  Electron harness with the 6 core flows.
- **Phase 2 — TypeScript + state store.** Introduce TS incrementally; extract
  album state into a store; break main.js into feature modules behind it. (Biggest
  single decision — see Open Questions.)
- **Phase 3 — Security hardening.** All windows → contextIsolation + preload; CSP;
  IPC input validation; Firebase Auth + server-signed licenses (stand up `server/`);
  dependency scanning; notarized signing.
- **Phase 4 — Performance + scalability.** Profile real large albums; virtualize
  grids; worker-thread compute; hit measured targets.
- **Phase 5 — Design/UX + accessibility.** Apply the design system live; hierarchy,
  motion, WCAG AA; visual-regression coverage.
- **Phase 6 — Documentation + release polish.** ADRs, IPC reference, onboarding,
  user help; final audit against the score table. **macOS is now "full and final."**
- **Phase 7 — Windows port.** Add the Windows implementation behind the platform
  interfaces built in Phases 2–3: a Windows Photoshop bridge (PowerShell/COM
  ExtendScript invocation instead of `osascript`), Win32 tools-bar docking (or a
  reworked non-docked tools UI), path/OS handling, NSIS/MSI packaging + Windows
  code-signing. Re-run the full test + score audit on Windows.

## Distribution & signing — DECIDED: no paid accounts

Owner will **not** purchase an Apple Developer account or a Windows code-signing
certificate. Consequences (accepted):
- **macOS:** DMG stays ad-hoc signed; first launch needs right-click→Open
  (Gatekeeper). No notarization.
- **Windows:** unsigned installer; SmartScreen shows "More info → Run anyway" on
  first run.
- **Score impact:** *distribution trust* within Security is capped ~9 (unsigned
  binaries are a real tamper/trust gap). ALL other dimensions and all code/
  architecture security remain 9.5-reachable. Overall 9.5+ is still attainable;
  this is a single ~0.5 dent on one sub-factor.
- **Mitigations (free):** ad-hoc signing + published SHA-256 checksums; clear
  first-launch instructions in the README; keep the CI pipeline signing-ready so
  credentials are a drop-in if the decision ever changes.

## Risks & mitigations

- **Untested stateful core + can't-verify-blind** → Phase 0/1 first; never move
  stateful code without a live smoke-test; keep `main` shippable, do risky phases
  on branches.
- **TypeScript migration churn** → incremental (`allowJs`, file-by-file), behind
  the test net from Phase 1.
- **Photoshop-contract fragility** → integration tests mock it; the JSX contract
  is "ask-first" to change; smoke-test every render path.
- **Backend scope creep (licensing)** → keep it a single stateless signing
  function; app verifies a signature with a bundled public key.
- **Scope is large** → phases are independently valuable; can stop at any phase
  boundary with a higher score than before.

## Open Questions — RESOLVED

1. **TypeScript:** ✅ YES — strict migration, incremental (`allowJs`, file-by-file).
2. **Licensing backend + Firebase Auth:** ✅ YES — stateless signing function +
   real sign-in.
3. **Timeline/appetite:** ✅ Whole program.
4. **Apple Developer account:** ❌ Not yet — notarization deferred (see Distribution
   & signing). **Windows added to scope**: Mac-first (full/final/verified), then port.
5. **Runnable env:** ✅ Owner provides a saved project `.json` + real Photoshop as
   the live test fixture.

### Remaining sub-decisions (can resolve at each phase boundary)
- Firebase Functions vs. a tiny standalone signer for licensing (Phase 3).
- Windows tools-bar: replicate the docked floating bar via Win32, or ship a
  simpler non-docked tools panel on Windows (Phase 7).
- When to acquire the Apple Developer account + Windows signing cert (parallel).
