const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')

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

const {
  executeJSX,
  executeJSXFile,
  writeJsonData,
  getPhotoshopAppName
} = require('./src/photoshop')
const jsxTemplates = require('./src/jsx/templates')
const proofRenderer = require('./src/proof_renderer')
const telemetry = require('./src/telemetry')
const curation = require('./src/curation')
const generativeTemplates = require('./src/generative_templates')
const plugins = require('./src/plugins')
const library = require('./src/library')
const toolsBar = require('./src/tools_bar')
const thumbnailer = require('./src/thumbnailer')
const renamer = require('./src/renamer')

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

// ── Firebase Admin via REST API ────────────────────────────
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'creative-hubb-toolkit'
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || ''
const FIRESTORE_BASE = `/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`

// Build a Firestore REST path. `mask` is the list of `updateMask.fieldPaths`
// values. Centralizing this kills the previously hardcoded API key duplication.
function firestorePath(suffix, mask = []) {
  const m = mask.length ? '&' + mask.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&') : ''
  return `${FIRESTORE_BASE}${suffix}?key=${FIREBASE_API_KEY}${m}`
}

// R3: derive the Firestore document id from an email in ONE place. Previously
// the `email.replace(/\./g, '_')` transform was copy-pasted in three spots,
// so any future change risked them drifting apart and looking up different
// docs for the same user. NOTE: this transform must stay byte-for-byte in sync
// with the owner's external activation tool — do not change it without also
// migrating existing Firestore docs (e.g. a@b.c and a_b_c would collide, but
// changing the scheme would orphan every already-activated account).
function emailToUserKey(email) {
  return String(email || '').replace(/\./g, '_')
}

// ⚡ Task 5.1: safe JSON parse for HTTPS response bodies. An unguarded
// JSON.parse inside a response.on('end') callback throws synchronously inside
// the event emitter — a non-JSON 500 page or a truncated body would crash the
// MAIN process (taking the whole app down). This returns a fallback instead.
function safeJsonParse(str, fallback = null) {
  try { return JSON.parse(str) } catch (_) { return fallback }
}

let mainWindow = null
let loginWindow = null
let currentUser = null
let currentLicense = null

// ── CREATE LOGIN WINDOW ────────────────────────────────────
function createLoginWindow() {
  // Singleton: never stack two login windows (the switch-account race).
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    return loginWindow
  }
  loginWindow = new BrowserWindow({
    width: 520,
    height: 620,
    resizable: false,
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'Creative Hubb Album Toolkit Pro',
    icon: path.join(__dirname, 'assets/icon.icns')
  })
  loginWindow.loadFile(path.join(__dirname, 'src/login.html'))
  loginWindow.on('closed', () => { loginWindow = null })
  return loginWindow
}

// ── CREATE MAIN APP WINDOW ─────────────────────────────────
function createMainWindow(licenseInfo = {}) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      additionalArguments: [`--license=${JSON.stringify(licenseInfo)}`]
    },
    title: 'Creative Hubb Album Toolkit Pro',
    icon: path.join(__dirname, 'assets/icon.icns')
  })
  mainWindow.loadFile(path.join(__dirname, 'src/index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

// ── GOOGLE SIGN IN ─────────────────────────────────────────
// ── GOOGLE SIGN IN ─────────────────────────────────────────
// Singleton guard: only ONE auth flow (window + local callback server on
// port 9842) may exist at a time. Without this, a second sign-in click opens
// a duplicate window AND fails to bind port 9842, leaving an orphaned,
// uncloseable window that can never receive its callback.
let _authWindow = null
let _authServer = null
function _teardownAuthFlow() {
  try { if (_authServer) _authServer.close() } catch (_) {}
  _authServer = null
  try { if (_authWindow && !_authWindow.isDestroyed()) _authWindow.close() } catch (_) {}
  _authWindow = null
}

ipcMain.handle('google-sign-in', async () => {
  return new Promise((resolve) => {
    const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
    const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
    const PORT = 9842
    const REDIRECT_URI = `http://127.0.0.1:${PORT}`

    // Guard: without credentials, opening a Google window just yields the
    // opaque "Missing required parameter: client_id" error. Fail fast with a
    // message that points at the real fix instead.
    if (!CLIENT_ID || !CLIENT_SECRET) {
      resolve({ error: 'Sign-in is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to a .env file in the app folder, then restart.' })
      return
    }

    // Singleton: if a sign-in window is already open, focus it instead of
    // spawning a second window + a second (doomed) server bind.
    if (_authWindow && !_authWindow.isDestroyed()) {
      _authWindow.focus()
      resolve({ error: 'A sign-in window is already open.' })
      return
    }
    // Clear any stale server from a previous aborted attempt.
    _teardownAuthFlow()

    let resolved = false
    let authWindow = null
    let authTimeout = null

    const safeResolve = (val) => {
      if (resolved) return
      resolved = true
      if (authTimeout) { try { clearTimeout(authTimeout) } catch (_) {} authTimeout = null }
      resolve(val)
    }

    const http = require('http')
    const renderPage = (res, title, color, sub) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<html><body style="background:#0a0a0a;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
        <div style="text-align:center">
          <h2 style="color:${color}">${title}</h2>
          <p style="color:#888;margin-top:8px">${sub}</p>
        </div></body></html>`)
    }
    let server = http.createServer(async (req, res) => {
      // Ignore favicon and other stray requests the browser makes.
      const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`)
      const code = urlObj.searchParams.get('code')
      const oauthError = urlObj.searchParams.get('error') // e.g. access_denied

      if (oauthError) {
        renderPage(res, '✕ Sign-in cancelled', '#e31c1c', 'You can close this window.')
        _teardownAuthFlow()
        safeResolve({ error: 'Sign in cancelled' })
        return
      }
      if (!code) {
        renderPage(res, '✕ Sign-in failed', '#e31c1c', 'No authorization code received. Close this window and try again.')
        _teardownAuthFlow()
        safeResolve({ error: 'No authorization code received. Please try again.' })
        return
      }

      // M7: do the token exchange BEFORE claiming success. Only render the
      // success page if the exchange + profile fetch actually worked.
      let outcome
      try {
        outcome = await handleOAuthRedirect(code, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
      } catch (e) {
        outcome = { error: e.message || 'Sign-in failed' }
      }

      if (outcome && outcome.email) {
        renderPage(res, '✓ Signed in successfully', '#22c55e', 'Return to Creative Hubb Album Toolkit Pro.')
      } else {
        renderPage(res, '✕ Sign-in failed', '#e31c1c', (outcome && outcome.error) || 'Please try again.')
      }
      _teardownAuthFlow()
      safeResolve(outcome || { error: 'Sign-in failed' })
    })
    _authServer = server

    server.on('error', (e) => {
      // EADDRINUSE = a previous flow's server is still bound. Reset and tell
      // the user to retry rather than leaving a dead window around.
      _teardownAuthFlow()
      const msg = e.code === 'EADDRINUSE'
        ? 'Another sign-in attempt is still finishing. Please wait a moment and try again.'
        : 'Server error: ' + e.message
      safeResolve({ error: msg })
    })

    server.listen(PORT, '127.0.0.1', () => {
      console.log('Auth server listening on port', PORT)
    })

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${CLIENT_ID}&` +
      `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
      `response_type=code&` +
      `scope=${encodeURIComponent('email profile')}&` +
      `prompt=select_account`

    authWindow = new BrowserWindow({
      width: 500,
      height: 650,
      show: true,
      // A real title-bar frame guarantees the user can always close the
      // window manually, even if the OAuth flow wedges.
      frame: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
      title: 'Sign in with Google'
    })
    _authWindow = authWindow

    // Google's "use a different account" / account-chooser sometimes triggers
    // a popup (window.open), which Electron would spawn as a SEPARATE OS
    // window — the user's "two sign-in windows, can't close one" bug. Force
    // any such popup to navigate IN-PLACE within this same auth window.
    authWindow.webContents.setWindowOpenHandler(({ url }) => {
      try { if (authWindow && !authWindow.isDestroyed()) authWindow.loadURL(url) } catch (_) {}
      return { action: 'deny' }
    })

    authWindow.loadURL(authUrl)

    // M3: safety timeout. If the user opens Google and walks away, don't leave
    // the server listening and the button spinning forever — reset after 2 min.
    authTimeout = setTimeout(() => {
      _teardownAuthFlow()
      safeResolve({ error: 'Sign-in timed out. Please try again.' })
    }, 120000)

    authWindow.on('closed', () => {
      // Clear our module refs (the window is gone) and shut the server.
      if (_authWindow === authWindow) _authWindow = null
      try { server.close() } catch (e) {}
      if (_authServer === server) _authServer = null
      // If the flow hadn't already resolved (success/error), the user closed
      // the window manually → genuine cancellation. Resolve immediately; the
      // old 3s delay just made the window feel unresponsive.
      safeResolve({ error: 'Sign in cancelled' })
    })
  })
})

