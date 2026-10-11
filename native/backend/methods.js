// methods.js — every method the interface can call on the background helper.
// Each takes (params, { emit }) and returns a JSON-serialisable result or throws an Error whose
// message is shown to the user, so messages say what happened and what to do.

'use strict'

const { openAlbum } = require('./lib/album')
const { redo, undo, updateAlbum } = require('./lib/project')
const { refreshProofs } = require('./lib/proofs')
const { listRecent, rememberAlbum } = require('./lib/recent')
const { cancelRender, renderPlan, renderStatus, startRender } = require('./lib/render')
const { listTemplates } = require('./lib/templates')

/** After anything that can change how spreads look: redraw their proofs in the background. */
function withProofs(fn) {
  return async (p, ctx) => {
    const result = await fn(p)
    refreshProofs(result.album ? result.album.path : result.path, ctx.emit)
    return result
  }
}

const methods = {
  'system.ping': async (p) => ({ pong: p.n ?? null, node: process.version }),

  'album.open': withProofs(async (p) => {
    const album = await openAlbum(p)
    await rememberAlbum(album)
    return album
  }),

  'album.recent': async () => listRecent(),

  // Edits. Each call is one undo step; the reply carries the updated album.
  'album.update': withProofs((p) => updateAlbum(p)),
  'album.undo': withProofs((p) => undo(p)),
  'album.redo': withProofs((p) => redo(p)),

  'templates.list': async (p) => {
    if (!p.album) throw new Error('missing `album`')
    const album = await openAlbum({ path: p.album })
    return listTemplates(album.templateCollections.map((c) => c.path))
  },

  // Proofs refresh on their own after edits; this asks for one explicitly (e.g. after the
  // photos changed on disk).
  'proofs.refresh': async (p, ctx) => {
    if (!p.album) throw new Error('missing `album`')
    return refreshProofs(p.album, ctx.emit)
  },

  // Sheets built by PhotoCraft. render.start returns at once; progress comes as events.
  'render.start': async (p, ctx) => startRender(p, ctx),
  'render.cancel': async (p) => cancelRender(p),
  'render.status': async () => renderStatus(),
  'render.plan': async (p) => renderPlan(p),
}

module.exports = { methods }
