// ps_jobs_handlers.js — temp-file JSX jobs (extract, actions, batch exports).
//
// Extracted from app.js (Phase: app.js split). Every handler follows the same
// shape: write a per-call randomized JSON payload (writeJsonData), run a
// scripts/*.jsx through the bridge with a DATA_PATH substitution, read the
// JSX's output JSON, clean up. The long-running batch jobs additionally poll
// a progress file the JSX writes (the JSX call blocks the Photoshop bridge
// until it returns, so we can't ipcMain.send mid-execution — polling a small
// JSON file every 500 ms is the simplest workable channel).

const { ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const bridge = require('../bridge').getBridge()
const guards = require('../ipc_guards')
const { writeJsonData } = require('../bridge/temp')
const telemetry = require('../telemetry')
const thumbnailer = require('../thumbnailer')

const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts')

function registerPsJobsHandlers() {
  // ── EXTRACT TEMPLATE FRAMES ────────────────────────────────
  // Opens a template PSD via the warm Photoshop bridge and dumps its frame
  // layer geometry (toolkithframe* / toolkitvframe*) to a JSON file. Done once
  // per template per session, then cached. Powers the fast composite renderer
  // — once we have the frames, every subsequent proof render is pure libvips
  // and never touches Photoshop again.
  ipcMain.handle('extract-template-frames', async (event, templatePath) => {
    templatePath = guards.reqAbsPath(templatePath, 'templatePath', 'extract-template-frames')
    const dataPayload = writeJsonData({
      templatePath,
      outputPath: path.join(os.tmpdir(),
        `albumstudio_frames_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
    })
    const payload = JSON.parse(fs.readFileSync(dataPayload, 'utf8'))
    const jsxPath = path.join(SCRIPTS_DIR, 'extract_frames.jsx')
    const t0 = Date.now()
    try {
      await bridge.executeJSXFile(jsxPath, 120000, { DATA_PATH: dataPayload })
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
    const outputPath = path.join(os.tmpdir(),
      `albumstudio_actions_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
    const dataPath = writeJsonData({ outputPath })
    const jsxPath = path.join(SCRIPTS_DIR, 'list_actions.jsx')
    try {
      await bridge.executeJSXFile(jsxPath, 60_000, { DATA_PATH: dataPath })
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

  ipcMain.handle('actions-run', async (event, payload) => {
    payload = guards.reqObject(payload, 'payload', 'actions-run'); guards.reqString(payload.setName, 'payload.setName', 'actions-run', { max: 256 }); guards.reqString(payload.actionName, 'payload.actionName', 'actions-run', { max: 256 })
    // payload = { setName, actionName }
    const outputPath = path.join(os.tmpdir(),
      `albumstudio_action_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
    const dataPath = writeJsonData({ ...payload, outputPath })
    const jsxPath = path.join(SCRIPTS_DIR, 'run_action.jsx')
    const t0 = Date.now()
    try {
      await bridge.executeJSXFile(jsxPath, 600_000, { DATA_PATH: dataPath })
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

  // ── BATCH JPEG EXPORT ─────────────────────────────────────
  // Walks a folder of PSDs, opens each in Photoshop ONCE, saves two JPEGs
  // (quality 12 → JPEG-High-Res/, quality 1 → JPEG-Low-Res/). Both output
  // folders are created as siblings of the source folder.
  ipcMain.handle('jpeg-export', async (event, sourceFolder) => {
    sourceFolder = guards.reqAbsPath(sourceFolder, 'sourceFolder', 'jpeg-export')
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

    const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const outputPath   = path.join(os.tmpdir(), `albumstudio_jpegexport_result_${tag}.json`)
    const progressPath = path.join(os.tmpdir(), `albumstudio_jpegexport_progress_${tag}.json`)

    const dataPath = writeJsonData({
      sourceFolder, hiResFolder, loResFolder, outputPath, progressPath,
    })
    const jsxPath = path.join(SCRIPTS_DIR, 'jpeg_export.jsx')

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
      await bridge.executeJSXFile(jsxPath, 60 * 60 * 1000, { DATA_PATH: dataPath })
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

  // ── PSD RESIZER (F1) ──────────────────────────────────────
  // Walks a folder of PSDs, opens each in Photoshop, resizes proportionally to
  // 12 in height @ 300 ppi (3600 px), and saves — either overwriting the
  // original (mode "overwrite") or into a sibling `Resized/` subfolder
  // (mode "copy"). Same progress-polling pattern as jpeg-export.
  ipcMain.handle('resize-psds', async (event, sourceFolder, mode) => {
    sourceFolder = guards.reqAbsPath(sourceFolder, 'sourceFolder', 'resize-psds'); mode = guards.reqString(mode, 'mode', 'resize-psds', { max: 64 })
    const t0 = Date.now()
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const outputPath   = path.join(os.tmpdir(), `albumstudio_resize_result_${tag}.json`)
    const progressPath = path.join(os.tmpdir(), `albumstudio_resize_progress_${tag}.json`)

    const dataPath = writeJsonData({
      sourceFolder,
      mode: mode === 'overwrite' ? 'overwrite' : 'copy',
      outputPath,
      progressPath,
    })
    const jsxPath = path.join(SCRIPTS_DIR, 'resize_psds.jsx')

    const poller = setInterval(() => {
      try {
        if (!fs.existsSync(progressPath)) return
        const raw = fs.readFileSync(progressPath, 'utf8')
        if (!raw) return
        try { event.sender.send('resize-psds-progress', JSON.parse(raw)) } catch (_) {}
      } catch (_) { /* ignore parse races */ }
    }, 500)

    try {
      await bridge.executeJSXFile(jsxPath, 60 * 60 * 1000, { DATA_PATH: dataPath })
      if (!fs.existsSync(outputPath)) {
        return { ok: false, error: 'resize_psds produced no output' }
      }
      const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      telemetry.event('resize_psds', {
        total: result.total,
        processed: result.processed,
        failed: result.failed,
        mode: mode === 'overwrite' ? 'overwrite' : 'copy',
        durationMs: Date.now() - t0,
      })
      return { ok: true, ...result, mode, durationMs: Date.now() - t0 }
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
    payload = guards.reqObject(payload, 'payload', 'inject-photo'); guards.reqAbsPath(payload.filePath, 'payload.filePath', 'inject-photo'); guards.reqString(payload.layerName, 'payload.layerName', 'inject-photo', { max: 256 })
    // payload = { filePath, layerName }
    const outputPath = path.join(os.tmpdir(),
      `albumstudio_inject_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
    const dataPath = writeJsonData({ ...payload, outputPath })
    const jsxPath = path.join(SCRIPTS_DIR, 'inject_photo.jsx')
    try {
      await bridge.executeJSXFile(jsxPath, 120000, { DATA_PATH: dataPath })
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
    const outputPath = path.join(os.tmpdir(),
      `albumstudio_exportopen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`)
    const dataPath = writeJsonData({ outputPath, scope: scope === 'active' ? 'active' : 'all' })
    const jsxPath = path.join(SCRIPTS_DIR, 'export_open_docs.jsx')
    try {
      await bridge.executeJSXFile(jsxPath, 30 * 60 * 1000, { DATA_PATH: dataPath })
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

  // ── BATCH THUMBNAILS (fast hybrid) ────────────────────────
  // Two lanes:
  //   1. sharp/libvips lane — every JPEG/PNG/TIFF/HEIC, in parallel, in this
  //      process, off the Photoshop bridge. The 50–100× speedup.
  //   2. Photoshop lane — ONLY the RAW files that genuinely need Camera Raw.
  // Progress for both lanes streams to the renderer via 'thumbs-progress'.
  ipcMain.handle('thumbnails-generate', async (event, folderPath) => {
    folderPath = guards.reqAbsPath(folderPath, 'folderPath', 'thumbnails-generate')
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
      const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const outputPath = path.join(os.tmpdir(), `albumstudio_rawthumbs_result_${tag}.json`)
      const progressPath = path.join(os.tmpdir(), `albumstudio_rawthumbs_progress_${tag}.json`)
      const dataPath = writeJsonData({
        folderPath,
        rawFiles: sharpResult.rawFiles,
        outputPath,
        progressPath,
      })
      const jsxPath = path.join(SCRIPTS_DIR, 'raw_thumbnails.jsx')
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
        await bridge.executeJSXFile(jsxPath, 60 * 60 * 1000, { DATA_PATH: dataPath })
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
}

module.exports = { registerPsJobsHandlers }