async function handleOAuthRedirect(code, clientId, clientSecret, redirectUri) {
  const https = require('https')
  const querystring = require('querystring')
  const postData = querystring.stringify({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  })

  const tokenRes = await new Promise((res) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': postData.length
      }
    }, (response) => {
      let data = ''
      response.on('data', chunk => data += chunk)
      response.on('end', () => res(safeJsonParse(data, {})))
    })
    req.write(postData)
    req.end()
  })

  if (!tokenRes.access_token) {
    return { error: 'Could not complete sign-in with Google (token exchange failed). Please try again.' }
  }

  const userInfo = await new Promise((res) => {
    https.get(
      `https://www.googleapis.com/oauth2/v2/userinfo?access_token=${tokenRes.access_token}`,
      (response) => {
        let data = ''
        response.on('data', chunk => data += chunk)
        response.on('end', () => res(safeJsonParse(data, {})))
      }
    )
  })

  if (!userInfo.email) { return { error: 'Could not read your Google profile. Please try again.' } }

  // ── Upsert the user doc WITHOUT ever resetting `activated`. ──────────
  // C3: the previous code sent `activated:false` on every login and relied
  // solely on the updateMask to protect it — one wrong mask would have
  // deactivated every returning user. We now check whether the doc exists
  // first; `activated:false` is only sent when CREATING a brand-new doc.
  const userKey = emailToUserKey(userInfo.email)

  let docExists = false
  try {
    const existing = await new Promise((res) => {
      https.get({ hostname: 'firestore.googleapis.com', path: firestorePath(`/users/${userKey}`) }, (r) => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(safeJsonParse(d, null)))
      }).on('error', () => res(null))
    })
    docExists = !!(existing && existing.fields)
  } catch (_) {}

  // Returning user: only touch login-time fields. New user: seed the doc
  // with activated:false so the owner can activate it later.
  const fields = {
    email: { stringValue: userInfo.email },
    name: { stringValue: userInfo.name || '' },
    photoURL: { stringValue: userInfo.picture || '' },
    lastLogin: { timestampValue: new Date().toISOString() }
  }
  const mask = ['email', 'name', 'photoURL', 'lastLogin']
  if (!docExists) {
    fields.activated = { booleanValue: false }
    mask.push('activated')
  }
  const userData = JSON.stringify({ fields })

  await new Promise((res) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: firestorePath(`/users/${userKey}`, mask),
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(userData) }
    }, (response) => {
      let data = ''
      response.on('data', chunk => data += chunk)
      response.on('end', () => res(safeJsonParse(data, {})))
    })
    req.write(userData)
    req.end()
  })

  currentUser = { email: userInfo.email, name: userInfo.name, photo: userInfo.picture }
  return { email: userInfo.email, name: userInfo.name }
}

// ── CHECK LICENSE ──────────────────────────────────────────
// Online-first license verification with an offline fallback. Extracted into a
// standalone function so BOTH the login screen (check-license IPC) and the boot
// auto-login path can run the exact same logic — boot must re-verify online so
// a deactivated/expired account doesn't keep opening from a stale local file.
async function verifyLicense(email) {
  const { machineId } = require('node-machine-id')
  const { saveLicense, getDaysRemaining, clearLicense, validateOfflineLicense } = require('./src/license')

  try {
    const currentMachineId = await machineId()

    // ── Try online check first ──────────────────────────
    try {
      const https = require('https')
      const userKey = emailToUserKey(email)

      const doc = await new Promise((resolve) => {
        https.get({ hostname: 'firestore.googleapis.com', path: firestorePath(`/users/${userKey}`) }, (res) => {
          let data = ''
          res.on('data', chunk => data += chunk)
          res.on('end', () => resolve(safeJsonParse(data, null)))
        }).on('error', () => resolve(null))
      })

      if (doc && doc.fields) {
        const activated = doc.fields.activated?.booleanValue
        if (!activated) {
          clearLicense()
          return { allowed: false, reason: 'not_activated' }
        }

        const expiresOn = doc.fields.expiresOn?.timestampValue
        if (!expiresOn) {
          clearLicense()
          return { allowed: false, reason: 'not_activated' }
        }

        const expiry = new Date(expiresOn)
        if (expiry <= new Date()) {
          clearLicense()
          return { allowed: false, reason: 'expired' }
        }

        // ── Check machine lock ──────────────────────────
        const registeredMachine = doc.fields.machineId?.stringValue

        // C1: if the license is already bound to a DIFFERENT machine, deny
        // here on the online path too (previously only the offline branch
        // enforced this, so the lock was effectively unenforced online).
        if (registeredMachine && registeredMachine !== currentMachineId) {
          clearLicense()
          return {
            allowed: false,
            reason: 'wrong_machine',
            registeredMachineName: doc.fields.machineName?.stringValue || ''
          }
        }

        if (!registeredMachine) {
          const updateData = JSON.stringify({
            fields: {
              ...doc.fields,
              machineId: { stringValue: currentMachineId },
              machineName: { stringValue: os.hostname() }
            }
          })
          await new Promise((res) => {
            const req = https.request({
              hostname: 'firestore.googleapis.com',
              path: firestorePath(`/users/${userKey}`, ['machineId', 'machineName']),
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(updateData) }
            }, (response) => {
              let data = ''
              response.on('data', chunk => data += chunk)
              response.on('end', () => res(safeJsonParse(data, {})))
            })
            req.write(updateData)
            req.end()
          })
        }

        const daysLeft = getDaysRemaining(expiresOn)

        // ── Save license locally ────────────────────────
        saveLicense({
          email,
          name: doc.fields.name?.stringValue || '',
          machineId: currentMachineId,
          expiresOn,
          activatedOn: doc.fields.activatedOn?.timestampValue || new Date().toISOString()
        })

        return { allowed: true, daysLeft, email }
      }

      // R5: the doc fetch succeeded but the user has no record yet (404 /
      // empty). That's "not activated", NOT "no internet". Only fall through
      // to the offline branch when the fetch itself failed (doc === null).
      if (doc !== null && !(doc && doc.fields)) {
        return { allowed: false, reason: 'not_activated' }
      }
    } catch(e) {
      console.log('Online check failed, trying offline...', e.message)
    }

    // ── Offline check (only reached when the online fetch errored) ──────
    // Shared validator keeps boot auto-login and this path in lockstep (R2).
    return validateOfflineLicense(currentMachineId, email)

  } catch(e) {
    return { allowed: false, reason: 'error', message: e.message }
  }
}

