# Album Studio quality improvement log

## Mission state

Target: all nine categories must independently score strictly above 9.5/10 with verification. Mission remains active; no category is certified.

Latest checkpoint: iteration 3 on 14 October 2026; evidence is in
`docs/quality/2026-10-14-iteration-3/verification.json`. The sections below preserve the earlier
baseline and iterations. Current unresolved priority is whole-album cross-process isolation
and durable project/cache/render publication. Independent final review hit the provider limit.

Continuation verified on 13 October 2026 (Asia/Kolkata). No earlier `QUALITY_IMPROVEMENT_LOG.md` or objective scorecard exists in this checkout. The last persisted state is the audit in `docs/reviews/2026-10-13-project-review.md`, root commit `81bd5b4`, engine commit `bdb1f8f`. This continuation preserves that audit and does not restart it.

Recovery branch: `codex/album-quality-improvement`. Pre-existing user files: untracked `docs/reviews/` and `invoice-template/`; the engine has untracked `.DS_Store` files. None are discarded or committed as part of the implementation work. All regression fixtures are disposable and separate from real albums.

## Stable scoring contract

`QUALITY_SCORECARD.json` defines rubric version 1 before implementation scoring. Each category has ten fixed criteria worth ten points each: complete and verified = 10; verified partial implementation = 5; failed, unverified or externally blocked = 0. Every category needs more than 95 points; an unresolved critical defect prevents certification regardless of points. External verification cannot be replaced with a mock or documentation.

The original audit ratings were subjective (explicitly stated in that report). They are retained as historical references. The stricter acceptance-evidence scores can be lower without implying that implementation regressed. No earlier 100-point rubric was found; this rubric implements the criteria in the supplied mission and must remain stable between iterations. Score increases must reference actual tests or verification artifacts.

## Iteration 0 — verify the recorded baseline

- Root commit/branch before work: `81bd5b4`, `native-shell`; no tracked changes.
- Engine: separate ignored checkout, `bdb1f8f`; no tracked changes.
- `npm test`: 251 shared + 61 helper + 27 interface tests passed; no failures or skips. Real sheet/parity tests ran with the existing local engine.
- `npm run lint`: zero errors, three historical warnings.
- `npm run typecheck`: shared/interface checks passed.
- `npm --prefix native/ui run build`: launched; completion captured below.
- Native baseline tests: launched using the existing cache and offline dependencies; completion captured below.
- Root production audit: Sharp 0.34.5 still has high-severity advisories; not resolved.
- A shell result-reporting wrapper mistakenly used zsh's read-only `status` variable after the commands. Raw test/lint/type/audit logs contain completed results; subsequent wrappers use `result_code`. No application failure is attributed to that wrapper error.
- Durable follow-up evidence is required for accessibility, current realistic scale benchmarks, actual deployed Firestore rules/issuer behavior, printer/lab specifications, clean release build, signing, notarisation and customer installation. Historical test counts do not satisfy these requirements.

Baseline logs: `/private/tmp/album-quality-baseline-tests.log`, `album-quality-baseline-lint.log`, `album-quality-baseline-types.log`, `album-quality-baseline-audit.json`, `album-quality-baseline-build.log`, `album-quality-baseline-rust.log`. Temporary paths are diagnostic working files, not final release evidence.

## Iteration 1 — priority 0 correctness and recovery (checkpoint verified; remaining review incomplete)

Highest unresolved risk: production colour/profile loss and stale/wrong-spread delivery.

Work ownership:

- Parent: colour regression and conversion; immutable sheet ownership helper; render/export revision and job coordination; scoring/log and integration review.
- Identity task: compatible photo/template identities, stable spread IDs, undo/migration, explicit ambiguity and relinking.
- Account task: rejected/unconfirmed binding, concurrent claims, expiry and cancellation; no invalidation of legitimate existing licences.
- Recovery task: missing/hung engine lifecycle, bounded shutdown, restart-safe rename recovery and safe removable-drive behavior.

