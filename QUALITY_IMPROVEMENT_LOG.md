# Album Studio quality improvement log

## Mission state

Target: all nine categories must independently score strictly above 9.5/10 with verification. Mission remains active; no category is certified.

Latest checkpoint: iteration 5 on 14 October 2026; evidence is in
`docs/quality/2026-10-14-iteration-5/verification.json`. Earlier sections remain historical.
Same-project and physical output/parent backend exclusion, journaled project saves and exact
output-path consumption checks now have regressions. Permanent/legacy output ownership,
durable render/cache publication and print/preflight metadata remain open. Final independent
review remains unavailable at the provider usage limit.

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


## Iteration 4 — cooperative project ownership, journaled saves and frozen decoder inputs

### Verified starting state and scope

Resumed on `codex/album-quality-improvement` from `89ebcc580d0570bc9407bda70b028f22912d094c`.
All **177 source and 40 evidence hashes** from iteration 3 verify against that committed source
and the unchanged evidence files. Engine checkout remains
`bdb1f8f35767700033ec9cd7b8fc0b80e182b0e9`, with no tracked engine changes. User audit/invoice
folders and the three engine `.DS_Store` entries remain untouched. No real albums, accounts,
licenses, existing application bundles or external services were changed.

The recorded priority was reproduced before implementation: independent helpers could hold
same-project jobs concurrently. The retained baseline loader reproduces the old source; its
job-isolation regression has 40 failures of 42 cases. Separate fail-first evidence also covers
project temp/backup symlinks and external revisions (0/3), album-creation/proof/cache mutation
races (0/3), project-file symlink location (0/1), engine fallback changed/restored PSD inputs
(0/3), and detached delivery-history and metadata replacement races (0/3 each).

### Implemented fixes and exact boundaries

- Canonical project leases now cover backend render/export preparation through publication,
  project opening/migration/edits/undo/redo, proof refresh and album-cache clearing. Folder,
  JSON, case and symlink aliases share ownership/history; hardlinked project JSON is refused.
  A complete flushed owner directory is atomically published with a private token and verified
  machine, boot, PID and process-start identity. Stale same-host dead owners use an exclusive
  reclamation guard; malformed/foreign/uncertain owners and interrupted guards fail closed.
  Locale/timezone differences initially allowed a live owner to appear stale: process-start
  commands now force UTC/C locale, with a real cross-environment regression. Real SIGKILL tests
  cover guard publication/capture/release and competing reclaim/acquisition windows. The Linux
  adapter is not runtime verified; native/editor/external writers are not cooperative yet.
- Project saves now require their exact read SHA-256 and an owned lease. Independent bounded
  no-follow reads reject over-64-MiB projects before whole-file allocation. Unique exclusive,
  flushed snapshots and install copies precede a durable journal, backup/project capture and
  commit marker. Public files and history are detached copies. Pending saves restore retained
  before bytes only to vacant names; committed saves retain the new revision. Reopening through
  the actual `album.open` route recovers valid interrupted saves even when the JSON name is
  absent. Existing manual revisions, symlink/hardlink backups, conflicting entries and all
  recovery snapshots are preserved. A committed retirement error explicitly says the project
  was saved and names the retained history. Real kills cover six save boundaries plus actual
  folder/file/dangling-symlink reopen recovery. Physical power-loss durability remains unverified.
- Direct album creation publishes a flushed exclusive private JSON without replacing a late
  arriving project. Proof refresh now holds a lease, reloads bounded manifest evidence under
  it and propagates publication failures. Job reservation occurs before its first await;
  internal migration/proof work reuses its owned capability. Completion releases the lease
  before the finished event. Undo/redo keys use canonical file/revision and refuse to apply an
  in-memory history across another process's saved revision.
- Delivery publication/rollback installs detached exclusive copies instead of hardlinks to
  archived bytes. A later normal public edit cannot change the only history copy. Metadata is
  applied through the verified no-follow handle; replacement regular/symlink entries preserve
  their unrelated bytes/mode/times. Existing delivery journals/capture guards remain intact.
- RGB layer fallback now passes the already verified bounded PSD/PSB buffer through a private
  read-only file to the real engine. Changed/restored originals cannot substitute a different
  layer composite. Explicit buffer callers consume those bytes. Source extension/profile
  conversion stays intact; synthetic fixtures do not certify arbitrary editor layers.
- PDF inputs now require complete bounded JPEG marker/scan structure and successful full
  entropy decoding before replacement. Missing/truncated scans, empty entropy, missing tables
  and oversized sparse files fail explicitly. Valid tested baseline, progressive and arithmetic
  sequential/progressive JPEG bytes are embedded unchanged. The independent colour oracle now
  renders five actual PDF pages, adding progressive JPEG, with the existing channel tolerance
  **3** unchanged. The benchmark's separate textured-patch check is not that colour oracle.

### HFS findings, rejected approach and test scheduling

The internal system temp disk had about 8 GiB free, so heavy tests use new disposable ignored
`bench/fixture/` directories on the external volume. That volume is **HFS journaled/noowners**
with coarse timestamps. This uncovered actual changed/restored input gaps: stat checks alone
could accept pixels consumed during a transient edit. A filesystem-notification attempt both
missed one such edit and produced false alarms; it was rejected and removed. Raw failed runs,
including this rejected approach, remain separate from final passing evidence.

Final source hashing compares two streamed SHA-256 passes through the same no-follow handle,
with before/after identity checks and at most four active readers. Decoder paths consume
verified private copies made read-only before RAW/adjustment/embedded preview/thumbnail/lab
conversion. Their content and write permissions are checked after use; unexpected edits are
preserved. Scoring applies the same permission/content rule. On coarse HFS, an original that
changes and restores may be accepted only when the converter actually consumed the verified
original snapshot. The RAW regression now checks those consumed pixels and the passed path;
a fake converter that ignores its arguments is not valid evidence. Private-edit regressions
explicitly make a copy writable before editing, then require refusal and byte preservation.

Derivative recipes, render/proof/export versions and scoring schema 3 invalidate older results
that could have been produced through live-path decoders. A legacy v2 scoring record falsely
calling a white image black is recalculated without replacing the old evidence. This does
not establish an atomic snapshot against arbitrary concurrent external programs or complete
catalogue/capture-order/preflight metadata invalidation.