ipcMain.handle('check-license', (event, email) => verifyLicense(email))

// ── LAUNCH MAIN APP ────────────────────────────────────────
// R4: don't blindly trust the renderer's licenseInfo (it could be forged by
// a tampered renderer). check-license always persists a verified license on
// success, so re-validate against that saved file here before opening the app.
ipcMain.handle('launch-app', async (event, licenseInfo) => {
  try {
    const { machineId } = require('node-machine-id')
    const { validateOfflineLicense } = require('./src/license')
    const currentMachineId = await machineId()
    const verified = validateOfflineLicense(currentMachineId, licenseInfo && licenseInfo.email)
    if (!verified.allowed) {
      // No trustworthy saved license — refuse to launch.
      return { ok: false, reason: verified.reason }
    }
    currentLicense = {
      allowed: true,
      daysLeft: verified.daysLeft,
      email: verified.email,
      name: (licenseInfo && licenseInfo.name) || '',
      offline: !!licenseInfo && !!licenseInfo.offline
    }
    if (licenseInfo && licenseInfo.email) currentUser = { email: licenseInfo.email }
  } catch (e) {
    return { ok: false, reason: 'error', message: e.message }
  }

  createMainWindow(currentLicense)
  if (loginWindow) {
    loginWindow.close()
    loginWindow = null
  }
  return { ok: true }
})

ipcMain.handle('get-license', () => {
  return currentLicense
})

// ── SIGN OUT ───────────────────────────────────────────────
// Returns to the login screen. Guarded against the "two login windows" race:
// if a login window already exists (e.g. switch-account was clicked from the
// login screen itself), focus it instead of spawning another.
ipcMain.handle('sign-out', () => {
  currentUser = null
  currentLicense = null
  // The local license file is what drives boot auto-login. If we don't remove
  // it, the next `npm start` silently re-opens the app for the signed-out
  // account. Explicit sign-out must mean "show the login window next time".
  try { require('./src/license').clearLicense() } catch (_) {}
  // Tear down any in-flight auth flow so a stale window/server can't linger.
  try { _teardownAuthFlow() } catch (_) {}

  if (loginWindow && !loginWindow.isDestroyed()) {
    // Already on (or have) a login window — just focus it.
    loginWindow.focus()
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.close(); mainWindow = null }
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close()
    mainWindow = null
  }
  createLoginWindow()
})

// ── QUIT APP ───────────────────────────────────────────────
// R7: lets the frameless login window quit the app outright. Essential when
// sign-in is impossible (no internet on first run, or user just wants to exit).
ipcMain.handle('quit-app', () => {
  app.quit()
})

// ── SHELL OPEN EXTERNAL ────────────────────────────────────
ipcMain.handle('open-external', (event, url) => {
  shell.openExternal(url)
})

// ── FOLDER PICKER ─────────────────────────────────────────
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled) return null
  return result.filePaths[0]
})

// ── FILE SAVE/OPEN ────────────────────────────────────────
ipcMain.handle('pick-file-save', async (event, defaultName) => {
  const result = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled) return null
  return result.filePath
})

ipcMain.handle('pick-file-open', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

// ── PROJECT FOLDER ────────────────────────────────────────
// "Project as a folder" model: a project lives at a directory containing
// project.json, proofs/, exports/, .ch-state. Existing single-JSON projects
// still load through the legacy `pick-file-open` path (which the renderer
// auto-detects).
ipcMain.handle('project-pick-save', async (event, suggestedName) => {
  const result = await dialog.showSaveDialog({
    defaultPath: suggestedName || 'New Album Project',
    properties: ['createDirectory'],
    title: 'Save album project as folder',
    buttonLabel: 'Save Project'
  })
  if (result.canceled) return null
  return result.filePath
})

ipcMain.handle('project-pick-open', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Open album project folder'
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

ipcMain.handle('project-write', async (event, projectPath, payload) => {
  const fsx = require('fs')
  const px = require('path')
  fsx.mkdirSync(projectPath, { recursive: true })
  fsx.mkdirSync(px.join(projectPath, 'proofs'), { recursive: true })
  fsx.mkdirSync(px.join(projectPath, 'exports'), { recursive: true })
  fsx.writeFileSync(
    px.join(projectPath, 'project.json'),
    JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...payload }, null, 2)
  )
  return { ok: true, path: projectPath }
})

ipcMain.handle('project-read', async (event, pathInput) => {
  const fsx = require('fs')
  const px = require('path')
  let projectFile = pathInput
  // If user picked a directory, look inside for project.json. If they picked
  // a .json directly, load that as legacy single-file project.
  try {
    const stat = fsx.statSync(pathInput)
    if (stat.isDirectory()) {
      projectFile = px.join(pathInput, 'project.json')
    }
  } catch (_) {}

  if (!fsx.existsSync(projectFile)) {
    return { ok: false, error: 'project.json not found' }
  }
  const raw = fsx.readFileSync(projectFile, 'utf8')
  return { ok: true, data: JSON.parse(raw), projectPath: px.dirname(projectFile) }
})

// ── OPEN IN PHOTOSHOP ─────────────────────────────────────
ipcMain.handle('open-in-photoshop', async (event, filePath) => {
  return executeJSX(jsxTemplates.openInPhotoshop(filePath))
})

// ── RUN JSX ───────────────────────────────────────────────
ipcMain.handle('run-jsx', async (event, jsxCode) => {
  return executeJSX(jsxCode)
})

// ── PLACE WALLPAPER ───────────────────────────────────────
ipcMain.handle('place-wallpaper', async (event, filePath, isHr) => {
  return executeJSX(jsxTemplates.placeWallpaper(filePath, isHr))
})

// ── PLACE PNG FRAME ───────────────────────────────────────
ipcMain.handle('place-png-frame', async (event, filePath, layerName) => {
  return executeJSX(jsxTemplates.placePngFrame(filePath, layerName))
})

// ── PLACE MASKED FRAME ────────────────────────────────────
ipcMain.handle('place-masked-frame', async (event, filePath, layerName, isJpg) => {
  return executeJSX(jsxTemplates.placeMaskedFrame(filePath, layerName, isJpg))
})

// ── PLACE IMAGE CLIPPED (B1) ──────────────────────────────
// Places an image into the active Photoshop document and clips it to the
// currently selected layer (clipping mask). Used by the Source-panel
// right-click → "Place".
ipcMain.handle('place-clipped', async (event, filePath) => {
  return executeJSX(jsxTemplates.placeClipped(filePath))
})

