#!/bin/zsh
# package-mac.sh — build "Album Studio.app" in native/dist (Apple silicon).
#
#   native/scripts/package-mac.sh
#
# Optional:
#   ALBUM_STUDIO_NODE_RUNTIME  folder of an official Node.js build (node-vXX-darwin-arm64, as
#                              unpacked from nodejs.org) to bundle; without it the app uses the
#                              Node.js installed on the Mac (Homebrew or /usr/local).
#   MACOS_SIGN_IDENTITY        codesign identity; default "-" (ad-hoc, for this Mac).
#
# Layout (see apps/album-studio/src/resources.rs, which finds these at run time):
#   Contents/MacOS/album-studio                 the app (window, editor, web interface)
#   Contents/Resources/ui/                      the interface
#   Contents/Resources/app/native/backend/      the background helper
#   Contents/Resources/app/src/, node_modules/  the Electron app's modules it reuses, and packages
#   Contents/Resources/bin/photocraft-cli       the PhotoCraft engine for sheets
#   Contents/Resources/node/                    Node.js (when ALBUM_STUDIO_NODE_RUNTIME is given)
#   Contents/Resources/NOTICE, licenses/        open-source notices and licence texts

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
NATIVE="$ROOT/native"
OUT="$NATIVE/dist"
APP="$OUT/Album Studio.app"
RES="$APP/Contents/Resources"
IDENTITY="${MACOS_SIGN_IDENTITY:--}"
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/Library/Caches/AlbumStudioBuild/target}"
export MACOSX_DEPLOYMENT_TARGET=13.0
VERSION=$(node -p "require('$NATIVE/ui/package.json').version")
SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)

step() { print -P "%F{blue}▸%f $1" }

step "Shell and engine (release build)"
(cd "$NATIVE/photocraft" && cargo build --release --locked -p album-studio -p photocraft-cli)

step "Interface"
(cd "$NATIVE/ui" && node build.mjs >/dev/null)

step "Bundle"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES/bin" "$RES/ui/dist" "$RES/app" "$RES/licenses"
cp "$CARGO_TARGET_DIR/release/album-studio" "$APP/Contents/MacOS/album-studio"
cp "$CARGO_TARGET_DIR/release/photocraft-cli" "$RES/bin/photocraft-cli"
cp "$NATIVE/ui/index.html" "$RES/ui/"
cp "$NATIVE/ui/dist/app.js" "$NATIVE/ui/dist/app.css" "$RES/ui/dist/"
[ -f "$NATIVE/ui/dist/app.js.LEGAL.txt" ] && cp "$NATIVE/ui/dist/app.js.LEGAL.txt" "$RES/licenses/interface-bundled-code.txt"

# The helper, the Electron modules it reuses and its packages (see collect-backend.mjs).
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

# Node.js, when an official build is given.
if [ -n "${ALBUM_STUDIO_NODE_RUNTIME:-}" ]; then
  mkdir -p "$RES/node/bin"
  cp "$ALBUM_STUDIO_NODE_RUNTIME/bin/node" "$RES/node/bin/node"
  cp "$ALBUM_STUDIO_NODE_RUNTIME/LICENSE" "$RES/licenses/nodejs-LICENSE.txt"
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
(cd "$NATIVE/photocraft" && cargo metadata --format-version 1 --locked 2>/dev/null) | node -e "
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
[ -f "$RES/node/bin/node" ] && codesign --force --sign "$IDENTITY" "$RES/node/bin/node"
codesign --force --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=1 "$APP" 2>&1 | tail -1

step "Done: $APP ($(du -sh "$APP" | cut -f1))"
