// One heavy filesystem/engine job owns a lease from preparation through final publication.
'use strict'
const crypto = require('crypto')
const path = require('path')
let active = null

function reserveJob(kind, album) {
  if (active) throw new Error(`An ${active.kind === 'export' ? 'export' : 'album render'} is already starting or running. Wait for it, or stop it.`)
  const lease = { id: crypto.randomUUID(), kind, requested: path.resolve(album), album: null, file: null }
  active = lease
  return lease
}
function identifyJob(lease, album) {
  if (active !== lease) throw new Error('The operation no longer owns its job lease.')
  lease.album = path.resolve(album.path)
  lease.file = path.resolve(album.file)
}
function releaseJob(lease) { if (active === lease) active = null }
function activeJob() { return active }
function spreadSelection(requested, spreads) {
  if (requested === undefined || requested === null) return null
  if (!Array.isArray(requested) || !requested.length || new Set(requested).size !== requested.length || requested.some((n) => !Number.isInteger(n) || !spreads.some((sp) => sp.n === n))) throw new Error('Select existing spreads once each; an empty selection cannot start a job.')
  return new Set(requested)
}
function assertProjectIdle(file, folder) {
  if (!active) return
  const keys = [file, folder].map((p) => path.resolve(p))
  if ([active.requested, active.album, active.file].some((p) => p && keys.includes(p))) {
    throw new Error(`This album is ${active.kind === 'export' ? 'exporting' : 'rendering'}. Wait for the job to finish, or stop it before editing.`)
  }
}
module.exports = { reserveJob, identifyJob, releaseJob, activeJob, assertProjectIdle, spreadSelection }
