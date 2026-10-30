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
| Readability | 5.5 | 7 | 9 |
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

Readability rose to 7 in phase 4a: all 55 backend runtime files, and the shared modules they
import, now type-check with strict null checks in CI, up from 2. The 237 errors were fixed with
JSDoc types and explicit null checks, with no behaviour change. None was a genuine bug, but nine
documented types were stale or malformed and are now enforced. Implicit `any` and untyped catch
variables remain for phase 4d.

Phase 4b-1 split the 10 functions above complexity 20 in the contract runtime and the shared
modules (`runtime.js`, `overlay_render.js`, `psd_layers.js`, `proof_renderer.js`) into named
helpers, with no behaviour change; 63 of the 73 remain for batches 4b-2 to 4b-5 and phase 5. Before
each change, new tests pinned what it could move: exact limit issues and step counts, every schema
rejection, PSD text layers and unwritable PNGs, and the proof renderer's sharp calls and output
bytes. Each was mutation-checked. In the shared suite, `proof_renderer.js` coverage rose from 35%
to 94% of lines, and `psd_layers.js` from 90% to 99%. Each refactored function was then compared
with the original: 268,731 comparisons in all, mostly seeded random inputs plus the authored
examples and test fixtures, with the validators' 40,409 inputs run under the real limits and five
scaled ones. There were 0 differences, and each comparison caught deliberate mutants.
Splitting the renderer exposed a real bug, now fixed with a test: on a page with edited template
layers, a photo that couldn't be read moved every later photo into the previous frame's place in
the layer stack, under or over the wrong template art. Readability stays at 7 until more of the
63 fall.

Phase 4b-2 split the 16 functions above complexity 20 in the verified reads, publication and
locking code (`labnaming.js`, `publication_broker.js`, `verified_file.js`, `cache.js`,
`private_stage.js`, `project_lock.js`, `project_transaction.js`, `file_publication.js`,
`render_transaction.js`, `delivery_transaction.js`) into named helpers, with no behaviour change;
47 of the 63 remain for batches 4b-3 to 4b-5 and phase 5. These files protect customer data, so
each save or publication ran on the old and new code with every file-system call failing in turn,
failing from that call on, or with another writer's edit arriving just before it, comparing the
calls, the result or error, what recovery did and the files left: 27,638 runs over 34 scenarios,
with up to 2,002 calls per operation, plus 20,000 random or changed inputs to the journal and
request checks, with 0 differences. Deliberate mutants were caught in every task; one that marked
a publication committed too early survived the planned sweeps until a scenario edited the stage
journal mid-run, and delivery was cancelled at every position because its checks make no
file-system calls. 18 new tests pinned the failure paths, each mutation-checked; backend tests
rose from 898 to 916, and `publication_broker.js` coverage from 92% to 99% of lines. Three of those
tests close a gap the split exposed: no test had ever reached the `verified_file.js` branch that
replaces a read error unable to take a close error, though the earlier coverage figure counted it.
Readability stays at 7 until more of the 47 fall.

## Phases

| Phase | Status |
|---|---|
| 0. Commit Codex's work | Done 2026-10-28 |
| 1. Docs and repo hygiene | Done 2026-10-28 |
| 2. Architecture | Done 2026-10-28 |
| 3. Tooling | Done 2026-10-29 |
| 4a. Null-checked types | Done 2026-10-29 |
| 4b-1. Contract runtime and shared modules | Done 2026-10-29 |
| 4b-2. Verified reads, publication and locking | Done 2026-10-30 |
| 4b-3 to 4b-5, 4c, 4d, 5–7 | Not started |

## Open items

- Phase 4: Codex's code added 26 long lines and two over-complex functions (`requestOf`,
  `validateExpectation`); the 10,000-entry message names the wrong operation in some paths;
  render recovery lists `.album-studio` without an entry bound.
- Phase 4: 18 errors thrown from catch blocks carry no cause (`eslint-suppressions.json`).
  `serializeError` copies recovery metadata from the cause chain, so each site needs its own
  decision and test. ESLint 10 counts two more complex functions than ESLint 8 did
  (`psd_template.js`, `project_lock.js`) with no code changed. `native/ui/spike.html` is a
  leftover shell feasibility page.
- Phase 4 (from 4a): four copies of one ag-psd canvas shim (`parity.js`, `preflight.js`,
  `psd_template.js`, `template_check.js`); `finishPrivateStage`'s `onRetired` option, which
  nothing passes; and three explicit `any` types for 4d to narrow (`makeCache`'s result,
  `onConflict`'s conflict, the overlay list).
- Phase 4 (from 4b-1): the proof renderer's pinning tests hash the JPEG bytes sharp writes on
  macOS with Apple silicon (CI's platform), so another runner, or a sharp update such as
  Dependabot's weekly ones, needs new pins taken before any renderer change. Nothing yet pins
  which stack slot each photo takes on an edited-template page holding both h and v photos; pin
  one before batch 4b-3. On an edited-template page, two frames with the same name share one
  slot, so one of their photos is lost; flattened pages draw both (this predates 4b-1).
  `contrastStage` applies clarity, and `matchesArray`/`matchesObject` return false or nothing
  where `matchesCombinator` returns a boolean; clearer names would help.
- Phase 4 (from 4b-2): four modules repeat one transaction skeleton of prepare, journal, capture,
  install, commit and recover (`project_transaction.js`, `file_publication.js`,
  `render_transaction.js`, `delivery_transaction.js`); merging them is a design change, not a
  split. When `cache.js` can't examine a moved snapshot, its retention report still names the
  original path (pinned as today's behaviour). `delivery_transaction.js` coverage moves by up to
  0.8 points of lines between full runs, because one lock branch runs only when the six processes
  in its competing-restart test collide; a deterministic test would settle it.
- CI: the native workspace's Rust tests fail on GitHub ("Workspace tests" in run 40826660009).
  The engine pin moved to `5301ba3` to fix two engine test bugs. They were matched to that failure
  by its log length, not by reading the hosted log, and local gates pass, so the next hosted run
  has to confirm it: [docs/quality/ENGINE_PIN_AND_CI.md](docs/quality/ENGINE_PIN_AND_CI.md).
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
