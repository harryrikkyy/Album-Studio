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

// Overlays are authored as resolution-independent SVG. When a page's true
// canvas size isn't in the payload we rasterize on a generous default long
// edge — big enough that the JSX's scale-to-fit is a downscale (which stays
// crisp) rather than an upscale (which would soften the text).
const OVERLAY_FALLBACK_EDGE = 4500

/**
 * Prepare a page's overlays for the Photoshop build, in two halves:
 *
 *   text   → `overlayTextLayers`, rebuilt as NATIVE, editable Photoshop text
 *            layers so the client can retype a name in the delivered PSD
 *   shapes → `overlayPngPath`, a transparent raster placed as one layer
 *
 * Returns a cleanup function that removes the temp PNG — always called in a
 * `finally`, so a failed Photoshop run doesn't leak files.
 *
 * @param {any} page a build-page payload or one entry of a batch
 * @returns {Promise<() => void>}
 */
async function attachOverlayArtwork(page) {
  const noop = () => {}
  if (!page || !Array.isArray(page.overlays) || !page.overlays.length) return noop
  try {
    const { rasterizeOverlays } = require('../proof_renderer')
    const { buildPsTextLayers, hasShapeOverlays } = require('../overlay_ps')

    let w = Number(page.canvasWidth)
    let h = Number(page.canvasHeight)
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      w = OVERLAY_FALLBACK_EDGE
      h = Math.round(OVERLAY_FALLBACK_EDGE * 0.75)
    }

    page.overlayTextLayers = buildPsTextLayers(page.overlays, w, h)

    // Only rasterize when there is actually a shape to draw; text is native.
    if (!hasShapeOverlays(page.overlays)) return noop
    const png = await rasterizeOverlays(page.overlays, w, h)
    if (!png) return noop
    page.overlayPngPath = png
    return () => { try { require('fs').unlinkSync(png) } catch (_) {} }
  } catch (e) {
    // A failed overlay prep must not sink the whole page render — the page
    // still builds, just without its captions. Breadcrumb so it's diagnosable.
    console.warn('Overlay prep failed; page will build without overlays:',
      e instanceof Error ? e.message : String(e))
    return noop
  }
}

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
    const cleanup = await attachOverlayArtwork(pageData)
    try {
      return await bridge.runJsxDataJob('build_page.jsx', pageData, 300000)
    } finally {
      cleanup()
    }
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
    const cleanups = await Promise.all((batch.pages || []).map(attachOverlayArtwork))
    try {
      return await bridge.runJsxDataJob('build_pages_batch.jsx', batch, ms)
    } finally {
      for (const c of cleanups) c()
    }
  })

  // ── BATCH THUMBNAILS (legacy: all through Photoshop) ──────
  ipcMain.handle('batch-thumbnails', async (event, folderPath) => {
    folderPath = guards.reqAbsPath(folderPath, 'folderPath', 'batch-thumbnails')
    return bridge.runJsxDataJob('batch_thumbnails.jsx', { folderPath }, 600000)
  })
}

module.exports = { registerPsPlaceHandlers }