Colour fail-first evidence: new `native/backend/test/color.test.js` ran against the old export path: 2 passed, 3 failed (Display P3 conversion, profile preservation for previews, invalid-profile rejection). The reference uses a separately tagged PNG oracle.

Identity fail-first evidence: isolated collision/reorder reproductions reconfirm the existing defects; dedicated regression tests are being added. New numbered-file adoption must happen before the first structural edit and must never rename a document open in the editor.

Account fail-first evidence: rejected/unconfirmed bind, competing device, invalid expiry and cancellation regressions failed before implementation; focused results will be recorded after diff review.

Next executable steps: complete the focused fixes, test original compatibility, run full Node/native gates, inspect every diff, record results and reassess all categories. Continue to the next unresolved priority; a known future signing dependency is not grounds to stop independent implementation work.


### Implemented and tested

- Persisted photo/template root identities, explicit legacy ambiguity and backend relinking; persistent spread IDs; immutable PSD ownership before structural edits. Undo/redo, clear/autofill and failure history preserve association. New renders use the spread's canonical PSD; production JPEGs retain page numbering. Identical Plan spreads keep distinct manual sheet proofs after swapping.
- Source-aware 8-bit RGB ICC conversion for JPEGs, saved-sheet proofs and template backdrops; P3/sRGB comparison against an independent tagged PNG; flat colour and transparency tests; invalid structural profiles rejected. PDF exact ICC bytes, chunk ordering/bounds, channel counts and xrefs verified. Unique PDF staging and promise-based file writes settle unwritable destinations.
- Production preflight for full originals, corruption, frame count, inherited visibility, crop coverage, unsupported edits and effective/source/actual-sheet resolution. Stale or unknown render records block production. A 200-pixel-high sheet does not satisfy a one-inch 300-PPI requirement by upsampling. The configured PPI is explicitly the fallback policy; no lab dimensions or bleed numbers were invented.
- One render/export lease is reserved before asynchronous preparation; same-project edits are blocked during a job. Completion releases the lease before events. Real engine regression renders a missing spread into a canonical PSD and immediately exports it.
- Whole-album PDF completeness and PDF-only freshness checks; staged JPEG/PDF generation; pre-publication revision checks; caught publication failure restores prior delivery. Cancellation, a source change and simulated ENOSPC preserve old JPEGs/PDF/cache; unowned delivery files are preserved. This does not certify hardware power-loss recovery.
- Conditional device binding with authoritative reread; failed/unconfirmed writes deny access; invalid expiry denies; cached grants expire. Session refresh and sign-in generations prevent late writes after cancellation/sign-out/timeout. Duplicate OAuth callbacks cannot compete or cancel the winning callback. Existing legitimate licensing schemes remain compatible.
- Engine failed-start/request/shutdown paths settle within bounds. Lab rename transactions persist journals, recover after killed subprocesses and use exclusive, content-checked copy fallbacks when hard links are unsupported. Conflict recovery preserves files and actionable paths.
- Sharp pinned to 0.35.5; compatible development patches resolve brace-expansion/js-yaml advisories. Root and interface npm audits report zero advisories. The native Rust dependency advisory check remains unverified.
- Interface displays blocked production reasons and unresolved lab/embedded-detail warnings, uses string job IDs, rejects stale plan responses and refuses incomplete/PDF-only stale plans. Actual GUI/accessibility verification remains incomplete.

One drafted preflight assertion expected a width-doubled frame to fail the 300-PPI policy. The real geometry supplies 400 PPI there; the fixture was corrected to triple width, which is actually below policy. A new proof test initially lacked its output directory; that fixture was corrected. The old delivery acceptance test that silently omitted spread 3 was replaced with a complete three-spread fixture, while a separate regression now requires missing-spread rejection. No failing production requirement was weakened to pass tests.

### Verification and scope

Final `npm test`: **262 shared + 187 helper + 30 interface = 479 passed**, zero failures, skips or cancellations. The verified unchanged native checkout baseline is **96 passed**, zero failures/ignores. Combined verified scope: 575 tests; this is not a full engine workspace/corpus/Clippy or native GUI result.

