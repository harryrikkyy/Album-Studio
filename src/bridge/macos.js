// @ts-check
// bridge/macos.js — the macOS PhotoshopBridge implementation: ExtendScript
// via `osascript … do javascript`, moved here from src/photoshop.js.
// (The Windows implementation — PowerShell/COM — lands in Phase 7.)

const { exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const { tmpJsxPath, writeJsonData } = require('./temp')

/**
 * @param {object} opts
 * @param {string} opts.scriptsDir  absolute path to the app's scripts/*.jsx
 * @returns {import('./index').PhotoshopBridge}
 */
function createMacosBridge({ scriptsDir }) {
  // ── PhotoshopQueue ────────────────────────────────────────────
  // Photoshop ExtendScript is single-threaded per document. Two concurrent
  // `osascript ... do javascript` calls race in unpredictable ways:
  // the second one may execute against a partially-modified state from the
  // first, layers can end up in the wrong place, and one error can leave the
  // document in a dirty state for the other call.
  //
  // The queue serializes every JSX call this process makes. Callers see
  // a normal Promise but they queue up FIFO behind any in-flight request.
  /** @type {Array<{run: () => Promise<any>, resolve: Function, reject: Function}>} */
  const queue = []
  let busy = false

  function drainQueue() {
    if (busy) return
    const next = queue.shift()
    if (!next) return
    busy = true
    next.run().then(
      (val) => { busy = false; next.resolve(val); drainQueue() },
      (err) => { busy = false; next.reject(err); drainQueue() }
    )
  }

  /** @param {() => Promise<any>} run */
  function enqueue(run) {
    return new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject })
      drainQueue()
    })
  }

  // Cache the Photoshop app name once per process. The previous version ran
  // fs.readdirSync('/Applications') on EVERY IPC call.
  /** @type {string | null} */
  let photoshopAppName = null
  function getPhotoshopAppName() {
    if (photoshopAppName) return photoshopAppName
    const apps = fs.readdirSync('/Applications').filter(a => a.startsWith('Adobe Photoshop'))
    if (apps.length === 0) throw new Error('Adobe Photoshop not found in /Applications')
    apps.sort().reverse()
    photoshopAppName = apps[0]
    return photoshopAppName
  }

  /**
   * Execute an in-memory JSX snippet in Photoshop via osascript.
   *
   * Calls are serialized through the queue — two concurrent invocations
   * will run sequentially in arrival order, never in parallel. This protects
   * against the race that used to break the wallpaper / page-build flows when
   * the user kicked off a render queue and then double-clicked something else.
   *
   * Uses a per-call randomized temp filename so concurrent calls never share
   * a script file (the previous implementation overwrote one fixed path).
   * @param {string} jsxCode
   * @param {number} [timeoutMs]
   */
  function executeJSX(jsxCode, timeoutMs = 600000) {
    return enqueue(() => new Promise((resolve, reject) => {
      /** @type {string | undefined} */
      let tmpPath
      try {
        const psApp = getPhotoshopAppName()
        tmpPath = tmpJsxPath()
        fs.writeFileSync(tmpPath, jsxCode)
        const cmd = `osascript -e 'tell application "${psApp}" to do javascript file "${tmpPath}"'`
        exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
          try { fs.unlinkSync(/** @type {string} */ (tmpPath)) } catch (_) {}
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
   * Execute a pre-existing JSX file in Photoshop. Serialized through the queue.
   *
   * @param {string} jsxFilePath - Absolute path to the JSX file
   * @param {number} [timeoutMs] - Optional timeout in ms (0 = none)
   * @param {Record<string, string> | null} [replacements] - Map of `{KEY: value}` whose `__KEY__`
   *                                  placeholders in the JSX source will be
   *                                  substituted before execution. Used to inject
   *                                  per-call data file paths so concurrent calls
   *                                  do not race on /tmp/albumstudio_*.json.
   */
  function executeJSXFile(jsxFilePath, timeoutMs = 0, replacements = null) {
    return enqueue(() => new Promise((resolve, reject) => {
      /** @type {string | null} */
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
        tmpPath = tmpJsxPath()
        fs.writeFileSync(tmpPath, src)

        const cmd = `osascript -e 'tell application "${psApp}" to do javascript file "${tmpPath}"'`
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
   * Run a scripts/*.jsx file with a per-call data JSON injected as
   * __DATA_PATH__, guaranteeing the temp data file is cleaned up afterwards.
   * Centralizes the write-data / run / unlink dance that every simple JSX
   * handler used to repeat verbatim.
   * @param {string} scriptName
   * @param {unknown} data
   * @param {number} [timeoutMs]
   */
  async function runJsxDataJob(scriptName, data, timeoutMs) {
    const dataPath = writeJsonData(data)
    const jsxPath = path.join(scriptsDir, scriptName)
    try {
      return await executeJSXFile(jsxPath, timeoutMs, { DATA_PATH: dataPath })
    } finally {
      try { fs.unlinkSync(dataPath) } catch (_) {}
    }
  }

  return { name: 'macos', getPhotoshopAppName, executeJSX, executeJSXFile, runJsxDataJob }
}

module.exports = { createMacosBridge }
