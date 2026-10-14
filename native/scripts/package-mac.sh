#!/bin/zsh
# package-mac.sh — build "Album Studio.app" in native/dist (Apple silicon).
#
#   native/scripts/package-mac.sh
#
# Node.js: the official build pinned below is bundled, so the app needs nothing installed. It is
# downloaded from nodejs.org once, checked against the pinned SHA-256, and kept in the build cache.
#
# Optional:
#   ALBUM_STUDIO_PACKAGE_PATH   new .app destination. Existing bundles are never replaced;
#                               choose a new path when Album Studio.app already exists.
#   ALBUM_STUDIO_NODE_RUNTIME  folder of another official Node.js build (node-vXX-darwin-arm64,
#                              as unpacked from nodejs.org) to bundle instead; "none" bundles
#                              nothing and the app uses the Node.js installed on the Mac.
#   ALBUM_STUDIO_SIGNIN_ENV    a sign-in settings file (Firebase project, Google OAuth client,
#                              licence key) to build into the app. By default none is: like the
#                              Electron app, each Mac supplies its own .env (Album Studio's data
#                              folder, or the Album Toolkit's), and the app reads it from there.
#   MACOS_SIGN_IDENTITY        codesign identity; default "-" (ad-hoc, for this Mac). A Developer
#                              ID identity alone does not prove hardened/notarised distribution;
#                              the full release procedure and clean-Mac install must be verified.
#
# Layout (see apps/album-studio/src/resources.rs, which finds these at run time):
#   Contents/MacOS/album-studio                 the app (window, editor, web interface)
#   Contents/Resources/ui/                      the interface
#   Contents/Resources/app/native/backend/      the background helper
#   Contents/Resources/app/src/, node_modules/  the shared modules it uses, and packages
#   Contents/Resources/bin/photocraft-cli       the PhotoCraft engine for sheets
#   Contents/Resources/bin/album-studio-rename-exclusive  atomic no-replace file capture
#   Contents/Resources/node/bin/node            Node.js (unless ALBUM_STUDIO_NODE_RUNTIME=none)
#   Contents/Resources/NOTICE, licenses/        open-source notices and licence texts

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NATIVE="$ROOT/native"
OUT="$NATIVE/dist"
FINAL_APP="${ALBUM_STUDIO_PACKAGE_PATH:-$OUT/Album Studio.app}"
FINAL_APP=$(node -e 'console.log(require("path").resolve(process.argv[1]))' "$FINAL_APP")
if [ -e "$FINAL_APP" ] || [ -L "$FINAL_APP" ]; then
  print "Existing bundle preserved: $FINAL_APP" >&2
  print "Set ALBUM_STUDIO_PACKAGE_PATH to a new .app path before building." >&2
  exit 1
fi
mkdir -p "$(dirname "$FINAL_APP")"
STAGE=$(mktemp -d "$(dirname "$FINAL_APP")/.album-studio-stage.XXXXXX")
APP="$STAGE/$(basename "$FINAL_APP")"
RES="$APP/Contents/Resources"
# A failed build stays reviewable in staging. Nothing deletes a previous customer app.
trap 'result_code=$?; if [ "$result_code" -ne 0 ]; then print "Build failed; staging preserved at $STAGE" >&2; fi' EXIT
IDENTITY="${MACOS_SIGN_IDENTITY:--}"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/Library/Caches/AlbumStudioBuild/target}"
export MACOSX_DEPLOYMENT_TARGET=13.0
VERSION=$(node -p "require('$NATIVE/ui/package.json').version")
NODE_VERSION=22.23.3
NODE_SHA256=23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53  # node-v22.23.3-darwin-arm64.tar.gz
SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)

step() { print -P "%F{blue}▸%f $1" }

step "Shell and engine (release build)"
node "$NATIVE/scripts/engine.mjs" build --target-dir "$CARGO_TARGET_DIR"

step "Interface"
(cd "$NATIVE/ui" && node build.mjs >/dev/null)

