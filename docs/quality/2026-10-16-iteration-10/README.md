# Iteration 10 — document source/receipts and shared recovery (in progress)

Architecture remains **7.0/10, uncertified**. This continues root
`cdd52fc77532444c83b365289af29b875d0a33e3` and isolated engine
`123b04517bf42f8e181950632520445a4468cbaa`. All698 prior root hashes and11
native-source hashes were verified before editing. Shipping engine remains
41a0f464405a1e4e20629de928727815679f5906; new native source is not yet pinned.
User folders `docs/reviews/` and `invoice-template/`, prior manifests and release
executables remain outside these changes.

## Actual defects and repairs

- `native-stale-ui-baseline.log`: actual native UI saved an older editor snapshot
  over newer customer fixture bytes. Source hashes alone were not being passed
  through the UI. Both sync/background saves now carry immutable decoder origin,
  current document path and validated last-publication receipts separately.
- `native-document-identity-first.log`:6 focused cases pass, including the repaired
  actual UI stale save in both modes. A dedicated sync document publisher and the
  background SaveCtl provide source evidence and committed typed file receipts.
- The menu's Save a Copy had a separate writer. It now uses the same document
  publisher with the ask-time snapshot. `native-copy-identity-unique-fixtures.log`:
  **7 focused pass**, including actual Save/Save As/menu Copy/current-file Copy and
  a later Save in both modes. Copy keeps dirty state; copying to a former source
  after Save As retains the current file receipt. Decoder origin/hash stay fixed.
- `native-copy-identity-first.log` and `native-copy-identity-repaired.log` failed
  because parallel fixture names used a coarse clock; the first repair script did
  not apply, so the first rerun remained broken. Atomic counters now make each
  exclusively created fixture distinct. No production guard or concurrency was
  weakened to pass these tests.
- `document-worker-copy-origin.log`: **15 actual worker tests pass** for source,
  receipt, alias, Copy, interrupted input and current-file admission behavior.
- `document-wire-types-baseline.log`: malformed numeric/array revision fields were
  coerced into strings. Validation now preserves declared string types.
  `document-wire-types-repaired.log`: **34 publication/worker tests pass**.
- `private-history-admission-baseline.log`: an ordinary save was admitted into its
  recovery history. Shared physical-directory policy now protects `.album-studio*`
  metadata/recovery hierarchies while allowing the canonical `.album-studio/sheets`
  document folder. `private-history-protected.log`: **51 focused tests pass**;
  no marker or nested publication metadata is created inside protected evidence.
- `native-shared-recovery-baseline.log`: backend consumers did not recover an
  interrupted native save before reading output; nested file reservations could
  not prove an already held enclosing scope. Output admission now retains project
  and output ownership while adding file reservations and recovering native
  transactions. Both numbered/canonical sheets restore pending saves or retain
  committed saves; read-only cache calls refuse pending native transactions.
  `native-shared-recovery-first.log`: **10 pass**.
- `native-render-admission-baseline.log`: native save admission accepted a real
  interrupted render. It now refuses until the project coordinator recovers that
  render. `native-shared-recovery-regression.log`: **97 publication, namespace,
  renderer and recovery tests pass**, no failures/cancellations/skips.

The new file-transaction enumeration uses a bounded10000-entry iterator. This
is not a claim that every older directory scanner or recovery family is bounded.
Native/publication history is retained; no reclamation or performance-neutrality
claim is made. The separate earlier65MiB streaming check does not certify large
production albums or all save latency/memory regimes.

## Broader verification

- `engine-ui-library-all.log`: engine **1078 pass,11 ignored**. Initial sandbox UI
  run **1473 pass,2 failed,8 ignored** because no Metal adapter was available.
- `ui-shortcut-host-gpu.log`: the shortcut rendering test passes with host Metal.
  `ui-mask-host-gpu.log` then exposed an existing fixture hardcoding Alt instead of
  the Mac Option label. The expected platform label was corrected, preserving all
  mask/layer assertions.
- `ui-library-host-all.log`: complete synthetic UI library **1475 pass,0 fail,
  8 ignored**. This is headless synthetic rendering, not an installed app/window
  acceptance. All19 ignored engine/UI manual or benchmark cases remain unverified.
- `native-app-document-all.log`: complete native app **126 pass**,0fail/ignored,
  using the CI-built atomic helper. Later root shared-recovery changes still need
  a final native rerun before integration.
- `native-document-clippy.log`: app all targets with warnings denied passes.
  Workspace formatting passes. The existing block0.1.6 future-compiler warning is
  retained. `lint-shared-recovery.log` and architecture gate pass,115files and
  zero violations; no hosted CI is inferred.
- Native CI now calls the existing checksum-tagged C-helper builder, with its
  release path explicitly supplied. `native-ci-rename-helper.log` passes locally;
  hosted Node22.23.3 remains unverified (local Node22.22.3).
- The complete strict Node gate is currently terminal session**50108**, output
  `node-document-recovery-gate.log`. The wrapper writes captured output at the
  end, so an empty log while running does not mean it was lost. Do not restart it
  solely for missing intermediate output. No pass is claimed until it finishes.

`native-document-identity-wip.patch` and `.json` preserve all current native
changes, including the untracked new pure publication model. Refresh after later
source changes; do not modify candidate source while a native build/test is live.

## Next executable steps

1. Finish session50108 and inspect exact totals/failures. Repair findings without
   weakening production guards. Rerun native app126 against final root worker
   changes and verify actual default native layering/source-copy parity.
2. Save the isolated native source, bundle it, reconstruct a fresh checkout and
   rebuild under a new target so old release executable hashes remain intact.
   Only deliberately advance the shipping pin/clean checkout after provenance and
   required checks pass; preserve the three known untracked metadata files.
3. Remaining architecture work includes other engine/native/authorized automation,
   generated-asset and Web/slice writers; global/permanent/legacy ownership and
   approved reclamation; whole-application invalidation; method-specific native
   DTOs/editor diagnostics; structured native errors and rollout acceptance.
4. Review source identity at the first disk open: current decoder provenance is
   bytes plus logical path, not a captured physical file/parent identity. Reproduce
   identical-byte file or folder-alias replacement before designing that binding.
   Never reopen a supplied-bytes API's path to fabricate input provenance.
5. Review low-level child lifetime before certifying ownership: lease ownership is
   currently a Node PID while atomic renames execute in a child. A child outliving
   that PID has **not been reproduced here**. A targeted lock-release handoff
   reproducer should establish whether a delayed child can move a subsequent
   owner's lock. Prefer explicit actual-I/O actor lifetimes if confirmed; do not
   claim a defect or a complete fix from the hypothesis alone.
6. Successful file receipts are currently applied after document-saved callbacks;
   direct engine/script writers remain separate. Verify callback ordering and
   nested saves when migrating those writers, so a later receipt cannot be
   replaced by an earlier outer save receipt. Preserve Copy's ask-time snapshot
   and capability-scoped automation authority.

The architecture target is unachieved. There is no current external execution
blocker: Metal access was resolved through an authorized synthetic host test.