`npm run lint`: zero errors and zero warnings. Shared/interface type checks passed. Interface production build passed (approximately 166.7 KB JS and 54.5 KB CSS). Static packaging collection includes all five new runtime modules and all installed dependency packages; an actual clean release bundle/installation is still unverified.

Shared/helper coverage run: 449 tests passed. Per-source evidence includes preflight 100.00% lines/91.71% branches, identity 97.37%/84.21%, account 95.96%/86.43%, delivery 95.20%/84.58%, PDF 100.00%/91.21%. Important gaps remain: shared proof renderer 48.46% lines, RAW helper 65.00%, render branches 59.09%. The reporter's aggregate includes test files; it is explicitly not used as overall product coverage. UI and Rust coverage are unmeasured.

Durable evidence and SHA-256 source/artifact records: `docs/quality/2026-10-13/verification.json`, with complete check logs/audit JSONs and retained fail-first artifacts in that folder. `docs/quality/RECOVERY_AND_VERIFICATION.md` records current behavior, remaining risks and restart commands. The old root audit and user invoice folder remain untouched.

### Reassessment using unchanged rubric version 1

These are acceptance-evidence scores under the fixed rubric, compared with its baseline. The earlier subjective audit scores remain separately retained in JSON. No category is certified; no score is rounded above 9.5.

| Category | Fixed-rubric baseline /10 | Current verified score /10 |
|---|---:|---:|
| Architecture | 6.5 | 6.5 |
| UI and workflow | 4.0 | 4.5 |
| Testing | 3.5 | 5.0 |
| Performance and scalability | 1.5 | 1.5 |
| Data integrity and recovery | 2.5 | 6.5 |
| Documentation | 3.0 | 4.5 |
| Security and licensing | 2.0 | 4.0 |
| Print and delivery correctness | 1.5 | 4.0 |
| Build and distribution | 2.5 | 2.5 |

Architecture still needs complete runtime typing/invalidation and state ownership review. UI needs real native workflows, relinking/ambiguity recovery and accessibility/large-grid verification. Testing needs remaining critical regressions, real GUI/corpus coverage and complete enforced CI. Performance has no current realistic scale/hardware-budget evidence. Data recovery lacks durable export restart reconciliation and full physical-drive/cross-process verification. Documentation needs verified fresh setup, release/customer procedures and external specs. Security still includes legacy HMAC and device-omitting signatures plus unverified real rules/issuer migration. Print still lacks other-mode/fallback colour oracles, print-size rendering, lab layout approval and a real printed corpus. Build lacks exact engine pin, clean bundle/customer setup and signed/notarised clean-Mac installation.

### Execution limit and external dependencies

Authoritative live agent inventory confirmed all three review agents terminal with the provider error **“You’ve hit your usage limit”**, reporting retry at **“4:07 PM”** without a date/timezone in the error. This is an actual execution limit, not a passing review. The parent finished the drafted preflight/PDF work and settled the tests before this checkpoint; the independent review phase remains incomplete. No tests/processes are still being awaited, and no mission completion is claimed. The goal remains active.

External verification requirements remain: approved native GUI/assistive-technology session; actual print-lab dimensions/bleed/safe-area/gutter/profile spec and a printed sample; authorised issuer/Firestore test environment and legitimate-account migration checks; real removable-drive/power-loss tests; Developer ID/notarisation access and a clean customer Mac. The current read-only signing query reports zero valid identities visible to the CLI; broader keychain access/credential installation is unverified. Credentials and real customer licences were not changed. The lab-spec clarification is still pending.

### Highest-priority next executable work

