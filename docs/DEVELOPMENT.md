# Development

How to build, run and test Album Studio. A fresh clone should be productive from here.

## Prerequisites

- macOS 13+ on Apple silicon, with Xcode's command-line tools.
- Node.js 22.23.3 and npm, for the helper's tests and the interface's build. The packaged app
  carries its own Node.js.
- Rust/Cargo 1.99.0 through rustup, for the pinned shell and PhotoCraft engine.
- Poppler (`brew install poppler`) for the required independent PDF colour test.
- The exact PhotoCraft revision reconstructed at `native/photocraft`. It is a separate,
  ignored repository. Setup verifies existing source and never resets it.

## Install

```bash
npm ci                       # the locked shared/helper packages
npm ci --prefix native/ui
brew install poppler
rustup toolchain install 1.99.0 --profile minimal --component rustfmt --component clippy
rustup override set 1.99.0
node native/scripts/engine.mjs setup
node native/scripts/engine.mjs check
node native/scripts/engine.mjs build
node native/scripts/engine.mjs test-node
cp .env.example .env         # sign-in settings: Firebase project and Google OAuth client
```

`.env` is git-ignored, and by default it isn't built into the app. Each Mac supplies its own:
the helper reads it from `~/Library/Application Support/Album Studio/.env`, then from the
repository root (when run from source), then from the Album Toolkit's folder.
Configure a private development environment; test fixtures do not require real account secrets.
See [engine setup and CI](quality/ENGINE_PIN_AND_CI.md) for pin checks, alternate targets and
fresh reconstruction. Local iteration-5 checks used Node 22.22.3; packaged 22.23.3 runtime
verification remains separate.

## Build and run

```bash
npm run build                # native/scripts/package-mac.sh → native/dist/Album Studio.app
npm start                    # open it
```

Packaging refuses an existing destination. To preserve an existing app, choose a new one:

```sh
ALBUM_STUDIO_PACKAGE_PATH="$PWD/native/dist/Album Studio - review.app" npm run build
open "native/dist/Album Studio - review.app"
```

`npm start` always opens the default bundle. A successful test/build does not update that bundle.

The package script does the following:
- builds the pinned release shell, engine and source-checksummed atomic file helper;
- bundles the interface and the helper, with exactly the modules and packages it needs
  (`native/scripts/collect-backend.mjs`);
- bundles Node.js 22.23.3 from nodejs.org, pinned by SHA-256 and downloaded once into
  `~/Library/Caches/AlbumStudioBuild`;
- adds the licence texts and signs the app ad hoc (for this Mac).

Options are documented at the top of the script, including Developer ID signing
(`MACOS_SIGN_IDENTITY`).

For work on the interface:

```bash
npm --prefix native/ui run watch           # rebuild on change
node native/ui/dev/serve.mjs               # the interface in a browser (no helper: screens only)
```

A debug build of the shell (`cargo build -p album-studio` in `native/photocraft`) loads the
interface from `native/ui/dist` and the helper from `native/backend`. Runtime captures require
the compiled `album-studio-rename-exclusive` beside the CLI; use the engine build command above
or set `ALBUM_STUDIO_RENAME_CLI` to the current compiled helper. Native UI/accessibility checks
require an authorised GUI session and disposable albums; a debug socket is not approval.

Two environment settings help with testing:
- `ALBUM_STUDIO_DATA_DIR` and `ALBUM_STUDIO_CACHE_DIR` keep a test run's data out of the real
  folders.
- `ALBUM_STUDIO_ACCOUNT=skip` skips the subscription check. It never works in the packaged
  app.

## Quality gates (before every commit)

| Command | Checks |
|---|---|
| `npm run lint` | ESLint over `src/`, `test/`, `native/backend/` and `native/contracts/`, then the readability ratchet (`native/scripts/check-readability.mjs`: no file may gain lines over 160 characters or functions above complexity 20) |
| `npm run typecheck` | `tsc` over the shared modules and backend files that opt in with `// @ts-check`, and the interface |
| `npm run check:architecture` | Dependency boundaries, module reachability, canonical contracts and the packaged closure |
| `node native/scripts/engine.mjs test-node` | All three application suites against the pinned CLI/helper; rejects skips |
| `npm --prefix native/ui run build` | Production interface assets |
| `cargo fmt --all -- --check`, `cargo test --workspace --locked --features heif` | Native workspace (in `native/photocraft`) |
| `cargo clippy --workspace --all-targets --locked --features heif -- -D warnings`, `cargo xtask layers` | Native lint and dependency boundaries |
| `cargo xtask test-corpus` | Checksum-verified real-file engine corpus |

