// ps_place_handlers.js — direct Photoshop bridge calls (place, swap, build).
//
// Extracted from app.js (Phase: app.js split). Every handler here is a thin
// guarded pass-through to the PhotoshopBridge: either an inline JSX template
// or a runJsxDataJob with a payload. The heavier temp-file/progress-poller
// jobs live in ps_jobs_handlers.js.

const { ipcMain } = require('electron')
const path = require('path')
const bridge = require('../bridge').getBridge()
const guards = require('../ipc_guards')
const jsxTemplates = require('../jsx/templates')

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts')

function registerPsPlaceHandlers() {
  // ── OPEN IN PHOTOSHOP ─────────────────────────────────────
  ipcMain.handle('open-in-photoshop', async (event, filePath) => {
    filePath = guards.reqAbsPath(filePath, 'filePath', 'open-in-photoshop')
    return bridge.executeJSX(jsxTemplates.openInPhotoshop(filePath))
  })

  // ── RUN JSX ───────────────────────────────────────────────
  ipcMain.handle('run-jsx', async (event, jsxCode) => {
    jsxCode = guards.reqString(jsxCode, 'jsxCode', 'run-jsx', { max: 262144 })
    return bridge.executeJSX(jsxCode)
  })

  // ── PLACE WALLPAPER ───────────────────────────────────────
  ipcMain.handle('place-wallpaper', async (event, filePath, isHr) => {
    filePath = guards.reqAbsPath(filePath, 'filePath', 'place-wallpaper')
    return bridge.executeJSX(jsxTemplates.placeWallpaper(filePath, isHr))
  })

  // ── PLACE PNG FRAME ───────────────────────────────────────
  ipcMain.handle('place-png-frame', async (event, filePath, layerName) => {
    filePath = guards.reqAbsPath(filePath, 'filePath', 'place-png-frame'); layerName = guards.reqString(layerName, 'layerName', 'place-png-frame', { max: 256 })
    return bridge.executeJSX(jsxTemplates.placePngFrame(filePath, layerName))
  })

  // ── PLACE MASKED FRAME ────────────────────────────────────
  ipcMain.handle('place-masked-frame', async (event, filePath, layerName, isJpg) => {
    filePath = guards.reqAbsPath(filePath, 'filePath', 'place-masked-frame'); layerName = guards.reqString(layerName, 'layerName', 'place-masked-frame', { max: 256 })
    return bridge.executeJSX(jsxTemplates.placeMaskedFrame(filePath, layerName, isJpg))
  })

  // ── PLACE IMAGE CLIPPED (B1) ──────────────────────────────
  // Places an image into the active Photoshop document and clips it to the
  // currently selected layer (clipping mask). Used by the Source-panel
  // right-click → "Place".
  ipcMain.handle('place-clipped', async (event, filePath) => {
    filePath = guards.reqAbsPath(filePath, 'filePath', 'place-clipped')
    return bridge.executeJSX(jsxTemplates.placeClipped(filePath))
  })

  // ── SWAP IMAGES ───────────────────────────────────────────
  ipcMain.handle('swap-images', async () => {
    const jsxPath = path.join(SCRIPTS_DIR, 'Swap_Clipped_Images.jsx')
    return bridge.executeJSXFile(jsxPath)
  })

  // ── EXPORT ALBUM ──────────────────────────────────────────
  // Each of these previously wrote to a fixed /tmp/albumstudio_*.json which two
  // concurrent invocations could stomp. We now write to a per-call randomized
  // path and inject it into the JSX via __DATA_PATH__ substitution.
  ipcMain.handle('export-album', async (event, exportData) => {
    exportData = guards.reqObject(exportData, 'exportData', 'export-album')
    return bridge.runJsxDataJob('export_album.jsx', exportData, 600000)
  })

  // ── BUILD PAGE ────────────────────────────────────────────
  ipcMain.handle('build-page', async (event, pageData) => {
    pageData = guards.reqObject(pageData, 'pageData', 'build-page')
    return bridge.runJsxDataJob('build_page.jsx', pageData, 300000)
  })

  // ── BUILD PAGES BATCH ─────────────────────────────────────
  // Warm-process render: opens the template ONCE, then duplicates / saves /
  // closes for each page in the batch. Saves the per-page open-template cost
  // when the render queue feeds N consecutive pages with the same template.
  ipcMain.handle('build-pages-batch', async (event, batch) => {
    batch = guards.reqObject(batch, 'batch', 'build-pages-batch')
    // batch = { templatePath, outputPath, pages: [{ pageName, photos }] }
    // Generous timeout: 30s per page, capped at 30 minutes.
    const ms = Math.min(30 * 60 * 1000, Math.max(60_000, batch.pages.length * 30_000))
    return bridge.runJsxDataJob('build_pages_batch.jsx', batch, ms)
  })

  // ── BATCH THUMBNAILS (legacy: all through Photoshop) ──────
  ipcMain.handle('batch-thumbnails', async (event, folderPath) => {
    folderPath = guards.reqAbsPath(folderPath, 'folderPath', 'batch-thumbnails')
    return bridge.runJsxDataJob('batch_thumbnails.jsx', { folderPath }, 600000)
  })
}

module.exports = { registerPsPlaceHandlers }
