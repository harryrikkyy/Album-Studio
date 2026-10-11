// inputs.js — everything that decides how a spread looks, as plain data for hashing: its
// template file, its photos (file, orientation, rotation, zoom/pan, colour) and its page edits.
// Rendered sheets and live proofs hash the same inputs, each salted with its own version.

'use strict'

const crypto = require('crypto')
const { fileStamp } = require('./cache')

async function spreadInputs(spread, album, ws) {
  const n = spread.n
  const photos = await Promise.all(spread.photoIds.map(async (id) => {
    const p = album.photos[id]
    const file = p && (p.original || p.thumb)
    return [id, file, file ? await fileStamp(file) : 'missing', p && p.orient,
      (ws.imageRotations || {})[id] || 0, (ws.imagePlacements || {})[id] || null, (ws.imageAdjustments || {})[id] || null]
  }))
  const tpl = spread.template && spread.template.file
  return [tpl, tpl ? await fileStamp(tpl) : null, photos,
    (ws.pageOverlays || {})[n] || null, (ws.pageLayerEdits || {})[n] || null, (ws.pageBackgrounds || {})[n] || null]
}

/** sha256 of the salt followed by the spread's inputs. */
async function inputsHash(salt, spread, album, ws) {
  return crypto.createHash('sha256').update(JSON.stringify([...salt, ...(await spreadInputs(spread, album, ws))])).digest('hex')
}

module.exports = { spreadInputs, inputsHash }