Default file-level test parallelism plus simultaneous full coverage/gate runs exceeded useful
memory on this 16 GiB Mac and caused timeouts. Final backend files run with concurrency **2**;
coverage and full gate run sequentially. In-file/process races still execute concurrently.
Two old render/export tests now await the actual completion event with a cleared 60-second
functional deadline instead of leaving a live job after a one/two-second polling assumption.
The expected accepted/completed/failed job assertions are unchanged. The identity fault hook
now targets the intended project-install boundary rather than also preventing recovery.
No test was removed or skipped, no colour tolerance was raised, and no production latency
budget was weakened: production performance budgets remain unverified.

### Final application verification

Strict pinned-engine/helper gate: **273 shared + 515 backend + 33 interface = 821 passed**,
zero failures, cancellations or skips. Separate shared/backend source coverage: **788 passed**,
zero failures, cancellations or skips. Earlier 820/787 passing results predate scoring schema 3
and are retained as historical, not current-source evidence. The full failed/intermediate runs
are also retained. Representative current source line/branch coverage: project lock 95.19/84.92,
project transaction 97.15/79.19, colour 97.27/82.35, cache 97.06/86.27, delivery 99.04/88.34,
delivery transaction 98.10/90.00, PDF 100/88.37, RAW 94.31/73.94, proofs 88.56/78.44 and render
97.28/77.42. Aggregate coverage includes test files and is not product coverage.

Lint has zero errors/warnings; shared/interface type checks and the unchanged interface build
pass (167.2 KiB JS, 54.5 KiB CSS). Static runtime closure is **52 files and 10 packages**,
including the new lease/transaction modules. Whole native workspace formatting passes freshly;
full native tests/Clippy/layering/corpus and hosted CI remain unrun here. Local Node is 22.22.3,
not the packaged/CI pin 22.23.3. Rust/Cargo are 1.99.0. The CLI/shell remain the prior pinned
reconstruction and the atomic helper remains the source-checksummed compiled helper; no new
full app package or installed-app check is claimed. Prior dependency audits/native test counts
remain historical.


### High-resolution pilot and retained failed measurement

The new guarded harness uses independent deterministic textured **4000×3000 JPEGs**, rather
than many IDs pointing to one tiny image. The final pilot uses 24 unique sources, eight simple
three-frame RGB spreads, **5400×1800 output at 6 inches/300 PPI**, three warm cycles, preserved-
stamp invalidation, spread reorder and independent PDF page/order/pixel checks. It uses a fresh
owned ignored folder, explicit 4 GiB disk/2 GiB sampled-RSS/900-second safety ceilings, a free-
space reserve, bounded workers and before/after source/executable hashes. No customer folder
is scanned. These limits are safeguards for the harness, not accepted production budgets.

The first pilot failed its oracle's assumption that Poppler single-axis scaling yields exactly
400 rows; the actual raster was 1200×401. Inspection confirmed every PDF MediaBox was the correct
**1296×432 points (18×6 inches)**. The corrected harness independently asserts every physical
page box, then explicitly requests both raster dimensions 1200×400. It retains the same pixel
checks/tolerance and reruns from fresh fixtures. The first failed report/log remains retained.
No application/PDF geometry code changed to accommodate that oracle error.

Final pilot: **completed**, source hashes unchanged during measurement, Apple M4/16 GiB,
Node 22.22.3, external HFS. Cold proof **3.417 s**, cold render **32.024 s**, cold export/PDF
**16.130 s**. Three warm renders **1.088/0.907/0.904 s**, three warm exports including rebuilt
PDF **7.652/8.209/7.485 s**, all eight sheets/JPEGs reused. Sampled aggregate process-tree RSS
maximum **1514.7 MiB**. Per-phase CPU/event-loop/disk samples are retained. Source/sheet/JPEG
hashes survive reorder; preserved-stamp mutation invalidates one spread. All eight PDF pages,
physical geometry, order and textured patches pass (maximum observed channel-average delta
**1.54**, predeclared texture tolerance 8; distinct from the strict colour-patch tolerance 3).
Across three warm cycles retained files grew **4,814,058 logical bytes**. Final logical footprint
**1.123 GiB**. This demonstrates growth, not an approved retention budget.

The fixture/report remain locally under `bench/fixture/native-pipeline-PI8tLH/`; the failed
fixture remains under `bench/fixture/native-pipeline-KIDFdL/`. Tracked reports and source/output
hashes preserve provenance; full generated images/PSDs are local ignored data, not shipped
release files. Cold is application-cache cold, not OS-cache cold. Synthetic textures/simple
RGB layers are not customer photo/RAW/high-depth/CMYK corpus. 250-ms RSS sampling can miss peaks;
ps CPU is a process-lifetime average and worker event-loop delay is not native UI latency.
Small/typical/large customer distributions and accepted hardware budgets remain unverified.

### All nine categories reassessed against the unchanged rubric

| Category | Iteration 3 /10 | Iteration 4 /10 | Remaining acceptance gap |
|---|---:|---:|---|
| Architecture | 6.5 | 6.5 | Whole-app/output ownership, contracts and complete invalidation |
| UI and workflow | 4.5 | 4.5 | Actual native relink/recovery/focus/accessibility and large grids |
| Testing | 5.0 | 5.0 | Final independent review, native GUI/workspace/corpus and hosted gates |
| Performance and scalability | 1.5 | 3.0 | Customer scale, true peak/latency, accepted budgets and retention |
| Data integrity and recovery | 6.5 | 6.5 | Shared outputs, durable render/cache journal and physical storage |
| Documentation | 4.5 | 4.5 | Verified customer/release/manual/external procedures |
| Security and licensing | 4.0 | 4.0 | Device-bound issuer/rules migration and hardened distribution |
| Print and delivery correctness | 4.0 | 4.0 | Metadata consumption, real corpus, bleed/gutter and lab samples |
| Build and distribution | 4.0 | 4.0 | Full package/native/hosted gates, notarisation and clean customer Mac |

All 90 fixed criteria were reassessed; no names or weights changed. Only performance criteria
4 (high-resolution render/export), 5 (peak memory/CPU) and 9 (repeated resource growth) move from
0 to **5 verified partial points each**, supported by the completed pilot. They remain partial
because their realistic/complete measurement requirements are open. No criterion receives new
full points and no category is certified. Strengthened project/process/print/backend tests do
not complete their remaining whole-app or external requirements. Mission remains incomplete.

### Actual execution limit, highest unresolved issue and next executable steps

All three review workers are terminal at the provider usage limit: **“You’ve hit your usage
limit”**, reporting **“4:51 PM”** without a date/timezone. This records the returned report,
not a verified future reset estimate. Scoped worker reviews found and fixed real defects, but
final independent review of the parent's project transaction, lease integration and HFS input
changes did not finish. Parent integration, targeted failure review, strict gate, source
coverage and pilot complete; they do not substitute for that required independent review.
Work is preserved at this actual review execution limit. The goal stays active, not complete.

