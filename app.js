const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

// ── .env loader ────────────────────────────────────────────
// Loads credentials (Google OAuth, Firebase API key, license secret) into
// process.env BEFORE any code below reads them. Dependency-free parser so it
// works on every Node version and in packaged builds. Looks for .env next to
// app.js first, then in the user-data folder (so a packaged app can ship
// without secrets and the user drops a .env beside it). Missing file = no-op.
function loadDotEnv() {
  const candidates = [
    path.join(__dirname, '.env'),
  ]
  // In a packaged build __dirname is inside the asar; also check userData.
  try { candidates.push(path.join(app.getPath('userData'), '.env')) } catch (_) {}
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue
      const text = fs.readFileSync(file, 'utf8')
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq === -1) continue
        const key = line.slice(0, eq).trim()
        let val = line.slice(eq + 1).trim()
        // Strip surrounding quotes if present.
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1)
        }
        // Don't clobber a value already set in the real environment.
        if (key && process.env[key] === undefined) process.env[key] = val
      }
    } catch (_) { /* unreadable .env is non-fatal */ }
  }
}
loadDotEnv()

// Every JSX call goes through the PhotoshopBridge (src/bridge): macOS
// osascript impl, or a recording mock in E2E runs.
const bridge = require('./src/bridge').getBridge()
const telemetry = require('./src/telemetry')
const plugins = require('./src/plugins')

// Initialise telemetry early — sets up rotating log files and a JSONL
// metrics stream under app.getPath('userData'). Failures are swallowed so a
// crashed log subsystem never blocks app boot.
try { telemetry.init() } catch (_) {}

// Discover plugins (built-ins + user-supplied) at startup so the renderer
// can ask listPlugins() without paying a lazy-load cost. Plugin failures
// log themselves; init never throws.
try { plugins.init() } catch (_) {}

// Hot-reload in dev only. Silently skipped if electron-reloader is not installed
// or if running from an asar bundle.
try {
  if (!app.isPackaged) require('electron-reloader')(module, {
    ignore: ['scripts/**', 'dist/**', 'assets/**']
  })
} catch (_) {}

app.disableHardwareAcceleration()

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('ch-auth', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('ch-auth')
}

// ── Session + windows ──────────────────────────────────────
// Who is signed in and which top-level windows exist (src/main/session.js).
const session = require('./src/main/session')

// Isolated profile for tests/benches (guarded like the E2E bypass): keeps
// parallel runs from fighting the developer's live profile over the DOM-
// storage LevelDB lock — a second instance sharing the profile stalls the
// renderer ~3.7s on its first synchronous localStorage read.
if (process.env.ALBUMSTUDIO_USER_DATA && !app.isPackaged) {
  app.setPath('userData', process.env.ALBUMSTUDIO_USER_DATA)
}

// Single instance per profile: a second launch focuses the running app
// instead of silently sharing (and fighting over) the same profile.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => session.focusExisting())
}

// ── IPC registrars (Phase: app.js split) ───────────────────
// Each src/main/* module owns one domain's ipcMain.handle registrations;
// this file is a composition root that wires them, exactly like the
// renderer's src/main.js. Registration order is irrelevant — everything is
// registered before app.whenReady resolves.
const { registerAuthHandlers } = require('./src/main/auth_flow')
const { verifyLicense, registerLicenseHandlers } = require('./src/main/license_flow')
const { registerFileHandlers } = require('./src/main/file_handlers')
const { registerPsPlaceHandlers } = require('./src/main/ps_place_handlers')
const { registerPsJobsHandlers } = require('./src/main/ps_jobs_handlers')
const { registerProofHandlers } = require('./src/main/proof_handlers')
const { registerGalleryExportHandler } = require('./src/main/gallery_export')
const { registerServiceHandlers } = require('./src/main/service_handlers')
const { registerAuxWindowHandlers } = require('./src/main/aux_windows')

registerAuthHandlers()
registerLicenseHandlers()
registerFileHandlers()
registerPsPlaceHandlers()
registerPsJobsHandlers()
registerProofHandlers()
registerGalleryExportHandler()
registerServiceHandlers()
registerAuxWindowHandlers()

// ── APP READY ─────────────────────────────────────────────
app.whenReady().then(async () => {
  // ── E2E test-mode (guarded) ──────────────────────────────────────────────
  // When launched by the Playwright harness, skip Google sign-in + the license
  // check and open the workspace directly with a stub license, so end-to-end
  // tests can drive real flows without real auth or a valid license file.
  //
  // Double-guarded so it can NEVER activate in a shipped app: it requires both
  // the ALBUMSTUDIO_E2E env flag (only set by the test runner) AND a non-packaged
  // build (app.isPackaged is true in any distributed DMG). The env flag alone is
  // inert in a real build.
  // Companion flag: force the login screen regardless of any saved license, so
  // the login-path E2E is deterministic on any machine (incl. a licensed dev box).
  // Checked BEFORE the bypass so a login-path test can share the same launcher
  // (which always sets ALBUMSTUDIO_E2E for the isolated profile) and still land
  // on login — the explicit login flag is the more specific intent.
  if (process.env.ALBUMSTUDIO_E2E_LOGIN === '1' && !app.isPackaged) {
    session.createLoginWindow()
    return
  }
  if (process.env.ALBUMSTUDIO_E2E === '1' && !app.isPackaged) {
    session.setLicense({ allowed: true, daysLeft: 999, email: 'e2e@test.local', offline: true })
    session.setUser({ email: 'e2e@test.local' })
    session.createMainWindow(session.getLicense())
    return
  }

  // Resolve Photoshop name once at startup so the first IPC call is fast.
  // Wrapped because running on a machine without Photoshop should not crash boot.
  try { bridge.getPhotoshopAppName() } catch (_) {}

  const { loadLicense } = require('./src/license')

  try {
    // 1. Is there a saved license at all? If not, go straight to login.
    const localLicense = loadLicense()

    if (localLicense && localLicense.email && localLicense.expiresOn) {
      // 2. Re-verify the SAME way the login screen does: online-first, with an
      //    offline fallback only when the network is genuinely unreachable.
      //    This is what makes deactivation / expiry take effect on the next
      //    launch instead of the app blindly trusting the stale local file.
      const result = await verifyLicense(localLicense.email)
      if (result.allowed) {
        session.setLicense({
          allowed: true,
          daysLeft: result.daysLeft,
          email: localLicense.email,
          offline: !!result.offline
        })
        session.setUser({ email: localLicense.email })
        session.createMainWindow(session.getLicense())
        return // Stop here! Do not open the login window.
      }
      // Not allowed (deactivated / expired / wrong machine): verifyLicense has
      // already cleared the local file where appropriate. Fall through to login.
    }
  } catch (e) {
    console.log('Silent boot license check failed:', e.message)
  }

  // 4. If no valid license was found, show the login screen normally
  session.createLoginWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) session.createLoginWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
