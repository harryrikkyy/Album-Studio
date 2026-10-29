// storage.js — cache sizes and preservation-first clear requests. Existing category names
// do not prove that every contained file is regenerable or still owned by this backend:
//   app caches (~/Library/Caches/Album Studio): template backdrops and frame shapes, RAW previews,
//     lab-naming thumbnails, Best-picks scores;
//   an album's own (in its print-sheet folder, .album-studio): developed RAW photos and
//     colour-adjusted copies used for rendering. Its render record stays.

'use strict'

const fs = require('fs')
const path = require('path')
const { openAlbum } = require('./album')
const { cacheRoot } = require('./cache')
const { validateOutputPaths } = require('./output_paths')

const APP = [
  { id: 'templates', label: 'Template backdrops and frame shapes' },
  { id: 'raw-previews', label: 'RAW previews' },
  { id: 'lab-thumbs', label: 'Lab naming thumbnails' },
  { id: 'picks', label: 'Best picks scores' },
]
const ALBUM = [
  { id: 'raw', label: 'Developed RAW photos' },
  { id: 'adjusted', label: 'Colour-adjusted photos' },
]

async function sizeOf(dir) {
  let bytes = 0
  let files = 0
  const walk = async (d) => {
    for (const e of await fs.promises.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) {
        bytes += (await fs.promises.stat(p).catch(() => ({ size: 0 }))).size
        files++
      }
    }
  }
  await walk(dir)
  return { bytes, files }
}

async function albumCacheDir(albumPath) {
  const a = await openAlbum({ path: albumPath })
  return path.join(a.outputFolder || path.join(a.path, 'exports'), '.album-studio')
}

// No persistent ownership catalogue exists for every legacy/global cache writer yet.
// A category name cannot authorize deleting manual edits, recovery evidence or live work.
// Empty categories are a no-op so clearing cannot race a cooperating or external creator.
async function preserveNonemptyCache(file) {
  const info = await fs.promises.lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info) return
  let nonempty = false
  if (info.isDirectory() && !info.isSymbolicLink()) {
    const directory = await fs.promises.opendir(file)
    try {
      nonempty = !!(await directory.read())
    } finally {
      await directory.close()
    }
  }
  if (!info.isDirectory() || info.isSymbolicLink() || nonempty) {
    throw Object.assign(
      new Error(
        `The cache ${file} contains existing files or uncertain ownership. All cache files, active private work and retained histories were preserved. Safe reclamation requires verified ownership and coordination with every cache writer; preserve this path before retrying.`,
      ),
      { code: 'CACHE_CLEAR_PRESERVED', retainedPath: file },
    )
  }
}

/**
 * Sizes of the app's caches, and of the open album's when given.
 * @param {{ album?: string }} [options]
 */
async function storageUsage({ album } = {}) {
  const app = await Promise.all(
    APP.map(async (c) => ({ ...c, scope: 'app', ...(await sizeOf(path.join(cacheRoot(), c.id))) })),
  )
  let albumCaches = []
  if (album) {
    const dir = await albumCacheDir(album)
    albumCaches = await Promise.all(
      ALBUM.map(async (c) => ({ ...c, scope: 'album', ...(await sizeOf(path.join(dir, c.id))) })),
    )
  }
  return {
    root: cacheRoot(),
    caches: [...app, ...albumCaches],
    retention: await require('./private_stage').privateStageUsage(cacheRoot()),
  }
}

/** Clear caches: `ids` from the app's list, and with `album`, from the album's. */
async function clearStorage({ ids, album }) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('Choose what to clear.')
  for (const id of ids)
    if (!APP.some((c) => c.id === id) && !(album && ALBUM.some((c) => c.id === id)))
      throw new Error(`Unknown cache \`${id}\`.`)
  for (const id of ids) if (APP.some((c) => c.id === id)) await preserveNonemptyCache(path.join(cacheRoot(), id))
  if (album)
    return require('./project').withProjectLease(
      album,
      async ({ lease }) =>
        require('./output_lock').withProjectOutputs(
          lease,
          async () => {
            const dir = await albumCacheDir(album)
            await lease.outputNamespace.assertFor(path.dirname(dir))
            await validateOutputPaths(path.dirname(dir))
            for (const id of ids) {
              await lease.assertOwned()
              if (APP.some((c) => c.id === id)) await preserveNonemptyCache(path.join(cacheRoot(), id))
              else {
                // Revalidate the actual managed descendants at the removal boundary. Never follow
                // an intermediate metadata alias or prune retained source/recovery directories.
                const checked = await validateOutputPaths(path.dirname(dir)),
                  selected = checked.directories[id]
                if (selected.descendantDirectories.length)
                  throw new Error(
                    `The cache ${selected.path} contains retained recovery or unknown directories. Preserve ${selected.descendantDirectories.join(', ')} before clearing ordinary cache files; no histories were removed.`,
                  )
                if (selected.identity) await preserveNonemptyCache(selected.path)
              }
            }
            return storageUsage({ album })
          },
          { kind: 'cache-clear' },
        ),
      { kind: 'cache-clear' },
    )
  for (const id of ids) {
    if (APP.some((c) => c.id === id)) await preserveNonemptyCache(path.join(cacheRoot(), id))
  }
  return storageUsage({ album })
}

module.exports = { storageUsage, clearStorage }