The highest unresolved isolation issue is **shared output ownership**. A new disposable
same-time two-process diagnostic holds a render reservation for project A and export reservation
for B when both declare the same output root. Actual delivery path calculation gives the same
cache and numbered JPEG destinations. Even distinct sibling output roots share a parent JPEG
directory. The diagnostic confirms overlapping preparation/namespaces; it does not attempt
publication and does not claim that existing overwrite protections were bypassed. Its first
invocation omitted the required helper environment and failed closed; that setup diagnostic and
the corrected successful run are both retained. The next fix needs an explicit root/parent
ownership policy and tests, not a broad claim that project locks protect every output path.

Next executable steps, preserving existing recovery histories and user files:

1. Verify iteration-4 source/evidence checksums and Git state. Complete independent review of
   final project journal/open/recovery/committed-error paths, alias/process lease integration,
   HFS read-only snapshots, and unresolved prior colour/history/helper review. Inspect the
   retained failed runs as well as final results; do not relabel the rejected watcher approach
   or earlier-source 820/787 results as current evidence.
2. Reuse `shared-output-diagnostic.cjs` with the mandatory atomic helper path. Add fail-first
   integration tests for two projects sharing an output root and different roots sharing a
   delivery parent, including existing/manual files and concurrent/killed jobs. Choose explicit
   ownership/refusal or root serialization plus compatible migration; preserve all ambiguities.
   Do not delete existing shared outputs or silently choose a project owner.
3. Journal render capture/install/cache publication and recovery durably, testing real kills at
   every boundary, source/manual edits, ENOSPC and committed cleanup. Add a reviewed history
   cleanup/retention workflow before pruning anything. Whole-app/native writers and global
   app-cache clearing also need an explicit ownership policy.
4. Reproduce live-metadata changes around `print_settings.psdDimensions` and preflight template/
   original decoding. Bind dimensions/resolution/profile/preflight to the same verified bytes
   later consumed, or refuse changes. Complete catalogue/capture-order invalidation, real RAW/
   JPEG proxy equivalence, framed high-depth/CMYK and real layer/mask/profile corpus.
5. Review the pilot before running small/typical/large customer workloads. Keep each new run
   isolated with explicit disk/RSS/time safeguards. Establish true peak/CPU, UI latency and
   retention budgets on realistic hardware; synthetic performance evidence is only partial.
6. Run full native workspace/Clippy/layering/corpus, hosted CI and a new staged root package.
   `block 0.1.6` future-compiler incompatibility and packaged pinned-Node verification remain
   open. Obtain an approved GUI/accessibility session, real lab spec/samples, authorized issuer/
   Firestore migration/test environment, physical drive/power-loss setup, Developer ID/
   notarisation access and clean customer Mac. Keep unverified acceptance requirements at zero.

Exact logs, review limits, benchmark measurements, diagnostic and SHA-256 source/evidence
manifest: `docs/quality/2026-10-14-iteration-4/verification.json`. User `docs/reviews/`,
`invoice-template/` and engine `.DS_Store` files remain untouched and excluded from checkpoints.


## Iteration 5 — physical output namespace exclusion and guarded render history

The preceding goal turn made progress: checkpoint `d6c1501` contains the implementation and
verified evidence from iteration 4. This continuation verifies its **187 source and 48 tracked
artifact hashes** against the current checkout before implementing anything. Tracked Git state
was clean; only the user's audit/invoice folders were untracked. Engine remains `bdb1f8f` with
no tracked changes and only the three pre-existing `.DS_Store` entries. No baseline audit was
repeated and no real album, account, external service or existing app bundle was changed.

The highest recorded issue was shared output/cache and delivery-parent overlap. Nine dedicated
regressions against `d6c1501` in both parent and child processes produce **1 pass/8 failures**,
zero skips: shared-root jobs, sibling delivery parents, physical symlink aliases, another
project's cache/proof work, unexpected/symlink/changed namespace records and foreign/malformed
render history. Verified stale-owner recovery already passes at baseline. The first draft
teardown removed disposable folders before releasing live owners; that hook failure is retained
separately. Teardown now releases children before removing the fixture. The corrected exact
baseline loader/log is authoritative; the earlier parent-only loader is not a full pinned child
run. No production assertion was weakened to repair test teardown.

### Implemented scope

- New physical sheet-folder namespace leases accompany backend project leases. Export/export
  planning additionally lease the actual delivery parent, since sibling sheet folders share
  `JPEG-High-Res/Page_NNN.jpg` and `JPEG-Low-Res/Page_NNN.jpg`. Root aliases map to the same
  physical directory. For symlinked outputs, delivery retains its existing logical-parent
  location while locking that parent's actual directory; no delivery location is silently moved.
- Small read-only namespace markers are exclusively published and flushed without replacing
  an existing entry. They reserve a service namespace, **not ownership of existing customer
  files**. Project lease machinery supplies the machine/boot/PID/start/token owner, safe
  reclamation guards and retained history. Partial acquisition releases every already held
  namespace. A failed shared-sheet acquisition does not leave the delivery parent locked.
  Dead same-host owners recover after real SIGKILL; uncertain/foreign/interrupted evidence
  retains the existing fail-closed policy.
- Job reservation obtains physical namespaces before migration/preparation and holds them
  through publication/finish. Plans, proof refresh, direct sheet-proof recording and album
  cache clearing participate. Internal work reuses its held capability without self-deadlock.
  Completion releases output leases and then the project lease before the finished event;
  primary/release errors and exact lock evidence are preserved.
- New rendered-cache writes carry the canonical project file. A known foreign association
  blocks preparation before migration or rendered-sheet/delivery publication. A foreign cache cannot make another
  project's album view adopt its sheets. Current unique/legacy records remain compatible with
  their previous per-file/manual policy; no blanket regeneration/deletion or silent permanent
  ownership claim is made. Render evidence is independently bounded to 64 MiB, no-follow and
  non-hardlinked. Malformed/oversized/invalid-shape history fails visibly instead of being
  treated as an empty cache and replaced.

A tenth fail-first regression found that an external writer could change the project's output
between namespace acquisition and `prepareExport`'s JSON read. Preparation then inspected the
new folder's recovery history without its lease. That regression initially fails **0/1**.
The final code checks the actual output and delivery parent immediately before recovery scans;
render planning, proof operations and cache clearing also validate their consumed output path.
The final ten-test focused suite passes. The unrelated recovery bytes remain unchanged and its
history is not even scanned. This is cooperative directory exclusion plus tested boundary
validation, not an atomic defence against arbitrary external path replacement between syscalls.

