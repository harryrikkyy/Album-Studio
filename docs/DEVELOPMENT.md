# Development

How to build, run and test Album Studio. A fresh clone should be productive from here.

## Prerequisites

- macOS 13+ on Apple silicon, with Xcode's command-line tools.
- Node.js 22 and npm, for the helper's tests and the interface's build. The packaged app
  carries its own Node.js.
- Rust (rustup, stable), for the shell and the PhotoCraft engine.
- The PhotoCraft fork, checked out at `native/photocraft` (branch `album-studio`). It's a
  separate repository and is ignored by this one.

## Install

```bash
npm install                  # the shared modules' and the helper's packages (sharp, ag-psd, …)
npm --prefix native/ui install
cp .env.example .env         # sign-in settings: Firebase project, Google OAuth client, licence key
```

`.env` is git-ignored, and by default it isn't built into the app. Each Mac supplies its own:
the helper reads it from `~/Library/Application Support/Album Studio/.env`, then from the
repository root (when run from source), then from the Album Toolkit's folder.

## Build and run

```bash
npm run build                # native/scripts/package-mac.sh → native/dist/Album Studio.app
npm start                    # open it
```

The package script does the following:
- builds the release shell and engine;
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
interface from `native/ui/dist` and the helper from `native/backend`. With
`ALBUM_STUDIO_DEBUG_SOCKET=dbg.sock`, it also runs scripts in the page for automated checks.

Two environment settings help with testing:
- `ALBUM_STUDIO_DATA_DIR` and `ALBUM_STUDIO_CACHE_DIR` keep a test run's data out of the real
  folders.
- `ALBUM_STUDIO_ACCOUNT=skip` skips the subscription check. It never works in the packaged
  app.

## Quality gates (before every commit)

| Command | Checks |
|---|---|
| `npm run lint` | ESLint over `src/`, `test/` and `native/backend/` |
| `npm run typecheck` | `tsc` over the shared modules (opt-in `// @ts-check`) and the interface |
| `npm test` | Shared modules (`test/`), the helper (`native/backend/test`), the interface (`native/ui/test`) |
| `cargo fmt --check`, `cargo clippy -p album-studio`, `cargo test -p album-studio` | The shell (in `native/photocraft`) |

The helper's tests that build real sheets need the engine (`photocraft-cli` in the build
cache). Without it they say they skip.

## Accounts

Sign-in uses the same Creative Hubb accounts as the Album Toolkit:
- Google sign-in happens in the user's browser.
- The user's record lives in Firestore (`firestore.rules`): activated, an expiry date, one
  machine.
- The licence is saved to `~/.ch_toolkit_license`, signed with the key in
  `src/license_public_key.pem`. The owner's activation tool is in `server/`.

The code is in `native/backend/lib/account.js`, and the helper refuses album work until the
check passes.