step "Bundle"
mkdir -p "$APP/Contents/MacOS" "$RES/bin" "$RES/ui/dist" "$RES/app" "$RES/licenses"
cp "$CARGO_TARGET_DIR/release/album-studio" "$APP/Contents/MacOS/album-studio"
cp "$CARGO_TARGET_DIR/release/photocraft-cli" "$RES/bin/photocraft-cli"
cp "$CARGO_TARGET_DIR/release/album-studio-rename-exclusive" "$RES/bin/album-studio-rename-exclusive"
cp "$NATIVE/ui/index.html" "$RES/ui/"
cp "$NATIVE/ui/dist/app.js" "$NATIVE/ui/dist/app.css" "$RES/ui/dist/"
cp "$NATIVE/scripts/engine/pin.json" "$RES/engine-pin.json"
[ -f "$NATIVE/ui/dist/app.js.LEGAL.txt" ] && cp "$NATIVE/ui/dist/app.js.LEGAL.txt" "$RES/licenses/interface-bundled-code.txt"

# The helper, the shared modules it uses and its packages (see collect-backend.mjs).
COLLECT=$(node "$NATIVE/scripts/collect-backend.mjs")
for f in $(print -r -- "$COLLECT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).files.join('\n')))"); do
  mkdir -p "$RES/app/$(dirname "$f")"
  cp "$ROOT/$f" "$RES/app/$f"
done
for p in $(print -r -- "$COLLECT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).packages.join('\n')))"); do
  mkdir -p "$RES/app/node_modules/$(dirname "$p")"
  rsync -a --exclude '*.md' --exclude '*.map' --exclude 'test' --exclude 'tests' --exclude '.github' "$ROOT/node_modules/$p/" "$RES/app/node_modules/$p/"
  for l in LICENSE LICENSE.md LICENSE.txt license COPYING; do
    if [ -f "$ROOT/node_modules/$p/$l" ]; then cp "$ROOT/node_modules/$p/$l" "$RES/licenses/npm-${p//\//-}-LICENSE.txt"; break; fi
  done
done

# Sign-in settings, only when asked for (only the keys the helper reads; see
# native/backend/lib/account.js).
SIGNIN_ENV="${ALBUM_STUDIO_SIGNIN_ENV:-}"
if [ -n "$SIGNIN_ENV" ] && [ -f "$SIGNIN_ENV" ]; then
  grep -E '^(FIREBASE_API_KEY|FIREBASE_PROJECT_ID|GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|LICENSE_SECRET_KEY)=' "$SIGNIN_ENV" > "$RES/app/.env" || true
  chmod 600 "$RES/app/.env"
  print "  Sign-in settings built in ($(wc -l < "$RES/app/.env" | tr -d ' ') keys)"
else
  print "  (No sign-in settings built in: the app reads this Mac's .env)"
fi

# Node.js: the pinned official build (fetched and checked once), or the one given.
NODE_RUNTIME="${ALBUM_STUDIO_NODE_RUNTIME:-}"
if [ -z "$NODE_RUNTIME" ]; then
  NODE_RUNTIME="$HOME/Library/Caches/AlbumStudioBuild/node-v$NODE_VERSION-darwin-arm64"
  if [ ! -x "$NODE_RUNTIME/bin/node" ]; then
    step "Node.js $NODE_VERSION (download from nodejs.org, once)"
    TMP=$(mktemp -d)
    curl -fsSL -o "$TMP/node.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz"
    print -r -- "$NODE_SHA256  $TMP/node.tar.gz" | shasum -a 256 -c - >/dev/null || { print "Node.js download does not match its pinned SHA-256" >&2; exit 1 }
    tar -xzf "$TMP/node.tar.gz" -C "$(dirname "$NODE_RUNTIME")"
    rm -rf "$TMP"
  fi
fi
if [ "$NODE_RUNTIME" != "none" ]; then
  mkdir -p "$RES/node/bin"
  cp "$NODE_RUNTIME/bin/node" "$RES/node/bin/node"
  cp "$NODE_RUNTIME/LICENSE" "$RES/licenses/nodejs-LICENSE.txt"
  print "  Node.js $("$RES/node/bin/node" --version) bundled"
