// Output admission recovers native file transactions before consumers interpret
// missing or newly installed sheets. File and project/output scopes stay owned.
'use strict'
const fs = require('fs')
const path = require('path')
const { acquirePublicationDirectories } = require('./namespace_lock')
const { recoverFiles } = require('./file_publication')
async function recoverOutputFiles(project, outputs, output, { delivery = false } = {}) {
  const folders = [output, path.join(output, '.album-studio', 'sheets')]
  if (delivery) { const root = path.dirname(output); folders.push(root, path.join(root, 'JPEG-High-Res'), path.join(root, 'JPEG-Low-Res')) }
  const recovered = []
  for (const folder of [...new Set(folders)]) {
    const metadata = path.join(folder, '.album-studio-publications')
    const present = await fs.promises.lstat(metadata).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!present) continue
    await project.assertOwned(); await outputs.assertOwned()
    const files = await acquirePublicationDirectories([path.join(folder, 'recovery-scope')], { enclosing: outputs })
    let result, failure
    try {
      result = await recoverFiles(folder, { async assertOwned() { await project.assertOwned(); await outputs.assertOwned(); await files.assertOwned() }, assertTarget: file => files.assertTarget(file) })
    } catch (error) {
      if (error.publicationCommitted) error.message = `An earlier native save committed; its recovery must finish before a new output operation. ${error.message}`
      failure = error
    }
    try { await files.release() } catch (error) { if (failure) failure.message += ` File reservation release also failed: ${error.message}`; else failure = error }
    if (failure) throw failure
    recovered.push({ folder, ...result })
  }
  return recovered
}
async function assertManagedRendersSettled(files) {
  for (const { folder, scope } of await files.managedDirectories()) {
    if (scope === 'sheets') await require('./render_transaction').assertRendersSettled(folder)
  }
}
module.exports = { recoverOutputFiles, assertManagedRendersSettled }
