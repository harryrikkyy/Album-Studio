// User-selected document destinations cannot adopt private recovery/ownership
// records. The canonical sheets directory is the one editable managed location.
// Callers provide a resolved physical directory and retain its identity checks.
'use strict'
const path = require('path')
function assertPublicationParent(folder) {
  const parts = folder.split(path.sep)
  for (const [index, part] of parts.entries()) {
    const name = part.toLowerCase()
    if (!name.startsWith('.album-studio')) continue
    if (name === '.album-studio' && index === parts.length - 2 && parts[index + 1].toLowerCase() === 'sheets') continue
    const error = new Error('Recovery evidence and application metadata cannot be changed by an ordinary save. Save your edits in a document folder to preserve the recovery files.')
    error.code = 'PUBLICATION_PRIVATE_PATH'
    throw error
  }
}
module.exports = { assertPublicationParent }