1. Verify this branch/checkpoint and `verification.json` checksums; recover review capacity and independently review every changed module. Do not repeat the original whole-folder audit or count interrupted agent work as approved.
2. Build failing colour oracles for Adobe RGB, 16-bit, CMYK, black/absent compatibility composites and semantic ICC corruption. Verify the engine PNG/template paths and independent PDF rendering before raising colour scores.
3. Implement rendering to declared physical print dimensions with an appropriate canvas/embedded-detail budget. Add a durable export publication journal and restart reconciliation, stronger source freshness and cross-process job locking. Existing size/time freshness and caught-error rollback are partial protections, not complete durability.
4. Continue the existing unresolved cache/RAW capture-order, queued-interface-album, relink/ambiguity UI, focus/keyboard/contrast and realistic distinct-photo performance work. Pin the exact engine, extend CI and verify a staged clean package. Preserve old application bundles before package replacement.
5. Verify the real lab and issuer/signing/install dependencies with authorised resources. Keep dependent criteria at zero until tested. Repeat inspect → diagnose → implement → test → review → reassess under the same criteria.

Recovery checkpoint is committed only on `codex/album-quality-improvement`; no merge, push, release publication or customer-data change is part of this checkpoint. The final Git check records the actual commit and preserved untracked folders.

Implementation source checkpoint: `d235d1ca1dd8a4faab97e388bdcfb0c9e8430ede`. The evidence follow-up explicitly includes diagnostic `.log` files, which the repository normally ignores. Source and artifact SHA-256 records still match. Root user folders remain untracked and unchanged.

## Iteration 2 — resume verified checkpoint; production colour, print rendering and restart recovery

The previous goal turn made concrete progress. This continuation verified both committed
checkpoints (`d235d1c`, `a4fa791`), the saved source/artifact hashes, current Git state and the
unchanged engine before continuing. It did not restart the original audit. The only initial
root untracked folders were the preserved audit and `invoice-template/`.

### Diagnosed, implemented and reviewed

- Semantic ICC mutations (invalid PCS/version/profile class/TRC function) reproduced silently
  unchanged values labelled sRGB. Headers/tags/curves and a bounded, cached native transform
  probe now reject those failures. Valid independently authored Adobe-RGB-compatible v2/v4
  matrix/TRC and LUT profiles pass separate source-container oracles. The fixture is not a
  copied or certified vendor profile.
- Native CMYK conversion through the engine differed from direct-ink TIFF under matched
  perceptual intent. Delivery now decodes actual PSD/PSB ink planes within strict bounds, for
  both depths and raw/RLE/ZIP/ZIP-prediction, and converts tagged TIFF samples through the same
  source policy as RGB. Unknown inks, missing profiles/composites, truncation and decompression
  overflow fail recoverably. Review found a fifth plane was assumed to be transparency without
  its declaration; that assumption was removed and the positive alpha fixture corrected to
  contain the required negative layer count. These tests do not certify engine CMYK editing.
- Sheets and template backdrops now share verified original-pixel handling. Real black and
  declared missing RGB composites are handled explicitly. Template edge regressions failed
  0/6 against the checkpoint implementation and pass 6/6 after repair. Review found ag-psd
  could decode a layerless 16-bit composite despite the requested skip, swapping bytes in
  place before a second decode. Metadata parsing now avoids that second read. Framed CMYK and
  high-depth template masks are explicitly unsupported with recovery instructions; full
  template/camera corpora and independent PDF rendering remain open.
- Rendering and delivery share print settings. Template geometry is resized before originals
  are embedded, and preflight computes the embedding limit against scaled frames before
  clamping to original detail. A real 600×300 output is verified from a 200×100 template,
  including frame geometry, original smart-object sample dimensions, pixel placement and
  decoration. Higher requested resolution invalidates plans; adequate larger owned sheets
  remain preserved. Insufficient originals and unreasonable canvas requests fail before
  publication. The 64 Mi-pixel cap is a safety policy, not a hardware performance result.
- Delivery publication is a durable journal of the JPEG/PDF set and next ownership cache,
  with flushed fingerprints, exclusive installation, restart reconciliation and process
  locking. Real SIGKILL tests exercise pending/committed publication, rollback and cleanup;
  competing stale-lock recovery is serialized. Cancellation and ENOSPC restore the old set.
  External edits, malformed paths/journals and recovery conflicts are retained. New delivery
  digests catch preserved-size/timestamp JPEG edits; legacy stamp-only records remain weaker.
  Recovery is invoked before plans trust cached output. Committed cleanup errors are surfaced
  without falsely claiming rollback. Physical-drive/power-loss guarantees remain unverified.
