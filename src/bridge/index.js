// @ts-check
// bridge/index.js — the PhotoshopBridge interface + platform factory.
// Every ExtendScript/JSX call the main process makes goes through one
// bridge instance, so the Photoshop contract lives behind a single seam:
// macOS drives Photoshop via osascript, E2E runs get a recording mock,
// and the Windows implementation (PowerShell/COM) slots in here in
// Phase 7 without touching any caller.

const path = require('path')

/**
 * @typedef {object} PhotoshopBridge
 * @property {string} name  implementation tag ('macos' | 'mock' | 'windows')
 * @property {() => string} getPhotoshopAppName
 * @property {(jsxCode: string, timeoutMs?: number) => Promise<string>} executeJSX
 * @property {(jsxFilePath: string, timeoutMs?: number, replacements?: Record<string, string> | null) => Promise<string>} executeJSXFile
 * @property {(scriptName: string, data: unknown, timeoutMs?: number) => Promise<any>} runJsxDataJob
 */

/**
 * @param {object} [opts]  overrides for tests; defaults read the real environment
 * @param {string} [opts.platform]
 * @param {boolean} [opts.e2e]
 * @param {string} [opts.jsxLogPath]
 * @param {string} [opts.scriptsDir]
 * @returns {PhotoshopBridge}
 */
function createPhotoshopBridge(opts = {}) {
  const e2e = opts.e2e !== undefined
    ? opts.e2e
    : (process.env.ALBUMSTUDIO_E2E === '1' && !isPackaged())
  if (e2e) {
    return require('./mock').createMockBridge({
      logPath: opts.jsxLogPath !== undefined ? opts.jsxLogPath : process.env.ALBUMSTUDIO_E2E_JSX_LOG,
    })
  }
  const platform = opts.platform || process.platform
  if (platform === 'darwin') {
    return require('./macos').createMacosBridge({
      scriptsDir: opts.scriptsDir || path.join(__dirname, '..', '..', 'scripts'),
    })
  }
  throw new Error(`No PhotoshopBridge implementation for ${platform} yet (Windows lands in Phase 7)`)
}

function isPackaged() {
  try { return require('electron').app.isPackaged } catch (_) { return false }
}

// One bridge per process — the macOS impl's queue must serialize ALL JSX
// calls, so everything shares this instance.
/** @type {PhotoshopBridge | null} */
let _bridge = null
function getBridge() {
  if (!_bridge) _bridge = createPhotoshopBridge()
  return _bridge
}

module.exports = { createPhotoshopBridge, getBridge }
