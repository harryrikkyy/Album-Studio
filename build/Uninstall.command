#!/bin/bash
# Uninstall.command — clean removal of Creative Hubb Album Toolkit Pro
#
# Removes the .app from /Applications AND resets every macOS TCC permission
# grant tied to this app's bundle ID (Accessibility, Apple Events
# automation, screen recording, etc.). Use this before installing a new
# DMG build so you don't accumulate stale TCC ghost entries from prior
# ad-hoc-signed installs.

set -u

APP_NAME="Creative Hubb Album Toolkit Pro"
APP_PATH="/Applications/${APP_NAME}.app"
BUNDLE_ID="com.creativehubb.albumtoolkit"
USER_DATA="$HOME/Library/Application Support/${APP_NAME}"
USER_LOGS="$HOME/Library/Logs/${APP_NAME}"

cd "$(dirname "$0")" || true

echo "──────────────────────────────────────────────────"
echo " Uninstall · ${APP_NAME}"
echo "──────────────────────────────────────────────────"
echo
echo "This will:"
echo "  • Quit the app if it's running"
echo "  • Move the app to the Trash"
echo "  • Reset macOS permissions (Accessibility, Automation, etc.)"
echo
read -r -p "Continue? [y/N] " REPLY
echo
case "$REPLY" in
  [yY]) ;;
  *) echo "Cancelled."; exit 0 ;;
esac

# 1) Try a graceful quit first, then force-kill stragglers.
echo "→ Quitting ${APP_NAME}..."
osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
sleep 1
pkill -f "${APP_NAME}" 2>/dev/null || true

# 2) Move the app to the Trash via Finder so it's recoverable.
if [ -d "${APP_PATH}" ]; then
  echo "→ Moving ${APP_PATH} to Trash..."
  osascript -e "tell application \"Finder\" to delete POSIX file \"${APP_PATH}\"" >/dev/null 2>&1 \
    || rm -rf "${APP_PATH}"
else
  echo "→ App not found at ${APP_PATH} (already removed?)"
fi

# 3) Reset every TCC permission tied to this bundle ID. tccutil's "All"
#    service covers Accessibility, AppleEvents, ScreenCapture, etc. in one
#    shot. Fall back to per-service resets on older macOS versions where
#    "All" isn't accepted.
echo "→ Resetting macOS permissions..."
if ! tccutil reset All "${BUNDLE_ID}" >/dev/null 2>&1; then
  tccutil reset Accessibility   "${BUNDLE_ID}" >/dev/null 2>&1 || true
  tccutil reset AppleEvents     "${BUNDLE_ID}" >/dev/null 2>&1 || true
  tccutil reset PostEvent       "${BUNDLE_ID}" >/dev/null 2>&1 || true
  tccutil reset ScreenCapture   "${BUNDLE_ID}" >/dev/null 2>&1 || true
  tccutil reset SystemPolicyAllFiles "${BUNDLE_ID}" >/dev/null 2>&1 || true
fi

# 4) Optionally remove user data and logs. Off by default so a reinstall
#    keeps your library, license, settings, and saved layouts. Uncomment
#    the two lines below for a fully clean wipe.
# rm -rf "${USER_DATA}"
# rm -rf "${USER_LOGS}"

echo
echo "✓ Done. ${APP_NAME} is uninstalled and its permissions are cleared."
echo "  You can now mount a fresh DMG and reinstall."
echo
echo "Press any key to close…"
read -r -n 1 -s