### Verification, scope and continuing limitations

Final strict gate: **273 shared + 525 backend + 33 interface = 831 passed**, zero failures,
cancellations or skips. The earlier 830-test gate and 797-test coverage predate the tenth
consumption-boundary regression and are preserved separately; they are not final-source checks.
Scoped project/job/alias/mutation/SIGKILL integration passed **83 tests**. Lint has zero errors
or warnings; shared/interface types and production interface build pass. Static runtime closure
is **53 files and 10 packages**, including the new namespace module. Native engine/source/helper
pins remain unchanged; this iteration does not relabel old native tests, formatting, dependency
audits, installed bundles or hosted checks as freshly verified.

Whole-app permanent ownership remains incomplete: ownerless legacy records, moved/copied
projects, missing/deleted evidence and manual reconciliation need an explicit migration/recovery
workflow. Native/editor/external writers and global app-cache clearing do not yet participate
in all these namespaces. Descendant symlink races and physical/removable/full-disk/power-loss
behaviour remain unverified. Render capture/install/cache still lacks a full restart journal;
retained histories still have no approved pruning/budget. Live print-dimension/preflight
metadata, catalogue/capture-order caches, real RAW/layer/high-depth/CMYK corpus and native GUI/
accessibility remain open. These limitations prohibit whole-app isolation/recovery certification.


Final separate coverage: **798 shared/backend tests passed**, no failures/cancellations/skips.
Namespace source line/branch coverage **97.20/80.95**, sheet/history module **100/88.89**,
delivery **99.04/88.82**, render **97.31/77.60**, proofs **88.63/78.61**, storage **94.67/85.19**.
Uncovered paths and aggregate-with-tests remain in the raw report; UI/Rust coverage is not claimed.

All three workers were given one read-only review/diagnosis attempt in this continuation. They
briefly reported running, then all returned terminal provider usage limits reporting **“10:00
PM”**, without a date/timezone. No review or metadata/journal design result completed. The one
worker's stale draft-benchmark status was corrected against the committed current state; no
benchmark was restarted from that old task report. The returned reset text is recorded verbatim,
not assumed to be a future local reset. Final independent review of output namespace integration
and prior parent transaction/HFS changes remains incomplete. Parent checks are not substituted
for independent review; prior scoped reviews remain scoped/historical. Source/testing work is
preserved at this actual review execution limit, and the goal remains active.


The current-source pilot completed with unchanged source/executable hashes during measurement:
24 distinct 12 MP synthetic textures, eight simple RGB spreads, 5400×1800 output/6 inches/300 PPI.
Cold proof **3.247 s**, cold render **30.459 s**, cold export/PDF **14.813 s**. Three warm renders
**0.981/0.850/0.841 s**, warm exports including rebuilt PDF **7.339/7.029/7.105 s**; eight files
reuse every cycle. Sampled aggregate process-tree RSS maximum **1603.2 MiB**. Three warm cycles
grow retained logical data by **4,827,875 bytes**; final footprint **1.123 GiB**. Exact source/
sheet/JPEG bytes, preserved-stamp invalidation, reorder association and all eight independently
rendered PDF pages/geometry/patches pass (maximum average-channel delta 1.54, same predeclared
texture tolerance 8; strict colour oracle remains tolerance 3). This refreshes current partial
performance evidence; it is not a statistically repeated performance comparison or customer/
RAW/layered scale/true-peak/UI/accepted-budget certification. Full generated data is locally
retained under `bench/fixture/native-pipeline-zguTv3/`, with tracked reports and checksums.

### Nine-category reassessment and next executable work

| Category | Iteration 4 /10 | Iteration 5 /10 | Remaining acceptance gap |
|---|---:|---:|---|
| Architecture | 6.5 | 6.5 | Whole-app/permanent ownership, contracts and complete invalidation |
| UI and workflow | 4.5 | 4.5 | Native ambiguity/recovery/accessibility/focus and real large grids |
| Testing | 5.0 | 5.0 | Final independent review, full native/GUI/corpus/hosted gates |
| Performance and scalability | 3.0 | 3.0 | Customer scale, true peak/CPU/UI and accepted retention budgets |
| Data integrity and recovery | 6.5 | 6.5 | Render/cache restart journal, legacy/native/global ownership/storage |
| Documentation | 4.5 | 4.5 | Verified real customer/release/manual/external procedures |
| Security and licensing | 4.0 | 4.0 | Descendant/external filesystem policy, issuer/rules and hardened release |
| Print and delivery correctness | 4.0 | 4.0 | Consumed metadata, broad real corpus, bleed/gutter and lab samples |
| Build and distribution | 4.0 | 4.0 | Full native/package/hosted/pinned runtime/notarised clean Mac |

All 90 criterion names, weights and points are unchanged. Every criterion was reassessed;
new cooperative namespace and current-source measurement evidence strengthen partial points
without completing their outstanding requirements. No category is certified. Mission remains
active and incomplete.

1. Verify this checkpoint's current source/evidence hashes, Git state and unchanged engine pin.
   Complete independent review of new output namespaces/association/consumption, then prior
   parent project transaction/HFS changes when execution capacity is actually available. All
   three fresh attempts ended at the provider limit; none produced completed independent review.
2. Add a durable render capture/install/cache journal with streaming PSD snapshots and bounded
   cache revisions. Recover pending versus committed sets before planning/running. Test real
   kills at each publication/cache/proof boundary, ENOSPC, private/manual/source edits, committed
   cleanup and cancellation/finish errors. Preserve every captured/unknown file and history.
3. Complete permanent/legacy/moved/copied output ownership and explicit reconciliation. Existing
   ownerless records are not silently assigned; known foreign histories remain blocked. Integrate
   native/editor/external and global app-cache ownership; test descendant symlink replacement.
   Add reviewed history retention/cleanup and real drive/power-loss verification before pruning.
4. Reproduce and fix print-dimension/preflight metadata substitution: consume the same verified
   bytes as actual export/render or refuse source changes. Complete catalogue/capture-order,
   RAW/JPEG proxy equivalence, real layers/masks/high-depth/CMYK/profile corpus and user workflows.
