# Native contracts and helper transport

Status: implemented in the architecture engine candidate; integration/build evidence is
recorded in the iteration8 quality log. This decision does not certify complete architecture.

## One contract source

`native/contracts/album-studio.schema.json` and `contract-manifest.json` remain the canonical
process contracts. The TypeScript generator derives browser types. The native generator
copies the same schema, manifest, authored examples and reviewed Rust validator into the
engine, and generates a method enum with ownership and debug availability. The native copy
is embedded at compile time; a packaged app does not load a mutable external schema.

The native generator refuses unsupported schema keywords/types, unresolved references,
nonprimitive discriminators/uniqueness policies, and ambiguous Rust method names. The root
engine pin requires exact copy parity through `contractsVersion: 1`. CI also runs the explicit
native drift check. Method-specific Rust request/result DTOs and a concrete editor-inspection
result remain unfinished. Runtime validation and a method enum do not close those requirements.

Both validators count UTF-16 units for string policy, reject prototype-control keys and bound
JSON traversal. JS now refuses lone UTF-16 surrogates, matching the native JSON decoder's
Unicode scalar requirement. Valid emoji and non-Latin text remain supported. Malformed legacy
text is refused without rewriting the source file; ownership/migration acceptance remains
separate work.

## Transport ownership and bounds

The UI thread admits requests without blocking pipe writes. A dedicated writer owns stdin;
reader threads own stdout/stderr. Generation-tagged data/control messages prevent an old
helper's EOF or reply from settling a replacement helper's requests. Pending entries retain
the method, page ID, generation and deadline. Wire IDs are positive JavaScript-safe integers;
valid integral JSON spellings such as `1.0` correlate with `1`. IDs are not reused on timeout.

| Boundary | Limit / behavior |
| --- | --- |
| Page request | 8 MiB per frame |
| Native ingress | 128 frames, 16 MiB aggregate; bounded overflow fault |
| Native pending requests | 128; duplicate page IDs refused |
| Queued/in-progress stdin | 16 MiB aggregate; nonblocking admission refusal |
| Stdout frame | 64 MiB; UTF-8 and newline required |
| Native stdout inbox | 128 messages, 128 MiB aggregate; producer backpressure |
| Stderr diagnostic | 64 KiB retained per line; excess drained, truncation reported |
| Pending lifetime | Six hours; late replies cannot steal later requests |

Native ingress overflow retains accepted frames and records one channel fault instead of
retaining unbounded rejected bodies. An uncorrelatable channel fault settles browser waiters
visibly; already admitted operations may still finish. No automatic retry is authorized.
Writer/EOF/invalid-reply/timeout errors explicitly require verification of completed work.
Valid helper error replies retain commit/restoration/recovery details unchanged. Existing
native library string errors still lack complete structured publication metadata.

The UI never waits for a retired connection's worker threads. A replacement is refused until
retired readers/writer finish, bounding generations that can hold pipe threads. Closing the
inbox unblocks producers. Shutdown still needs review with the native save-ownership work;
transport lifecycle tests do not establish safe document publication.

## Reproducible integration

The engine pin binds the commit, lockfile, bundle checksum and a fully qualified `bundleRef`.
Old manifests without that field retain the historical `refs/heads/album-studio` lookup.
Installation still checks out the exact pinned commit. Relative local mirrors resolve before
fetch changes into staging. Existing modified/drifted checkouts are refused rather than reset.
A build rechecks the pin and source after compilation before reporting verified provenance.

Actual native tests execute disposable children and the production Node dispatcher, covering
valid ping, real sign-in admission failures, obsolete EOF/replies, malformed/partial/invalid
UTF-8 output, full/blocked queues, deadlines, scalar text, structured recovery replies and
numeric ID compatibility. Authored examples cover all 53 methods and 17 events in the native
validator; they do not execute all native GUI handlers. See the retained raw logs for exact
source/test scope. Native editor save ownership, whole-application invalidation, permanent/
legacy/global reconciliation and migration rollout remain required work.