`npm test` alone permits some missing-engine skips and is insufficient for acceptance. The
strict gate requires a provenance-tagged CLI and the current atomic helper. Poppler is required
and absence fails its PDF test. A successful Node gate does not imply full native workspace,
corpus, hosted CI or installed-app checks passed. Exact evidence and open requirements are in
[the archived quality log](quality/archive/QUALITY_IMPROVEMENT_LOG-2026-10.md), [the evidence archive](quality/ARCHIVE.md)
and [recovery guidance](quality/RECOVERY_AND_VERIFICATION.md).

Backend test files run with concurrency 2. In-file job/process races still run concurrently;
this bounds simultaneous engines and decoder allocations on the 16 GiB verification Mac.
Run coverage and the strict gate sequentially. Coverage uses the same file limit:

```sh
ALBUM_STUDIO_PHOTOCRAFT_CLI=/absolute/target/release/photocraft-cli \
ALBUM_STUDIO_RENAME_CLI=/absolute/target/release/album-studio-rename-exclusive \
node --experimental-test-coverage --test --test-concurrency=2 test/*.test.js native/backend/test/*.test.js
```

For heavy tests, set `TMPDIR` to a fresh disposable directory on a volume with enough free
space. Filesystem semantics matter: iteration 4 found HFS one-second timestamps could hide
changed/restored source contents. Do not replace that coverage with timestamp-only assertions.

The headless benchmark creates distinct synthetic 12 MP JPEGs, renders at 300 PPI, repeats
warm operations, verifies reorder ownership and rasterises the output PDF independently:

```sh
ALBUM_STUDIO_PHOTOCRAFT_CLI=/absolute/target/release/photocraft-cli \
ALBUM_STUDIO_RENAME_CLI=/absolute/target/release/album-studio-rename-exclusive \
node bench/native_pipeline_bench.js --profile pilot --rss-gib 2
```

Start with the pilot and review its retained `bench/fixture/native-pipeline-*/report.json`.
Larger profiles require an explicit disk ceiling; the harness checks available space, records
source hashes and aborts at its time/RSS ceilings. Those ceilings are test safety limits, not
accepted production budgets. Synthetic textures and simple rectangular templates do not
certify camera RAW, layered customer templates, actual UI responsiveness or real lab output.

## Run one suite

The backend tests drive the real PhotoCraft engine through two variables. The packaged app's
copies work:

    export ALBUM_STUDIO_PHOTOCRAFT_CLI="$PWD/native/dist/Album Studio Latest.app/Contents/Resources/bin/photocraft-cli"
    export ALBUM_STUDIO_RENAME_CLI="$PWD/native/dist/Album Studio Latest.app/Contents/Resources/bin/album-studio-rename-exclusive"

`ALBUM_STUDIO_PHOTOCRAFT_CLI` is the engine's command-line renderer; `ALBUM_STUDIO_RENAME_CLI` is the
atomic-rename helper that publication uses. Then run any one suite or file:

    node --test test/*.test.js                                   # shared modules
    npm --prefix native/backend test                             # backend helper
    npm --prefix native/ui test                                  # interface logic
    node --test native/backend/test/publication_broker.test.js   # one file

## Accounts

Sign-in uses the same Creative Hubb accounts as the Album Toolkit:
- Google sign-in happens in the user's browser.
- The user's record lives in Firestore (`firestore.rules`): activated, an expiry date, one
  machine.
- The licence is saved to `~/.ch_toolkit_license`. The licence server in `server/` signs it and the
  app verifies it with `src/license_public_key.pem`; the owner's admin panel, outside this
  repository, calls that server.

The code is in `native/backend/lib/account.js`, and the helper refuses album work until the
check passes.