- Queued edit/undo/redo requests capture their album at enqueue time and copy edit operations.
  Three album-switch/failure regressions fail before the fix and pass afterwards. Late render
  plans cannot replace a newer album/settings plan. Actual native interaction is unverified.
- The exact eleven-commit engine fork is preserved in a checksum-pinned incremental Git
  bundle with its upstream prerequisite, Cargo.lock, compiler and provenance. Anonymous fresh
  reconstruction and a separate-target cold release engine/shell build completed. A fresh
  provenance-tagged CLI runs the application gate with zero permitted skips. Setup never
  resets an existing checkout. Packaging uses staging and atomic no-replace publication,
  preserving even an empty existing destination. CI defines native workspace, adversarial,
  formatting, Clippy, layering and real-file corpus gates. Hosted execution and full root
  packaging/install were not verified. The `block 0.1.6` future-compiler incompatibility is
  recorded rather than suppressed.

### Final verification

Final strict application gate: **273 shared + 307 helper + 33 interface = 613 passed**;
zero failures, skips or cancellations. It uses the freshly reconstructed pinned CLI, not the
old installed app. Shared/helper source coverage: 580 passing tests. Key source line/branch
coverage: colour 96.20/82.78, delivery transaction 98.76/89.13, delivery 99.01/87.10,
print settings 100/93.75, preflight 100/91.36, render 98.04/70.00. Gaps remain in RAW
(65% lines), shared proof renderer (48.46% lines), interface/native coverage and real corpora.
The aggregate coverage table includes tests and is not a product coverage score.

Lint: zero errors/warnings. Shared/interface types and interface production build pass
(167.2 KB JS, 54.5 KB CSS). Static backend collection contains 49 runtime files and 10
installed packages, including both new helpers. Script syntax/source whitespace checks pass.
The 96-test unchanged native baseline is retained as earlier evidence, not relabelled a fresh
whole-workspace run. The dependency lockfiles are unchanged from the prior zero-advisory npm
reports; Rust advisory and hosted/full native gates remain unverified.

Exact logs, failing-before artifacts, source/artifact hashes and test scopes are preserved in
`docs/quality/2026-10-13-iteration-2/verification.json`. Earlier checkpoint evidence remains
unchanged. `RECOVERY_AND_VERIFICATION.md` and `ENGINE_PIN_AND_CI.md` describe supported paths,
limitations and executable restart procedures.

### All nine categories reassessed under the unchanged rubric

| Category | Iteration 1 /10 | Iteration 2 /10 |
|---|---:|---:|
| Architecture | 6.5 | 6.5 |
| UI and workflow | 4.5 | 4.5 |
| Testing | 5.0 | 5.0 |
| Performance and scalability | 1.5 | 1.5 |
| Data integrity and recovery | 6.5 | 6.5 |
| Documentation | 4.5 | 4.5 |
| Security and licensing | 4.0 | 4.0 |
| Print and delivery correctness | 4.0 | 4.0 |
| Build and distribution | 2.5 | 4.0 |

Build gains ten verified points for the exact dependency pin and five partial points for fresh
engine/shell reconstruction/build; fresh root packaging and installation still lack evidence.
Every other criterion retains its prior points. Stronger evidence within a partial criterion
does not make it complete. Architecture still lacks complete runtime contracts/invalidation;
UI lacks native accessibility/relink/scale workflows; testing lacks independent review and
full CI/corpus/GUI coverage; performance lacks realistic hardware measurements; data lacks
strong source freshness and whole-app durable/cross-process isolation; documentation lacks
verified customer/release procedures; security lacks issuer/rules/device-bound migration;
print lacks complete source/layer/corpus/lab proof; build lacks signed/notarised installation.
No category is certified and the mission is not complete.

### Precise execution limit and next executable steps

