# Iteration 6 source checkpoint

Continue from `verification.json`, `reassessment.json`, the root improvement log and scorecard.
The iteration-5 starting checkpoint `180c56a` and all 480 recorded source/evidence/executable/
local-benchmark hashes were verified before implementation. This continues the established
audit; no category, criterion or weight has been removed.

The change journals a rendered PSD and its exact render-cache revision together. Streamed,
detached old/next snapshots and a flushed immutable journal precede public-name mutations.
A separate checksum-bound commit marker distinguishes pending rollback from committed history.
Cooperating operations recover while project and physical output leases are held, before
reading sheet ownership. Ordinary album reopening participates; inspecting a foreign cache
still allows choosing a different output without adopting its sheets.

Managed output/proof descendants now reject intermediate symlinks, special entries and
unexpected directory slots. Root aliases remain supported. Cache clearing preserves retained
recovery directories. Snapshot creation uses an exclusive descriptor, read-only permissions
from creation, streamed copies and descriptor-based permission changes; failed exclusive
creation and substituted names are preserved. Error metadata prevents caller cleanup from
removing an uncertain snapshot stage.

- `render-recovery-before.log`: two real-engine crash/reopen regressions fail against the
  previous capture/install path. The new standalone journal API did not previously exist.
- `output-paths-baseline.cjs`, `output-paths-before.log`: five embedded modules are byte-for-byte
  `180c56a` source, verified against Git. Both real-process shared-metadata/shared-proof deletion
  regressions fail. This is a scoped source override, not a complete separate checkout build.
- `cache-snapshot-before.log`: both existing-destination deletion and customer-referent chmod
  regressions fail before the snapshot fix.
- `render-journal-first-fix.log`, `render-journal-second-fix.log`: the worker's intermediate
  17/18 then 18/18 contract checks. An intentional journal-edit fixture needed to change its
  disposable read-only permissions before injecting invalid bytes; production validation was
  strengthened. These intermediate logs do not cover all later tests/source.
- `render-integration-before-preview-fix.log`: one test used the wrong methods export; another
  correctly found that refresh selected a live approximation after a committed sheet's proof
  metadata failed. The final test calls the actual API; refresh now selects the verified
  current sheet even when a stale manifest entry already exists.
- `focused-final.log`: snapshot, real-engine/reopen/preview/cancellation checks pass. Earlier
  focused logs have their exact narrower scope; the full gate covers the final set.
- `node-gate.log`: 273 shared + 587 backend + 33 interface = **893 passed**, no failures,
  cancellations or skips, with provenance-tagged pinned engine and current no-replace helper.
- `coverage.log`: **860 shared/backend tests pass**, no skips. Production rows and uncovered
  paths remain visible. The aggregate includes tests; UI/Rust coverage is not claimed.
- `lint.log`, `typecheck.log`, `ui-build.log`, `backend-closure.json`: zero lint errors/warnings,
  types and production interface build pass; closure includes both new modules, 55 files and
  10 installed packages. The unused helper in the first lint log was removed.
- `review-and-limits.json`: scoped reviewers independently reproduced four concrete loss/
  permission bugs. The final implementations/integration have not completed independent
  review. All workers terminated at the provider limit reporting “Oct 15th, 2026 3:02 AM”; no
  timezone was supplied. Parent inspection and tests are not substituted for independent review.
- `reassessment.json`: all 90 fixed criteria reassessed. Scores remain conservative and no
  category is certified. Performance evidence and limits are recorded in `verification.json`.
- `pipeline-pilot.json`, `pipeline-metrics.json`, `pipeline-pilot.log`: current-source synthetic
  pilot passes with unchanged source/executable hashes, all eight PDF geometry/raster/patch
  checks and warm reuse. Cold render 51.091 s and retained footprint 1.820 GiB exceed the
  previous single pilot's 30.459 s/1.123 GiB. This is a measured cost to address, not an accepted
  budget or controlled statistical comparison. Generated data remains locally retained.

Do not prune immutable/captured/manual/unknown histories. An interrupted preparation without
a validated journal is retained and reported as an orphan; foreign/malformed/manual conflicts
fail closed. Read-only and directory-flush checks on this local filesystem plus SIGKILL are
not proof of hardware power-loss durability or removable/network-volume support. Descendant
validation bounds (100,000 entries, depth 64) are failure limits, not production scale budgets;
path checks do not prevent arbitrary external replacement between syscalls.

Permanent/legacy/moved/copied/native/editor/global-cache ownership, broader private-stage
cleanup, approved retention budgets, consumed print/preflight metadata, realistic customer
scale, real RAW/layer/mask/high-depth/CMYK corpus and native GUI/accessibility remain open.
Actual lab specifications/samples, issuer/rules/migration environment, physical storage/power
tests, signing/notarization and a clean customer Mac require authorized external resources.
Full native workspace/Clippy/corpus/hosted CI, staged root package and packaged Node 22.23.3
are still unverified; the local runtime is 22.22.3. Existing bundles and user work are preserved.
