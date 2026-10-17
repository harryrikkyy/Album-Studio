# UI/workflow iteration 2 — retained-work visibility

Continues commit5b41bfaee43f3a21996b7f50e4c1230f650eb332 and iteration1 without
restarting the audit. UI/workflow stays55/100 =5.5/10. The9.5 target is unfinished.
All90 rubric names, weights, points and statuses and all nine category scores remain unchanged.

## Verified starting state

The previous manifest's42 artifacts and385 retained evidence/binary files match their hashes.
Of149 recorded source files,146 matched; only the three UI files changed in this iteration
differed when checked. `previous-checkpoint-verification.json` records that check before the
scorecard update and mission-log append. `baseline.json` records the existing dirty tracked
files. No architecture production file, engine pin, frozen executable, user `docs/reviews/`
or `invoice-template/` file was edited by this iteration.

## Implemented and reviewed

Settings previously discarded the optional retention field returned by storage.usage/clear.
It now keeps the complete validated result, shows saved-work folder and byte usage against
configured limits, and warns at either cap (including zero configured budgets). The free-space
reserve is explicitly a requirement rather than a reading of available disk space. Empty
history and absent optional retention remain distinct; missing information is not reported as
zero. Existing failure/retry and request-generation guards remain. Clear responses also update
the complete usage result, with stale success responses suppressed.

The refresh/retry button stays mounted and focusable through measurement, preventing focus
loss when the readings temporarily disappear. aria-busy/aria-disabled report measurement and
repeat activation is ignored until it finishes. Narrow Settings stays scrollable without
horizontal overflow. The retained-work panel offers only Show retained work, calling the
existing validated shell.reveal route and showing rejection in the dialog's persistent error
area. It offers no deletion or reclamation and makes no claim that opening the folder frees space.
No production storage limits or retention policy changed.

## Executed checks

- `application.log`:297 shared +848 backend +61 UI =1206 pass,0 failure/cancellation/skip.
  The existing engine gate verifies the shipping41a0f4644 CLI and atomic-helper checksum,
  then runs all suites and rejects skips. The architecture graph passes with118 files.
  This is the preserved working tree with existing architecture WIP, not a clean-checkout claim.
- `types-final.log`, `lint-final.log`, `build-final.log`: successful final type, lint and
  production UI checks. Bundle263.0KiB JS/56.9KiB CSS. Source/fixture syntax and whitespace checks pass.
- `browser-acceptance.json`:13 actual production-web-UI checks against validated synthetic
  replies. Count/byte/zero caps, normal/empty/absent retention, refresh, focus retention,
  failed measurement/retry, modal reveal error,24 forward/backward key steps, Escape return,
  read-only retained-work actions and760x480 overflow checks pass. Earlier iteration1's23
  browser cases remain retained evidence; they were not all rerun as part of these13 cases.
- Screenshots cover both appearances, the compact window and reveal rejection.
  `storage-limit-*-final.jpg` show final copy; earlier screenshots are retained intermediate views.
- `isolated-gate-profile.json` records fresh disposable cache/data roots. The existing app
  history remains256 folders/256 files/1951232 bytes. `app-history-before.json` and
  `app-history-after.json` have the same names/content hash. This iteration explicitly records
  its hash encoding (sorted relative name, NUL, file bytes); it does not compare different
  aggregate hash encodings as if they were equal. No retained history was pruned.

The fixture refuses actual shell operations. A visible shell.reveal rejection tests the error
path, not a successful native Finder reveal. Browser checks cannot certify native app behavior.
Initial type/build/UI runs also passed; final logs supersede those initial runs.

## Reassessment of all ten UI criteria

| Criterion | Points /10 | Remaining acceptance |
|---|---:|---|
| Verified essential end to end workflows |5|Actual Mac create, plan, render, edit, deliver and reopen|
| Undo and redo |10|Prior verified evidence retained; native end-to-end remains separate|
| Spread and edit association |5|Native save/reopen and publication candidate integration|
| Job progress and recovery |5|Native render/export stop, partial failure and finishing warnings|
| Actionable errors |5|Complete relink/reconciliation and approved retained-work recovery|
| Keyboard operation |5|All places and native frame/crop/editor adjustment|
| Focus and modal behavior |5|All native dialogs, busy transitions and editor handoffs|
| Accessible names and contrast |5|VoiceOver and full composed/native-screen audit|
| Realistic large grid usability |5|Varied real-photo corpus and native memory/latency/drag-drop|
| Empty loading offline failure states |5|Native account, drive and backend interruptions across the full flow|

All remain honestly scored; the new storage checks strengthen partial evidence without completing
these scopes. Other category scores remain historical context and receive no new certification.

## Precise remaining blocker and next executable steps

Native host interaction remains unverified: the prior permitted isolated-app lookup timed out
after4242.2032 seconds and reset computer control. This iteration used the recovered browser
surface and did not repeat that long lookup or bypass denied controls. A working permitted
native window/control surface, or recorded human-assisted native acceptance, is required to
complete the Mac-specific criteria. The old unfinished architecture goal entry also cannot be
replaced through the exposed goal tools; its clearing operation remains the user's /goal clear.
Neither limitation was marked complete to inflate scores.

1. Obtain the permitted native app window with disposable account/config/project/photo/template
   data; reuse the recorded isolated fixture setup and verified binaries. Diagnose native control
   availability before repeating the previous hanging lookup. Record a real successful launch.
2. Resolve the preserved native save-publication candidate integration prerequisite before claiming
   source-revision/editor-save acceptance. Keep shipping41a, prior engine metadata and frozen
   binaries intact until a separately verified integration is ready.
3. Execute the Mac create-to-delivery/reopen checklist, render/export stop/failure routes,
   editor associations, keyboard/busy-dialog handoffs, VoiceOver and representative photo-corpus
   performance tests. Record failures and repair them; browser fixtures alone cannot satisfy them.
4. Actual retained history is still at its256-folder limit. This UI makes it visible but cannot
   safely reclaim unknown/retained work. Define and verify writer ownership, coordination and a
   preservation/reclamation policy before implementing a cleanup action. Do not delete this history
   or relax retention limits simply to make an export/test pass.
5. Continue the unchanged rubric and use fresh cache/data profiles for full application gates.

Reproduce synthetic storage checks with `node native/ui/dev/fixtures.mjs` and
`http://127.0.0.1:5191/?open=/album&scenario=retention-limit`. Additional scenarios:
normal, retention-bytes, retention-empty, retention-zero-budget, retention-unavailable,
retention-refresh and storage-error. Wait for Spread1of3 before opening Settings so the
album-context change does not consume a fail-once fixture measurement. The loopback server
and temporary browser tab were stopped after verification.