// ── SWAP IMAGES ───────────────────────────────────────────
ipcMain.handle('swap-images', async () => {
  const jsxPath = path.join(__dirname, 'scripts', 'Swap_Clipped_Images.jsx')
  return executeJSXFile(jsxPath)
})

// ── EXPORT ALBUM ──────────────────────────────────────────
// Each of these previously wrote to a fixed /tmp/albumstudio_*.json which two
// concurrent invocations could stomp. We now write to a per-call randomized
// path and inject it into the JSX via __DATA_PATH__ substitution.
ipcMain.handle('export-album', async (event, exportData) => {
  const dataPath = writeJsonData(exportData)
  const jsxPath = path.join(__dirname, 'scripts', 'export_album.jsx')
  try {
    return await executeJSXFile(jsxPath, 600000, { DATA_PATH: dataPath })
  } finally {
    try { fs.unlinkSync(dataPath) } catch (_) {}
  }
})

// ── BUILD PAGE ────────────────────────────────────────────
ipcMain.handle('build-page', async (event, pageData) => {
  const dataPath = writeJsonData(pageData)
  const jsxPath = path.join(__dirname, 'scripts', 'build_page.jsx')
  try {
    return await executeJSXFile(jsxPath, 300000, { DATA_PATH: dataPath })
  } finally {
    try { fs.unlinkSync(dataPath) } catch (_) {}
  }
})

