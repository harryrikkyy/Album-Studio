'use strict'

// Unknown or structural edits require a full pass. Photo transforms apply everywhere the
// photo appears; moving a photo can also affect its previous spread, so it stays a full pass.
function proofScope(ops, album) {
  if (!Array.isArray(ops)) return null
  const spreads = new Set()
  for (const op of ops) {
    if (
      ['setTemplate', 'fitTemplate', 'setPhotos', 'swapPhotos', 'movePhoto', 'removePhoto', 'clearSpread'].includes(
        op.op,
      )
    )
      spreads.add(op.n)
    else if (['rotatePhotos', 'placePhoto', 'adjustPhoto'].includes(op.op)) {
      const ids = new Set(op.ids || [op.id])
      for (const spread of album.spreads) if (spread.photoIds.some((id) => ids.has(id))) spreads.add(spread.n)
    } else return null
  }
  return [...spreads].filter(Number.isInteger)
}

module.exports = { proofScope }