5. Run realistic customer small/typical/large, true peak/CPU/UI and retention budgets after pilot
   review. Obtain approved native GUI/accessibility, actual lab spec/samples and authorized issuer/
   Firestore/device-migration inputs. Run full native workspace/Clippy/layering/corpus, hosted CI,
   staged root package/packaged pinned-Node and `block 0.1.6` compatibility checks; obtain signing/
   notarisation credentials, clean customer Mac and physical storage/full-disk/power-loss setup.

Source/evidence manifest: `docs/quality/2026-10-14-iteration-5/verification.json`. Earlier artifacts,
user `docs/reviews/`, `invoice-template/`, engine `.DS_Store` and existing bundles remain preserved.

## Iteration 6 — resumed checkpoint, durable renders and independently reproduced loss paths

### Starting state and priority

Resumed `180c56ab1753838cbb8ddf00e11d81dcfc21d0d9` on the existing quality branch. Tracked
files were clean; user `docs/reviews/` and `invoice-template/` remained untracked and untouched.
All **480** iteration-5 source, artifact, executable and locally retained benchmark hashes
matched before implementation. The engine remains `bdb1f8f35767700033ec9cd7b8fc0b80e182b0e9`;
only the same three untracked engine `.DS_Store` files remain. No audit restart, dependency
upgrade, old-bundle modification, publication or real-account migration occurred.

The highest recorded local issue was the gap between PSD capture/install and render-cache
publication. Two real-engine regressions first fail **0/2**: after a worker is killed at sheet
capture or install, the ordinary render plan cannot restore the exact old sheet/cache pair.
New standalone journal API tests are contract checks, not 18 separate historical bug claims.

### Implementation and exact verified scope

- `render_transaction.js` streams large PSDs with fixed 1 MiB allocations and two complete
  SHA-256 passes through the same no-follow handle, including declared-length, inode, link,
  permissions and metadata checks. JSON cache reads are limited to 64 MiB; journals to 64 KiB.
  Old/next PSD and cache snapshots are detached and read-only. A flushed immutable journal
  precedes any public-name change; installs are detached copies and captures use no-replace
  moves. The separate read-only commit marker binds the exact journal checksum.
- Pending recovery validates both public names before modifying either, rolls cache back
  before the sheet, and restores only vacant or exactly transaction-owned names. Manual,
  unknown, symlink, hard-link, malformed, foreign-project and modified-snapshot conflicts
  preserve their bytes/history and fail visibly. Interrupted preparation is retained as an
  orphan. Committed recovery does not rewrite later public manual edits; history retirement
  errors retain commit/revision/path metadata. No recovery history is pruned.
- Project and physical output leases are held before restart recovery and render-cache reads.
  Render planning/running, proof refresh, export preparation/cache clearing and ordinary album
  reopening enter that guarded recovery path. An inspecting open may report a foreign cache
  without adopting its sheets, so its output can be changed; mutation paths still reject the
  association. Exact before-cache bytes and before-sheet fingerprints are checked again at
  publication. Logical output paths remain logical in cache records; journals bind physical
  targets and canonical project identity.
- Render publication uses the journal and receives its final cache revision/sheet record.
  Unique private previews replace the previously shared temporary name. A failed preview
  after durable commit reports the saved sheet with a warning. Refresh regenerates the exact
  verified current sheet's preview even when a stale proof-manifest entry already exists.
  Cancellation before commit rolls back and reports stopped without a false failed sheet;
  cancellation after commit preserves the committed pair. The interface handles the cancelled
  result without marking it current. Native visual/interaction verification remains open.

Review capacity briefly became available. Two reviewers independently reproduced **four P1
loss/permission paths**. The output reviewer held a real child job while another project
followed an intermediate `.album-studio` alias to delete its derivative; shared `proofs/pages`
aliases also allowed preview removal and manifest replacement. The five-module pinned
`180c56a` replay was byte-verified against Git; both regressions fail **0/2** before fixes.
The cache reviewer reproduced an EEXIST catch deleting a pre-existing destination and
path-based chmod following a substituted snapshot alias to change customer-file permissions.
The parent's fail-first regressions also fail **0/2** before the snapshot fix.

- `output_paths.js` canonicalizes allowed root aliases but rejects intermediate output/proof
  aliases, special entries and invalid managed-directory slots. Bounded existing-descendant
  validation participates in output acquisition/held assertions and proof manifest read/write/
  preview capture/removal. Directory substitutions during enumeration fail closed. Cache
  clearing validates its actual target again and refuses to remove retained recovery or
  unknown subdirectories. Customer bytes and unrelated histories remain intact in tests.
- `snapshotFile` now creates an exclusive read-only file through a held descriptor and streams
  verified source bytes. Permission changes use that descriptor; named-node/link/mode/digest
  checks precede consumption. It never unlinks a failed exclusive destination or substituted
  name. An unchanged generated failure is retained through a no-replace history move; errors
  carry snapshot/retained paths so RAW/proof/render/delivery callers preserve uncertain stages.
  Partial-write ENOSPC, manual private edits, bounded allocations and read-only-from-first-write
  checks pass. The old copy-hook ABA fixture now injects the same mutation at source-handle
  reading; its refusal, original-byte and empty-owned-stage assertions remain intact.

The parent caught and corrected the unfinished validator's broad `render-` directory prefix
(which would classify `render-cache.json` as a directory) before final gates. An intermediate
integration run found a wrong exported-method reference in one test and the actual live-proof
fallback described above. Their failures and final repairs are retained separately; no
intermediate result is represented as a final-source verification.

### Tests, resources and review execution limit

The final strict application gate passes **273 shared + 587 backend + 33 interface = 893**,
with zero failures, cancellations or skips. Separate final shared/backend coverage passes
**860**, also zero failures/cancellations/skips. Production line/branch coverage includes
render journal **100/85.01**, output paths **100/87.84**, cache **95.51/82.02**, output locking
**97.35/84.00**, render **99.04/78.52** and proofs **89.75/78.77**. The raw report keeps uncovered
paths and the aggregate including tests; UI/Rust coverage is not claimed. Eleven standalone
publication/recovery SIGKILL boundaries, five engine-render boundaries, normal reopen,
manual/conflicting entries, read-only/coarse-time ABA, injected partial-write/fsync ENOSPC,
committed cleanup, preview failure and cancellation are exercised locally. This does not
substitute for physical power-loss, unplugged-drive or real-full-volume tests.

Lint passes with zero errors/warnings, shared/interface types pass and production interface
build passes (167.3 KiB JavaScript, 54.5 KiB CSS). Runtime closure contains **55 files and ten
packages**, including both new modules. Engine/helper pins are checked by the gate. No new
native source, full native-workspace/Clippy run, hosted gate, packaged pinned-Node runtime,
installed bundle or hardened release is claimed.

