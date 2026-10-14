# Quality checkpoint: operating rules and remaining verification

This document describes the source on `codex/album-quality-improvement`. It does not certify an installed application or print-lab approval. The fixed acceptance rubric is in `QUALITY_SCORECARD.json`; the continuing work record is in `QUALITY_IMPROVEMENT_LOG.md`.

Latest source/test checkpoint: `docs/quality/2026-10-14-iteration-4/verification.json`.
Earlier evidence remains historical; its coverage numbers do not describe the latest changed modules.

## Identity and existing albums

Asset identities are persisted in `workspace.identity`. Existing unique photo and template IDs remain compatible. Colliding names receive identities derived from the saved source root and relative file path. Ambiguous old references or adjustments remain explicit conflicts; the helper does not choose an arbitrary candidate.

Every spread has a persistent `albumPages[n].id`. Before structural edits, migration freezes existing numbered PSD ownership in `workspace.sheetOwnership`. Moving, deleting, inserting, undoing or redoing spreads does not rename or overwrite those documents. Deleted spread documents remain on disk for recovery. New renders use `exports/.album-studio/sheets/<spread-id>.psd`; delivery page numbers remain `Page_NNN.jpg`.

The backend supports the `relinkFolder` project operation for photo or template roots. Its interface and arbitrary individual-file rename recovery are still incomplete. Preserve the project and the old root when relinking. An ambiguity requires an explicit choice; bulk regeneration is not a recovery strategy.

Unknown legacy PSDs are marked unverified and protected from automatic replacement. A Plan change makes its sheet stale even if that sheet was also edited manually. Preserve manual edits before choosing an explicit replacement. An existing unowned file at a canonical destination blocks rendering; do not delete it to silence the error without reviewing and preserving it.

New sheet records bind a versioned source-content hash and the actual PSD SHA-256. Old size/time
hashes, even when shaped like a SHA-256 value, cannot certify an old sheet. Such sheets remain
protected and production export is blocked pending explicit review/regeneration. Same-size,
preserved-timestamp original/template/PSD edits are tested. A complete manual relink/approval
interface remains unfinished.

## Production gate and colour policy

Production export requires an owned, verified sheet matching the current Plan inputs. It checks full original availability and decoding, frame matching, inherited visibility, crop coverage, source resolution and actual PSD raster resolution. Thumbnails cannot substitute for missing originals. Preview-only vignettes, unsupported font overrides and unverified group transforms block production. Numeric edits and settings must be finite and within their declared domains.

The fallback minimum effective PPI is the configured output PPI, not an invented universal lab threshold. An undersized PSD cannot satisfy that policy by JPEG upsampling. The interface passes the selected print height/PPI to rendering and delivery. Rendering scales template geometry before measuring frames and embedding original photos. The application caps canvases at 64 Mi pixels and PPI at 10,000; this is a safety policy, not a measured hardware budget. Direct legacy renderer calls without settings retain the template's original canvas. New sheets record their settings and per-source effective-PPI evidence. Actual high-resolution albums, decorative-template detail and customer/lab embedded-layer checks remain unverified.

Untagged RGB composites follow an explicit sRGB policy. Tagged RGB composites retain their source ICC resource and 8/16-bit samples in lossless TIFF before conversion to tagged sRGB JPEGs. Tagged transparency is flattened onto white paper. Tests compare Display P3, sRGB, independently authored Adobe-RGB-compatible matrix/TRC profiles and v2/v4 LUT profiles with separately encoded source oracles. PDF image objects retain exact JPEG ICC profiles. Profile headers/tags/curves are bounds checked; a bounded, content-cached LittleCMS transform probe rejects semantic failures instead of accepting a warning and relabelling unchanged pixels.

RGB and CMYK compatibility composites use a bounded PSD/PSB raw/RLE/ZIP/ZIP-prediction planar
decoder and a tagged TIFF transform. Both depths and all format/depth/compression combinations
are exercised against separate sample oracles. Saved-selection auxiliary channels are not
transparency: the decoder requires a negative layer count, including global layer-info records,
before unmatting merged alpha. Unknown channel provenance, missing real composites/profiles,
wrong source profiles, truncation and oversized decompression fail safely. The engine's CMYK
conversion differed from the independent ink oracle under matched intent; production decoding
avoids that conversion. This does not certify the engine's own CMYK editor/render behaviour.
Source PSD/PSB reads have a 512 MiB limit before allocation; decoded composite planes have a
separate 512 MiB bound. Larger legitimate files currently fail with recovery instructions.

