// Node has no atomic no-replace rename. Use the small bundled OS primitive; never fall back
// to a check followed by an overwriting rename or a source unlink.
'use strict'
const { execFile } = require('child_process')
const path = require('path')
const { cliPath } = require('./photocraft')

function renameExclusive(source, target) {
  const binary = process.env.ALBUM_STUDIO_RENAME_CLI || path.join(path.dirname(cliPath()), 'album-studio-rename-exclusive')
  return new Promise((resolve, reject) => {
    execFile(binary, [source, target], { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536 }, (error, _out, stderr) => {
      if (!error) { resolve(); return }
      const code = /^([A-Z]+):/m.exec(stderr || '')
      const failure = new Error(error.code === 'ENOENT' ? 'The atomic publication helper is missing. Rebuild the pinned native engine/helpers before publishing; all existing files were preserved.' : `Atomic file capture failed: ${(stderr || error.message).trim()}`, { cause: error })
      failure.code = code ? code[1] : error.code
      reject(failure)
    })
  })
}
module.exports = { renameExclusive }
