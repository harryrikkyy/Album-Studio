const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { app } = require('electron')

// ── PhotoshopQueue ────────────────────────────────────────────
// Photoshop ExtendScript is single-threaded per document. Two concurrent
// `osascript ... do javascript` calls race in unpredictable ways:
// the second one may execute against a partially-modified state from the
// first, layers can end up in the wrong place, and one error can leave the
// document in a dirty state for the other call.
//
// PhotoshopQueue serializes every JSX call this process makes. Callers see
// a normal Promise but they queue up FIFO behind any in-flight request.
const _psQueue = []
let _psBusy = false

function _drainQueue() {
  if (_psBusy) return
  const next = _psQueue.shift()
  if (!next) return
  _psBusy = true
  next.run().then(
    (val) => {
      _psBusy = false
      next.resolve(val)
      _drainQueue()
    },
    (err) => {
      _psBusy = false
      next.reject(err)
      _drainQueue()
    }
  )
}

function _enqueue(run) {
  return new Promise((resolve, reject) => {
    _psQueue.push({ run, resolve, reject })
    _drainQueue()
  })
}

// ── Cache the Photoshop app name once per process. The previous version ran
//    fs.readdirSync('/Applications') on EVERY IPC call.
let _photoshopAppName = null
function getPhotoshopAppName() {
  if (_photoshopAppName) return _photoshopAppName
  const apps = fs.readdirSync('/Applications').filter(a => a.startsWith('Adobe Photoshop'))
  if (apps.length === 0) throw new Error('Adobe Photoshop not found in /Applications')
  apps.sort().reverse()
  _photoshopAppName = apps[0]
  return _photoshopAppName
}

/**
 * Safe JSX single-quoted string literal. Escapes \, ', \r, \n, U+2028, U+2029.
 * Use this anywhere a user-supplied path or layer name is interpolated into JSX
 * to prevent injection (e.g. a filename like  foo");app.activeDocument.close();// ).
 */
function jsxString(value) {
  return "'" + String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029') + "'"
}

function _tmpJsxPath() {
  return path.join(
    app.getPath('temp'),
    `albumstudio_${process.pid}_${crypto.randomBytes(6).toString('hex')}.jsx`
  )
}

/**
 * Execute an in-memory JSX snippet in Photoshop via osascript.
 *
 * Calls are serialized through PhotoshopQueue — two concurrent invocations
 * will run sequentially in arrival order, never in parallel. This protects
 * against the race that used to break the wallpaper / page-build flows when
 * the user kicked off a render queue and then double-clicked something else.
 *
 * Uses a per-call randomized temp filename so concurrent calls never share
 * a script file (the previous implementation overwrote one fixed path).
 */
function executeJSX(jsxCode, timeoutMs = 600000) {
  return _enqueue(() => new Promise((resolve, reject) => {
    let tmpPath
    try {
      const psApp = getPhotoshopAppName()
      tmpPath = _tmpJsxPath()
      fs.writeFileSync(tmpPath, jsxCode)
      const cmd = `osascript -e 'tell application "${psApp}" to do javascript file "${tmpPath}"'`
      exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
        try { fs.unlinkSync(tmpPath) } catch (_) {}
        if (err) reject(new Error(stderr || err.message))
        else resolve(stdout.trim())
      })
    } catch (e) {
      if (tmpPath) { try { fs.unlinkSync(tmpPath) } catch (_) {} }
      reject(e)
    }
  }))
}

/**
 * Execute a pre-existing JSX file in Photoshop. Serialized through PhotoshopQueue.
 *
 * @param {string} jsxFilePath - Absolute path to the JSX file
 * @param {number} timeoutMs   - Optional timeout in ms (0 = none)
 * @param {object} [replacements] - Map of `{KEY: value}` whose `__KEY__`
 *                                  placeholders in the JSX source will be
 *                                  substituted before execution. Used to inject
 *                                  per-call data file paths so concurrent calls
 *                                  do not race on /tmp/albumstudio_*.json.
 */
function executeJSXFile(jsxFilePath, timeoutMs = 0, replacements = null) {
  return _enqueue(() => new Promise((resolve, reject) => {
    let tmpPath = null
    try {
      const psApp = getPhotoshopAppName()

      // Always run the JSX from a freshly written temp file. In a packaged
      // build __dirname lives inside app.asar; the scripts are asarUnpacked
      // but the path the caller hands us still points at the .asar virtual
      // path. Photoshop is an external process and cannot read inside the
      // asar archive, so handing it that path silently fails (this was the
      // "Swap 2 Images does nothing when packaged" bug — calls that pass
      // `replacements` already round-tripped through a temp file and so
      // worked, while swap, which passes none, did not). Node's fs CAN read
      // through the asar, so we read here and write a real file that PS can
      // open. This also keeps the replacement path working unchanged.
      let src = fs.readFileSync(jsxFilePath, 'utf8')
      if (replacements && Object.keys(replacements).length) {
        for (const [k, v] of Object.entries(replacements)) {
          // values are typically file paths embedded inside a double-quoted
          // JSX string, so escape \ and " before substitution.
          const safe = String(v).replace(/\\/g, '/').replace(/"/g, '\\"')
          src = src.split(`__${k}__`).join(safe)
        }
      }
      tmpPath = _tmpJsxPath()
      fs.writeFileSync(tmpPath, src)
      const runPath = tmpPath

      const cmd = `osascript -e 'tell application "${psApp}" to do javascript file "${runPath}"'`
      const execOptions = timeoutMs > 0 ? { timeout: timeoutMs } : {}
      exec(cmd, execOptions, (err, stdout, stderr) => {
        if (tmpPath) { try { fs.unlinkSync(tmpPath) } catch (_) {} }
        if (err) reject(new Error(stderr || err.message))
        else resolve(stdout.trim() || 'success')
      })
    } catch (e) {
      if (tmpPath) { try { fs.unlinkSync(tmpPath) } catch (_) {} }
      reject(e)
    }
  }))
}

/**
 * Write JSON data to a uniquely-named temp file. Returns the absolute path.
 * Caller is responsible for unlinking the file when done.
 */
function writeJsonData(data, filename) {
  const fname = filename || `albumstudio_${process.pid}_${crypto.randomBytes(6).toString('hex')}.json`
  const dataPath = path.join(app.getPath('temp'), fname)
  fs.writeFileSync(dataPath, JSON.stringify(data))
  return dataPath
}

module.exports = {
  getPhotoshopAppName,
  jsxString,
  executeJSX,
  executeJSXFile,
  writeJsonData
}
