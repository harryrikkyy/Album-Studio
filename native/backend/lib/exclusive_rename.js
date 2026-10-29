// Node has no atomic no-replace rename. Use the small bundled OS primitive; never fall back
// to a check followed by an overwriting rename or a source unlink.
'use strict'
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const { cliPath } = require('./photocraft')
/** @typedef {import('../../contracts/runtime').RecoverableError} RecoverableError */
const HELPER = 'album-studio-rename-exclusive'

// The helper is found on its own, not only beside whichever engine ALBUM_STUDIO_PHOTOCRAFT_CLI
// names, so a substituted engine still uses the real helper. An explicit ALBUM_STUDIO_RENAME_CLI
// wins; then the app bundle's bin/ (this file is Contents/Resources/app/native/backend/lib), the
// development build, and the configured engine's folder.
function helperCandidates() {
  if (process.env.ALBUM_STUDIO_RENAME_CLI) return [process.env.ALBUM_STUDIO_RENAME_CLI]
  return [
    path.resolve(__dirname, '../../../../bin', HELPER),
    path.join(process.env.HOME || '', 'Library/Caches/AlbumStudioBuild/target/release', HELPER),
    path.join(path.dirname(cliPath()), HELPER),
  ]
}

/** @param {string} source @param {string} target @returns {Promise<void>} */
function renameExclusive(source, target) {
  const candidates = helperCandidates(),
    binary = candidates.find((file) => fs.existsSync(file)) || candidates[0]
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [source, target],
      { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536 },
      (error, _out, stderr) => {
        if (!error) {
          resolve()
          return
        }
        const code = /^([A-Z]+):/m.exec(stderr || '')
        const missing = `The atomic publication helper is missing (looked for ${candidates.join(', ')}). Rebuild the pinned native engine/helpers or set ALBUM_STUDIO_RENAME_CLI before publishing; all existing files were preserved.`
        // Without a code prefix, execFile reports the helper's exit as a number (or null when killed).
        /** @type {Omit<RecoverableError, 'code'> & { code?: string | number | null }} */
        const failure = new Error(
          error.code === 'ENOENT' ? missing : `Atomic file capture failed: ${(stderr || error.message).trim()}`,
          { cause: error },
        )
        failure.code = code ? code[1] : error.code
        reject(failure)
      },
    )
  })
}
module.exports = { renameExclusive, helperCandidates }
