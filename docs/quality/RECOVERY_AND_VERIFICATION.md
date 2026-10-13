# Quality checkpoint: operating rules and remaining verification

This document describes the source on `codex/album-quality-improvement`. It does not certify an installed application or print-lab approval. The fixed acceptance rubric is in `QUALITY_SCORECARD.json`; the continuing work record is in `QUALITY_IMPROVEMENT_LOG.md`.

## Identity and existing albums

Asset identities are persisted in `workspace.identity`. Existing unique photo and template IDs remain compatible. Colliding names receive identities derived from the saved source root and relative file path. Ambiguous old references or adjustments remain explicit conflicts; the helper does not choose an arbitrary candidate.

Every spread has a persistent `albumPages[n].id`. Before structural edits, migration freezes existing numbered PSD ownership in `workspace.sheetOwnership`. Moving, deleting, inserting, undoing or redoing spreads does not rename or overwrite those documents. Deleted spread documents remain on disk for recovery. New renders use `exports/.album-studio/sheets/<spread-id>.psd`; delivery page numbers remain `Page_NNN.jpg`.

The backend supports the `relinkFolder` project operation for photo or template roots. Its interface and arbitrary individual-file rename recovery are still incomplete. Preserve the project and the old root when relinking. An ambiguity requires an explicit choice; bulk regeneration is not a recovery strategy.

Unknown legacy PSDs are marked unverified and protected from automatic replacement. A Plan change makes its sheet stale even if that sheet was also edited manually. Preserve manual edits before choosing an explicit replacement. An existing unowned file at a canonical destination blocks rendering; do not delete it to silence the error without reviewing and preserving it.

## Production gate and colour policy

Production export requires an owned, verified sheet matching the current Plan inputs. It checks full original availability and decoding, frame matching, inherited visibility, crop coverage, source resolution and actual PSD raster resolution. Thumbnails cannot substitute for missing originals. Preview-only vignettes, unsupported font overrides and unverified group transforms block production. Numeric edits and settings must be finite and within their declared domains.

The fallback minimum effective PPI is the configured output PPI, not an invented universal lab threshold. An undersized PSD cannot satisfy that policy by JPEG upsampling. Rendering to a chosen physical print size, with an appropriate embedding and canvas budget, still needs implementation and high-resolution testing. Current rendering uses the template's native canvas.

Untagged RGB composites follow an explicit sRGB policy. Tagged 8-bit RGB composites retain their source ICC resource in a lossless TIFF container before conversion to tagged sRGB JPEGs. Tagged transparency is flattened onto white paper. Tests compare Display P3 and sRGB pixels with a separately tagged PNG oracle. PDF image objects retain the exact JPEG ICC profiles in ICCBased colour spaces.

Other colour modes, Adobe RGB, 16-bit and absent-composite engine fallbacks still require independent colour oracles. Engine output that drops an existing sheet profile fails export. Profile structure is bounds-checked; the full set of malformed semantic ICC profiles is not certified. PDF xrefs, channel declarations and exact bytes are tested, but independent colour-managed PDF rendering and a real lab print are not verified.

`workspace.printSpec` can declare dimensions and layout/profile requirements. The current gate checks declared dimensions and reports unsupported profiles, while bleed, safe-area and gutter compliance remain explicitly unverified. No real lab specification was supplied for this checkpoint. Existing or edited PSDs also need a visual check of embedded detail; original resolution alone does not prove every embedded layer's detail.

## Jobs and failure recovery

A shared helper lease reserves render/export work before asynchronous preparation. It prevents overlap within one helper process and blocks edits to the active project. Completion releases the lease before announcing the finished event. Separate application processes still need cross-process verification and locking.

Export stages every requested JPEG and the complete whole-album PDF before publication. PDF-only export requires fresh review JPEGs for every spread. Cancellation, a source revision change, or caught publication failure preserves the previous delivery. Publication restores backups on caught write errors; an external rollback conflict retains recovery files and reports their paths. Unowned or externally edited delivery files are preserved.

This is not yet a power-loss-safe multi-file transaction. A durable export journal, restart reconciliation, directory synchronization and real full-disk/removable-drive tests remain required. Do not remove `delivery-*` staging or backup folders after an interrupted publication until the target files and cache have been reconciled.