Live agent inventory confirms all three review workers terminal with **"You've hit your usage
limit"**, reporting retry at **"6:20 PM"** without a date/timezone. The parent completed the
already drafted integrations and final verification, but a second-agent review of the final
diff did not finish. This is the actual execution limit for this checkpoint; no review is
claimed complete and no live check is still awaited. The goal remains active.

The highest unresolved production defect is **source/render freshness still using size and
time**: originals, templates, sheets and RAW/thumbnail/adjustment caches can miss content
changes preserving those values. Next: add failing preserved-stamp source/sheet regressions,
introduce bounded content evidence across those caches, and define conservative compatibility
for old manual/unknown sheets without overwriting or retrospectively claiming ownership.
Then independently review decoder/transaction/setup/UI changes, add whole-app cross-process
leases and durable project/render/cache publication, complete framed high-depth/CMYK and PDF
oracles, relink/ambiguity UI, accessibility and realistic distinct-photo benchmarks.

Restart by verifying Git HEAD/branch plus the new manifest hashes, checking the engine pin,
and running the no-skip gate with a freshly built tagged CLI. Do not repeat the old audit or
count the previous app bundle as current. Run hosted/native workspace/Clippy/layering/corpus
and a new staged package when execution capacity permits; preserve existing bundles. External
dependencies remain the authorised lab spec/printed sample, approved GUI/accessibility session,
issuer/Firestore test environment and customer migration, physical-drive/power-loss testing,
Developer ID/notarisation access and a clean customer Mac. These remain unverified requirements.
Root user folders and the engine's three existing `.DS_Store` files remain untouched.

Diagnostic stdout logs retain their original trailing whitespace; only those raw evidence logs are excluded from the source whitespace check. Their recorded checksums are verified without normalisation.

## Iteration 3 — content freshness, private inputs, bounded decoding and capture races

Resumed `0259580cec6cb6eb5fbb4d3986c94fc6bf7bd849` on the existing recovery branch. The
previous 184 source/artifact checksums, pinned engine and untracked user folders were verified
before implementation. No audit restart, user-file cleanup or existing-bundle replacement
occurred. The engine source remains unchanged at `bdb1f8f35767700033ec9cd7b8fc0b80e182b0e9`.

### Diagnosed, implemented and tested

- Preserved-size/time originals and templates reused obsolete render and template results.
  Bounded SHA-256 reads now check no-follow file handles and before/after identity. Hashing is
  limited to four open readers and 1 MiB read buffers; no global size/time digest cache hides
  changes. Versioned input hashes distinguish verified content evidence from historical
  stamp-derived hashes. New render records include the actual PSD digest. Old unknown/manual
  sheets remain protected and cannot silently acquire a new claim of production ownership.
- RAW, adjustment, thumbnail, template, proof, scoring and lab-preview caches now bind source
  contents, recipe and output digests. Edited/unrecognised cached images remain intact with
  actionable errors or retained history. Embedded RAW previews use bounded header/preview
  reads. Tests cover source edits/restoration during decoding, same-size/stamp mutations,
  malformed preview offsets, failed thumbnail refresh and orphan proxies. Fake RAW converters
  in these tests are not evidence of real-camera decoding or RAW/JPEG proxy equivalence.
- Rendering, proof generation and delivery consume private copies tied to verified digests.
  Template artifacts have their own digests; corrupting a backdrop after verification cannot
  produce a proof. Exact project JSON and source revisions are checked before publication.
  Final integration found a scoring snapshot could change to black during analysis and be
  restored before the final hash; its inode/size/mtime/ctime identity is now checked too.
  Both persistent and changed-then-restored snapshots reject scores and preserve their bytes.
- Replacing an existing PSD captures it using an atomic no-replace OS primitive before
  validating the captured digest. A real-engine regression inserts a manual edit at that
  boundary and verifies the exact bytes and old cache survive. Old PSD/proof versions are
  retained in history. This does not provide a complete restart journal for render/cache/project
  updates, nor a hardware-atomic snapshot of all source files.
