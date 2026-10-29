// User-selected document destinations cannot adopt private recovery/ownership
// records. The canonical sheets directory is the one editable managed location.
// Callers provide a resolved physical directory and retain its identity checks.
'use strict'
const path = require('path')
// APFS compares names case-insensitively and folds letters such as the long s (ſ) onto s.
const folded = (name) => name.normalize('NFC').toUpperCase().toLowerCase()
/** Whether a file or folder name is one of Album Studio's private names, in any letter case. */
const isPrivateName = (name) => folded(name).startsWith('.album-studio')
function assertPublicationParent(folder) {
  const parts = folder.split(path.sep)
  for (const [index, part] of parts.entries()) {
    if (!isPrivateName(part)) continue
    if (folded(part) === '.album-studio' && index === parts.length - 2 && folded(parts[index + 1]) === 'sheets')
      continue
    const error = new Error(
      'Recovery evidence and application metadata cannot be changed by an ordinary save. Save your edits in a document folder to preserve the recovery files.',
    )
    error.code = 'PUBLICATION_PRIVATE_PATH'
    throw error
  }
}
module.exports = { assertPublicationParent, isPrivateName }
