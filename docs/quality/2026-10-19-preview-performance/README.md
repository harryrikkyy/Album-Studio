# Preview performance repair — 2026-10-19

The user reported severe slowness and repeated bottom-right preview errors. The screenshot
identifies PRIVATE_STAGE_BUDGET: retained decoder work reached the unchanged 8 GiB limit.
The current history is customer-derived work, distinct from the previously approved synthetic
backup. This repair neither deletes/relocates that history nor raises its limits.

## Diagnosis and implementation

Ordinary previews used persistent private snapshots of every original photo and PSD, followed
by persistent colour TIFF intermediates. Successful decoder work was retained by policy,
so repeated previews consumed gigabytes and eventually refused further work. A refresh also
held the album edit/output lease throughout catalogue scanning, source hashing and decoding.
A local edit rehashed unrelated spreads, and every failed spread appended a persistent toast.

Ordinary interactive previews now consume exact, digest-verified immutable buffers, with a
256 MiB cumulative source budget and the existing 512 MiB PSD/composite policy. Compatible
profiled RGB/CMYK composites can use a bounded in-memory TIFF wrapper. Global preview decoding
is serialized across albums; up to three frames decode at a time. Interactive intermediate
JPEGs use the standard encoder instead of mozjpeg. Print settings remain unchanged.

Project capture/publication use short leases; ordinary pixel decoding runs outside the edit
queue. Publication rechecks the project revision, manifest predecessor and full input digests.
A changed project/source discards stale pixels and reruns. Existing proofs are preserved before
replacement. Completed manifests are saved even if another refresh was queued during publication.
Known local edits refresh only affected spreads. Photo transforms include every use; replacement,
move-between-page and structural/unknown operations conservatively request a full pass.

Album model hydration still inventories collections and resolves identities on every read,
but skips the canvas headers it never returns. Fitting, autofill and catalogue consumers retain
fresh verified dimensions. No timestamp-only source-content cache was introduced.

Storage failures produce one persistent, understandable notification per album; other preview
failures are grouped per spread. Dismissing a message allows a later failure to appear again.

## Regressions and validation

The initial isolated reproductions have three actual failures and zero cancellations: a full
history blocks ordinary previews, repeated edits accumulate source snapshots, and a deliberately
blocked decoder also blocks an edit. Earlier malformed/sandbox runs are retained separately,
not represented as product regressions. The corrected tests verify history inode/size preservation,
zero ordinary source-history growth, responsive edits, rejection of stale rotated pixels and
absence of unrelated full-photo hashing. An additional regression verifies nested catalogue
changes while album hydration performs zero unused PSD-header opens.

Full gate, exact final source hashes, measured results and packaged/native acceptance are recorded
in verification.json and the accompanying receipts. A running process or empty buffered log is
not treated as a passing gate. Tests use isolated cache/data/output roots and the verified pinned
41a0f4644 engine plus atomic no-replace helper. Customer images/screenshots remain outside Git.

## Benchmark method

benchmark.cjs runs the actual 131-photo project against two owned runtime/project/output/cache
copies under the recorded temporary directory. The saved project currently has 14 spreads;
the earlier preview-recovery copy had 15. Source photos/templates are read-only references.
Both runs use the bundled official Node 22.23.3 and the same native engine. The before snapshot
uses pre-repair production files; unrelated architecture WIP is identical in both runtimes.
Runtime closure hashes and original project hash are retained in benchmark-environment.json.
The before/after runs are sequential, without simultaneous regression/build workloads. No OS
cache flush is attempted. These are local observations, not competitor benchmarks or universal
latency guarantees. Cold means an empty Album Studio derived cache, not a cold operating system.
Three alternating edits target one photo used on one spread. Refresh and edit durations are
reported separately; end-to-end latency is their sum. Every output JPEG is fully decoded and
hashed. The after run additionally edits with an 8 GiB sparse retained-history fixture, verifies
that fixture's identity/size, and checks that no source stages were added.

## Explicit limits

Layer-stack edits and engine fallback for templates without a usable compatibility composite
still use the existing native filesystem capabilities and retention policy. Print rendering,
sheet-save proofs and delivery are not universally converted to memory, nor certified by these
interactive-preview measurements. Those special paths may still refuse work at a full history
budget. RAM use remains substantial for large PSDs and is measured rather than claimed constant.
No old recovery evidence is automatically reclaimed. Broader editor, print/lab and clean-Mac
acceptance remains outstanding; all nine quality category scores remain unchanged.

## Final results

Code checkpoint: `7d321ad2137ce8b9fc9c2a7ee56d780563b4a5f2`. The packaged runtime also includes
the preserved preexisting architecture WIP, identified by baseline.json/preservation.json.
Final gate: 297 shared + 861 backend + 62 UI = **1220 passed**, zero failed/cancelled/skipped.
Lint and both application/UI type checks pass without warnings. The earlier 1219-test gate
predates the final catalogue optimization; full-final-gate.log is the final gate.

| Local measured operation | Before | After |
| --- | ---: | ---: |
| Album model open | 3.529 s | 0.320 s |
| Generate all 14 previews from empty derived cache | 49.271 s | 33.617 s |
| Unchanged full refresh | 10.826 s | 5.095 s |
| Median photo edit save | 3.627 s | 0.393 s |
| Median photo preview refresh | 9.489 s | 1.615 s |
| Median edit to completed preview, including save | 12.822 s | 2.027 s |
| Global source-history growth, full preview plus 3 edits | 3,660,171,630 bytes | 0 bytes |
| Peak process RSS across these phases | 1425.98 MiB | 1427.36 MiB |

The after full-history fixture edit refresh completed in 1.580 s, with zero failures and the
8 GiB fixture unchanged. Both runs produced 14 fully decoded valid JPEGs. No memory reduction
is claimed. Initial full generation and unchanged all-page verification remain measurable costs.

`native/dist/Album Studio Performance.app` is a new 237 MB, locally ad-hoc-signed build. Its
73-file runtime closure exactly matches the tested workspace, interface assets match the build,
Node 22.23.3 is bundled, and deep strict signature/plist checks pass. The native engine remains
41a0f464405a1e4e20629de928727815679f5906; all six frozen prior executables are unchanged.

The actual new bundle and its bundled helper were confirmed running. Native File > Open Album
loaded the independent acceptance copy using the normal, already-full live cache. All 14 native
JPEGs fully decode and match manifest digests. The screen shows 131 photos, 14 spreads, composed
artwork and populated thumbnails, Preview Ready, and no error toast. Its private screenshot stays
outside Git. Automated key events could not reliably reach embedded web editing controls, so
rapid-template/undo GUI acceptance is explicitly unverified. Attempted keys changed no project.
The isolated decoder/edit concurrency regression and real-album backend edit benchmarks pass.

The diagnostic app was closed normally and confirmed stopped; the older user-owned Fixed.app
session was left running. Quit that older version before using Performance.app for the working
album. Existing app bundles were preserved.

After native verification, the original project hash and the entire existing live-history
metadata inventory are unchanged: 74 stages, 1204 files, 8,589,743,103 bytes. All 256 previously
approved synthetic backup files still match their prior content hashes. Existing tracked WIP
was byte-identical before the append-only mission-log update. No customer recovery cleanup,
archive move, limit increase, shipping engine change, or quality score increase occurred.