// ── EXTRACT TEMPLATE FRAMES ────────────────────────────────
// Opens a template PSD via the warm Photoshop bridge and dumps its frame
// layer geometry (toolkithframe* / toolkitvframe*) to a JSON file. Done once
// per template per session, then cached. Powers the fast composite renderer
// — once we have the frames, every subsequent proof render is pure libvips
// and never touches Photoshop again.
ipcMain.handle('extract-template-frames', async (event, templatePath) => {
  const dataPayload = writeJsonData({
    templatePath,
    outputPath: path.join(require('os').tmpdir(),
      `albumstudio_frames_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
  })
  const payload = JSON.parse(fs.readFileSync(dataPayload, 'utf8'))
  const jsxPath = path.join(__dirname, 'scripts', 'extract_frames.jsx')
  const t0 = Date.now()
  try {
    await executeJSXFile(jsxPath, 120000, { DATA_PATH: dataPayload })
    if (!fs.existsSync(payload.outputPath)) {
      return { ok: false, error: 'frame extraction produced no output' }
    }
    const result = JSON.parse(fs.readFileSync(payload.outputPath, 'utf8'))
    telemetry.event('frames_extracted', {
      template: path.basename(templatePath),
      frames: result.frames?.length || 0,
      durationMs: Date.now() - t0,
    })
    return result
  } catch (e) {
    telemetry.event('frames_extract_failed', { error: e.message })
    return { ok: false, error: e.message }
  } finally {
    try { fs.unlinkSync(dataPayload) } catch (_) {}
    try { fs.unlinkSync(payload.outputPath) } catch (_) {}
  }
})

// ── PROOF RENDER (FAST, NO PHOTOSHOP) ──────────────────────
// Renders one or more page composites via sharp/libvips. The renderer process
// stays free for UI work — sharp runs natively in the main process. Returns
// per-job results so the renderer can update Tab 7 cards as they complete.
ipcMain.handle('render-proof', async (event, job) => {
  const result = await proofRenderer.renderPageProof(job)
  telemetry.event('proof_render', {
    ok: result.ok,
    ms: result.ms,
    pages: 1,
    photos: job.photos?.length || 0,
  })
  return result
})

ipcMain.handle('render-proofs-batch', async (event, jobs) => {
  const t0 = Date.now()
  const results = await proofRenderer.renderProofBatch(jobs, (r, idx, total) => {
    // Stream progress to the renderer that requested the batch. Best-effort —
    // if the window is closed mid-render the send simply no-ops.
    try { event.sender.send('proof-progress', { idx, total, result: r }) } catch (_) {}
  })
  telemetry.event('proof_render_batch', {
    pages: jobs.length,
    durationMs: Date.now() - t0,
    failed: results.filter(r => !r.ok).length,
  })
  return results
})

// Final composite render — generative templates skip Photoshop entirely and
// produce a high-quality JPEG via libvips. Used by the renderer's queue worker
// when it sees a page whose template is a generative one (templatePath null
// or starts with 'gen_').
ipcMain.handle('render-final-composite', async (event, job) => {
  const result = await proofRenderer.renderFinalComposite(job)
  telemetry.event('final_composite', {
    ok: result.ok,
    ms: result.ms,
    photos: job.photos?.length || 0,
  })
  return result
})

// ── BAKE ADJUSTED SOURCE ───────────────────────────────────
// Applies the SAME non-destructive adjustments as the live preview to a
// full-resolution source and writes an adjusted copy. The Photoshop build
// then places this copy instead of the original, so the delivered PSD matches
// the on-screen preview pixel-for-pixel. EXIF orientation + ICC are preserved
// (withMetadata, no rotate/autoOrient here) so Photoshop treats the copy
// exactly like the original — colour ops are orientation-invariant.
ipcMain.handle('bake-adjusted-source', async (event, payload) => {
  const { srcPath, adjust, outDir } = payload || {}
  if (!srcPath || !adjust) return { ok: false, error: 'missing srcPath/adjust' }
  try {
    const { getSharp } = require('./src/sharp_config')
    const sharp = getSharp()
    fs.mkdirSync(outDir, { recursive: true })
    const base = path.basename(srcPath).replace(/\.[^.]+$/, '')
    const rand = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const out = path.join(outDir, `${base}_adj_${rand}.jpg`)
    let pipe = sharp(srcPath, { failOn: 'none' })
    pipe = proofRenderer.applyAdjust(sharp, pipe, adjust)
    await pipe
      .withMetadata() // keep orientation tag + ICC so PS places it identically
      .jpeg({ quality: 95, mozjpeg: true })
      .toFile(out)
    return { ok: true, path: out }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ── PROOF GALLERY EXPORT ───────────────────────────────────
// Generates a self-contained HTML gallery in `<projectPath>/proofs/gallery/`
// for client review. The gallery is a single index.html with vanilla JS:
//   - Swipeable / arrow-keyed page-by-page browsing
//   - Approve / Comment per page, persisted to feedback.json
//   - "Export feedback" button that downloads the JSON for the photographer
ipcMain.handle('export-proof-gallery', async (event, payload) => {
  // payload = { projectPath, pages: [{ pageNum, proofPath, label }], albumName }
  const galleryDir = path.join(payload.projectPath, 'proofs', 'gallery')
  fs.mkdirSync(galleryDir, { recursive: true })
  fs.mkdirSync(path.join(galleryDir, 'pages'), { recursive: true })

  // Copy each proof JPEG into the gallery so the folder is self-contained
  // and can be zipped or dropped onto Dropbox without dangling references.
  const manifest = []
  for (const p of payload.pages) {
    if (!fs.existsSync(p.proofPath)) continue
    const dest = path.join(galleryDir, 'pages', `page_${String(p.pageNum).padStart(3, '0')}.jpg`)
    fs.copyFileSync(p.proofPath, dest)
    manifest.push({
      pageNum: p.pageNum,
      label: p.label || `Page ${p.pageNum}`,
      file: `pages/page_${String(p.pageNum).padStart(3, '0')}.jpg`,
    })
  }

  const html = buildGalleryHtml(payload.albumName || 'Album Proof', manifest)
  fs.writeFileSync(path.join(galleryDir, 'index.html'), html)
  fs.writeFileSync(path.join(galleryDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  telemetry.event('proof_gallery_export', { pages: manifest.length })
  return { ok: true, path: galleryDir, pages: manifest.length }
})

function buildGalleryHtml(albumName, manifest) {
  // Inline page list keeps the gallery a single self-contained file with no
  // network dependencies — works offline and from a Dropbox shared link.
  const pageJson = JSON.stringify(manifest)
  const safeAlbum = String(albumName).replace(/</g, '&lt;')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${safeAlbum} — Proof</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0a0a0a; color: #f3f3f3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { position: sticky; top: 0; z-index: 10; padding: 14px 20px;
    background: rgba(10,10,10,0.85); backdrop-filter: blur(12px);
    border-bottom: 1px solid #222; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 16px; margin: 0; font-weight: 500; flex: 1; }
  header .meta { font-size: 13px; color: #888; }
  .stage { position: relative; padding: 24px; min-height: calc(100vh - 60px);
    display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .page-wrap { width: 100%; max-width: 1200px; aspect-ratio: 3/2;
    background: #181818; border-radius: 12px; overflow: hidden;
    box-shadow: 0 20px 60px rgba(0,0,0,0.5); position: relative; }
  .page-wrap img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    width: 100%; max-width: 1200px; }
  button, .btn { background: #1d1d1d; color: #f3f3f3; border: 1px solid #333;
    padding: 9px 16px; border-radius: 8px; cursor: pointer; font: inherit; }
  button:hover { background: #2a2a2a; }
  .btn-primary { background: #e31c1c; border-color: #e31c1c; }
  .btn-primary:hover { background: #c01818; }
  .approved { background: #1f6f3c !important; border-color: #1f6f3c !important; }
  textarea { flex: 1; min-width: 240px; min-height: 36px; padding: 8px 12px;
    background: #141414; color: #f3f3f3; border: 1px solid #333;
    border-radius: 8px; font: inherit; resize: vertical; }
  .pager { display: flex; align-items: center; gap: 8px; }
  .pager input { width: 60px; padding: 6px 8px; background: #141414;
    color: #f3f3f3; border: 1px solid #333; border-radius: 6px; text-align: center; }
  .nav-arrow { position: absolute; top: 50%; transform: translateY(-50%);
    width: 48px; height: 48px; border-radius: 50%; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; user-select: none; font-size: 22px; }
  .nav-arrow.prev { left: 14px; }
  .nav-arrow.next { right: 14px; }
  .nav-arrow:hover { background: rgba(0,0,0,0.85); }
  @media (max-width: 700px) {
    .page-wrap { aspect-ratio: 1.5/1; border-radius: 8px; }
    .nav-arrow { width: 40px; height: 40px; font-size: 18px; }
  }
</style>
</head>
<body>
<header>
  <h1>${safeAlbum}</h1>
  <span class="meta" id="meta"></span>
  <button class="btn-primary" id="exportBtn">Send Feedback</button>
</header>
<div class="stage">
  <div class="page-wrap">
    <img id="pageImg" alt="">
    <div class="nav-arrow prev" id="prev">‹</div>
    <div class="nav-arrow next" id="next">›</div>
  </div>
  <div class="controls">
    <div class="pager">
      <button id="firstBtn">⏮</button>
      <input id="pageInput" type="number" min="1">
      <span id="totalLbl"></span>
      <button id="lastBtn">⏭</button>
    </div>
    <button id="approveBtn">✓ Approve</button>
    <textarea id="commentBox" placeholder="Add a comment for this page (optional)"></textarea>
  </div>
</div>
<script>
const pages = ${pageJson};
const state = JSON.parse(localStorage.getItem('proofFeedback') || '{}'); // pageNum -> { approved, comment }
let idx = 0;

const img = document.getElementById('pageImg');
const meta = document.getElementById('meta');
const approveBtn = document.getElementById('approveBtn');
const commentBox = document.getElementById('commentBox');
const pageInput = document.getElementById('pageInput');
const totalLbl = document.getElementById('totalLbl');

totalLbl.textContent = '/ ' + pages.length;

function persist() {
  localStorage.setItem('proofFeedback', JSON.stringify(state));
}
function render() {
  const p = pages[idx];
  if (!p) return;
  img.src = p.file;
  img.alt = p.label;
  meta.textContent = p.label;
  pageInput.value = idx + 1;
  const fb = state[p.pageNum] || {};
  commentBox.value = fb.comment || '';
  approveBtn.classList.toggle('approved', !!fb.approved);
  approveBtn.textContent = fb.approved ? '✓ Approved' : '✓ Approve';
}
function go(n) { idx = Math.max(0, Math.min(pages.length - 1, n)); render(); }

document.getElementById('prev').onclick = () => go(idx - 1);
document.getElementById('next').onclick = () => go(idx + 1);
document.getElementById('firstBtn').onclick = () => go(0);
document.getElementById('lastBtn').onclick = () => go(pages.length - 1);
pageInput.onchange = () => go(parseInt(pageInput.value, 10) - 1);
approveBtn.onclick = () => {
  const p = pages[idx]; const fb = state[p.pageNum] || {};
  fb.approved = !fb.approved; state[p.pageNum] = fb; persist(); render();
};
commentBox.oninput = () => {
  const p = pages[idx]; const fb = state[p.pageNum] || {};
  fb.comment = commentBox.value; state[p.pageNum] = fb; persist();
};
document.getElementById('exportBtn').onclick = () => {
  const out = pages.map(p => ({
    pageNum: p.pageNum, label: p.label,
    approved: !!(state[p.pageNum] && state[p.pageNum].approved),
    comment: (state[p.pageNum] && state[p.pageNum].comment) || ''
  }));
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'feedback.json';
  document.body.appendChild(a); a.click(); a.remove();
};
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') go(idx - 1);
  else if (e.key === 'ArrowRight') go(idx + 1);
  else if (e.key === 'a' || e.key === 'A') approveBtn.click();
});
render();
</script>
</body>
</html>`
}

// ── TELEMETRY EVENT (FROM RENDERER) ────────────────────────
ipcMain.handle('telemetry-event', (event, name, fields) => {
  try { telemetry.event(name, fields || {}) } catch (_) {}
})

ipcMain.handle('telemetry-paths', () => {
  return {
    log: telemetry.logFilePath(),
    metrics: telemetry.metricsFilePath(),
  }
})

// ── CURATION ──────────────────────────────────────────────
// Photo curation engine. Heavy work happens in the main process so libvips
// can saturate cores; the renderer just drives the UI and shows results.
//
// Two-step protocol so the renderer can present settings and previews
// before committing:
//   1. `curation-analyze`  — read folder, compute features, return them.
//   2. `curation-curate`   — apply user-tuned thresholds to a feature set,
//                            return keepers + drops.
// Optional step 3:
//   3. `curation-export`   — copy keepers into <folder>/_Selected.
ipcMain.handle('curation-analyze', async (event, folderPath) => {
  const t0 = Date.now()
  try {
    const features = await curation.analyzeFolder(folderPath, (p) => {
      // Stream progress so 2,000-photo runs feel alive.
      try { event.sender.send('curation-progress', p) } catch (_) {}
    })
    telemetry.event('curation_analyze', {
      folder: path.basename(folderPath),
      photos: features.length,
      durationMs: Date.now() - t0,
    })
    return { ok: true, features }
  } catch (e) {
    telemetry.event('curation_analyze_failed', { error: e.message })
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('curation-curate', (event, features, options) => {
  try {
    const result = curation.curate(features, options || {})
    telemetry.event('curation_curate', {
      total: result.stats.total,
      kept: result.stats.kept,
      droppedBlur: result.stats.droppedBlur,
      droppedExposure: result.stats.droppedExposure,
      droppedDuplicates: result.stats.droppedDuplicates,
    })
    return { ok: true, ...result }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('curation-export', (event, keepers, folderPath) => {
  try {
    const result = curation.exportKeepers(keepers, folderPath)
    telemetry.event('curation_export', { copied: result.copied })
    return { ok: true, ...result }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ── GENERATIVE TEMPLATES ──────────────────────────────────
// Returns the default catalog of parameterized layouts. The renderer treats
// each entry as a virtual template — same shape as a PSD-backed entry, with
// an extra `generator` discriminator that flags it for the JS-only render
// pipeline.
ipcMain.handle('generative-catalog', () => {
  try {
    return { ok: true, templates: generativeTemplates.defaultCatalog() }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('generative-regen', (event, spec) => {
  try {
    const tpl = generativeTemplates.regen(spec)
    if (!tpl) return { ok: false, error: 'unknown generator' }
    return { ok: true, template: tpl }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

// ── PLUGINS ───────────────────────────────────────────────
// Inspect and toggle plugins. Built-in plugins ship inside the app bundle;
// user-supplied plugins live under app.getPath('userData')/plugins. The
// renderer never invokes plugin code directly — every dispatch goes through
// the main process so node-only modules (sharp, fs) keep working.
ipcMain.handle('plugins-list', () => {
  try { return { ok: true, plugins: plugins.listPlugins(), dir: plugins.pluginsDir() } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('plugins-set-enabled', (event, id, enabled) => {
  try { return plugins.setEnabled(id, enabled) }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('plugins-reload', () => {
  try {
    plugins.reload()
    return { ok: true, plugins: plugins.listPlugins() }
  } catch (e) { return { ok: false, error: e.message } }
})

// ── LIBRARY ───────────────────────────────────────────────
// Persistent per-user catalog of templates / wallpapers / pngs / masks /
// saved layouts. Pre-populates new projects so the photographer doesn't
// re-hunt for the same 20 templates every wedding.
ipcMain.handle('library-list', () => {
  try { return { ok: true, library: library.listLibrary(), dir: library.libraryDir() } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('library-add', (event, kind, setName, srcPaths) => {
  try { return library.addToLibrary(kind, setName, srcPaths) }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('library-remove', (event, kind, setName) => {
  try { return library.removeFromLibrary(kind, setName) }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('library-save-layout', (event, layoutName, layoutData) => {
  try { return library.saveLayout(layoutName, layoutData) }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('library-load-layout', (event, file) => {
  try { return library.loadLayout(file) }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('library-delete-layout', (event, file) => {
  try { return library.deleteLayout(file) }
  catch (e) { return { ok: false, error: e.message } }
})

// ── TOOLS BAR (FLOATING DOCK) ─────────────────────────────
// Thin frameless window that AppleScript-tracks Photoshop's window bounds
// and docks itself to the bottom edge. Lives in src/tools_bar.{html,js}.
ipcMain.handle('tools-bar-open', () => {
  try { toolsBar.openToolsBar(); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
})
ipcMain.handle('tools-bar-close', () => {
  try { toolsBar.closeToolsBar(); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
})
ipcMain.handle('tools-bar-status', () => {
  return { ok: true, open: toolsBar.isOpen() }
})

// Resize the bar's window vertically so the dropdown can render upward
// without being clipped by the frameless window's tight height. The bar
// renderer asks for extra space when opening the action search dropdown
// and releases it when the dropdown closes.
ipcMain.handle('tools-bar-set-height', (event, height) => {
  try { toolsBar.setBarHeight(height); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
})

// Toggle click-through for the bar's transparent (empty) areas. Renderer
// calls this on pointerenter / pointerleave of the visible chrome so the
// user can click Photoshop's canvas through the empty space the bar's
// window covers.
ipcMain.handle('tools-bar-set-interactive', (event, interactive) => {
  try { toolsBar.setInteractive(!!interactive); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
})

// ── RENAMER ───────────────────────────────────────────────
// Visual drag-and-drop workspace that renames a folder of album sheets to a
// print naming convention. Lives in src/renamer.{html,js} + the pure
// src/renamer_naming.js. See renamer-design.md.
ipcMain.handle('renamer-open', () => {
  try { renamer.openRenamerWindow(); return { ok: true } }
  catch (e) { return { ok: false, error: e.message } }
})

ipcMain.handle('renamer-status', () => {
  return { ok: true, open: renamer.isOpen() }
})

// ── SPREAD EDITOR ──────────────────────────────────────────
// A separate "mini Photoshop" window. The album state lives in the main
// renderer, so we relay: the main renderer pushes the current spread payload
// via `editor-open`; the editor pulls it with `editor-get-spread`; the editor
// pushes edits back via `editor-apply`, which we forward to the main window.
let _editorWin = null
let _editorSpread = null
ipcMain.handle('editor-open', (event, spreadPayload) => {
  _editorSpread = spreadPayload || null
  if (_editorWin && !_editorWin.isDestroyed()) {
    _editorWin.webContents.send('editor-spread-updated', _editorSpread)
    _editorWin.show(); _editorWin.focus()
    return { ok: true }
  }
  _editorWin = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'Spread Editor — Album Toolkit',
    backgroundColor: '#0b0c20',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  _editorWin.loadFile(path.join(__dirname, 'src/editor.html'))
  _editorWin.on('closed', () => { _editorWin = null })
  return { ok: true }
})

ipcMain.handle('editor-get-spread', () => _editorSpread)

// Editor → main renderer: persist placement/adjustment changes + refresh.
ipcMain.handle('editor-apply', (event, changes) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('editor-changes', changes)
  }
  return { ok: true }
})

// Editor → main renderer: swap two photos between frames on a page.
ipcMain.handle('editor-swap', (event, msg) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('editor-swap', msg)
  }
  return { ok: true }
})

// Editor → main renderer: navigate to another spread (main rebuilds + pushes
// the fresh payload back via editor-open → editor-spread-updated).
ipcMain.handle('editor-goto', (event, msg) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('editor-goto', msg)
  }
  return { ok: true }
})

// Folder picker scoped to the renamer (returns the chosen directory path).
ipcMain.handle('renamer-pick-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    title: 'Choose an order folder to rename',
  })
  if (result.canceled || !result.filePaths.length) return null
  return result.filePaths[0]
})

ipcMain.handle('renamer-list-images', async (event, folderPath) => {
  if (!folderPath || typeof folderPath !== 'string') {
    return { ok: false, error: 'no folder', images: [] }
  }
  try { return await renamer.listImages(folderPath) }
  catch (e) { return { ok: false, error: e.message, images: [] } }
})

// List immediate subdirectories of a folder (for the Renamer's folder
// navigator). Returns the parent path too so the UI can offer an "up" row.
ipcMain.handle('renamer-list-dir', (event, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string') return { ok: false, error: 'no path' }
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    const folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(dirPath, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    const parent = path.dirname(dirPath)
    return {
      ok: true,
      path: dirPath,
      name: path.basename(dirPath),
      parent: parent === dirPath ? null : parent,
      folders,
    }
  } catch (e) {
    return { ok: false, error: e.message }
  }
})

ipcMain.handle('renamer-apply-renames', async (event, payload) => {
  const folderPath = payload && payload.folderPath
  const ops = (payload && payload.ops) || []
  if (!folderPath) return { ok: false, error: 'no folder', renamed: 0 }
  try { return await renamer.applyRenames(folderPath, ops) }
  catch (e) { return { ok: false, error: e.message, renamed: 0 } }
})

// ── PHOTOSHOP ACTIONS ─────────────────────────────────────
// list-actions: enumerate every action set + action via JSX, cache for the
// session. Heavy first call (~500ms), instant on subsequent searches.
let _actionsCache = null
let _actionsCacheAt = 0
const ACTIONS_TTL_MS = 60_000 // 60s — long enough to keep filtering snappy,
                              // short enough that adding an action in PS shows up

ipcMain.handle('actions-list', async (event, opts) => {
  const force = opts && opts.force
  if (!force && _actionsCache && Date.now() - _actionsCacheAt < ACTIONS_TTL_MS) {
    return { ok: true, actions: _actionsCache, cached: true }
  }
  const outputPath = path.join(require('os').tmpdir(),
    `albumstudio_actions_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
  const dataPath = writeJsonData({ outputPath })
  const jsxPath = path.join(__dirname, 'scripts', 'list_actions.jsx')
  try {
    await executeJSXFile(jsxPath, 60_000, { DATA_PATH: dataPath })
    if (!fs.existsSync(outputPath)) {
      return { ok: false, error: 'list_actions produced no output' }
    }
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    if (result.ok) {
      _actionsCache = result.actions
      _actionsCacheAt = Date.now()
    }
    telemetry.event('actions_list', {
      ok: result.ok,
      count: (result.actions || []).length,
    })
    return result
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    try { fs.unlinkSync(dataPath) } catch (_) {}
    try { fs.unlinkSync(outputPath) } catch (_) {}
  }
})

// ── BATCH JPEG EXPORT ─────────────────────────────────────
// Walks a folder of PSDs, opens each in Photoshop ONCE, saves two JPEGs
// (quality 12 → JPEG-High-Res/, quality 1 → JPEG-Low-Res/). Both output
// folders are created as siblings of the source folder.
//
// Progress is polled from the JSX's own progress file rather than streamed
// over IPC because the JSX call blocks the Photoshop bridge until it
// returns — so we can't ipcMain.send mid-execution. Polling a small JSON
// file every 500 ms is the simplest workable channel.
ipcMain.handle('jpeg-export', async (event, sourceFolder) => {
  const t0 = Date.now()
  // Output folder layout: siblings of the source folder (NOT children),
  // matching the user's requested structure:
  //   parent/
  //   ├── <source folder>     (PSDs)
  //   ├── JPEG-High-Res/
  //   └── JPEG-Low-Res/
  const parent = path.dirname(sourceFolder)
  const hiResFolder = path.join(parent, 'JPEG-High-Res')
  const loResFolder = path.join(parent, 'JPEG-Low-Res')
  fs.mkdirSync(hiResFolder, { recursive: true })
  fs.mkdirSync(loResFolder, { recursive: true })

  const tmpDir = require('os').tmpdir()
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const outputPath   = path.join(tmpDir, `albumstudio_jpegexport_result_${tag}.json`)
  const progressPath = path.join(tmpDir, `albumstudio_jpegexport_progress_${tag}.json`)

  const dataPath = writeJsonData({
    sourceFolder, hiResFolder, loResFolder, outputPath, progressPath,
  })
  const jsxPath = path.join(__dirname, 'scripts', 'jpeg_export.jsx')

  // Poller — reads the progress file written by the JSX and forwards it
  // to whichever renderer kicked off the export. Best-effort: a missing or
  // partially-written file just means "no new info this tick".
  const poller = setInterval(() => {
    try {
      if (!fs.existsSync(progressPath)) return
      const raw = fs.readFileSync(progressPath, 'utf8')
      if (!raw) return
      const progress = JSON.parse(raw)
      try { event.sender.send('jpeg-export-progress', progress) } catch (_) {}
    } catch (_) { /* ignore parse races */ }
  }, 500)

  try {
    // Generous timeout — wedding albums of 200 pages with heavy PSDs can
    // take 10+ minutes. Cap at 1 hour.
    await executeJSXFile(jsxPath, 60 * 60 * 1000, { DATA_PATH: dataPath })
    if (!fs.existsSync(outputPath)) {
      return { ok: false, error: 'jpeg_export produced no output' }
    }
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    telemetry.event('jpeg_export', {
      total: result.total,
      processed: result.processed,
      failed: result.failed,
      durationMs: Date.now() - t0,
    })
    return {
      ok: true,
      ...result,
      hiResFolder,
      loResFolder,
      durationMs: Date.now() - t0,
    }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    clearInterval(poller)
    try { fs.unlinkSync(dataPath) } catch (_) {}
    try { fs.unlinkSync(outputPath) } catch (_) {}
    try { fs.unlinkSync(progressPath) } catch (_) {}
  }
})

// ── INJECT PHOTO (Tab 6 double-click) ─────────────────────
// Injects a photo into the active layer of the active Photoshop document via
// the JSX bridge (the UXP stub path never worked in this Electron build —
// app.activeDocument there is a fake that only knows about docs the app
// itself opened, which is why "open a PSD first" fired even with a doc open).
ipcMain.handle('inject-photo', async (event, payload) => {
  // payload = { filePath, layerName }
  const outputPath = path.join(require('os').tmpdir(),
    `albumstudio_inject_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
  const dataPath = writeJsonData({ ...payload, outputPath })
  const jsxPath = path.join(__dirname, 'scripts', 'inject_photo.jsx')
  try {
    await executeJSXFile(jsxPath, 120000, { DATA_PATH: dataPath })
    if (!fs.existsSync(outputPath)) {
      return { ok: false, error: 'inject produced no output' }
    }
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    telemetry.event('inject_photo', { ok: result.ok, reason: result.reason || null })
    return result
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    try { fs.unlinkSync(dataPath) } catch (_) {}
    try { fs.unlinkSync(outputPath) } catch (_) {}
  }
})

// ── EXPORT OPEN DOCS (TARGETED JPEG EXPORT) ───────────────
// Exports Photoshop documents that are currently OPEN — the targeted
// counterpart to the bulk folder export. After re-editing sheets, this
// updates just those JPEGs (in their JPEG-High-Res / JPEG-Low-Res siblings)
// without re-exporting the whole folder. Documents stay open and unmodified.
//   scope 'active' → only the frontmost document
//   scope 'all'    → every open document
ipcMain.handle('export-open-docs', async (event, scope) => {
  const t0 = Date.now()
  const outputPath = path.join(require('os').tmpdir(),
    `albumstudio_exportopen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
  const dataPath = writeJsonData({ outputPath, scope: scope === 'active' ? 'active' : 'all' })
  const jsxPath = path.join(__dirname, 'scripts', 'export_open_docs.jsx')
  try {
    await executeJSXFile(jsxPath, 30 * 60 * 1000, { DATA_PATH: dataPath })
    if (!fs.existsSync(outputPath)) {
      return { ok: false, error: 'export produced no output' }
    }
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    telemetry.event('export_open_docs', {
      scope: scope === 'active' ? 'active' : 'all',
      total: result.total || 0,
      processed: result.processed || 0,
      skipped: result.skipped || 0,
      failed: result.failed || 0,
      durationMs: Date.now() - t0,
    })
    return { ok: true, ...result, durationMs: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    try { fs.unlinkSync(dataPath) } catch (_) {}
    try { fs.unlinkSync(outputPath) } catch (_) {}
  }
})

ipcMain.handle('actions-run', async (event, payload) => {
  // payload = { setName, actionName }
  const outputPath = path.join(require('os').tmpdir(),
    `albumstudio_action_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
  const dataPath = writeJsonData({ ...payload, outputPath })
  const jsxPath = path.join(__dirname, 'scripts', 'run_action.jsx')
  const t0 = Date.now()
  try {
    await executeJSXFile(jsxPath, 600_000, { DATA_PATH: dataPath })
    if (!fs.existsSync(outputPath)) {
      return { ok: false, error: 'run_action produced no output' }
    }
    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
    telemetry.event('action_run', {
      ok: result.ok,
      durationMs: Date.now() - t0,
      set: payload.setName,
      action: payload.actionName,
    })
    return result
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    try { fs.unlinkSync(dataPath) } catch (_) {}
    try { fs.unlinkSync(outputPath) } catch (_) {}
  }
})

// ── BUILD PAGES BATCH ─────────────────────────────────────
// Warm-process render: opens the template ONCE, then duplicates / saves /
// closes for each page in the batch. Saves the per-page open-template cost
// when the render queue feeds N consecutive pages with the same template.
ipcMain.handle('build-pages-batch', async (event, batch) => {
  // batch = { templatePath, outputPath, pages: [{ pageName, photos }] }
  const dataPath = writeJsonData(batch)
  const jsxPath = path.join(__dirname, 'scripts', 'build_pages_batch.jsx')
  try {
    // Generous timeout: 30s per page, capped at 30 minutes.
    const ms = Math.min(30 * 60 * 1000, Math.max(60_000, batch.pages.length * 30_000))
    return await executeJSXFile(jsxPath, ms, { DATA_PATH: dataPath })
  } finally {
    try { fs.unlinkSync(dataPath) } catch (_) {}
  }
})

// ── BATCH THUMBNAILS (legacy: all through Photoshop) ──────
ipcMain.handle('batch-thumbnails', async (event, folderPath) => {
  const dataPath = writeJsonData({ folderPath })
  const jsxPath = path.join(__dirname, 'scripts', 'batch_thumbnails.jsx')
  try {
    return await executeJSXFile(jsxPath, 600000, { DATA_PATH: dataPath })
  } finally {
    try { fs.unlinkSync(dataPath) } catch (_) {}
  }
})

// ── BATCH THUMBNAILS (fast hybrid) ────────────────────────
// Two lanes:
//   1. sharp/libvips lane — every JPEG/PNG/TIFF/HEIC, in parallel, in this
//      process, off the Photoshop bridge. The 50–100× speedup.
//   2. Photoshop lane — ONLY the RAW files that genuinely need Camera Raw.
// Progress for both lanes streams to the renderer via 'thumbs-progress'.
ipcMain.handle('thumbnails-generate', async (event, folderPath) => {
  const t0 = Date.now()
  // Lane 1: sharp. Runs immediately, reports incremental progress.
  const sharpResult = await thumbnailer.generateThumbnails(folderPath, (p) => {
    try { event.sender.send('thumbs-progress', { lane: 'fast', ...p }) } catch (_) {}
  })

  let rawProcessed = 0
  let rawFailed = 0
  const rawErrors = []

  // Lane 2: RAW via Photoshop, only if there are RAW files.
  if (sharpResult.rawFiles && sharpResult.rawFiles.length > 0) {
    const tmpDir = require('os').tmpdir()
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const outputPath = path.join(tmpDir, `albumstudio_rawthumbs_result_${tag}.json`)
    const progressPath = path.join(tmpDir, `albumstudio_rawthumbs_progress_${tag}.json`)
    const dataPath = writeJsonData({
      folderPath,
      rawFiles: sharpResult.rawFiles,
      outputPath,
      progressPath,
    })
    const jsxPath = path.join(__dirname, 'scripts', 'raw_thumbnails.jsx')
    const poller = setInterval(() => {
      try {
        if (!fs.existsSync(progressPath)) return
        const raw = fs.readFileSync(progressPath, 'utf8')
        if (!raw) return
        const progress = JSON.parse(raw)
        try { event.sender.send('thumbs-progress', { lane: 'raw', ...progress }) } catch (_) {}
      } catch (_) {}
    }, 500)
    try {
      await executeJSXFile(jsxPath, 60 * 60 * 1000, { DATA_PATH: dataPath })
      if (fs.existsSync(outputPath)) {
        const r = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
        rawProcessed = r.processed || 0
        rawFailed = r.failed || 0
        if (Array.isArray(r.errors)) rawErrors.push(...r.errors)
      }
    } catch (e) {
      rawErrors.push('RAW lane: ' + e.message)
    } finally {
      clearInterval(poller)
      try { fs.unlinkSync(dataPath) } catch (_) {}
      try { fs.unlinkSync(outputPath) } catch (_) {}
      try { fs.unlinkSync(progressPath) } catch (_) {}
    }
  }

  const result = {
    ok: true,
    fastProcessed: sharpResult.processed,
    fastFailed: sharpResult.failed,
    fastTotal: sharpResult.total,
    rawProcessed,
    rawFailed,
    rawTotal: (sharpResult.rawFiles || []).length,
    processed: sharpResult.processed + rawProcessed,
    failed: sharpResult.failed + rawFailed,
    total: sharpResult.total + (sharpResult.rawFiles || []).length,
    errors: [...(sharpResult.errors || []), ...rawErrors],
    thumbDir: sharpResult.thumbDir,
    durationMs: Date.now() - t0,
  }
  telemetry.event('thumbnails_generate', {
    fast: result.fastProcessed,
    raw: result.rawProcessed,
    failed: result.failed,
    durationMs: result.durationMs,
  })
  return result
})


// ── APP READY ─────────────────────────────────────────────
app.whenReady().then(async () => {
  // Resolve Photoshop name once at startup so the first IPC call is fast.
  // Wrapped because running on a machine without Photoshop should not crash boot.
  try { getPhotoshopAppName() } catch (_) {}

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
        currentLicense = {
          allowed: true,
          daysLeft: result.daysLeft,
          email: localLicense.email,
          offline: !!result.offline
        }
        currentUser = { email: localLicense.email }
        createMainWindow(currentLicense)
        return // Stop here! Do not open the login window.
      }
      // Not allowed (deactivated / expired / wrong machine): verifyLicense has
      // already cleared the local file where appropriate. Fall through to login.
    }
  } catch (e) {
    console.log('Silent boot license check failed:', e.message)
  }

  // 4. If no valid license was found, show the login screen normally
  createLoginWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createLoginWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
