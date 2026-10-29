// Filesystem adapter for identity's pure registry rules. Physical aliases can share a new
// identity; separately saved identities remain distinct and require an explicit choice.
'use strict'
const fs = require('fs')
const path = require('path')
const { rootFor } = require('./identity')

async function canonical(folder) {
  try {
    return await fs.promises.realpath(folder)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  }
}
async function prepareSourceAliases(candidates, kind, registry) {
  const logicalRoots = [...new Set(candidates.map((a) => path.resolve(a.folder || a.sourceRoot)))],
    groups = new Map(),
    chosen = new Map(),
    conflicts = []
  for (const folder of logicalRoots) {
    const real = await canonical(folder)
    if (!real) continue
    if (!groups.has(real)) groups.set(real, [])
    groups.get(real).push(folder)
  }
  const savedByCanonical = new Map()
  for (const [id, root] of Object.entries(registry.roots)) {
    if (root.kind !== kind) continue
    const real = root.canonicalPath || (await canonical(root.path))
    if (!real) continue
    if (!savedByCanonical.has(real)) savedByCanonical.set(real, [])
    savedByCanonical.get(real).push([id, root])
  }
  for (const [real, folders] of groups) {
    const saved = savedByCanonical.get(real) || [],
      selected = new Set(),
      unresolved = []
    for (const folder of folders) {
      const exact = saved.filter(
        ([, root]) => path.resolve(root.path) === folder || (root.aliases || []).includes(folder),
      )
      let id
      if (exact.length === 1) id = exact[0][0]
      else if (!exact.length && saved.length === 1) id = saved[0][0]
      else if (!saved.length) id = rootFor(registry, kind, real)
      else {
        unresolved.push(folder)
        continue
      }
      chosen.set(folder, { id, real, aliases: folders })
      selected.add(id)
    }
    if (saved.length <= 1) {
      const id = selected.values().next().value
      if (id) {
        const root = registry.roots[id]
        root.canonicalPath = real
        root.aliases = [...new Set([...(root.aliases || []), root.path, real, ...folders])]
      }
    }
    if (selected.size > 1 || unresolved.length)
      conflicts.push({
        kind,
        id: saved[0][0],
        reason: 'physical-source-alias',
        candidates: saved.map(([id]) => id),
        field: 'sourceRoots',
      })
  }
  const resolved = candidates.flatMap((a) => {
    const logical = path.resolve(a.folder || a.sourceRoot),
      root = chosen.get(logical)
    if (!root) return []
    const file = kind === 'photo' ? a.thumb : a.file,
      relative = path.relative(logical, path.resolve(file))
    return [
      {
        ...a,
        identityRootId: root.id,
        canonicalRoot: root.real,
        locatorAliases: [
          ...new Set([
            file,
            path.join(root.real, relative),
            ...root.aliases.map((folder) => path.join(folder, relative)),
            ...(registry.roots[root.id].aliases || []).map((folder) => path.join(folder, relative)),
          ]),
        ],
      },
    ]
  })
  return { candidates: resolved, conflicts }
}
module.exports = { prepareSourceAliases }
