// inputs.js — everything that decides how a spread looks, as plain data for hashing: its
// template file, its photos (file, orientation, rotation, zoom/pan, colour) and its page edits.
// Rendered sheets and live proofs hash the same inputs, each salted with its own version.

'use strict'

const crypto = require('crypto')
const { fileDigest } = require('./cache')
const CONTENT_HASH_PREFIX = 'inputs-sha256-1:'

async function sourceDigest(file) {
  if (!file) return 'missing'
  try { return await fileDigest(file) } catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e }
}

async function spreadInputs(spread, album, ws) {
  const n = spread.n
  const photos = await Promise.all(spread.photoIds.map(async (id) => {
    const p = album.photos[id]
    const file = p && (p.original || p.thumb)
    return [id, file, await sourceDigest(file), p && p.orient,
      (ws.imageRotations || {})[id] || 0, (ws.imagePlacements || {})[id] || null, (ws.imageAdjustments || {})[id] || null]
  }))
  const tpl = spread.template && spread.template.file
  return [tpl, tpl ? await sourceDigest(tpl) : null, photos,
    (ws.pageOverlays || {})[n] || null, (ws.pageLayerEdits || {})[n] || null, (ws.pageBackgrounds || {})[n] || null]
}

/** sha256 of the salt followed by the spread's inputs. */
async function inputsHash(salt, spread, album, ws) {
  return hashInputValues(salt, await spreadInputs(spread, album, ws))
}
const hashInputValues = (salt, inputs) => CONTENT_HASH_PREFIX + crypto.createHash('sha256').update(JSON.stringify([...salt, ...inputs])).digest('hex')

const contentVerified = (record) => !!(record && typeof record.hash === 'string' && new RegExp(`^${CONTENT_HASH_PREFIX}[a-f0-9]{64}$`).test(record.hash))

module.exports = { spreadInputs, inputsHash, hashInputValues, contentVerified, CONTENT_HASH_PREFIX }