- Delivery now checks cancellation after final hashing and source/project validity after
  flushing the committed journal record but immediately before its marker rename. A late stop
  cannot falsely label an already committed set as rolled back. Backup/discard capture refuses
  existing destinations. Retirement moves the entire validated stage into delivery history
  instead of checksum-then-unlinking mutable recovery bytes. Real SIGKILL, conflict, helper
  post-syscall failure and competing-process delivery regressions pass. History is excluded
  from active recovery scans; unexpected bytes and conflicting paths remain preserved.
- RGB auxiliary selection channels were incorrectly interpreted as alpha; some 16-bit RGB RLE
  composites decoded to black through ag-psd. RGB and CMYK now share a bounded planar
  PSD/PSB raw/RLE/ZIP/ZIP-prediction route, preserving 8/16-bit samples. Transparency requires
  actual negative layer-count provenance, including global Lr16/Layr/Lr32 records. Malformed
  planes/unknown channels fail explicitly. PSD/PSB source reads reject files over 512 MiB before
  allocation; composite allocation has a separate 512 MiB bound. These limits reject some
  legitimate large documents and are not performance certification.
- The independent Poppler PDF oracle initially exposed CMYK intent differences up to 15
  channel values. PDF image objects now explicitly request perceptual intent. Final actual
  ICCBased PDF rendering with an explicit sRGB display profile matches sRGB/P3/Gray patches
  exactly and CMYK patches within the unchanged tolerance of 3. Exact streams, page geometry,
  source JPEGs, ICC and rendered PNGs are retained. This synthetic oracle does not certify
  arbitrary PDFs, editor layers or lab output.
- The tiny atomic helper is now compiled with its source SHA-256, required by the strict gate,
  bundled and signed beside the CLI. Missing helpers fail with recovery instructions. CI
  installs Poppler; developer/recovery instructions now describe the mandatory helper/verifier,
  pinned setup, safe package destination, content evidence and retained history. Full new app
  packaging, hosted CI and clean-Mac installation remain unverified.

The original template freshness fixture did not initially preserve exact mtime precision.
Its corrected fixture normalises timestamps to integral seconds and fails against the prior
module (0/1), then passes against the fix. The pinned baseline loader and raw failing log are
retained. The original source freshness regression fails 0/3 before the new API; the final
expanded suite covers four bounded/content/identity/concurrency cases. No requirement or PDF
colour tolerance was weakened to make tests pass. A syntax check initially used Bash on a
Zsh script; the supported Zsh parser passes and that diagnostic is not an application failure.

### Final verification and limits

Strict real-engine application gate: **273 shared + 409 helper + 33 interface = 715 passed**,
zero failed/skipped/cancelled. Separate shared/helper source coverage: **682 passed**, zero
failures or skips. The immediately preceding full run is retained with its one scoring
snapshot failure; final logs are separate. Representative source line/branch coverage:
colour 97.23/81.63, cache 96.81/89.58, delivery transaction 98.84/89.65, delivery 99.03/87.34,
RAW 93.82/75.19, template 93.80/78.52, proofs 86.86/74.21, render 97.20/74.79. The report's
aggregate includes tests and must not be presented as product coverage.

Lint has zero errors/warnings; shared/interface types and interface production build pass
(167.2 KiB JS, 54.5 KiB CSS). Static runtime closure: 50 files and 10 installed packages,
including the new atomic wrapper. Current helper source checksum/version, engine pin and
source/shell syntax/whitespace checks pass. Local Node is 22.22.3; package/CI pin is 22.23.3.
Rust/Cargo are 1.99.0; the CLI is the previously freshly reconstructed pinned build, not a new
whole-workspace build in this iteration. The C helper was freshly compiled. The historical
96 native tests, prior dependency audits and old app bundle are not relabelled current checks.

### All nine categories reassessed using the same ten criteria each

