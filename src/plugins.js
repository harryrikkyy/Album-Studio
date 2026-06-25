// plugins.js
//
// Plugin loader + dispatcher. Lives in the main process so plugins get the
// full Node module surface (sharp, fs, child_process), but plugins are
// sandboxed to a known directory so the user can drop one in without
// touching the app bundle.
//
// Plugin layout — each plugin is a folder under userData/plugins:
//   plugins/
//     my-face-detector/
//       manifest.json   { name, version, hooks, enabled?, settings? }
//       index.js        module.exports = { focalPoint, ... }
//
// Supported hooks (all optional):
//   focalPoint(filePath)              -> { x, y, confidence } in 0..1
//   photoFilter(features)              -> boolean (true = keep)
//   autoFillPolicy(photos, context)    -> reordered photos array
//   onPageRendered({ pageNum, output }) -> any (post-render side effects)
//
// Conflict resolution: when multiple plugins implement the same hook, the
// dispatcher calls them in priority order (manifest.priority, default 100).
// For producer hooks (focalPoint), the FIRST plugin that returns a non-null
// result wins. For filter hooks (photoFilter), every plugin must agree.
// For transform hooks (autoFillPolicy), they chain.
//
// Errors from a plugin never bubble — a buggy plugin gets logged + disabled
// for the session.

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

let _plugins = []        // [{ id, dir, manifest, mod, disabled }]
let _initialized = false

function pluginsDir() {
  const dir = path.join(app.getPath('userData'), 'plugins')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function builtInDir() {
  // Built-in plugins ship inside the app bundle. They live next to this
  // file so they survive packaging without asarUnpack gymnastics.
  return path.join(__dirname, 'builtin_plugins')
}

function loadPluginFolder(dir) {
  const manifestPath = path.join(dir, 'manifest.json')
  const indexPath = path.join(dir, 'index.js')
  if (!fs.existsSync(manifestPath) || !fs.existsSync(indexPath)) return null
  let manifest, mod
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    return { error: `manifest parse failed: ${e.message}`, dir }
  }
  // Honor user-disabled flag from manifest. Re-saving the manifest with
  // enabled:false is the on-disk way to disable a plugin.
  if (manifest.enabled === false) {
    return { id: manifest.name || path.basename(dir), dir, manifest, disabled: true }
  }
  try {
    // Clear cache so reload picks up edits — useful during plugin authoring.
    delete require.cache[require.resolve(indexPath)]
    mod = require(indexPath)
  } catch (e) {
    return { error: `require failed: ${e.message}`, manifest, dir }
  }
  return { id: manifest.name || path.basename(dir), dir, manifest, mod }
}

function discover() {
  const collected = []
  // Built-ins first.
  const builtIn = builtInDir()
  if (fs.existsSync(builtIn)) {
    for (const entry of fs.readdirSync(builtIn, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const r = loadPluginFolder(path.join(builtIn, entry.name))
      if (r) collected.push({ ...r, builtin: true })
    }
  }
  // User-supplied second so they override on collision.
  const user = pluginsDir()
  if (fs.existsSync(user)) {
    for (const entry of fs.readdirSync(user, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const r = loadPluginFolder(path.join(user, entry.name))
      if (r) collected.push({ ...r, builtin: false })
    }
  }
  // Sort by priority asc (lower = earlier). Default 100. Built-ins above
  // user plugins at equal priority unless user explicitly bumps theirs.
  collected.sort((a, b) =>
    (a.manifest?.priority ?? 100) - (b.manifest?.priority ?? 100)
  )
  return collected
}

function init() {
  if (_initialized) return _plugins
  _plugins = discover()
  _initialized = true
  // Log to telemetry without taking a hard dep on it.
  try {
    const tel = require('./telemetry')
    tel.event('plugins_loaded', {
      total: _plugins.length,
      enabled: _plugins.filter(p => !p.disabled && !p.error).length,
      builtin: _plugins.filter(p => p.builtin).length,
    })
  } catch (_) {}
  return _plugins
}

function reload() {
  _initialized = false
  return init()
}

function listPlugins() {
  init()
  return _plugins.map(p => ({
    id: p.id,
    builtin: !!p.builtin,
    disabled: !!p.disabled,
    error: p.error || null,
    manifest: p.manifest || null,
    dir: p.dir,
  }))
}

function setEnabled(id, enabled) {
  init()
  const p = _plugins.find(x => x.id === id)
  if (!p) return { ok: false, error: 'not found' }
  if (p.builtin) return { ok: false, error: 'cannot disable built-in plugin' }
  // Persist by rewriting the manifest's `enabled` field.
  const manifestPath = path.join(p.dir, 'manifest.json')
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    m.enabled = enabled
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2))
  } catch (e) {
    return { ok: false, error: e.message }
  }
  reload()
  return { ok: true }
}

// ─── hook dispatch ────────────────────────────────────────────────────────

function _live() {
  init()
  return _plugins.filter(p => p.mod && !p.disabled && !p.error)
}

/**
 * Producer hook: the FIRST non-null result wins. Used for focal-point
 * detection where multiple plugins make sense but only one answer is final.
 */
async function dispatchFirst(hookName, ...args) {
  for (const p of _live()) {
    const fn = p.mod[hookName]
    if (typeof fn !== 'function') continue
    try {
      const r = await fn(...args)
      if (r != null) return { value: r, source: p.id }
    } catch (e) {
      _logPluginError(p, hookName, e)
    }
  }
  return null
}

/**
 * Filter hook: every plugin must agree. False from any plugin rejects.
 */
async function dispatchAnd(hookName, ...args) {
  for (const p of _live()) {
    const fn = p.mod[hookName]
    if (typeof fn !== 'function') continue
    try {
      const r = await fn(...args)
      if (r === false) return { keep: false, vetoer: p.id }
    } catch (e) {
      _logPluginError(p, hookName, e)
    }
  }
  return { keep: true }
}

/**
 * Transform hook: chains, each plugin gets the previous output.
 */
async function dispatchChain(hookName, value, ...rest) {
  let v = value
  for (const p of _live()) {
    const fn = p.mod[hookName]
    if (typeof fn !== 'function') continue
    try {
      const r = await fn(v, ...rest)
      if (r !== undefined) v = r
    } catch (e) {
      _logPluginError(p, hookName, e)
    }
  }
  return v
}

/**
 * Side-effect hook: every plugin runs, results are ignored.
 */
async function dispatchAll(hookName, ...args) {
  for (const p of _live()) {
    const fn = p.mod[hookName]
    if (typeof fn !== 'function') continue
    try { await fn(...args) } catch (e) { _logPluginError(p, hookName, e) }
  }
}

function _logPluginError(plugin, hookName, err) {
  // A buggy plugin disables itself for the rest of the session so it doesn't
  // poison subsequent calls.
  plugin.disabled = true
  plugin.error = `${hookName}: ${err.message}`
  try {
    require('./telemetry').event('plugin_error', {
      id: plugin.id,
      hook: hookName,
      error: err.message,
    })
  } catch (_) {}
  console.warn(`[plugin:${plugin.id}] ${hookName} threw — disabled for session:`, err.message)
}

module.exports = {
  init,
  reload,
  listPlugins,
  setEnabled,
  pluginsDir,
  dispatchFirst,
  dispatchAnd,
  dispatchChain,
  dispatchAll,
}
