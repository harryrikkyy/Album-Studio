// Stable identities are additive to the legacy project format. The registry retains absent
// assets, so removing a folder cannot free its IDs for another photograph or template.
'use strict'

const crypto = require('crypto')
const path = require('path')
const { fileURLToPath } = require('url')

const sanitize = (s) => s.replace(/[^a-zA-Z0-9]/g, '_')
const digest = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const workspaceOf = (data) => data.workspace || data
const newSpreadId = () => 'spread_' + crypto.randomUUID()

function registryOf(data) {
  const ws = workspaceOf(data)
  if (!ws.identity) ws.identity = { version: 1, roots: {}, assets: {} }
  const r = ws.identity
  if (r.version !== 1 || !r.roots || !r.assets || typeof r.roots !== 'object' || typeof r.assets !== 'object' || Array.isArray(r.roots) || Array.isArray(r.assets)) {
    throw new Error('The album identity registry is invalid. Restore project.json.bak before editing this album.')
  }
  const bad = () => { throw new Error('The album identity registry is invalid. Restore project.json.bak before editing this album.') }
  for (const [id, root] of Object.entries(r.roots)) {
    if (!/^root_[a-zA-Z0-9_-]+$/.test(id) || !root || !['photo', 'template'].includes(root.kind) || typeof root.path !== 'string' || !path.isAbsolute(root.path)) bad()
  }
  const seen = new Set()
  for (const [id, asset] of Object.entries(r.assets)) {
    if (!asset || !['photo', 'template'].includes(asset.kind) || !/^(img|tpl)_[a-zA-Z0-9_-]+$/.test(id) || typeof asset.legacyId !== 'string' || typeof asset.relativePath !== 'string' || !asset.relativePath || path.isAbsolute(asset.relativePath) || asset.relativePath === '..' || asset.relativePath.startsWith('..' + path.sep) || !r.roots[asset.rootId] || r.roots[asset.rootId].kind !== asset.kind) bad()
    const locator = JSON.stringify([asset.kind, asset.rootId, asset.relativePath])
    if (seen.has(locator)) bad()
    seen.add(locator)
  }
  return r
}

function rootFor(registry, kind, folder) {
  const resolved = path.resolve(folder)
  const found = Object.entries(registry.roots).find(([, r]) => r && r.kind === kind && typeof r.path === 'string' && path.resolve(r.path) === resolved)
  if (found) return found[0]
  const id = 'root_' + digest([kind, resolved])
  registry.roots[id] = { kind, path: resolved }
  return id
}

/** Registry-assigned legacy IDs remain stable; only genuinely new collisions get a suffix. */
function assignAssetIds(candidates, kind, registry) {
  const located = candidates.map((candidate) => {
    const root = candidate.folder || candidate.sourceRoot
    const file = kind === 'photo' ? candidate.thumb : candidate.file
    const rootId = rootFor(registry, kind, root)
    const relativePath = path.relative(path.resolve(root), path.resolve(file))
    if (!relativePath || relativePath.startsWith('..' + path.sep) || path.isAbsolute(relativePath)) throw new Error('An asset is outside its source folder.')
    return { ...candidate, legacyId: candidate.legacyId || candidate.id, rootId, relativePath }
  })
  const counts = new Map()
  for (const a of located) counts.set(a.legacyId, (counts.get(a.legacyId) || 0) + 1)
  const records = new Map()
  for (const [id, a] of Object.entries(registry.assets)) {
    if (a && a.kind === kind) records.set(JSON.stringify([a.rootId, a.relativePath]), id)
  }
  const seen = new Set()
  return located.filter((a) => {
    const key = JSON.stringify([a.rootId, a.relativePath])
    if (seen.has(key)) return false // duplicate folder tokens never duplicate the same asset
    seen.add(key)
    return true
  }).map((a) => {
    const key = JSON.stringify([a.rootId, a.relativePath])
    let id = records.get(key)
    if (!id) {
      const availableLegacy = counts.get(a.legacyId) === 1 && !Object.hasOwn(registry.assets, a.legacyId)
      id = availableLegacy ? a.legacyId : a.legacyId + '__' + digest([kind, a.rootId, a.relativePath])
      const occupied = registry.assets[id]
      if (occupied && (occupied.kind !== kind || occupied.rootId !== a.rootId || occupied.relativePath !== a.relativePath)) {
        throw new Error('Two assets have the same identity. Restore the album backup before editing.')
      }
      registry.assets[id] = { kind, rootId: a.rootId, relativePath: a.relativePath, legacyId: a.legacyId }
      records.set(key, id)
    }
    return { ...a, id }
  })
}

function fileFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null
  try { return fileURLToPath(url) } catch (_) { return null }
}

function referenceIndex(candidates, kind, registry) {
  const byId = new Map(), byLegacy = new Map(), aliases = new Map()
  for (const asset of candidates) {
    byId.set(asset.id, asset)
    if (!byLegacy.has(asset.legacyId)) byLegacy.set(asset.legacyId, [])
    byLegacy.get(asset.legacyId).push(asset)
  }
  for (const entry of Object.entries(registry.assets)) {
    const asset = entry[1]
    if (asset.kind !== kind) continue
    if (!aliases.has(asset.legacyId)) aliases.set(asset.legacyId, [])
    aliases.get(asset.legacyId).push(entry)
  }
  return { byId, byLegacy, aliases }
}

/** An alias alone is evidence only when it selects exactly one asset. */
function resolveReference(entry, candidates, kind, registry, index = referenceIndex(candidates, kind, registry)) {
  const direct = index.byId.get(entry.id)
  const record = registry.assets[entry.id]
  const matches = index.byLegacy.get(entry.id) || []
  const aliases = index.aliases.get(entry.id) || []
  // Photos saved by the old app usually include the exact thumbnail URL. Template thumbnail
  // URLs are not PSD locators: two nested templates can share one thumbnail.
  const exact = kind === 'photo' ? fileFromUrl(entry.url) : (typeof entry.file === 'string' ? entry.file : null)
  if (exact) {
    const located = matches.filter((a) => path.resolve(kind === 'photo' ? a.thumb : a.file) === path.resolve(exact))
    if (located.length === 1) return { asset: located[0] }
    const absent = aliases.filter(([, a]) => {
      const root = registry.roots[a.rootId]
      return root && path.resolve(root.path, a.relativePath) === path.resolve(exact)
    })
    if (absent.length === 1) return { id: absent[0][0], asset: null }
  }
  if (direct && record) return { asset: direct }
  if (aliases.length === 1 && matches.length === 1) return { asset: matches[0] }
  if (aliases.length > 1) return { conflict: { kind, id: entry.id, reason: 'ambiguous-reference', candidates: aliases.map(([id]) => id) } }
  return { asset: null }
}

/** Materialise stable IDs once, before operations can move or replace page positions. */
function ensureSpreadIds(data, { seed } = {}) {
  const seen = new Set()
  const total = Math.max(1, Number(data.totalActivePages) || Object.keys(data.albumPages || {}).length || 1)
  data.albumPages ||= {}
  for (let n = 1; n <= total; n++) {
    const page = data.albumPages[n] ||= { photos: [], template: null }
    if (page.id && (typeof page.id !== 'string' || !/^spread_[a-zA-Z0-9_-]+$/.test(page.id) || seen.has(page.id))) {
      throw new Error('The album has an invalid or duplicate spread identity. Restore project.json.bak before editing.')
    }
    page.id ||= seed ? 'spread_' + digest([seed, n]) : newSpreadId()
    seen.add(page.id)
  }
}

/** Explicit relink preserves root identity; changing folder lists alone is never a relink. */
function relinkRoot(data, kind, from, to) {
  const registry = registryOf(data)
  const root = Object.values(registry.roots).find((r) => r.kind === kind && path.resolve(r.path) === path.resolve(from))
  if (!root) throw new Error('That source folder has no saved identity. Open and save the album before relinking it.')
  if (Object.values(registry.roots).some((r) => r !== root && r.kind === kind && path.resolve(r.path) === path.resolve(to))) throw new Error('That folder already belongs to a different album source.')
  root.path = path.resolve(to)
}

module.exports = { sanitize, registryOf, assignAssetIds, referenceIndex, resolveReference, fileFromUrl, ensureSpreadIds, newSpreadId, relinkRoot }