| Category | Iteration 2 /10 | Iteration 3 /10 | Remaining acceptance gap |
|---|---:|---:|---|
| Architecture | 6.5 | 6.5 | Whole-app state ownership, runtime contracts, complete invalidation |
| UI and workflow | 4.5 | 4.5 | Native workflows, ambiguity/relink, focus/accessibility, large grids |
| Testing | 5.0 | 5.0 | Final independent review, native GUI/workspace/corpus and hosted gates |
| Performance and scalability | 1.5 | 1.5 | Distinct high-resolution album timing, memory, latency, retention budgets |
| Data integrity and recovery | 6.5 | 6.5 | Whole-app leases, durable project/cache/render journal and drive tests |
| Documentation | 4.5 | 4.5 | Verified customer/release procedures and missing real workflows |
| Security and licensing | 4.0 | 4.0 | Device-bound issuer migration, real rules, hardened distribution |
| Print and delivery correctness | 4.0 | 4.0 | Framed high-depth/CMYK, broad corpus, actual bleed/gutter/lab evidence |
| Build and distribution | 4.0 | 4.0 | Full root package, hosted native gates, signing/notarisation/clean Mac |

All 90 criteria were reassessed. Stronger evidence within a partial criterion is insufficient
for its ten verified points. Source freshness is substantially stronger, but catalogue/photo
metadata timestamp caches remain; full invalidation is not certified. PDF synthetic verification
does not complete colour/corpus/lab criteria. Unmeasured full-hash cost and retained histories
prevent performance claims. No points were raised or requirements removed, and no category is
certified. The mission remains incomplete.

### Execution limit, highest unresolved defect and executable continuation

All three workers are terminal at the provider account limit: **"You've hit your usage limit"**,
reporting **"Oct 14th, 2026 2:45 AM"** without a timezone. This is the verbatim provider message,
not a verified future reset estimate. The parent completed the drafted integrations, repaired
the final failed regression and obtained green final checks. Independent final review of the
integrated changes did not finish; it remains a required check. Work is checkpointed at this
actual review execution limit. The goal is active, not completed or certified.

The highest unresolved defect is **whole-album cross-process isolation**: two live independent
Node processes acquired and held a render lease for the same path concurrently. The read-only
diagnostic and both PIDs/leases are retained in `job-isolation.json`. Delivery's publication
lock does not protect render preparation, project migration or edits.

Next executable steps:

1. Verify this manifest, branch/HEAD and engine pin; preserve user folders and existing app
   bundles. Run final independent review of source/derived snapshots, colour planes, capture
   recovery/history and shipped helper integration when execution capacity is available.
2. Add a whole-album cross-process lease before migration/preparation and every project edit.
   Canonicalise aliases, retain owner token/PID, fail closed on uncertain ownership, and test
   two live processes, stale owners, interrupted reclamation, stop/release and alias paths.
   Add a failing subprocess regression first; do not mistake the delivery-only lock for a fix.
3. Journal render capture/install/cache and project revisions durably; test kills at each
   boundary, source/manual edits and ENOSPC. Recovery must expose the exact retained history
   path. Keep existing sheets, ambiguity and weak legacy evidence protected. Add a reviewed
   history-cleanup workflow and retention/disk budgets before any automatic pruning.
4. Close remaining metadata/capture-order invalidation, real camera RAW/JPEG equivalence,
   framed high-depth/CMYK, actual native ambiguity/relink/accessibility workflows and realistic
   unique-photo benchmarks. Re-run the strict pinned-engine/helper/Poppler gate after changes.
5. Run full native workspace/Clippy/layering/corpus, hosted CI and a new staged root package.
   The previously reported `block 0.1.6` future-compiler incompatibility remains unresolved.
   Obtain an approved GUI/accessibility session, real lab spec/sample, issuer/Firestore test
   environment and migration inputs, drive/power-loss setup, Developer ID/notarisation access
   and a clean customer Mac. Keep externally unverified criteria at zero.

New evidence and source/artifact checksums are in
`docs/quality/2026-10-14-iteration-3/verification.json`. Older evidence is unchanged. User
`docs/reviews/`, `invoice-template/` and the three engine `.DS_Store` files remain untouched.
