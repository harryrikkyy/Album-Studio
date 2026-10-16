# Pinned Album Studio engine

`pin.json` is the root project's authoritative engine dependency. It fixes the source commit,
upstream prerequisite, incremental bundle SHA-256, Cargo lockfile SHA-256, compiler release,
build date and feature set. A moving branch or an arbitrary local engine is not a release input.

The original checkout was inspected on 13 October 2026. It is a shallow clone with upstream
`https://github.com/storytold/photocraft.git`, base/tag `v0.6.0` at
`0c72d95425dece90ef9a1cceb49e3315c96e22d5`, and eleven local Album Studio commits ending at
`bdb1f8f35767700033ec9cd7b8fc0b80e182b0e9`. There is no fork/origin remote containing those
commits. Fetching a moving upstream branch would lose the Album Studio shell.

`album-studio.bundle` preserves those exact eleven commit objects and changed blobs, with the
upstream base as its prerequisite. It was generated with Git's incremental bundle mechanism:

```sh
git -C native/photocraft bundle create /absolute/output/album-studio.bundle album-studio ^v0.6.0
```

It is 124,593 bytes. Its SHA-256 is
`484638db77b391739bf38b763a05c592188713e7b397e98ac27a15e510b88f05`.
Git verifies both its prerequisite and its advertised `refs/heads/album-studio` commit.
The fork changes 34 source/manifest files: the Album Studio app, small UI hooks and Cargo.lock.
Every local commit's changed blobs were scanned for private-key headers, literal credential
assignments and customer/credential file paths; no findings were returned. This is a focused
source-package inspection, not a completed whole-engine security audit.

PhotoCraft is dual licensed under MIT or Apache-2.0. The exact upstream licence texts and
NOTICE are retained beside the bundle. Their copyright and attribution requirements still
apply to this reconstructed fork; package-mac.sh also copies those texts into the application.
No fonts, customer photos, sign-in configuration or private signing material were added to the
bundle. Source reconstruction uses the public prerequisite anonymously, with credential
helpers, additional HTTP headers and interactive prompts disabled.

Updating this dependency requires an intentional review of the new engine source, generation
of its incremental bundle, updating every manifest checksum, rebuilding, and running the
engine, integration and corpus gates. Never modify a pin merely to make an unexplained source
drift pass.

## Architecture continuation, 16 October 2026

The current pin advances the original fork with two reviewed local commits: native
composition-root registration, bounded generation-scoped pipe/ingress lifecycle, canonical
embedded JSON validation/generated method ownership, and integral wire-ID compatibility.
The final source commit is `41a0f464405a1e4e20629de928727815679f5906`; the original bdb1f8f source objects and
`album-studio.bundle` are retained. The intermediate591c5b4 bundle is retained separately.

The authoritative final bundle is `architecture-20261016-wire-id.bundle` with SHA-256
`f2234f91cc5f407f8f440179abe0eb571af18e1cfcf332592c16ab1d789d8b54` and advertised ref `refs/heads/codex/architecture-native`.
The unchanged prerequisite is `0c72d95425dece90ef9a1cceb49e3315c96e22d5`. The final lockfile SHA-256 is
`1f0ee0881214592d3a2ad51c5974a4a31a3f72e4590ecba4cd8862492d24c8d6`. The pin requires Rust1.99.0, HEIF and canonical native copy parity.
A local independent reconstruction, provenance-checked release rebuild and strict1142-test
application gate passed; native119-test and layering/Clippy evidence is recorded in iteration8.
Focused changed-source scanning is separate evidence, not a whole-engine security audit.
The packaged application, full workspace/corpus, hosted CI and native GUI remain unverified.