Lab naming uses `.as-rename-<id>.json` journals and `.as-lab-rename.lock`. Reopening a folder attempts recovery after verifying ownership and content. A conflict or malformed journal preserves files and reports the journal path. Keep both files and the journal, reconnect the original drive and resolve the named conflict before retrying. Restart and cyclic-rename tests include real killed subprocesses; the hard-link fallback is fault-injected. Physical exFAT/SMB, hardware power loss and large-copy performance are not verified.

Engine requests and shutdown are bounded. Missing executables, failed starts, hung requests, malformed replies and interrupted sessions settle instead of leaving callers indefinitely pending. RAW decoding and repeated large workloads still need realistic performance measurements.

## Licensing and security

Rejected or unconfirmed binding cannot save access. An empty binding uses a conditional Firestore write and an authoritative reread of the same device. Expiry, cancelled/timed-out sign-in and duplicate OAuth callbacks are tested. Shared refreshes are coalesced and late responses cannot recreate cleared sessions.

Tests use fake REST responses and disposable loopback OAuth endpoints. They are not evidence that deployed Firestore rules or an issuer rollout are correct. A deployed rules/emulator suite and authorised test accounts remain required.

Legacy client-held HMAC licences remain compatible and remain a security weakness. The existing Ed25519 signed fields also omit the device binding. Do not remove legacy validation or invalidate legitimate customers without an issuer-compatible, verified migration. Prepare versioned device-bound claims, issuer tests and a rollback plan, then verify the real activation/offline/renewal/machine-change flows before rollout. No credentials, real accounts or customer licences were changed in this checkpoint.

Root and interface npm dependencies report zero advisories after the compatible Sharp and tooling updates. Rust advisory coverage and hardened distribution remain unverified. The current keychain query reports zero valid signing identities visible to the command; installation/access to a Developer ID identity and notarisation credentials requires verification.

## Resume without repeating the audit

1. Read the latest log and scorecard, check the current branch/diff and verify the saved evidence checksums. Preserve `invoice-template/`, the previous audit and engine `.DS_Store` files.
2. Complete independent review of identity, preflight, colour/PDF, account and publication changes. Reviewer agents terminated at the provider's usage limit; the parent completed unfinished preflight/PDF work and ran tests. Do not treat the missing review as complete.
3. Reproduce the remaining colour/template/fallback cases and implement print-size rendering with verified raster and embedding budgets. Add a restart-recoverable delivery journal, stronger freshness checks and cross-process regression cases. Current freshness still relies on file size/time stamps; content changes preserving those stamps require stronger detection.
4. Fix source thumbnail/RAW invalidation and capture-order metadata, album capture in queued interface edits, relink/ambiguity workflows, keyboard/focus/contrast and realistic large grids. The native GUI was not approved for computer-use verification; obtain an approved UI session and use disposable albums before claiming workflow/accessibility completion.
5. Measure small, typical and large albums with distinct high-resolution files, retained edits and repeated render/export cycles. Record machine, PPI, wall time, peak memory/CPU, responsiveness and correctness. Coverage is evidence of exercised code, not a scale benchmark.
6. Pin the exact engine revision, extend CI to native build/tests and enforce release checks. Verify a clean checkout build and packaged helper dependencies, then signed/notarised installation on a clean Mac. Do not mistake the interface build or static dependency collector for an installed-app test.
7. Obtain the actual print-lab spec and issuer/rules test environment. Keep externally dependent rubric criteria at zero until directly verified. Reassess every category against the same criteria after each meaningful iteration.

Useful current checks from the repository root:

```sh
npm test
npm run lint
npm run typecheck
npm --prefix native/ui run build
node --experimental-test-coverage --test test/*.test.js native/backend/test/*.test.js
npm audit --json
npm --prefix native/ui audit --json
node native/scripts/collect-backend.mjs
```

The account tests require permission to bind disposable localhost listeners. Native baseline verification used:

```sh
cd native/photocraft
CARGO_TARGET_DIR=/Users/harry/Library/Caches/AlbumStudioBuild/target /Users/harry/.cargo/bin/cargo test --locked --offline -p album-studio
```

That cache path and the engine revision were verified locally. They must be checked again on another host. Source regression success does not assert that an old `native/dist/Album Studio.app` contains these changes.
