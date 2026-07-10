// @ts-check
// bridge/temp.js — per-call temp files for the Photoshop bridge. Randomized
// names so concurrent calls never share a script or data file.

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

// Electron's temp path when running inside the app; plain os.tmpdir() when
// required outside Electron (unit tests; CI skips the Electron binary via
// ELECTRON_SKIP_BINARY_DOWNLOAD, which makes require('electron') throw).
function tempDir() {
  try { return require('electron').app.getPath('temp') }
  catch (_) { return require('os').tmpdir() }
}

function tmpJsxPath() {
  return path.join(
    tempDir(),
    `albumstudio_${process.pid}_${crypto.randomBytes(6).toString('hex')}.jsx`
  )
}

/**
 * Write JSON data to a uniquely-named temp file. Returns the absolute path.
 * Caller is responsible for unlinking the file when done.
 * @param {unknown} data
 * @param {string} [filename]
 */
function writeJsonData(data, filename) {
  const fname = filename || `albumstudio_${process.pid}_${crypto.randomBytes(6).toString('hex')}.json`
  const dataPath = path.join(tempDir(), fname)
  fs.writeFileSync(dataPath, JSON.stringify(data))
  return dataPath
}

module.exports = { tmpJsxPath, writeJsonData }
