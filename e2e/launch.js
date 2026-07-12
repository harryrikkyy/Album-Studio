// Shared launcher: guarded test-mode + an ISOLATED userData profile per run.
// Without the isolation, a test launch shares the developer's live profile —
// two instances then fight over the DOM-storage LevelDB lock and the app
// under test stalls seconds on its first localStorage read (and, with the
// single-instance lock, would refuse to start at all while the dev app runs).
const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

/** @param {Record<string, string>} [extraEnv] */
async function launchApp(extraEnv = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'albumstudio-profile-'))
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: {
      ...process.env,
      ALBUMSTUDIO_E2E: '1', // guarded bypass (dev build only)
      ALBUMSTUDIO_USER_DATA: userData,
      ...extraEnv,
    },
  })
  app.once('close', () => {
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch (_) {}
  })
  return app
}

module.exports = { launchApp }
