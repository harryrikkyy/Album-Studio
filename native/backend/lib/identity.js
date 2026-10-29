// Stable identities are additive to the legacy project format. The registry retains absent
// assets, so removing a folder cannot free its IDs for another photograph or template.
'use strict'

const crypto = require('crypto')
const path = require('path')
const { fileURLToPath } = require('url')
const { migrateProject, pageCount, validateIdentity } = require('./project_domain')

const sanitize = (s) => s.replace(/[^a-zA-Z0-9]/g, '_')
const digest = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const workspaceOf = (data) => data.workspace || data
const newSpreadId = () => 'spread_' + crypto.randomUUID()

function registryOf(data) {
  const ws = workspaceOf(data)
  if (!ws.identity) ws.identity = { version: 1, roots: {}, assets: {} }
  const r = ws.identity
  validateIdentity(r)
  r.version = 1
  return r
}

function rootFor(registry, kind, folder) {
  const resolved = path.resolve(folder)
  const found = Object.entries(registry.roots).find(
    ([, r]) => r && r.kind === kind && typeof r.path === 'string' && path.resolve(r.path) === resolved,
  )
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
    const rootId = candidate.identityRootId || rootFor(registry, kind, candidate.canonicalRoot || root)
    if (!registry.roots[rootId] || registry.roots[rootId].kind !== kind)
      throw new Error('The source root identity could not be verified. Preserve the project before retrying.')
    const relativePath = path.relative(path.resolve(root), path.resolve(file))
    if (!relativePath || relativePath.startsWith('..' + path.sep) || path.isAbsolute(relativePath))
      throw new Error('An asset is outside its source folder.')
    return { ...candidate, legacyId: candidate.legacyId || candidate.id, rootId, relativePath }
  })
  const counts = new Map()
  for (const a of located) {
    if (!counts.has(a.legacyId)) counts.set(a.legacyId, new Set())
    counts.get(a.legacyId).add(JSON.stringify([a.rootId, a.relativePath]))
  }
  // A missing asset still owns every name by which an old project can refer to it.
  // Looking only for an exact registry key would let a new photo claim a formerly
  // ambiguous alias after all of its original folders were removed.
  const reserved = new Set(Object.keys(registry.assets))
  for (const asset of Object.values(registry.assets)) {
    reserved.add(asset.legacyId)
    for (const alias of asset.legacyAliases || []) reserved.add(alias)
  }
  const records = new Map()
  for (const [id, a] of Object.entries(registry.assets)) {
    if (a && a.kind === kind) records.set(JSON.stringify([a.rootId, path.normalize(a.relativePath)]), id)
  }
  const seen = new Map()
  return located
    .filter((a) => {
      const key = JSON.stringify([a.rootId, a.relativePath])
      if (seen.has(key)) {
        const first = seen.get(key)
        first.legacyAliases = [...new Set([...(first.legacyAliases || []), a.legacyId, ...(a.legacyAliases || [])])]
        first.locatorAliases = [...new Set([...(first.locatorAliases || []), ...(a.locatorAliases || [])])]
        return false
      }
      seen.set(key, a)
      return true
    })
    .map((a) => {
      const key = JSON.stringify([a.rootId, a.relativePath])
      let id = records.get(key)
      if (!id) {
        const availableLegacy = counts.get(a.legacyId).size === 1 && !reserved.has(a.legacyId)
        id = availableLegacy ? a.legacyId : a.legacyId + '__' + digest([kind, a.rootId, a.relativePath])
        const occupied = registry.assets[id]
        if (
          occupied &&
          (occupied.kind !== kind || occupied.rootId !== a.rootId || occupied.relativePath !== a.relativePath)
        ) {
          throw new Error('Two assets have the same identity. Restore the album backup before editing.')
        }
        registry.assets[id] = { kind, rootId: a.rootId, relativePath: a.relativePath, legacyId: a.legacyId }
        reserved.add(id)
        reserved.add(a.legacyId)
        records.set(key, id)
      }
      const saved = registry.assets[id]
      const aliases = [...new Set([...(saved.legacyAliases || []), ...(a.legacyAliases || []), a.legacyId])].filter(
        (alias) => alias !== saved.legacyId,
      )
      if (aliases.length) saved.legacyAliases = aliases
      for (const alias of aliases) reserved.add(alias)
      return { ...a, id, legacyAliases: aliases }
    })
}

function fileFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null
  try {
    return fileURLToPath(url)
  } catch (_) {
    return null
  }
}

function referenceIndex(candidates, kind, registry) {
  const byId = new Map(),
    byLegacy = new Map(),
    aliases = new Map()
  for (const asset of candidates) {
    byId.set(asset.id, asset)
    for (const alias of new Set([asset.legacyId, ...(asset.legacyAliases || [])])) {
      if (!byLegacy.has(alias)) byLegacy.set(alias, [])
      byLegacy.get(alias).push(asset)
    }
  }
  for (const entry of Object.entries(registry.assets)) {
    const asset = entry[1]
    if (asset.kind !== kind) continue
    for (const alias of new Set([asset.legacyId, ...(asset.legacyAliases || [])])) {
      if (!aliases.has(alias)) aliases.set(alias, [])
      aliases.get(alias).push(entry)
    }
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
  const exact = kind === 'photo' ? fileFromUrl(entry.url) : typeof entry.file === 'string' ? entry.file : null
  if (exact) {
    const located = matches.filter((a) =>
      [kind === 'photo' ? a.thumb : a.file, ...(a.locatorAliases || [])].some(
        (file) => path.resolve(file) === path.resolve(exact),
      ),
    )
    if (located.length === 1) return { asset: located[0] }
    const absent = aliases.filter(([, a]) => {
      const root = registry.roots[a.rootId]
      return (
        root &&
        [root.path, ...(root.aliases || [])].some(
          (folder) => path.resolve(folder, a.relativePath) === path.resolve(exact),
        )
      )
    })
    if (absent.length === 1) return { id: absent[0][0], asset: null }
  }
  if (direct && record) return { asset: direct }
  if (aliases.length === 1 && matches.length === 1) return { asset: matches[0] }
  if (aliases.length > 1)
    return { conflict: { kind, id: entry.id, reason: 'ambiguous-reference', candidates: aliases.map(([id]) => id) } }
  return { asset: null }
}

/**
 * Materialise stable IDs once, before operations can move or replace page positions.
 * @param {{ seed?: string }} [options]
 */
function ensureSpreadIds(data, options = {}) {
  const { seed } = options
  migrateProject(data)
  const seen = new Set()
  const total = pageCount(data)
  data.albumPages ||= {}
  for (let n = 1; n <= total; n++) {
    const page = (data.albumPages[n] ||= { photos: [], template: null })
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
  if (
    Object.values(registry.roots).some(
      (r) => r !== root && r.kind === kind && path.resolve(r.path) === path.resolve(to),
    )
  )
    throw new Error('That folder already belongs to a different album source.')
  root.path = path.resolve(to)
  delete root.canonicalPath
  delete root.aliases
}

module.exports = {
  sanitize,
  registryOf,
  rootFor,
  assignAssetIds,
  referenceIndex,
  resolveReference,
  fileFromUrl,
  ensureSpreadIds,
  newSpreadId,
  relinkRoot,
}