Sheets and original template backdrops share the verified pixel route. A declared missing RGB
compatibility composite uses the actual engine layer render. A declared real black composite
remains valid without starting the engine. Template cache schema 6 binds source contents and
each derived artifact's digest; old results are regenerated. Metadata-only high-depth/CMYK
templates avoid decoding pixels twice; framed high-depth/CMYK templates fail with a conversion
instruction because their masks are not verified. Independent Poppler 26.05.0 rendering of
actual sRGB/P3/Gray/CMYK PDF streams passes with explicit sRGB display and perceptual intent
(channel tolerance 3). This synthetic oracle does not certify the wider real-file colour/RAW
corpus, embedded editor layers or actual lab prints.

RAW, adjustment, thumbnail, proof, template and lab-preview caches use content evidence;
edited or unknown derived files are preserved. Rendering/proof/delivery and image converters
consume private verified source copies. Copies are made read-only before decoding, then their
contents and permissions are checked. Hashing compares two streamed passes through the same
file handle because HFS timestamps can miss a change restored within one second. This is
verified content consistency, not an atomic snapshot against arbitrary external writers.
Derivative recipe versions were raised, including scoring version 3, so earlier results cannot
certify output made through the old live-path converters. Real-camera RAW equivalence and
JPEG/RAW proxy selection/capture order remain unverified. Some catalogue/metadata caches still
use timestamps; complete invalidation and realistic full-hash performance remain open.

`workspace.printSpec` can declare dimensions and layout/profile requirements. The current gate checks declared dimensions and reports unsupported profiles, while bleed, safe-area and gutter compliance remain explicitly unverified. No real lab specification was supplied for this checkpoint. Existing or edited PSDs also need a visual check of embedded detail; original resolution alone does not prove every embedded layer's detail.

## Jobs and failure recovery

A helper reserves render/export work before asynchronous preparation, then holds a cooperative
filesystem project lease through completion. Project opening, migration, edits, undo/redo,
proof refresh and album-cache clearing acquire that same lease. File, folder, case and symlink
aliases resolve to the actual project file. Hardlinked project JSON is refused. Independent
macOS processes are tested; the Linux identity adapter is not runtime verified. The native
editor, older application and arbitrary external programs do not yet cooperate with this lease.
Different projects sharing an output directory are also not isolated by this project lock.
Completion releases its lease before announcing the finished event.

Project lock owners carry a private token, machine/boot/process-start identity and operation.
Dead owners on the verified same host can be reclaimed through an exclusive guard; foreign,
malformed or uncertain evidence fails closed. Interrupted reclamation/release guards require
manual review after all relevant helpers have stopped. Preserve the named `.lock`, `.reclaim`,
candidate and `.album-studio-project-lock-history/` directories; never delete a live owner's
lock. There is no automatic history pruning.

Project saves use an exact read revision and bounded independent files (64 MiB maximum).
Before changing public project/backup names, a flushed journal and detached snapshots are
published under `.album-studio-project-state-<hash>/save-<uuid>/`. Pending saves restore the
previous revision only to vacant names; committed saves keep the new revision. Opening a
project recovers a valid interrupted save, including when the project name is temporarily
absent. Symlink/hardlink backups and conflicting manual edits are preserved. Completed stages
are retained under that directory's `history/`; a later edit cannot change a detached snapshot.
An error saying the project was saved reports a committed revision with recovery/retirement
work remaining. Preserve its exact named history path before retrying. Real SIGKILL tests
cover project and backup capture/install/commit boundaries; hardware power loss is unverified.

