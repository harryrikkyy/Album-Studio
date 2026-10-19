# Album loading repair — 2026-10-19

User report: the latest packaged app starts, but folders do not finish loading and opening a
ready album gets stuck. The previous package checks covered signatures and helper startup,
not native album loading. This repair does not raise any quality score or claim full delivery
acceptance.

## Cause and source repair

Template canvas inspection used full two-pass fileEvidence for each26-byte PSD header.
The user's four linked collections contain3955 PSDs and roughly138GB of directly contained
files. Opening the catalogue therefore read hundreds of gigabytes unnecessarily. JPEG size
and capture-time metadata had the same whole-file read pattern.

Commit31998ff changes only metadata consumers to a bounded two-pass header reader. It shares
the existing four-reader concurrency bound, opens read-only/no-follow descriptors, compares
both header reads, and checks descriptor/path identity and metadata around the read. It is
explicitly not full-file source evidence. Full fileEvidence, verified decoding, snapshots,
print settings and rendering/publication verification are unchanged. EXIF parsing is cached
by header content rather than the unconsumed pixel payload. No persistent stamp cache is added.

Seven new regressions fail before the repair and pass after it: PSD/JPEG/EXIF read budgets,
transient header substitutions, symbolic sources/invalid budgets, short/empty files and path
replacement. Existing same-size/timestamp metadata invalidation and complete source-evidence
regressions still pass. Focused26 tests pass; the full pinned-engine gate passes297 shared+
855 backend+61 UI=1213, with0 failures/cancellations/skips. Lint, types and source whitespace
checks pass. The gate uses the fresh cache/data roots in isolated-gate-profile.json.

## Actual data and native package checks

A read-only direct model load of the real album completes in4260ms:15 spreads,131 photos,
all15 spread templates resolved,0 missing spread photos. Reading3955 PSD headers consumes
205660 bytes total,52 bytes per file. The original project JSON hash matches before/after.
The measurement forbids writable descriptor opens and filesystem mutation methods.
Actual photo-folder inspection completes in6589ms and collection inspection in2952ms;
all3955 templates are counted. These timings are individual local runs, not a latency guarantee.

The rebuilt native/dist/Album Studio Fixed.app contains the corrected72-file runtime closure
and matching interface assets, bundled Node22.23.3 and pinned41a0f4644 engine. Deep strict
signature verification, plist validation, executable versions and packaged helper ping pass.
It is an ad-hoc local Mac build, not a notarized distribution claim. The two older bundles
are preserved.

Unlike the previous timed-out native lookup, permitted native control now launches the app.
The File menu and native folder chooser open an independent temporary project/output copy,
referencing the real photo/template roots for reading. The workspace visibly reaches Plan
with131 photos and15 spreads. The private screenshot at /private/tmp/album-studio-native-open-retention-blocker-20261019.png records the actual native
screen, including the remaining error. Native custom-web-view accessibility still omits its
controls and one coordinate attempt returned AXError.notImplemented; native menus/chooser
and standard window close remain usable. No all-place accessibility certification is inferred.

## Second blocker: retained test artifacts fill the live history

The native test reveals a separate preview failure: live cache history is at256 folders.
All256 files are composite.tif, totaling1951232 bytes. Independent regeneration of the four
RGB synthetic test fixtures (48x24,8/16bit, opaque/alpha) yields exactly the four hashes in
history-fixture-identification.json. Every retained file matches one of them byte-for-byte.
These files were created by the earlier unisolated RGB test runs; that test isolation was
already repaired in the prior UI checkpoint. No current production retention limit changed.

A concrete recovery proposal is to stop packaged writers, revalidate every folder/file and
hash, and atomically move the entire history directory to a new backup beside it using the
no-replace helper. Then verify all256 files and write a restore receipt. No file would be
deleted and no budget raised. The backup's location differs from the canonical recovery path,
so the move requires explicit human approval under the automatic approval review.

Automatic approval review rejected the attempted action before process creation because it
changes the live recovery location, could affect recovery/concurrent writers, and the user had
not explicitly authorized relocation. No history moved or was deleted. An explicit approval
question is pending in this chat. Do not bypass the rejection with a new production cache,
indirect execution, automatic pruning or a higher limit. Isolated cache testing remains allowed.

## Next executable steps

1. Await the user's explicit decision about the reversible backup move. If declined, preserve
   live history and clearly report that previews remain blocked; the metadata loading fix still
   applies in Album Studio Fixed.app.
2. If approved, confirm all packaged/native writers exited, revalidate the exact inventory and
   ownership assumptions, atomically publish the backup without replacement, verify every hash,
   and retain the complete restore receipt. Abort on any changed or additional file.
3. Reopen the independent album/output copy in the corrected app and verify actual previews,
   then retest folder/album loading. Preserve original project/photo/template data.
4. Keep the original source project's hash unchanged. Existing architecture work, engine pin,
   frozen executables, user docs/reviews and invoice-template files remain preserved.

The independent project copy is retained at the path in acceptance-project.json for the next
native check; normal app opening added it to recents. This is test state, not a customer album.
The diagnostic window was closed normally before the proposed history move.
