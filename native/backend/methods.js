// methods.js — every method the interface can call on the background helper.
// Each takes (params, { emit }) and returns a JSON-serialisable result or throws an Error whose
// message is shown to the user, so messages say what happened and what to do.

'use strict'

const { openAlbum } = require('./lib/album')
const { listRecent, rememberAlbum } = require('./lib/recent')

const methods = {
  'system.ping': async (p) => ({ pong: p.n ?? null, node: process.version }),

  'album.open': async (p) => {
    const album = await openAlbum(p)
    await rememberAlbum(album)
    return album
  },

  'album.recent': async () => listRecent(),
}

module.exports = { methods }