Export stages every requested JPEG and the complete whole-album PDF before publication. PDF-only export requires fresh review JPEGs for every spread. Before trusting a cached delivery, planning recovers journals. Publication flushes staged bytes and records content fingerprints for the JPEG/PDF set and its next ownership cache in `delivery-*/journal.json`. Pending/interrupted publication rolls back; a committed marker keeps the complete new set and resumes cleanup. Real killed-subprocess tests cover publication, rollback and cleanup boundaries. New delivery cache entries use SHA-256 content verification, detecting same-size/preserved-timestamp edits. Legacy entries retain their stamp-only compatibility policy and are not claimed to provide equivalent freshness.

Publication/recovery holds `.delivery.lock` across processes. Stale-owner reclamation uses an
exclusive `.delivery.recovery.lock` guard. A kill during guard reclamation fails closed: inspect
its PID, paths and journal before manually resolving it. Never remove active locks or recovery
folders to silence an error. External edits, unowned files, malformed journals,
symlink/traversal attempts and conflicting recovery copies are preserved with actionable paths.
A complete committed set whose retirement fails is reported as committed with a recovery error.
The final source/project snapshot and cancellation flag are checked immediately before the
commit marker. Once committed, completion does not misreport cancellation as rollback.

This is restart-recoverable publication, not an instantaneous multi-name filesystem switch for
outside readers. Unsupported directory fsync receives a documented best-effort fallback.
Completed/rolled-back stages are atomically retired intact into `.album-studio/delivery-history/`;
recovery scanning excludes that history. Existing sheets captured during replacement stay in
`.album-studio/render-history/`, and old proofs in `proofs/.album-studio-history/`. There is no
automatic pruning: disk-growth limits and a reviewed cleanup workflow remain open. Do not
delete a stage/history until its files and ownership have been reconciled. A killed render
after capture can require manual restoration from render history: its full restart journal
and cache durability are not implemented. Killed partial copies and reclamation-guard
interruption can also need manual conflict resolution. Physical power loss, real full disks
and exFAT/SMB/removable-drive cases remain unverified.

**Highest unresolved data risks:** different project files can still share an output root,
whose render cache and numbered delivery files are not isolated by the project lease. Even
sibling output roots share a parent JPEG directory. A disposable two-process diagnostic
confirms concurrent job reservations and colliding destinations; it did not attempt publication
or establish actual overwriting. Render
capture/cache publication also lacks a complete restart journal. Reproduce the shared-root
collision with two disposable projects, then require explicit output ownership or serialize
that root. Add durable render/cache recovery with real kill/conflict/ENOSPC tests. Print
resolution/preflight metadata still needs consumption-boundary review: checking live metadata
between content hashes does not prove it describes the frozen bytes later exported.

Lab naming uses `.as-rename-<id>.json` journals and `.as-lab-rename.lock`. Reopening a folder attempts recovery after verifying ownership and content. A conflict or malformed journal preserves files and reports the journal path. Keep both files and the journal, reconnect the original drive and resolve the named conflict before retrying. Restart and cyclic-rename tests include real killed subprocesses; the hard-link fallback is fault-injected. Physical exFAT/SMB, hardware power loss and large-copy performance are not verified.

Engine requests and shutdown are bounded. Missing executables, failed starts, hung requests, malformed replies and interrupted sessions settle instead of leaving callers indefinitely pending. RAW decoding and repeated large workloads still need realistic performance measurements.

## Licensing and security

Rejected or unconfirmed binding cannot save access. An empty binding uses a conditional Firestore write and an authoritative reread of the same device. Expiry, cancelled/timed-out sign-in and duplicate OAuth callbacks are tested. Shared refreshes are coalesced and late responses cannot recreate cleared sessions.

Tests use fake REST responses and disposable loopback OAuth endpoints. They are not evidence that deployed Firestore rules or an issuer rollout are correct. A deployed rules/emulator suite and authorised test accounts remain required.

Legacy client-held HMAC licences remain compatible and remain a security weakness. The existing Ed25519 signed fields also omit the device binding. Do not remove legacy validation or invalidate legitimate customers without an issuer-compatible, verified migration. Prepare versioned device-bound claims, issuer tests and a rollback plan, then verify the real activation/offline/renewal/machine-change flows before rollout. No credentials, real accounts or customer licences were changed in this checkpoint.

