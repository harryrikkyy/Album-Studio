// session.js — who is signed in, and which top-level windows exist.
//
// Owns the login/main BrowserWindow refs plus the currentUser/currentLicense
// session state that the auth, license, and editor modules previously shared
// through app.js module globals (Phase: app.js split). Everything else reaches
// this state through the accessors below, so no registrar module holds its own
// copy of a window ref that could go stale.

const { BrowserWindow, app } = require('electron')
const path = require('path')

// Repo root (this file lives at src/main/): preloads + html live in src/,
// packaged assets at the root.
const SRC_DIR = path.join(__dirname, '..')
const ROOT_DIR = path.join(__dirname, '..', '..')

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
      preload: path.join(SRC_DIR, 'login_preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    title: 'Creative Hubb Album Toolkit Pro',
    icon: path.join(ROOT_DIR, 'assets/icon.icns')
  })
  loginWindow.loadFile(path.join(SRC_DIR, 'login.html'))
  loginWindow.on('closed', () => { loginWindow = null })
  return loginWindow
}

// ── CREATE MAIN APP WINDOW ─────────────────────────────────
function createMainWindow(licenseInfo = {}) {
  // Pass a definitive --e2e signal to the renderer only when the (non-packaged)
  // main process is in test-mode, so the renderer's guarded test hook is double-
  // protected the same way the auth bypass is.
  const additionalArguments = [`--license=${JSON.stringify(licenseInfo)}`]
  if (process.env.ALBUMSTUDIO_E2E === '1' && !app.isPackaged) additionalArguments.push('--e2e')
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      // The renderer runs bundled (src/dist/renderer.bundle.js) against the
      // allowlisted `native` bridge. sandbox:false because the preload needs
      // node's fs for the renderer's file-system slice.
      preload: path.join(SRC_DIR, 'main_preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      additionalArguments
    },
    title: 'Creative Hubb Album Toolkit Pro',
    icon: path.join(ROOT_DIR, 'assets/icon.icns')
  })
  mainWindow.loadFile(path.join(SRC_DIR, 'index.html'))
  mainWindow.on('closed', () => { mainWindow = null })
}

// Live window accessors — callers must re-check isDestroyed() themselves,
// exactly as the previous module-global reads did.
function getMainWindow() { return mainWindow }
function getLoginWindow() { return loginWindow }
function setMainWindow(win) { mainWindow = win }
function setLoginWindow(win) { loginWindow = win }

function getUser() { return currentUser }
function setUser(u) { currentUser = u }
function getLicense() { return currentLicense }
function setLicense(l) { currentLicense = l }

// second-instance: focus whichever top-level window is alive instead of
// silently letting a second launch share (and fight over) the same profile.
function focusExisting() {
  const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow
    : (loginWindow && !loginWindow.isDestroyed()) ? loginWindow : null
  if (win) { if (win.isMinimized()) win.restore(); win.focus() }
}

module.exports = {
  createLoginWindow,
  createMainWindow,
  getMainWindow,
  getLoginWindow,
  setMainWindow,
  setLoginWindow,
  getUser,
  setUser,
  getLicense,
  setLicense,
  focusExisting,
}
