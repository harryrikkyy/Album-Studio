# UI and workflow — iteration 1

The user stopped architecture work and requested UI/workflow >=9.5/10. This work continues
from root `cdd52fc77532444c83b365289af29b875d0a33e3`, preserving the architecture WIP. The shipping
engine stays `41a0f464405a1e4e20629de928727815679f5906`; the isolated native save-publication
candidate has not been integrated. No new architecture certification is claimed.

## Implemented

- Global keyboard commands respect dialogs, IME composition, consumed events and control-owned
  navigation. Native menu commands cannot edit the background album through a modal.
- Segmented controls have one Tab stop and arrow/Home/End selection. Menus support first/last
  opening, Home/End, disabled-item skipping, Escape and Tab exit with focus restoration.
- Dialog Tab edges are contained in WebKit. Errors stay until dismissed and appear in the
  active dialog's top layer; closing it retains the notification outside the dialog.
- Photo browsing mounts at most120 options per page, with filename search, one photo Tab stop,
  arrow/Page/Home/End focus and Space/Shift-Space selection. Selection outside search/filter
  results is explicit. Actions remain in the accessible selection toolbar; placements can
  navigate to their spreads. Names are visible, and missing thumbnails show an explicit fallback.
- At760x480, Photos and Spread remain reachable. The inspector has its own close action.
  Photo placements/templates switch to the spread and restore useful focus. Empty plans offer
  the first-spread action; selection is preserved when reaching it from Photos.
- Failed recent-album loading differs from a confirmed empty list. Storage and template-loading
  failures have retry actions. Stale album opens, refreshes and quiet reads cannot replace a
  newer selection or an edit applied while reading.
- Authored light/dark text contrasts cover neutral surfaces, status notices, primary actions
  and menu text. Focused menu shortcut text, dark destructive-menu text and light status notices
  were repaired without changing the neutral photo surround.

## Evidence and limits

`browser-acceptance.json` contains23 executed production-web-UI checks using the separate
`native/ui/dev/fixtures.mjs` transport. The synthetic fixture has no real backend, accounts,
folder pickers, native editor or filesystem operations. The6000-photo fixture uses small SVG
samples and is not a real photo-corpus or memory/latency benchmark. Three final screenshots
cover dark, light and the minimum-size photo pane. Earlier screenshots are intermediate evidence.

The first WebKit dialog Tab loop reached BODY. The final guard passed24 forward+24 reverse
steps in New Album, plus32 bidirectional steps in Settings. A storage-retry attempt was started
before the album finished opening; its context change correctly triggered a second measurement.
The rerun waits for the spread heading. That setup failure remains in the acceptance record.

`quiet-refresh-baseline.log` records three actual failing state regressions before repair.
`contrast-baseline.log` initially assumed secondary menu ink; inspecting the rendered menu
corrected that assumption. `contrast-confirmed-baseline.log` reproduces the remaining genuine
failures (focused hints3.840/3.083, dark destructive text2.670, light status4.310/3.933).
`contrast-fixed.log` passes. These tests certify their authored pairs, not overall WCAG conformance.

Earlier full gates passed1195 and1203 tests. `application-verified.log` then failed32 backend
RGB cases with PRIVATE_STAGE_BUDGET. That existing test file lacked a temporary cache override
and repeated runs exhausted the real app cache's256-stage history limit. Its cache is now isolated;
all37 focused RGB cases pass. No existing app history was deleted, and production retention limits
were not changed. `app-history-before-isolated-gate.json` records256 files/1951232 bytes and a
names/content hash. The final whole-app gate uses `isolated-gate-profile.json` for cache/data
isolation. It passes297 shared+848 backend+61 UI=1206, with zero failures/cancellations/skips.
The app-history names/content hash is unchanged after that gate. Types, production UI build,
lint and the118-file architecture graph pass. The final UI bundle is261.3KiB JS/56.2KiB CSS.

All385 retained prior evidence/executable/benchmark hashes pass. The11 pre-existing tracked
changes matched their UI baseline before the mission-log append. `docs/reviews/` and
`invoice-template/` were not changed. Backend production architecture files and engine pins
remain untouched by this UI iteration. One backend test file received the cache-isolation fix.

## Native verification blocker

`cua.getApp` for the isolated native fixture timed out after4242.2032 seconds and reset the
UI-control kernel. No successful native launch or interaction was observed; a subsequent process
inspection found no fixture app process. `native-host-fixture.json` records its disposable config,
refusing helper and copied binary hash. That attempted host never qualifies as a native acceptance
pass. Browser control recovered and the independent checks continued.

The goal tool rejected replacing the usage-limited architecture goal while it remains unfinished.
There is no clear operation in the exposed goal tools, and computer control of Codex itself was
explicitly denied. The user command is `/goal clear`, then a new UI goal can be created. Architecture
was stopped by user instruction; it was not completed.

## Assessment on the unchanged ten-criterion rubric

| Criterion | Points /10 | Remaining acceptance |
|---|---:|---|
| Essential end-to-end workflows |5|Actual Mac create→plan→render→editor→deliver→reopen flow|
| Undo and redo |10|Retained prior evidence; no new native end-to-end certification|
| Spread and edit association |5|Actual editor save/reopen and context changes in the native window|
| Job progress and recovery |5|Native render/export stop, partial failure and finishing warnings|
| Actionable errors |5|Native recovery/ambiguity/relink and complete recovery actions|
| Keyboard operation |5|All places and native editor, including crop/frame adjustment|
| Focus and modal behavior |5|All native dialogs, busy transitions and editor/web-view handoffs|
| Accessible names and contrast |5|VoiceOver and complete composed-screen/native-editor audit|
| Realistic large-grid usability |5|Representative varied photo corpus, actual native memory/latency|
| Empty/loading/offline/failure states |5|Real native account/drive/backend interruptions across the full flow|

Supported score:55/100 =5.5/10 (previous45/100). Only previously unverified focus/modal and large-grid
criteria gain partial points. No criterion is removed, no other category score is raised, and the
UI category is not certified. The9.5 target remains unfinished.

## Next executable steps

1. Read `verification.json`, the current Git diff and the native host failure; do not restart the audit.
2. Obtain a working native app window through the permitted UI-control surface, or run and record
   the native acceptance checklist with human interaction. Do not bypass the denied debug/control
   or Codex-app surfaces. Keep the native test config and project/photo/template data disposable.
3. Resolve the preserved native save-publication candidate's integration prerequisite before claiming
   editor save/source-revision acceptance; preserve the existing engine checkout metadata and binaries.
4. Execute the ten remaining acceptance scopes above, retaining failures and correcting each defect.
   Use a representative varied JPEG/RAW corpus for large-grid work, not the SVG fixture alone.
   Surface retained-history usage/review in Settings before claiming complete storage recovery;
   the production256-stage limit is still enforced and no approved reclamation flow was invented.
5. Continue reassessing this same rubric; do not mark the goal complete on browser/unit tests alone.

The UI fixture can be reproduced with `node native/ui/dev/fixtures.mjs`, then
`http://127.0.0.1:5191/?open=/album&large=1`. Other implemented scenarios are `empty`, `offline`,
`empty-plan`, `storage-error` and `missing-thumbs`. It listens on loopback only. This preview may
be stopped after recording evidence; it is not a packaged production launch.