The sequential current-source pilot completed at `bench/fixture/native-pipeline-PdgWy1/`,
with unchanged source/executable hashes: 24 distinct synthetic 4000×3000 JPEGs, eight simple
RGB spreads, 5400×1800 output at six inches/300 PPI, three warm cycles, preserved-stamp
invalidation, reorder association and all eight independent PDF raster/geometry/patch checks.
Cold proof **3.698 s**, render **51.091 s**, export/PDF **17.123 s**; warm renders
**1.080/0.950/1.097 s**, warm export/PDF **7.839/7.484/7.267 s**. All eight sheets/JPEGs reuse
each warm cycle. Sampled aggregate process-tree RSS maximum **1561.875 MiB**; retained logical
footprint **1.820 GiB**, 311 generated files. Exact bytes/ordering and independent PDF checks
pass with the same tolerances; no product geometry, colour tolerance or workload was reduced.

Cold render is higher than iteration-5's **30.459 s**, and retained footprint higher than
**1.123 GiB**. The durable copies/checks add work and retained bytes; the measured total is
higher. These single synthetic runs are
not a controlled statistical comparison, but the result prevents any claim that recovery
was free or that performance/retention budgets are complete. Optimize only while preserving
snapshot/journal/manual-edit guarantees; measure again. Real customer distributions, RAW/
layered scale, true peak/CPU/UI and approved cleanup budgets remain open.

All three workers terminated at the provider usage limit reporting **“Oct 15th, 2026 3:02 AM”**,
without a timezone. This supersedes the previous turn's bare reset text; it is recorded
verbatim, not treated as a verified future reset estimate. They delivered scoped findings and
partial implementation, but final independent review of journal/path/snapshot integration,
and completion of the prior project transaction/lock/HFS review, remain incomplete. The
parent finished the saved work and current local gates. Parent inspection/tests do not
substitute for the missing independent review. The source checkpoint is preserved at this
actual review execution limit; the mission remains active and unfinished.

### All nine categories reassessed with all 90 fixed criteria

| Category | Iteration 5 /10 | Iteration 6 /10 | Remaining acceptance gap |
|---|---:|---:|---|
| Architecture | 6.5 | 6.5 | Contracts, permanent/legacy/native/global ownership and invalidation |
| UI and workflow | 4.5 | 4.5 | Native recovery/relink/focus/accessibility and real large grids |
| Testing | 5.0 | 5.0 | Final independent/native/GUI/corpus/hosted verification |
| Performance and scalability | 3.0 | 3.0 | Cold journal cost, customer scale, true peaks/UI and retention budgets |
| Data integrity and recovery | 6.5 | 6.5 | Whole-app ownership, private-stage policies and physical drive/power tests |
| Documentation | 4.5 | 4.5 | Verified native/customer/physical/security/release procedures |
| Security and licensing | 4.0 | 4.0 | Global/external filesystem races, real issuer/rules and hardened release |
| Print and delivery correctness | 4.0 | 4.0 | Consumed metadata, real corpus, bleed/gutter and actual lab samples |
| Build and distribution | 4.0 | 4.0 | Full native/package/hosted/packaged-Node/notarised clean-Mac gates |

`reassessment.json` records every criterion's name, weight, previous/current points, inherited
evidence and current scoped assessment. A live comparison to `180c56a` confirms that all 90
names, weights and points are unchanged and score sums match. Stronger local evidence within
partial criteria does not complete their outstanding requirements. No category is certified.

### Next executable steps and precise external dependencies

1. Verify this source/evidence manifest, Git state and unchanged engine/executable pins. When
   review execution is available, independently review `render_transaction.js`, `output_paths.js`,
   their production consumers and the parent `snapshotFile`/retention changes. Finish the prior
   project transaction/lock/HFS scoped review. Add fail-first engine-close/job-lease finish-error
   checks for retaining committed per-sheet results and accurate job counts; those full paths
   have not been certified by the narrower preview/history/cancellation tests. Retain provider-terminal evidence; do not claim
   a completed review from a dispatch or passing parent tests.
2. Reproduce consumed print-dimension/preflight metadata A/B/A substitution. Tie the exact
   metadata bytes to the verified/frozen PSD/photo consumed by export/render, then test source
   and private changes without weakening colour/resolution gates. Complete catalogue/capture-
   order invalidation and project runtime bounds/contracts with fail-first evidence.
3. Complete explicit ownerless/legacy/moved/copied reconciliation and native/editor/global
   ownership. Protect remaining global-cache/private-stage cleanup boundaries and external
   descendant replacements. Establish approved history budgets; do not prune existing retained
   evidence. Measure and safely optimize cold-render copy/hash/path costs before broader scale.
4. Run customer small/typical/large, real RAW/layer/mask/high-depth/CMYK and native GUI/focus/
   accessibility workflows. They require an approved GUI/AT session and actual customer/camera
   corpus. Obtain an actual lab specification plus physical printed samples for bleed/gutter,
   profile/colour and production acceptance. Synthetic/headless checks cannot satisfy these.
5. Use an authorized issuer/Firestore device-migration/rules environment; signing/notarization
   credentials and a clean customer Mac; physical removable/exFAT/SMB/full-volume/power-loss
   setup. Run full native workspace/Clippy/layer/corpus, hosted CI, staged root package and
   packaged Node **22.23.3** plus `block 0.1.6` compatibility. Local Node **22.22.3** success is
   not packaged-runtime verification. These external requirements remain unverified.

Source/evidence manifest: `docs/quality/2026-10-14-iteration-6/verification.json`. Prior evidence,
all local benchmark data, user folders, engine `.DS_Store` files and existing bundles remain
preserved. Goal status is active; no completion, pause or blocked certification is inferred
from this checkpoint or the provider review limit.


## Iteration 7 — canonical contracts, explicit ownership and native handoff gaps

The updated user goal is **Architecture strictly above9.5/10**. The ten criteria retain their
existing names, weights and10/5/0 scoring; strict >9.5 therefore requires100/100. Architecture
remains **6.5/10, uncertified**. Other category scores are retained as historical context.
Resumed `1528ffaade6cf48cdb0e2eea6c01700e6558f391`; no audit restart. Before edits all533
iteration-6 hashes matched. After implementation449 prior artifacts, release executables and
retained benchmark hashes still match. User folders, old recovery histories, engine source/
release binaries and all three existing engine `.DS_Store` files remain preserved.

