# Iteration 7: architecture boundaries and remaining native work

This iteration spans 15–16 October 2026 and resumes source checkpoint
`1528ffaade6cf48cdb0e2eea6c01700e6558f391`. The user updated the goal to
**Architecture strictly above 9.5/10**. Existing 10-criterion weights and scoring stay fixed.
Architecture remains **65/100 (6.5/10), uncertified**: stronger evidence inside partial criteria
does not complete native transport, editor/global ownership or migration requirements.
Other category scores remain historical context; they were not newly certified.

## Verified candidate source

- `node-gate-final.log`: final strict gate **289 shared + 798 backend + 46 interface =1133**,
  no failures, cancellations or skips, real pinned engine/helper, independent PDF checks.
- `node-gate-first.log`: preceding gate289 shared passed,795/797 backend passed. The two
  integration failures and `project-integration-repaired.log` remain preserved. One assertion
  now checks the structured project error and unchanged bytes; the obsolete-edit fault is
  injected after the authoritative read. A separate test verifies fields saved before that
  read are preserved alongside the requested edit. No conflict refusal was weakened.
- `typecheck-current.log`, `lint-final.log`, `ui-build-final.log`: shared/interface types,
  lint zero warnings/errors and production build pass. Interface JavaScript248.2KiB,
  CSS54.5KiB. The canonical runtime/schema adds browser bytes; no performance neutrality claim.
- `architecture-current.json`:108 JS/TS files,603 dependency edges, zero cycles/violations,
  65 packaged runtime files,10 packages,39 backend +14 native method inventory,17 event inventory.
  Static gates do not establish native runtime contracts. Exact runtime counts are recorded
  from this JSON and the final manifest, rather than inferred from older scope reports.
- `prior-evidence-reverified.json`:449 prior artifact, binary and retained-pilot hashes match.
  Earlier source evidence is historical; source modifications here are intentional and hashed
  separately. Previous before-edit verification covered all533 iteration-6 hashes.

Canonical request/result/event vectors cover53 methods/17 events. Actual dispatch integration
executes all39 backend handlers with disposable JPEG/PSD/proof/render/export/PDF fixtures and
13 event producer names. Account/browser services are explicitly mocked. Native vectors are
examples, not native execution. The real bundled browser bridge exercises validation, pending
capacity, post failure, recovery metadata and malformed/native-empty events. Production-consumer
checks retain finishing warnings next to successful sheet counts.

Private-stage and journal checks reproduce and repair deletion, substituted snapshot, descriptor
close, changed journal and commit-node identity faults. Complete private trees retire exclusively;
unknown/edited/partial bytes remain available. Historical asset identities and aliases remain
reserved after removal; final host alias and handoff regressions pass inside the complete gate.
Retention limits are per-parent refusal policies, not distributed reservations or approved
reclamation. No old recovery history was pruned.

Input framing now coalesces fragments into64KiB slabs. A one-MiB/one-byte input uses16 retained
slabs; the retained local allocation probe is scoped, not a customer benchmark. Output frames,
aggregate admission, callback/drain order and stream failures are bounded and tested. A broken
output channel visibly stops new request admission; completed operations must be checked before
retrying. Native transport still needs the same end-to-end guarantees.

## Native replay and next implementation boundary

The actual pinned `cargo xtask layers` run fails: `album-studio` is absent from its explicit
composition-root table. See `album-architecture-native-layers-fixed-path.log`.
`native-replay/` copies the exact pinned backend/layering sources, records their SHA-256 values,
then appends isolated regressions. The disposable Node child reproduces old helper EOF failing a
new helper request. `native-replay-fail-first.log` is14 pass/2 fail. The isolated candidate in
`native-replay/candidate-generation-and-layers.patch` passes16/16 in
`native-replay-candidate.log`, using the retained Cargo.lock. This candidate is **not applied to
the pinned engine, not a native app build, and not a completed native fix**. Warnings in the
small replay crate are retained; no Clippy certification is inferred.

Next: review and integrate a generation-safe bounded typed native adapter; route editor and
standalone saves through explicit revision/ownership/publication contracts; register the app
without exempting dependencies from forbidden upward imports. Add production-native regression
seams, update the engine pin/bundle through a reviewed source commit, preserve all old binaries,
build a new provenance-tagged CLI/shell, then rerun the complete gate and native app tests.
Do not overwrite the three existing engine `.DS_Store` files or user folders.

Provider/automatic-review limits interrupted some worker attempts. Those did not execute;
later parent-approved host checks and full gate did execute and pass. Temporary worker-native
replay paths disappeared before parent verification, so the parent recreated and retained its
own replay here. Current source and retained logs, not bare worker messages, are authoritative.
No native GUI/accessibility session, real account migration or physical storage/print/release
certification is claimed. Those are not substituted for the remaining architecture work.

## Checkpoint source inventory correction

The three root generated-type regressions in `test/contract_types.test.js` ran in the final
289-test shared suite but were left untracked by the first checkpoint staging list. The
follow-up source checkpoint includes that exact executed test source and its hash. It also
retains the late, unapplied native-layer candidate at
`native/scripts/engine/architecture-candidate.patch`; its own tests are not claimed from the
Node gate. No application source or test result changed during this inventory correction.