else
  print "  (Node.js not bundled: the app will use the one installed on this Mac)"
fi

# Notices and licence texts.
cp "$NATIVE/NOTICE" "$RES/NOTICE"
cp "$NATIVE/photocraft/NOTICE" "$RES/licenses/photocraft-NOTICE"
cp "$NATIVE/photocraft/LICENSE-MIT" "$RES/licenses/photocraft-LICENSE-MIT"
cp "$NATIVE/photocraft/LICENSE-APACHE" "$RES/licenses/photocraft-LICENSE-APACHE"
cp "$NATIVE/photocraft/assets/fonts/"OFL-*.txt "$RES/licenses/" 2>/dev/null || true
cp "$NATIVE/photocraft/assets/icons/LICENSE-lucide.txt" "$RES/licenses/photocraft-icons-LICENSE-lucide.txt" 2>/dev/null || true
for p in preact @preact/signals lucide-preact; do
  [ -f "$NATIVE/ui/node_modules/$p/LICENSE" ] && cp "$NATIVE/ui/node_modules/$p/LICENSE" "$RES/licenses/npm-${p//\//-}-LICENSE.txt"
done
(cd "$NATIVE/photocraft" && cargo metadata --format-version 1 --locked --features heif 2>/dev/null) | node -e "
let s=''; process.stdin.on('data', d => s += d).on('end', () => {
  const m = JSON.parse(s); const rows = m.packages.filter(p => p.source).map(p => p.name + ' ' + p.version + ' — ' + (p.license || 'see the crate'))
  console.log('Rust crates in Album Studio and the PhotoCraft engine, with their licences:\n\n' + [...new Set(rows)].sort().join('\n'))
})" > "$RES/licenses/rust-crates.txt"

# Icon and Info.plist.
cp "$ROOT/assets/icon.icns" "$RES/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Album Studio</string>
  <key>CFBundleName</key><string>Album Studio</string>
  <key>CFBundleExecutable</key><string>album-studio</string>
  <key>CFBundleIdentifier</key><string>com.creativehubb.albumstudio</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>AlbumStudioBuildCommit</key><string>$SHA</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.photography</string>
  <key>LSMinimumSystemVersion</key><string>$MACOSX_DEPLOYMENT_TARGET</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSRequiresAquaSystemAppearance</key><false/>
  <key>NSHumanReadableCopyright</key><string>Copyright © 2026 Creative Hubb. Includes open-source software: see About and NOTICE.</string>
</dict>
</plist>
PLIST

step "Sign ($([ "$IDENTITY" = "-" ] && echo "ad-hoc, for this Mac" || echo "$IDENTITY"))"
# Inside out: native modules and helpers first, the app last.
find "$RES" -type f \( -name '*.node' -o -name '*.dylib' \) -print0 | xargs -0 -I{} codesign --force --sign "$IDENTITY" {} 2>/dev/null
codesign --force --sign "$IDENTITY" "$RES/bin/photocraft-cli"
codesign --force --sign "$IDENTITY" "$RES/bin/album-studio-rename-exclusive"
# Node.js keeps the Node.js Foundation's own signature on an ad-hoc build; with a real identity it
# is signed again with the hardened runtime and the entitlements Node needs (JIT, native modules).
if [ -f "$RES/node/bin/node" ] && [ "$IDENTITY" != "-" ]; then
  codesign --force --options runtime --entitlements "$NATIVE/scripts/node.entitlements" --sign "$IDENTITY" "$RES/node/bin/node"
fi
codesign --force --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=1 "$APP" 2>&1 | tail -1

step "Publish completed bundle"
node "$NATIVE/scripts/publish-new-directory.mjs" "$APP" "$FINAL_APP"
rmdir "$STAGE"
step "Done: $FINAL_APP ($(du -sh "$FINAL_APP" | cut -f1))"
