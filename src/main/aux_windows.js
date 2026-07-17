// aux_windows.js — IPC for the auxiliary windows: floating Tools Bar,
// Renamer, and the Spread Editor relay.
//
// Extracted from app.js (Phase: app.js split). The tools-bar and renamer
// windows are owned by src/tools_bar.js / src/renamer.js — the handlers here
// are thin guarded delegates. The Spread Editor window IS owned here: the
// album state lives in the main renderer, so we relay — the main renderer
// pushes the current spread payload via `editor-open`; the editor pulls it
// with `editor-get-spread`; the editor pushes edits back via `editor-apply`,
// which we forward to the main window.

const { BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const guards = require('../ipc_guards')
const toolsBar = require('../tools_bar')
const renamer = require('../renamer')
const session = require('./session')

const SRC_DIR = path.join(__dirname, '..')

function registerAuxWindowHandlers() {
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
    height = guards.reqNumber(height, 'height', 'tools-bar-set-height', { min: 0, max: 4000 })
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
  // src/renamer_naming.js. See docs/notes/renamer-design.md.
  ipcMain.handle('renamer-open', () => {
    try { renamer.openRenamerWindow(); return { ok: true } }
    catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('renamer-status', () => {
    return { ok: true, open: renamer.isOpen() }
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
    folderPath = guards.reqAbsPath(folderPath, 'folderPath', 'renamer-list-images')
    if (!folderPath || typeof folderPath !== 'string') {
      return { ok: false, error: 'no folder', images: [] }
    }
    try { return await renamer.listImages(folderPath) }
    catch (e) { return { ok: false, error: e.message, images: [] } }
  })

  // List immediate subdirectories of a folder (for the Renamer's folder
  // navigator). Returns the parent path too so the UI can offer an "up" row.
  ipcMain.handle('renamer-list-dir', (event, dirPath) => {
    dirPath = guards.reqAbsPath(dirPath, 'dirPath', 'renamer-list-dir')
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
    payload = guards.reqObject(payload, 'payload', 'renamer-apply-renames')
    if (payload.folderPath) payload.folderPath = guards.reqAbsPath(payload.folderPath, 'payload.folderPath', 'renamer-apply-renames')
    if (payload.ops !== undefined) guards.reqArray(payload.ops, 'payload.ops', 'renamer-apply-renames', { max: 10000 })
    const folderPath = payload && payload.folderPath
    const ops = (payload && payload.ops) || []
    if (!folderPath) return { ok: false, error: 'no folder', renamed: 0 }
    try { return await renamer.applyRenames(folderPath, ops) }
    catch (e) { return { ok: false, error: e.message, renamed: 0 } }
  })

  // ── SPREAD EDITOR ──────────────────────────────────────────
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
      // Hardened: the editor renderer talks to main only through the frozen
      // contextBridge surface in editor_preload.js, so it runs with no direct
      // Node access. (Pilot for migrating the rest of the app off nodeIntegration.)
      webPreferences: {
        preload: path.join(SRC_DIR, 'editor_preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
      },
    })
    _editorWin.loadFile(path.join(SRC_DIR, 'editor.html'))
    _editorWin.on('closed', () => { _editorWin = null })
    return { ok: true }
  })

  ipcMain.handle('editor-get-spread', () => _editorSpread)

  // Editor → main renderer: persist placement/adjustment changes + refresh.
  ipcMain.handle('editor-apply', (event, changes) => {
    const mainWindow = session.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('editor-changes', changes)
    }
    return { ok: true }
  })

  // Editor → main renderer: swap two photos between frames on a page.
  ipcMain.handle('editor-swap', (event, msg) => {
    const mainWindow = session.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('editor-swap', msg)
    }
    return { ok: true }
  })

  // Editor → main renderer: navigate to another spread (main rebuilds + pushes
  // the fresh payload back via editor-open → editor-spread-updated).
  ipcMain.handle('editor-goto', (event, msg) => {
    const mainWindow = session.getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('editor-goto', msg)
    }
    return { ok: true }
  })
}

module.exports = { registerAuxWindowHandlers }
