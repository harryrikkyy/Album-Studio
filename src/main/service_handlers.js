// service_handlers.js — thin IPC delegates to the main-process services:
// telemetry, curation, generative templates, plugins, library.
//
// Extracted from app.js (Phase: app.js split). Each handler is a guarded
// pass-through to an already-extracted src/ module; no state lives here.

const { ipcMain } = require('electron')
const path = require('path')
const guards = require('../ipc_guards')
const telemetry = require('../telemetry')
const curation = require('../curation')
const generativeTemplates = require('../generative_templates')
const plugins = require('../plugins')
const library = require('../library')

function registerServiceHandlers() {
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
    folderPath = guards.reqAbsPath(folderPath, 'folderPath', 'curation-analyze')
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
}

module.exports = { registerServiceHandlers }
