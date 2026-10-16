# Iteration 9 — native publication ownership, in progress

Architecture remains **7.0/10, uncertified** on the unchanged scorecard. No other
category is newly certified. Root baseline: `6362dcacc52c1703d0ae23caabde5a5ae4c743ee`;
shipping engine pin: `41a0f464405a1e4e20629de928727815679f5906`.

`baseline-verification.json` verified all 640 iteration8 manifest entries before
these edits. The previous manifest is intentionally unchanged. User-owned
`docs/reviews/` and `invoice-template/` are excluded from this work.

## Reproduced defect

The actual native `Services::write` callback overwrites an existing sheet while
another real Node process holds both project and output capabilities. The fixture
uses disposable files; `native-save-owner-verified-bytes.log` retains the exact
failing before/after assertion. This is not a hypothetical race.

## Implemented prerequisites and tests

- The isolated candidate records the SHA-256 and length of actual decoder inputs,
  without reopening their names later. Engine library **1077 pass, 11 ignored**;
  selected UI save/import identity tests **5 pass**. Ignored cases are existing
  benchmarks/timing checks, not verified requirements. These changes are not yet
  integrated in the shipping pin.
- The verified streaming reader is shared with render publication. Metadata
  buffering is limited to64MiB, while document reads stream in1MiB chunks. Reader
  and existing render regressions **42 pass**. The full strict reader-era gate
  **297 shared+801 backend+46 UI=1144 pass**, no fail/cancel/skip, predates the newer
  namespace/publication changes and does not certify them.
- Physical namespace capabilities are separated from the output/project adapter.
  Standalone publishers also reserve existing enclosing managed sheets/delivery
  scopes, which grants serialization only, not album adoption. The focused
  namespace/output/publication run **29 pass** before the two larger batch cases.
- Shared publication I/O centralizes detached copying, reserved commit inode,
  exclusive rename, verified content/identity and directory synchronization.
  Existing render+reader **42 pass** after extraction with the configured helper.
- `file_publication.js` implements compare-and-publish for up to256 files in one
  physical directory. Immutable journals/snapshots, old and new file revisions,
  reserved commit inode, durable commit distinction and retained history protect
  recovery. **16 pass** includes SIGKILL at five publication stages, two-file
  partial commit rollback, manual edits, stale target identities, marker inode
  substitution and a65MiB+1 streaming case with bounded explicit allocations.
  This does not certify multi-directory atomic batches or production performance.
- The private stdio worker uses bounded64KiB JSON frames and streams document
  bytes separately. It owns leases and I/O throughout preparation/publication;
  the native parent explicitly authorizes commit after preparation. The actual
  worker boundary **8 pass** covers ownership refusal, streamed receipt,
  stale source/inode expectations, disconnect at three phases, payload hash,
  trailing commands and an intervening manual edit. An initial failed-admission
  pipe-lifetime bug and its failing raw run remain retained; admission now closes
  its private input and has deadlines.
- Lint and architecture gates pass at the `*-native-publication.log` checkpoint.
  Their exact coverage is the source state when run, not future edits.

## Native adapter under verification

`native-candidate-wip.patch` includes tracked changes **and all new native source
files**; `native-candidate-wip.json` records their digests and base commit. The
candidate lives at `bench/fixture/native-architecture-engine-10cee1b`. Its service
adapter starts the private worker, bounds reply count/size, owns reader/watchdog
threads and reaps its child on drop. Background save acquires publication scopes
before encoding and sends the final decision through `SaveCtl::commit`. Ambient
interactive document writes use the same actor; preferences retain their
separate settings writer.

The initial native compile found an ambiguous JSON reply type, retained in
`native-save-owner-broker-first.log`. The type annotation was repaired. The
original ownership regression now passes in `native-save-owner-broker-repaired.log`.
The complete app suite passes **123/123** at `native-app-publication-all.log`;
subsequently the additional actual headless UI sync/background save test passes
with all five focused ownership cases at `native-ui-publication-focused.log`
(119 filtered;124 total candidate tests). The worker preserves saved identity,
reopens the written PSD, refuses an owned output, preserves bytes on cancellation,
and permits a successful retry after its cancelled child is reaped. App Clippy
all-targets with warnings denied passes; the block0.1.6 future-compiler warning is
retained. Bundled CLI discovery now mirrors the main backend adapter, but an
installed-app launch is not inferred from this source change.

The complete current strict Node gate passes **297 shared+835 backend+46 UI=1178**,
no fail/cancel/skip, at `node-publication-gate.log`. This includes later Unicode
path, target-specific capability and access-time/key-order tests. Root lint,
type checks and UI build pass; UI output remains248.6KiB JS/54.5KiB CSS. The earlier
84-test combined focus also passes at `native-publication-current-regression.log`.

The shipping checkout and release binaries remain unchanged; no shipping pin
advancement has occurred in iteration9. The isolated passing foundation is saved
as123b04517bf42f8e181950632520445a4468cbaa. The verified incremental
`native-publication.bundle` contains that branch and requires41a0f46. The WIP
patch/manifest retains the complete41a0f46-to-foundation source change, including
the files that were untracked before this checkpoint.

## Remaining work (not complete and not an external blocker)

1. Preserve this passing foundation checkpoint; verify installed-app helper
   discovery when the eventual candidate is bundled and rebuilt.
2. Pass earlier decoder/source identity and last-published typed receipts through
   the actual UI save paths. The worker supports `source` and `exact` expectations,
   but the initial native adapter still uses explicit interactive `overwrite`.
   Therefore stale editor protection is **not integrated**. Import hashes are not
   filesystem identity, album/spread authority, or last-save receipts.
3. Continue typed native receipts and structured errors. The exact-record check now
   uses the shared content/inode/mode predicate, ignores incidental access time and
   JSON key order, and passes a real-worker regression. Successful input staging
   retires into retained inputs; failed preparation reports its retained stage.
4. Cover authorized automation, generated assets, Save for Web/slices and engine
   direct writes without granting ambient authority or reducing existing features.
   Complete multi-directory batch design/acceptance and bounded recovery enumeration.
5. Bind album/spread ownership and invalidate render/proof/delivery state on manual
   publication. Never rewrite the render recipe baseline to adopt manual edits.
6. Finish permanent/legacy/global reconciliation, migration and rollout evidence,
   method-specific native DTOs and remaining native error/invalidation requirements.
7. Run the appropriate full current Node/native/format/lint/layer checks, preserve
   failures as well as passes, save source/bundles, reconstruct/build the final
   candidate and only then deliberately advance the clean shipping pin/checkout.
   Forced-add exact raw logs when making checkpoints: `*.log` is globally ignored.

The architecture target has not been achieved. There is no current external
execution blocker; these are executable implementation and verification steps.
