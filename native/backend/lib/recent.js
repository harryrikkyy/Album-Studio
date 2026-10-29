// recent.js — the "Albums" list: projects opened recently, newest first, kept in the app's data
// folder (ALBUM_STUDIO_DATA_DIR, else ~/Library/Application Support/Album Studio).

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const LIMIT = 50

function dataDir() {
  return process.env.ALBUM_STUDIO_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Album Studio')
}

function storeFile() {
  return path.join(dataDir(), 'recent-albums.json')
}

async function readRecent() {
  try {
    const list = JSON.parse(await fs.promises.readFile(storeFile(), 'utf8'))
    return Array.isArray(list) ? list : []
  } catch (_) {
    return []
  }
}

/** Remember an opened album (a small summary, enough to draw its card without opening it). */
async function rememberAlbum(album) {
  const entry = {
    path: album.path,
    name: album.name,
    openedAt: new Date().toISOString(),
    spreads: album.stats.spreads,
    photos: album.stats.photos,
    cover: (album.spreads.find((s) => s.proof) || {}).proof || null,
  }
  const list = (await readRecent()).filter((e) => e.path !== entry.path)
  list.unshift(entry)
  await fs.promises.mkdir(dataDir(), { recursive: true })
  // Write-then-rename so a crash never leaves a half-written list.
  const tmp = storeFile() + '.tmp'
  await fs.promises.writeFile(tmp, JSON.stringify(list.slice(0, LIMIT), null, 2))
  await fs.promises.rename(tmp, storeFile())
  return entry
}

/** The list, each entry marked with whether its folder is reachable right now. */
async function listRecent() {
  const list = await readRecent()
  return Promise.all(
    list.map(async (e) => ({
      ...e,
      available: await fs.promises.access(e.path).then(
        () => true,
        () => false,
      ),
    })),
  )
}

module.exports = { listRecent, rememberAlbum, dataDir }
