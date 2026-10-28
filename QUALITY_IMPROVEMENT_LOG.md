# Quality status

The quality programme raises the review score from 7.2 to above 9. The design is
[docs/superpowers/specs/2026-10-28-quality-above-nine-design.md](docs/superpowers/specs/2026-10-28-quality-above-nine-design.md);
each phase has a plan in [docs/superpowers/plans/](docs/superpowers/plans/).

## Scorecard

Re-scored after every phase from measurements; an area that misses its target says so.

| Area | Baseline (2026-10-27) | Now | Target |
|---|---:|---:|---:|
| Architecture & structure | 8 | 8 | 9 |
| Testing | 8 | 8 | 9.5 |
| UI code | 7.5 | 7.5 | 9 |
| Tooling & CI | 7.5 | 7.5 | 9.5 |
| Data integrity & reliability | 8 | 8 | 9 |
| Readability | 5.5 | 5.5 | 9 |
| Security & licensing | 7.5 | 7.5 | 9 |
| Performance | 7.5 | 7.5 | 9 |
| Docs & repo hygiene | 5 | 9 | 9 |
| **Average** | **7.2** | **7.6** | **9.1** |

Docs reached 9 in phase 1: tracked `docs/` fell from 19.5 MB to 2.4 MB with no raw logs (all
archived with checksums), the 1,368-line log became this page, `PRODUCT.md`, the licence server
README and the dev guide match the code, 7 untrue comments were fixed, and every relative link
in the living docs resolves.

## Phases

| Phase | Status |
|---|---|
| 0. Commit Codex's work | Done 2026-10-28 |
| 1. Docs and repo hygiene | Done 2026-10-28 |
| 2–7 | Not started |

## Open items

- Phase 2: delete `src/renderer_pure.js`, `src/shortcut_target.js` and `src/ui_icons.js`;
  `src/editor_geometry.js` stays, since `src/proof_renderer.js` uses it.
- Phase 3: the Google-rename fix is already on this branch (`97b4c96`); no merge is needed.
- Phase 4: Codex's code added 26 long lines and two over-complex functions (`requestOf`,
  `validateExpectation`); the 10,000-entry message names the wrong operation in some paths;
  render recovery lists `.album-studio` without an entry bound.
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