The prior root/interface npm audits reported zero advisories after the compatible Sharp and
tooling updates; those audits were not rerun in iteration 4. Rust advisory coverage and hardened
distribution remain unverified. The prior keychain query reported zero valid signing identities
visible to the command; current access to Developer ID/notarisation credentials needs verification.

## Resume without repeating the audit

1. Read the latest log and scorecard, check the current branch/diff and verify the saved evidence checksums. Preserve `invoice-template/`, the previous audit and engine `.DS_Store` files.
2. Complete independent review of the final project transaction/lease and HFS snapshot changes,
   plus unresolved review from earlier iterations. All three workers terminated at the provider
   usage limit, reporting `4:51 PM` without a date/timezone. This is the verbatim provider report,
   not a verified reset estimate. Scoped worker reviews and parent checks do not complete the
   final independent review of integration.
3. Fix shared-output ownership and durable render/cache publication described above. Same-project
   process exclusion and project recovery now have executable regressions; do not restart those
   diagnoses or mistake them for whole-app isolation or physical-drive guarantees.
   Preserve manual files and legacy evidence, complete framed high-depth/CMYK support and
   measured high-resolution budgets.
4. Album association is now captured when edits/undo/redo are queued; the request's operations are copied then, and inactive-album results cannot change the displayed album. Verify the actual native interaction and stale-plan UI race, implement relink/ambiguity workflows, source capture-order invalidation, keyboard/focus/contrast and realistic large grids. The native GUI was not approved for computer-use verification; obtain an approved session and use disposable albums before claiming workflow/accessibility completion.
5. Review the completed synthetic pilot in iteration 4 (24 distinct 12 MP inputs, eight spreads,
   300 PPI). The 16 GiB M4 measured 32.0 seconds cold render, 16.1 seconds export/PDF and 1515 MiB
   sampled process-tree RSS. Three warm cycles/reorder/PDF checks pass; retained histories grow.
   Next measure customer small/typical/large albums, layered/RAW inputs, true peak/CPU and actual
   UI latency. The pilot's safety ceilings and synthetic labels are not production budgets.
6. The engine is now checksum-pinned and reconstructs the unpublished fork from a tracked incremental bundle plus its exact public prerequisite. See `ENGINE_PIN_AND_CI.md`. Local cold engine/shell build and no-skip application gate pass; the full root fresh-checkout package, hosted native workspace/Clippy/corpus jobs, future-incompatible `block 0.1.6`, actual bundle/customer setup, hardened signing and notarised clean-Mac installation remain open. Existing bundles are preserved by atomic no-replace publication. Do not mistake a CLI/interface build or static collector for an installed-app test.
7. Obtain the actual print-lab spec and issuer/rules test environment. Keep externally dependent rubric criteria at zero until directly verified. Reassess every category against the same criteria after each meaningful iteration.

Useful current checks from the repository root:

```sh
node native/scripts/engine.mjs check
node native/scripts/engine.mjs build
node native/scripts/engine.mjs test-node
npm run lint
npm run typecheck
npm --prefix native/ui run build
ALBUM_STUDIO_PHOTOCRAFT_CLI=/absolute/target/release/photocraft-cli \
ALBUM_STUDIO_RENAME_CLI=/absolute/target/release/album-studio-rename-exclusive \
node --experimental-test-coverage --test --test-concurrency=2 test/*.test.js native/backend/test/*.test.js
npm audit --json
npm --prefix native/ui audit --json
node native/scripts/collect-backend.mjs
```

Poppler must be on PATH or selected by `ALBUM_STUDIO_PDFTOPPM`. Plain `npm test` does not
reject missing-engine skips; the strict gate above does. Account tests need disposable localhost
listeners. Native baseline verification used:

```sh
cd native/photocraft
CARGO_TARGET_DIR=/Users/harry/Library/Caches/AlbumStudioBuild/target /Users/harry/.cargo/bin/cargo test --locked --offline -p album-studio
```

That cache path and the engine revision were verified locally. They must be checked again on another host. Source regression success does not assert that an old `native/dist/Album Studio.app` contains these changes.
