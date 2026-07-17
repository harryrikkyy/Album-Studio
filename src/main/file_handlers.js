// file_handlers.js — shell, pickers, project folder I/O, native drag-out.
//
// Extracted from app.js (Phase: app.js split). Pure dialog/fs plumbing with
// no session or bridge state.

const { ipcMain, dialog, shell, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const guards = require('../ipc_guards')

const ROOT_DIR = path.join(__dirname, '..', '..')

function registerFileHandlers() {
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
    if (defaultName !== undefined && defaultName !== null) defaultName = guards.reqBaseName(defaultName, 'defaultName', 'pick-file-save')
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
    if (suggestedName !== undefined && suggestedName !== null) suggestedName = guards.reqBaseName(suggestedName, 'suggestedName', 'project-pick-save')
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
    projectPath = guards.reqAbsPath(projectPath, 'projectPath', 'project-write'); payload = guards.reqObject(payload, 'payload', 'project-write')
    fs.mkdirSync(projectPath, { recursive: true })
    fs.mkdirSync(path.join(projectPath, 'proofs'), { recursive: true })
    fs.mkdirSync(path.join(projectPath, 'exports'), { recursive: true })
    fs.writeFileSync(
      path.join(projectPath, 'project.json'),
      JSON.stringify({ version: 1, savedAt: new Date().toISOString(), ...payload }, null, 2)
    )
    return { ok: true, path: projectPath }
  })

  ipcMain.handle('project-read', async (event, pathInput) => {
    pathInput = guards.reqAbsPath(pathInput, 'pathInput', 'project-read')
    let projectFile = pathInput
    // If user picked a directory, look inside for project.json. If they picked
    // a .json directly, load that as legacy single-file project.
    try {
      const stat = fs.statSync(pathInput)
      if (stat.isDirectory()) {
        projectFile = path.join(pathInput, 'project.json')
      }
    } catch (_) {}

    if (!fs.existsSync(projectFile)) {
      return { ok: false, error: 'project.json not found' }
    }
    const raw = fs.readFileSync(projectFile, 'utf8')
    return { ok: true, data: JSON.parse(raw), projectPath: path.dirname(projectFile) }
  })

  // ── NATIVE FILE DRAG-OUT ──────────────────────────────────
  // Lets the user drag source/Photos-tab thumbnails straight into Photoshop (or
  // Finder) and drop the ORIGINAL high-res files — exactly like dragging from
  // Finder. The renderer cancels its own HTML5 drag and calls this with the
  // resolved original file path(s); Electron then starts a real OS drag.
  let _dragIcon = null
  function getDragIcon() {
    if (_dragIcon && !_dragIcon.isEmpty()) return _dragIcon
    try { _dragIcon = nativeImage.createFromPath(path.join(ROOT_DIR, 'assets', 'icon.iconset', 'icon_32x32.png')) } catch (_) {}
    // startDrag throws on an empty icon (macOS), so guarantee a non-empty one.
    if (!_dragIcon || _dragIcon.isEmpty()) {
      _dragIcon = nativeImage.createFromDataURL(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
    }
    return _dragIcon
  }
  ipcMain.on('start-native-drag', (event, filePaths) => {
    // .on has no promise to reject, so invalid input bails silently.
    if (!Array.isArray(filePaths) || filePaths.length === 0 || filePaths.length > 1000) return
    if (filePaths.some(p => typeof p !== 'string' || p.includes('\0') || !path.isAbsolute(p))) return
    const existing = filePaths.filter(p => { try { return fs.existsSync(p) } catch (_) { return false } })
    if (existing.length === 0) return
    const icon = getDragIcon()
    try {
      if (existing.length === 1) event.sender.startDrag({ file: existing[0], icon })
      else event.sender.startDrag({ file: existing[0], files: existing, icon })
    } catch (e) { /* startDrag can throw if the drag isn't active; ignore */ }
  })
}

module.exports = { registerFileHandlers }
