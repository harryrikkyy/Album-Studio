# Reconstructing and checking Album Studio's engine

The engine is now pinned by `native/scripts/engine/pin.json`. The root includes a checksum-pinned
122 KB incremental Git bundle for the eleven local Album Studio commits, so a fresh machine
does not need an unpublished fork remote. `native/scripts/engine/PROVENANCE.md` records its
source, inspection scope and dual licences.

## Fresh developer setup

Use macOS 13+ on Apple silicon, Xcode command-line tools (including the C compiler), Node.js
22.23.3/npm, Git, and Rust/Cargo 1.99.0. The C compiler builds the tiny atomic no-replace
publication helper. That executable is shipped beside the engine and is required for runtime
capture of existing sheets, proofs and delivery files. The compiler itself is not shipped.
Tests also require Poppler's `pdftoppm` for independent PDF colour verification:

```sh
npm ci
npm ci --prefix native/ui
brew install poppler
node native/scripts/engine.mjs setup
rustup toolchain install 1.99.0 --profile minimal --component rustfmt --component clippy
rustup override set 1.99.0
node native/scripts/engine.mjs check
node native/scripts/engine.mjs build
node native/scripts/engine.mjs test-node
```

Setup fetches only the exact public upstream prerequisite and imports the tracked fork bundle,
then verifies the final commit and Cargo.lock before publication. It creates an independent
detached checkout. An existing checkout is inspected only; a different HEAD or tracked changes
cause an actionable failure. Untracked files such as `.DS_Store` remain untouched. Offline
setup can use an existing, trusted source mirror:

```sh
node native/scripts/engine.mjs setup --engine /new/checkout --base-repository /existing/checkout
```

The mirror must contain the exact prerequisite. This does not replace or edit either an
existing checkout or a user project. Interrupted setup may leave a generated staging directory;
inspect it before deleting it. No command resets or discards engine work.

Build defaults to a separate `native/photocraft/target/album-studio-pinned` directory, uses
`--locked`, includes the pinned HEIF feature, checks compiler versions, and stamps the source
SHA/date into the binaries. `--target-dir` can select another build cache. The Node gate requires
that freshly tagged CLI and the atomic helper reporting its current source SHA-256, runs the three application test suites, and rejects incomplete
summaries or any skipped tests. An old binary reporting `dev build` is insufficient evidence.
To refresh only the C helper in an already verified target, run
`node native/scripts/engine.mjs build-rename --target-dir /absolute/build/target`.
The PDF test fails if Poppler is missing. `ALBUM_STUDIO_PDFTOPPM` may name its executable;
`ALBUM_STUDIO_RENAME_CLI` may select the atomic helper for direct test commands. The strict gate
sets the latter automatically. These overrides do not certify an old installed application.

## Safe package output

`package-mac.sh` refuses an existing destination before building. Set a new output path:

```sh
ALBUM_STUDIO_PACKAGE_PATH="$PWD/native/dist/Album Studio - review.app" npm run build
```

It validates/builds the pinned engine and assembles/signs the complete app in a sibling staging
directory. Publication uses the OS's atomic no-replace rename (`renamex_np(RENAME_EXCL)` on
macOS), so even an empty existing directory or a destination created during publication is
preserved. A failed package remains in staging. No previous `.app` is deleted or overwritten.
An interrupted publication lock names the source/destination and process; inspect that process
and the paths before retrying. Packaging was not run during this pin/setup change.
The existing `npm start` command still opens `native/dist/Album Studio.app`; open the new review
bundle explicitly when you choose another destination. Its resources include the full engine
pin manifest beside the compiled engine and the signed atomic helper. New runtime capture
paths fail with recovery instructions if that helper is missing; there is no overwriting fallback.

The existing README quick-start predates this prerequisite/setup requirement. Run these
commands first; a successful interface build is not a substitute for engine setup or packaging.

## CI contract and verification limits

The root workflow now runs on pushes/PRs/manual runs. Public action revisions and the compiler
are pinned. `macos-15` selects a standard arm64 runner according to
[GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Separate jobs reduce the disk pressure of combined release/dev/corpus targets:

- Lint, types, both npm audits, exact engine reconstruction and shell/CLI/atomic-helper build, all
  Node suites with zero skipped tests, interface production build, retained integration logs.
- Rust workspace tests, the explicitly ignored adversarial registry suite, formatting, Clippy
  and dependency layering.
- The engine's checksum-pinned real-file decoder/compositor corpus, fetched and tested through
  its existing `cargo xtask test-corpus` gate.

The integration job installs Poppler and records its version. It independently renders real
ICCBased PDF streams with an explicit sRGB display profile. This is a synthetic pixel oracle;
an actual print-lab specification, printed sample and broader document corpus remain required.

This is an enforced workflow definition, not a claim that hosted CI has run. Optional-font,
hardware/GPU, RAW corpus, native GUI, complete signing/notarisation and clean-customer-Mac
verification remain distinct requirements. The source/compiler/dependency pin does not assert
byte-identical builds across different Xcode/SDKs or optional font inputs. No credentials,
signing identities or real customer settings were used or changed.

## Evidence from this continuation

Latest verification is `2026-10-14-iteration-3/verification.json`: 715 application tests pass
(273 shared, 409 helper, 33 interface), with no failures or skips. Shared/helper coverage runs
682 tests separately. Local Node was 22.22.3; the package/CI Node pin is 22.23.3. Do not relabel
the local checks as tests of that packaged runtime. The atomic helper was freshly compiled and
its source checksum verified. Root packaging, hosted CI and final independent review remain
unverified. The entries below retain the earlier engine reconstruction/build history.

- Existing engine: exact pinned HEAD and lockfile, no tracked changes; three pre-existing
  untracked `.DS_Store` files preserved.
- Eleven focused setup/publication tests pass, including a fail-first packaging-guard test,
  local fresh reconstruction, wrong-source/lock/bundle rejection, preserved edits and the OS
  primitive refusing an empty destination.
- Anonymous fresh reconstruction from the public upstream completed at
  `/private/tmp/album-studio-pinned-20261013-bdb1f8f`; its final HEAD and lockfile match the pin.
- Packaging script syntax, JavaScript syntax, focused lint and source whitespace checks pass.
- Cold release shell/CLI build from the reconstructed checkout completed in 3m 08s, using a new
  target directory, Rust/Cargo 1.99.0, the locked dependency set and HEIF. The CLI reports
  `photocraft-cli 0.6.0 (bdb1f8f35, 2026-10-12)`. The initial target was empty; existing release
  binaries and application bundles were not replaced.
- The strict Node gate against that freshly built CLI passed 273 shared, 294 helper and
  33 interface tests: 600 total, zero failed/skipped/cancelled. The first sandboxed attempt
  lacked localhost callback permission; the rerun allowed isolated callback sockets and
  passed. This result includes other agents' concurrent regression additions at the time of
  the run, and is not a certification of a later root-tree revision.
- The cold build reports a genuine future incompatibility in `block 0.1.6`: an uninhabited
  Objective-C static type will become a hard compiler error in a future Rust release. The
  pinned current compiler builds successfully. No warning was disabled; the dependency needs
  an intentional upstream/fork update and new pin before claiming future-compiler support.
- Hosted CI, full Rust workspace/Clippy/corpus and a packaged application installation remain
  unverified in this continuation. The workflow defines those gates, but configuration is
  not evidence of their completion.
