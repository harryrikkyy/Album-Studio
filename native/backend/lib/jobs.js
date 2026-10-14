// One heavy filesystem/engine job owns a lease from preparation through final publication.
'use strict'
const crypto = require('crypto')
const path = require('path')
const { canonicalProject, acquireProjectLease, serializeProject } = require('./project_lock')
let active = null

async function reserveJob(kind, album) {
  if (active) throw new Error(`An ${active.kind === 'export' ? 'export' : 'album render'} is already starting or running. Wait for it, or stop it.`)
  const lease = { id: crypto.randomUUID(), kind, requested: path.resolve(album), album: null, file: null }
  active = lease
  try {
    const location = await canonicalProject(album)
    lease.project = await serializeProject(location.file, () => acquireProjectLease(location, { kind }))
    lease.album = location.folder; lease.file = location.file
    return lease
  } catch (error) { if (active === lease) active = null; throw error }
}
async function identifyJob(lease, album) {
  if (active !== lease) throw new Error('The operation no longer owns its job lease.')
  const location = await canonicalProject(album.file)
  if (location.folder !== lease.album || location.file !== lease.file) throw new Error('The running job resolved to a different project. Preserve its files before retrying.')
  await lease.project.assertOwned()
}
async function releaseJob(lease) {
  try { if (lease.project) await lease.project.release() }
  finally { if (active === lease) active = null }
}
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
