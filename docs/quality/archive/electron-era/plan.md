# Plan: Road to 9.5+ (implementation plan)

> Phase 2 (Plan) artifact. Derived from `tasks/spec.md`. **Reviewable, not yet
> executable** — approve this before I break it into `tasks/todo.md` and build.
> Sequencing follows a dependency graph: each phase unlocks the next; each ends
> at a verification checkpoint (CI green + live smoke-test on the sample project).

## Guiding principles

1. **`main` stays shippable.** Every risky phase runs on a branch, merged only
   after its checkpoint passes.
2. **Extract → test → move.** No stateful code moves without a characterization
   test pinning its current behavior first.
3. **Portability designed-in.** Platform-specific code (Photoshop bridge, tools-
   bar, paths, packaging) goes behind interfaces in Phases 2–3, so the Windows
   port (Phase 7) is an added implementation, not a rewrite.
4. **Verify on the real fixture.** The owner's saved `.json` project + real
   Photoshop is the canonical smoke-test after each phase.

## Dependency graph (what unlocks what)

```
P0 verification+CI ─┬─> P1 safety-net tests ─> P2 TS + state store ─┬─> P4 perf/scale ─┐
                    │                                               ├─> P5 design/UX ──┼─> P6 docs+audit ─> P7 Windows
                    └─────────────────> P3 security+licensing ──────┘                  │
   (secret rotation, owner) ......................................................... (parallel)
```

P1 must precede P2 (need the net before untangling state). P3 depends on P2's
preload/IPC seams. P4/P5 depend on P2. P6 audits everything. P7 is last (needs
the mac version "full and final").

---

## Phase 0 — Verification foundation & CI  *(unblocks all)*
**Goal:** every change gets automatic static gates + a repeatable live smoke-test.
- Add GitHub Actions: `lint`, `typecheck`, `test`, `build:mac` on push/PR.
- Add coverage reporting (`node --experimental-test-coverage` or c8) — baseline,
  no gate yet.
- Commit the sample project `.json` as a test fixture under `e2e/fixtures/`
  (sanitized — no private data).
- Document the local run/smoke procedure in `docs/DEVELOPMENT.md`.
- **Owner (parallel):** rotate the leaked Google secret + license key; delete the
  compromised `dist/` build.
- **Checkpoint:** CI green on a no-op PR; `docs/DEVELOPMENT.md` lets a cold start
  run the app against the fixture.

## Phase 1 — Safety net (characterization + integration + E2E harness)
**Goal:** pin current behavior so the refactor can't silently break it.
- Integration tests for the main-process IPC handlers with Photoshop/fs mocked
  (request→handler→response per channel).
- Characterization tests around the stateful core (history, album state, render-
  queue hashing) capturing today's outputs.
- Stand up **Playwright-for-Electron**; automate the 6 smoke flows (boot, build
  page, edit spread, undo/redo, swap, export) against the fixture, Photoshop
  mocked at the bridge.
- **Checkpoint:** ≥ the 6 E2E flows green in CI; coverage baseline recorded.

## Phase 2 — TypeScript + state store + module split  *(the big one)*
**Goal:** typed codebase, single source of truth for state, `main.js` broken up.
- Introduce TS with `allowJs` (both compile); `tsconfig` strict; `typecheck`
  becomes `tsc --noEmit`.
- Define `src/shared/` types + the IPC channel contract (one declaration used by
  main, preload, renderer).
- Build the **state store** (single source of truth; no reassigned module
  globals); migrate album state, history, selection, render-queue onto it.
- Split `main.js` → `renderer/features/*` + `renderer/state/*` + `renderer/ui/*`,
  each ≤ ~400 lines, file-by-file behind the Phase 1 tests.
- Extract a **`PhotoshopBridge` interface** + macOS (`osascript`) implementation;
  route all JSX calls through it. (Windows impl added in P7.)
- Extract an **fs/paths service** replacing the UXP stubs.
- **Checkpoint:** app runs identically on the fixture (live smoke-test); all P1
  tests still green; `tsc` clean; no file > ~500 lines.

## Phase 3 — Security hardening + licensing backend
**Goal:** close the structural security gaps.
- Migrate **all** windows (main, login, tools-bar, renamer) to
  `contextIsolation:true` + per-window preload bridges (editor already done).
- Add **CSP** to every renderer HTML; verify no inline-eval breakage on the fixture.
- Validate/normalize every IPC input (path traversal, type checks) at the boundary.
- Stand up `server/` — a stateless **license-signing** function (private key
  server-side); the app verifies a signature with a bundled public key. Add real
  **Firebase Auth** sign-in; tighten Firestore rules off `read:if true`.
- CI: dependency scanning (`npm audit` gate + Dependabot).
- **Checkpoint:** full smoke-test passes with isolation+CSP on; license verifies
  offline via signature; auth flow works on the fixture.

## Phase 4 — Performance + scalability
**Goal:** measured speed + large-album headroom.
- Profile a real 200-page album; set + record targets (proof render ms, startup s,
  peak RSS).
- Finer proof-invalidation; thumbnail-cache reuse; **worker-thread** offload for
  sharp/compute off the main thread.
- **Virtualize** photo/page grids; stream/paginate state for 500+ pages / 5000+
  photos.
- **Checkpoint:** benchmarks meet targets; large-fixture album stays responsive
  and within the RSS bound.

## Phase 5 — Design/UX + accessibility
**Goal:** the visual/interaction bar + WCAG AA.
- Apply the design system (`docs/notes/ui-ux-design-system.md`) consistently as
  tokens; visual-hierarchy pass; motion/micro-interactions; empty/error/loading
  states. Iterate live using the `impeccable` skill.
- Accessibility: keyboard nav, focus management, ARIA, contrast ≥ AA.
- Add **visual-regression** screenshots to CI.
- **Checkpoint:** an automated a11y pass (axe) is clean on key screens; visual-
  regression baseline locked; live design review.

## Phase 6 — Documentation + release polish (macOS final)
**Goal:** score-table audit; macOS "full and final."
- ADRs for the big decisions; IPC/API reference; contributor + onboarding guide;
  user help. TSDoc on public interfaces.
- Final audit against the spec's score table on macOS.
- **Checkpoint:** every dimension meets its target on macOS; overall ≥ 9.5.

## Phase 7 — Windows port
**Goal:** feature + score parity on Windows.
- Windows `PhotoshopBridge` impl (PowerShell/COM ExtendScript invocation).
- Tools-bar: Win32 docking **or** a reworked non-docked tools panel (sub-decision).
- Path/OS handling; NSIS/MSI packaging; Windows code-signing in CI.
- Re-run full test suite + score audit on Windows.
- **Checkpoint:** the 6 E2E flows + score audit pass on Windows.

---

## Risks (plan-level)
- **Blind runtime changes** → owner fixture + smoke-test after every phase; keep
  `main` shippable.
- **TS/state churn** → incremental, behind P1 net; one module at a time.
- **Photoshop-contract drift** (mac & win) → bridge interface + integration mocks;
  JSX contract is "ask-first."
- **Scope size** → each phase is independently valuable; stop at any boundary
  strictly better than before.

## What I need to start Phase 0
- The sample project `.json` (sanitized) to commit as the E2E fixture.
- Confirm the GitHub repo / Actions are available (or we run CI elsewhere).
- Your go-ahead on this plan → I then write `tasks/todo.md` (discrete tasks with
  acceptance + verify steps) for **Phase 0 only**, and we proceed phase by phase.
