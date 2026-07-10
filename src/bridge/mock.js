// @ts-check
// bridge/mock.js — the E2E PhotoshopBridge: never drives Photoshop.
// runJsxDataJob records each job to the manifest file the Playwright
// export spec asserts on (same double guard as the auth bypass: E2E env
// flag AND non-packaged). The other calls report success without side
// effects.

const fs = require('fs')

/**
 * @param {object} opts
 * @param {string} [opts.logPath]  ALBUMSTUDIO_E2E_JSX_LOG manifest path
 * @returns {import('./index').PhotoshopBridge}
 */
function createMockBridge({ logPath } = {}) {
  return {
    name: 'mock',
    getPhotoshopAppName: () => 'Adobe Photoshop (mocked)',
    executeJSX: async () => 'success',
    executeJSXFile: async () => 'success',
    runJsxDataJob: async (scriptName, data) => {
      if (logPath) {
        try { fs.appendFileSync(logPath, JSON.stringify({ scriptName, data }) + '\n') } catch (_) {}
      }
      return { success: true, mocked: true }
    },
  }
}

module.exports = { createMockBridge }
