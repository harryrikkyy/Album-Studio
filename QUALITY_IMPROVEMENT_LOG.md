# Quality status

The quality programme raises the review score from 7.2 to above 9. The design is
[docs/superpowers/specs/2026-10-28-quality-above-nine-design.md](docs/superpowers/specs/2026-10-28-quality-above-nine-design.md);
each phase has a plan in [docs/superpowers/plans/](docs/superpowers/plans/).

## Scorecard

Re-scored after every phase from measurements; an area that misses its target says so.

| Area | Baseline (2026-10-27) | Now | Target |
|---|---:|---:|---:|
| Architecture & structure | 8 | 9 | 9 |
| Testing | 8 | 8 | 9.5 |
| UI code | 7.5 | 8 | 9 |
| Tooling & CI | 7.5 | 9 | 9.5 |
| Data integrity & reliability | 8 | 8 | 9 |
| Readability | 5.5 | 6.5 | 9 |
| Security & licensing | 7.5 | 7.5 | 9 |
| Performance | 7.5 | 7.5 | 9 |
| Docs & repo hygiene | 5 | 9 | 9 |
| **Average** | **7.2** | **8.1** | **9.1** |

Docs reached 9 in phase 1: tracked `docs/` fell from 19.5 MB to 2.4 MB with no raw logs (all
archived with checksums), the 1,368-line log became this page, `PRODUCT.md`, the licence server
README and the dev guide match the code, 7 untrue comments were fixed, and every relative link
in the living docs resolves.

Architecture reached 9 in phase 2: three Electron-era modules nothing reached (628 lines) are
gone, the architecture gate now rejects any runtime module no entry point reaches, and the module
map is in `docs/ARCHITECTURE.md`.

Tooling reached 9 in phase 3: Prettier formats the code and CI checks it; ESLint 10's flat config
lints every JavaScript file and the interface's TypeScript, with accessibility rules, and any
warning fails; the strict test gate enforces coverage limits (shared 88% of lines and branches,
backend 94% and 88%). Its last half point is the strict backend typecheck in CI (phase 4). UI code
rose to 8 with the TypeScript and accessibility linting. Readability rose to 6.5: code lines over
120 characters fell from 3,117 to 340, while the 50 over-complex functions wait for phase 4. The
gate also exposed a real bug, now fixed with tests: copying a file's timestamps could round its
millisecond stamp the other way, failing about one render or delivery copy in 20,000.

## Phases

| Phase | Status |
|---|---|
| 0. Commit Codex's work | Done 2026-10-28 |
| 1. Docs and repo hygiene | Done 2026-10-28 |
| 2. Architecture | Done 2026-10-28 |
| 3. Tooling | Done 2026-10-29 |
| 4–7 | Not started |

## Open items

- Phase 4: Codex's code added 26 long lines and two over-complex functions (`requestOf`,
  `validateExpectation`); the 10,000-entry message names the wrong operation in some paths;
  render recovery lists `.album-studio` without an entry bound.
- Phase 4: 18 errors thrown from catch blocks carry no cause (`eslint-suppressions.json`).
  `serializeError` copies recovery metadata from the cause chain, so each site needs its own
  decision and test. ESLint 10 counts two more complex functions than ESLint 8 did
  (`psd_template.js`, `project_lock.js`) with no code changed. `native/ui/spike.html` is a
  leftover shell feasibility page.
- Phase 5: five accessibility findings in three controls lack keyboard operation: the
  Inspector's photo rows, the spread's frame hit areas and the frame-adjust overlay
  (`eslint-suppressions.json`). Coverage limits rise from 88/88 (shared) and 94/88 (backend).
- Phase 6: the broker accepts `project.json` as a target without the project lease;
  `replacesSource` is misnamed; hard-link aliases are untested.
- Phase 7: lock histories, `inputs/` and orphan stages grow without bound; opening an album runs
  four settled checks per spread.
- Production requirements still open: [docs/quality/RECOVERY_AND_VERIFICATION.md](docs/quality/RECOVERY_AND_VERIFICATION.md).

## History

- The full log of earlier iterations (to 2026-10-19) and Codex's scorecard:
  [docs/quality/archive/](docs/quality/archive/).
- Raw evidence moved out of git: [docs/quality/ARCHIVE.md](docs/quality/ARCHIVE.md).
- Recovery and verification guidance: [docs/quality/RECOVERY_AND_VERIFICATION.md](docs/quality/RECOVERY_AND_VERIFICATION.md).
