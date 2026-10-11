// storage.js — the space Album Studio's caches take, and clearing them. Everything here can be
// made again from the originals (it is, the next time it's needed), so clearing loses no work:
//   app caches (~/Library/Caches/Album Studio): template backdrops and frame shapes, RAW previews,
//     lab-naming thumbnails, Best-picks scores;
//   an album's own (in its print-sheet folder, .album-studio): developed RAW photos and
//     colour-adjusted copies used for rendering. Its render record stays.

'use strict'

const fs = require('fs')
const path = require('path')
const { openAlbum } = require('./album')
const { cacheRoot } = require('./cache')

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
      else if (e.isFile()) { bytes += (await fs.promises.stat(p).catch(() => ({ size: 0 }))).size; files++ }
    }
  }
  await walk(dir)
  return { bytes, files }
}

async function albumCacheDir(albumPath) {
  const a = await openAlbum({ path: albumPath })
  return path.join(a.outputFolder || path.join(a.path, 'exports'), '.album-studio')
}

/** Sizes of the app's caches, and of the open album's when given. */
async function storageUsage({ album } = {}) {
  const app = await Promise.all(APP.map(async (c) => ({ ...c, scope: 'app', ...(await sizeOf(path.join(cacheRoot(), c.id))) })))
  let albumCaches = []
  if (album) {
    const dir = await albumCacheDir(album)
    albumCaches = await Promise.all(ALBUM.map(async (c) => ({ ...c, scope: 'album', ...(await sizeOf(path.join(dir, c.id))) })))
  }
  return { root: cacheRoot(), caches: [...app, ...albumCaches] }
}

/** Clear caches: `ids` from the app's list, and with `album`, from the album's. */
async function clearStorage({ ids, album }) {
  if (!Array.isArray(ids) || !ids.length) throw new Error('Choose what to clear.')
  for (const id of ids) {
    if (APP.some((c) => c.id === id)) await fs.promises.rm(path.join(cacheRoot(), id), { recursive: true, force: true })
    else if (album && ALBUM.some((c) => c.id === id)) await fs.promises.rm(path.join(await albumCacheDir(album), id), { recursive: true, force: true })
    else throw new Error(`Unknown cache \`${id}\`.`)
  }
  return storageUsage({ album })
}

module.exports = { storageUsage, clearStorage }