The implementation establishes canonical53-method/17-event request/result/error schemas,
generated interface types, real dispatcher/browser validation, bounded UTF-8 framing/output,
project/version/operation bounds and explicit legacy normalization. Shared render input/recipe
modules remove coordinator cycles. Source-alias identity preserves all historical IDs/aliases
and conflicting edits. Verified-byte metadata/preflight/decoded delivery guards replace mutable
header reopen checks. Private-stage capabilities protect RAW/proof/render/delivery/colour work;
unknown/edited/partial trees retire exclusively and remain available. Journal checksum/commit-node
identity and descriptor-close recovery errors are checked. Finishing errors preserve committed
sheet counts and remain visible in the interface. Native/editor/global ownership is not complete.

The final strict gate passes **289 shared +798 backend +46 interface =1133**, zero failures,
cancellations or skips. Lint0/0, shared/interface types and production interface build pass
(JavaScript248.2KiB, CSS54.5KiB). The actual graph passes108files/603edges/zero cycles;65 runtime
files and10 packages are packaged. Actual39 backend methods and13 event producers cross canonical
validation using real disposable render/export/PDF fixtures; account/browser services are mocked.
Native14-method examples/source inventory do not prove native execution. See the retained raw
logs and `verification.json` in `docs/quality/2026-10-15-iteration-7/`.

The first full gate had two integration-test failures. Structured invalid-registry metadata
replaced the old wording assertion while preserving byte checks. The obsolete-edit fault moved
from preliminary validation to after the authoritative leased read; another test proves an
external field saved before that read survives the requested edit. The repaired18-test scope
and final full gate pass; first failures remain retained. No production conflict guard was
weakened. Earlier worker automatic-review rejections did not execute; later parent approval
completed the host86/full1133 gates. Worker provider limits interrupted remaining native design.

A root-owned replay of exact pinned native source now reproduces **two unresolved failures**:
the missing native composition-root registration and old helper EOF failing a new generation's
request. Baseline14/16 passes; isolated candidate16/16 passes. Its source hashes, fixtures,
Cargo.lock, logs and candidate patch are retained. The candidate is not applied to the pinned
engine or compiled into Album Studio. Temporary earlier worker paths were missing, so their
bare reports were not used as substitute evidence.

**Next executable work:** integrate bounded/generation-safe typed native transport and explicit
editor/standalone document-save ownership/publication; register the app in the native layering
table with regression coverage; create a reviewed engine commit/pin/bundle while preserving old
source/binaries and untracked files; rebuild new provenance-tagged native outputs; execute the
native and full application gates. Complete permanent/legacy/global reconciliation, native
error/invalidation semantics and supported migration rollout before closing partial criteria.
These are unfinished implementation requirements, not external blockers or completed work.
`docs/ARCHITECTURE.md` and the iteration README document exact boundary scope and limits.
The goal remains active; this is a verified source checkpoint for continuing native work.

Checkpoint inventory correction: `test/contract_types.test.js` supplied three of the289 passing
shared tests but remained untracked in initial commit `10cee1b`; its exact source is included
in the follow-up checkpoint and manifest. The late native-layer candidate patch is retained
unapplied. The correction changes no application code or test result. Native work continues
in ignored candidate checkout `bench/fixture/native-architecture-engine-10cee1b` on
`codex/architecture-native`, based on exact engine `bdb1f8f`; the original checkout is unchanged.

## Iteration8 — native lifecycle prerequisites (in progress)

Verified all658 iteration7 hashes at `0167e72`. The candidate engine at
`bench/fixture/native-architecture-engine-10cee1b` is isolated from the original checkout and
binaries. Generation-scoped pending/reader events and explicit app layer registration are
being integrated with actual native module tests and a disposable Node child. The native-app
test build is recorded directly in `docs/quality/2026-10-16-iteration-8/`; it is not yet claimed
passed. Native bounded/typed transport and editor/standalone ownership remain required work.
No architecture score or shipping engine pin has been raised/changed. Continue from the current
execution handle and candidate Git state, preserving all previous evidence and user folders.

Iteration8 continuation checkpoint (build in progress): isolated native source commits
`591c5b47da2dd086c47f4d9d64fc0b41722df0c7` and compatibility follow-up
`41a0f464405a1e4e20629de928727815679f5906` are saved on `codex/architecture-native`.
Both source bundles are retained under `native/scripts/engine/`. The latest candidate passes
119 native-app tests (real disposable helpers and actual Node dispatcher ping/sign-in-denial
round trips), strict app Clippy across all targets, workspace formatting, 15 layer regression
tests and the actual 30-crate layer graph. Authored 53-method/17-event examples also execute
against embedded native schema validation; they do not execute every native GUI method.
Native ingress/pending/frame/aggregate/writer queues are bounded, pipe writes leave the UI
thread, helper generations isolate EOF and replies, deadlines preserve uncertainty, and
structured recovery replies survive. Unicode scalar validation now agrees across JS/Rust.
Rust method-specific DTOs and the opaque editor diagnostic remain incomplete.

Fresh reconstruction of 591c5b4 passed after a real relative-mirror-path defect was repaired;
the failed attempt and passing regression remain retained. The root build gate now rechecks
source/pin after compilation to reject concurrent source edits; its injected-source-edit
regression passes. The first cold release build is still running as terminal session84701,
from immutable `bench/fixture/native-architecture-reconstructed-591c5b4`, with a new target at
`native/photocraft/target/architecture-20261016`, Rust1.99.0 and HEIF. It began before the last
wire-ID fix/post-build guard and is intermediate evidence only. Do not mutate that source
checkout during compilation. The original engine remains clean at bdb1f8f with exactly three
preserved untracked metadata files; six original metadata/binary hashes are recorded in
`engine-preservation-before.json`. User folders and prior release binaries remain untouched.

Next executable steps: finish the current build; advance the root pin and reconstructed
checkout to 41a0f46 using its retained bundle, then rebuild with the final post-build guard;
verify native/root gates against those provenance-tagged outputs; explicitly advance the
original clean checkout only after preserving metadata and historical source/binaries;
retain hashes and a root source checkpoint. The working root pin currently still names the
intermediate591c5b4 and intentionally cannot certify the advanced canonical runtime yet.
Continue with editor/standalone save ownership/publication and whole-application invalidation,
permanent/legacy/global reconciliation, and migration acceptance. Architecture remains6.5;
no category has been inflated and there is no external blocker for this ongoing local work.

