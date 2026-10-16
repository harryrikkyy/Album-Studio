# Iteration 8: integrated native architecture prerequisites

Architecture improves from **6.5 to 7.0/10** under the unchanged ten-criterion rubric. Only
criterion9 (dependency/layering gates) gains5 verified points. Six criteria remain partial;
no score above9.5 or complete architecture is claimed. Other category scores are historical.

Root checkpoint parent: `0167e72319285669c5038375f83095362168eff4`. All658 prior hashes matched
before changes (`baseline-verification.json`). Final engine source:
`41a0f464405a1e4e20629de928727815679f5906`, following checkpoint591c5b4. Both incremental bundles
are retained. The new pin uses `bundleRef` and requires exact canonical native copy parity.
The original checkout was deliberately advanced after successful tests/build; its old commit,
three untracked metadata files and three previous release executables remain preserved.
`engine-preservation-before.json` and `engine-preservation-after.json` verify that transition.

## Implemented and executed

- Generation-scoped native requests/replies/EOF; retired connections cannot fail new requests.
- Bounded native ingress, frame/pending/inbox/writer budgets and nonblocking pipe admission.
  Worker backpressure retains accepted messages; diagnostic truncation keeps stderr draining.
- Embedded canonical53-method/17-event JSON validation and generated method ownership/debug
  availability. Integral JSON IDs and Unicode scalar text agree across JS/Rust. Native GUI
  handler execution and method-specific Rust DTOs remain incomplete.
- Structured helper recovery errors survive forwarding. Invalid output, deadlines and partial
  delivery settle requests visibly and require state verification before retrying.
- Native composition-root registration and forbidden upward dependency regressions; root
  method-owner mismatch gate; generated native drift checks in the pin/CI; relative local
  mirror reconstruction; post-build source/pin rechecks with mutation regressions.

| Executed check | Result | Raw evidence |
| --- | --- | --- |
| Strict final real-engine Node gate |297 shared +799 backend +46 UI =1142; zero fail/cancel/skip|node-gate-final.log|
| Native app suite |119 pass, zero fail/ignore|native-app-wire-id-final-host.log|
| Native actual Node/disposable children |17 transport tests pass; includes ping/sign-in denial|native-integral-wire-id.log|
| Native app Clippy, all targets, warnings denied |Pass|native-integral-wire-id-clippy.log|
| Native workspace formatting |Pass|native-integral-wire-id-format.log|
| Native layer regression tests |15 pass|native-layer-tests.log|
| Actual default native layer graph |30 crates; zero violations|default-native-layers-final.log|
| Final HEIF release rebuild |Rust/Cargo1.99.0; CLI/shell identify41a0f4644|native-release-final-build.log / native-shell-version.log|
| Root lint/types/UI production build |Pass; JS248.6KiB/CSS54.5KiB|lint-final-complete.log / typecheck-final.log / ui-build-final.log|
| Architecture graph |108files/603edges; zero cycles/violations|architecture-final.log|
| Canonical native drift |Pass in actual default checkout|native-default-contract-drift.log|
| Source/pin mutation and reconstruction regressions |16 pass|engine-provenance-guards-final.log|

The first bounded transport run had two restart-timing failures; retirement now refuses new
admission until worker teardown finishes, and tests wait for readiness without draining the
obsolete EOF. Old-generation isolation assertions remain. The first actual Node-helper test
incorrectly expected protected status methods to work signed out; it now verifies the actual
sign-in denials. No account bypass or production guard was introduced. Sandbox socket failures
were rerun with approved host access. Native lint failures were repaired; their raw logs remain.

The first cold591c5b4 build took6m53s. Its binaries remain at
`bench/fixture/native-architecture-release-591c5b4`, with hashes in
`intermediate-release-591c5b4.json`. The final41a0f46 rebuild took4m10s and used the new post-build
provenance checks. Final outputs are in `native/photocraft/target/architecture-20261016`.
Historical outputs, recovery histories, benchmarks and user folders were preserved.

## Remaining work and next executable steps

The next priority is native editor/standalone save ownership and publication, including both
background `Services::save_file` and synchronous export/write paths, authorized automation,
recovery adoption and generated image assets. Imported source bytes need revision evidence
bound to the document; a stale editor must not replace a concurrently changed sheet. Publication
must share album/output capabilities and journal ownership and invalidate proof/render/delivery
records after a verified commit. Holding a lock for an entire edit session is insufficient.

Continue with typed local DTOs/editor diagnostics, structured native publication errors,
whole-application invalidation, permanent/legacy/global reconciliation/reclamation and migration
acceptance. See `reassessment.json` and the native architecture decision for exact scope.
Hosted CI, complete native workspace/corpus, native GUI/AT and packaged-app installation remain
unverified. Current executed Node is22.22.3; configured22.23.3 packaging/CI runtime is unverified.
The existing block0.1.6 future-compiler warning remains visible. No current local execution
limit or external blocker prevents continuing the implementation; the goal remains active.
