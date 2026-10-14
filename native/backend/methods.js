// methods.js — every method the interface can call on the background helper.
// Each takes (params, { emit }) and returns a JSON-serialisable result or throws an Error whose
// message is shown to the user, so messages say what happened and what to do.

'use strict'

const fs = require('fs')
const account = require('./lib/account')
const { openAlbum } = require('./lib/album')
const { createAlbum, inspectCollections, inspectFolders, knownCollections, setAlbumFolders, suggestAlbum } = require('./lib/newalbum')
const { redo, undo, updateAlbum, withProjectLease } = require('./lib/project')
const { refreshProofs, spreadLayout } = require('./lib/proofs')
const { listRecent, rememberAlbum } = require('./lib/recent')
const { cancelExport, exportPlan, exportStatus, startExport } = require('./lib/deliver')
const { cancelRender, renderPlan, renderStatus, startRender } = require('./lib/render')
const { addCollections, collectionTemplates, libraryCollections, removeCollection, setDefaults } = require('./lib/library')
const { listSheets, renameSheets } = require('./lib/labnaming')
const { analyzePhotos, copyPicks } = require('./lib/picks')
const { clearStorage, storageUsage } = require('./lib/storage')
const { listTemplates } = require('./lib/templates')

/** After anything that can change how spreads look: redraw their proofs in the background. */
function withProofs(fn) {
  return async (p, ctx) => {
    const result = await fn(p, ctx)
    refreshProofs(result.album ? result.album.path : result.path, ctx.emit)
    return result
  }
}

const methods = {
  'system.ping': async (p) => ({ pong: p.n ?? null, node: process.version }),

  // The Creative Hubb account: until its check passes, only these answer (see server.js).
  // account.signIn answers when the browser sign-in is done (or failed, cancelled, timed out).
  'account.status': async (p) => account.status(p),
  'account.signIn': async (p, ctx) => account.signIn(p, ctx),
  'account.cancelSignIn': async () => account.cancelSignIn(),
  'account.retry': async () => account.retry(),
  'account.signOut': async () => account.signOut(),

  'album.open': withProofs(async (p) => {
    const album = await withProjectLease(p.path, ({ file, lease }) => require('./lib/output_lock').withProjectOutputs(lease, () => openAlbum({ path: file }), { kind: 'open-project', allowForeignCache: true }), { kind: 'open-project' })
    await rememberAlbum(album)
    return album
  }),

  'album.recent': async () => listRecent(),

  // Starting an album: what the chosen folders hold, collections earlier albums used, a name
  // and place to suggest, and creation (thumbnails → project → first plan; progress as events).
  'folders.inspect': async (p) => inspectFolders(p),
  'templates.collections': async () => knownCollections(),
  'templates.inspect': async (p) => inspectCollections(p),
  'album.suggest': async (p) => suggestAlbum(p),
  'album.create': withProofs((p, ctx) => createAlbum(p, ctx)),
  'album.setFolders': withProofs((p, ctx) => setAlbumFolders(p, ctx)),

  // Edits. Each call is one undo step; the reply carries the updated album.
  'album.update': withProofs((p) => updateAlbum(p)),
  'album.undo': withProofs((p) => undo(p)),
  'album.redo': withProofs((p) => redo(p)),

  'templates.list': async (p) => {
    if (!p.album) throw new Error('missing `album`')
    const album = await openAlbum({ path: p.album })
    const data = JSON.parse(await fs.promises.readFile(album.file, 'utf8'))
    return listTemplates(album.templateCollections.map((c) => c.path), (data.workspace || data).identity)
  },

  'spread.layout': async (p) => spreadLayout(p),

  // Library: the template collections across albums, and which ones new albums start with.
  'library.collections': async () => libraryCollections(),
  'library.add': async (p) => addCollections(p),
  'library.remove': async (p) => removeCollection(p),
  'library.setDefaults': async (p) => setDefaults(p),
  'library.templates': async (p) => collectionTemplates(p),

  // Settings › Storage: what the caches take, and clearing them (all of it can be made again).
  'storage.usage': async (p) => storageUsage(p),
  'storage.clear': async (p) => clearStorage(p),

  // Tools › Lab naming: an order folder's sheets, and a collision-safe, undoable rename.
  'lab.list': async (p) => listSheets(p),
  'lab.rename': async (p) => renameSheets(p),

  // Tools › Best picks: scores for a shoot's photos (progress as events), and copying the picks.
  'picks.analyze': async (p, ctx) => analyzePhotos(p, ctx),
  'picks.copy': async (p) => copyPicks(p),

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

  // Files for the lab and the client (JPEG-High-Res, JPEG-Low-Res, the low-res PDF), made from
  // the rendered sheets. export.start returns at once; progress comes as events.
  'export.plan': async (p) => exportPlan(p),
  'export.start': async (p, ctx) => startExport(p, ctx),
  'export.cancel': async (p) => cancelExport(p),
  'export.status': async () => exportStatus(),
}

module.exports = { methods }