Iteration8 integrated checkpoint supersedes the preceding in-progress state. Final engine pin
41a0f464405a1e4e20629de928727815679f5906 reconstructs from the retained bundle and passes canonical
copy parity. Its provenance-checked HEIF release rebuild passes (4m10s after the6m53s cold
intermediate build). The actual original checkout is now deliberately at that pin, tracked
clean, with old commit/three metadata files/three old release binaries preserved and hashes
verified before/after. Intermediate591c binaries were copied to a separate retained fixture.

The final strict gate passes **297 shared +799 backend +46 UI =1142**, zero fail/cancel/skip.
Native app119, real/disposable-child transport17, layer regression15, native app Clippy all
targets with warnings denied, workspace format, actual default30-crate layer graph, root
lint/types/build, native drift and architecture graph gates pass. No GUI, full native workspace,
corpus, hosted CI or packaged-app acceptance is inferred. Root UI build is248.6KiB JS/54.5KiB CSS;
no performance-neutrality claim is made. Executed Node22.22.3 differs from unverified configured
22.23.3. The block0.1.6 future-compiler warning was retained without disabling a warning.

Architecture is reassessed **7.0/10**, gaining5 points only for criterion9's integrated verified
layer/dependency gates. All90 criterion names/weights remain unchanged; other category scores
are retained historical context. Native canonical runtime/method enum, asynchronous capacity,
generation isolation, Unicode/integral-ID consistency, structured Node error forwarding,
source/pin mutation guards and method-owner drift tests are implemented. Method-specific Rust
DTOs/editor diagnostics, native save/publication errors, whole-application invalidation and
ownership/migration completion remain partial. The exact raw failures and passing results are
retained in the iteration8 README and verification manifest.

Continue implementation next with native editor/standalone save ownership. Background opens
use engine jobs with OpenSource::Path/Bytes; synchronous opens use Services::import, so recording
only the synchronous importer misses the default path. Save workers use Services::save_file;
synchronous saves use Services::export/write; authorized automation and document-saved image
assets have separate writers. Bind consumed source revisions to document identity and route
all relevant publications through shared album/output capability/journal rules, with explicit
invalidation after commit. Do not serialize an entire edit session under a permanent lock or
silently reduce supported save features. Global/permanent/legacy ownership and migration still
need executable acceptance. There is no current local execution limit or external blocker;
the goal remains active and unachieved.

## Iteration 9 — in progress: native document publication ownership

Resumed from root6362dcacc52c1703d0ae23caabde5a5ae4c743ee and pinned engine41a0f46;
all640 iteration8 manifest hashes verified before these edits. Architecture remains7.0/10.
A real native Services::write regression now proves that a sheet is overwritten while a
disposable Node process owns both project and output capabilities. The failing test and exact
before/after bytes are retained in iteration9 native-save-owner-verified-bytes.log. This is
an unresolved production defect, not a passed requirement. No customer files were used.

The isolated candidate now retains SHA-256/length of the actual decoder input in both sync
and background imports. Engine library1077 pass,11 existing benchmark/timing cases ignored;
UI save-identity selection5 pass. Neither result certifies filesystem identity, write
authority, last-published receipts, full workspace or GUI acceptance. These candidate changes
are not yet in the shipping pin. The original shipping checkout remains at41a0f46.

The streaming verified-file reader was extracted from render publication with unchanged
identity/content checks and an explicit64MiB buffered-metadata bound. Focused42 pass and the
full strict gate297 shared+801 backend+46 UI=1144 pass,0 fail/cancel/skip. A first extraction
failure from removing a still-used helper and an initial lint failure remain retained.

Namespace capabilities are now separated from the output/project adapter. File-publication
parent reservation rejects competing writers, alias retargeting and hardlinked markers.
All13 focused namespace/output-isolation tests, lint and architecture checks pass. The1144
gate predates namespace extraction and does not certify it. These primitives alone do not
close native ownership: the publication actor must hold shared output/project capabilities
and perform the actual I/O; source proof, compare-and-publish, durable recovery, invalidation
and all native write paths remain to implement and verify. User folders docs/reviews/ and
invoice-template/ and prior evidence/binaries remain untouched. No external blocker exists.

Iteration9 continuation: shared publication I/O retains the42 passing render/reader
regressions. A new same-directory compare-and-publish transaction passes16 tests, including
real SIGKILL recovery, two-file rollback, manual-edit preservation, stale inode rejection and
a65MiB+1 streaming case. The actual private stdio publication worker passes8 boundary tests.
The namespace/output/publication focus passed29 before the last two batch cases. Initial
missing-helper test configuration, lint issues and worker failed-admission pipe lifetime
failures remain retained alongside repairs. Lint/architecture pass at their named checkpoint.

The native service adapter is compiling/testing in session45386; this is not yet a passed
native regression or an integrated pin. Candidate WIP patch includes new native files and
hashes. The adapter currently uses explicit interactive overwrite expectation; actual earlier
source/receipt propagation, bundled CLI environment, structured native result metadata and
remaining writer/invalidation/migration paths still need implementation. The iteration9 README
records exact next executable steps. Architecture remains7.0 and uncertified; no external
blocker has been encountered and no category score has been inflated.

Iteration9 verified publication-foundation checkpoint: the reproduced actual native writer
ownership failure now passes. Full native app123/123 passes; the subsequently added actual
headless UI synchronous/background save case passes with all5 focused ownership cases
(124 candidate tests in total,119 filtered in that run). Successful writes, cancellation
after preparation, dead-child-only retry and earlier-source worker refusal are executed.
Bundled CLI environment discovery was corrected; installed-app acceptance is not inferred.
Native app Clippy all targets with warnings denied passes, retaining block0.1.6 future warning.

The complete current strict gate passes297 shared+835 backend+46 UI=1178, zero fail/cancel/skip.
Lint/type checks/UI build pass; UI output248.6KiB JS/54.5KiB CSS. The new default native adapter
still uses interactive overwrite; earlier source/last-published receipts must be propagated
through actual UI paths before stale-editor protection is claimed. Source/receipt/identity
authority remain distinct. No pin/bundle/clean shipping checkout advancement yet. The refreshed
WIP patch and hashes include all new native files. Architecture remains7.0/10, uncertified.

Isolated foundation source is saved at123b04517bf42f8e181950632520445a4468cbaa, tracked
clean, with a verified incremental native-publication.bundle requiring41a0f46. The shipping
pin remains41a0f46. Iteration9 verification.json records265 root source hashes,48 artifacts
and385 retained prior artifact/executable/pilot hashes; all385 are unchanged. Candidate
source hashes and the complete41a-to-foundation patch are retained separately.
