// cache.js — where derived files live (template backdrops, RAW previews): the user's Caches
// folder, which macOS may clear, so everything here can be made again from the originals.

'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

function cacheRoot() {
  return process.env.ALBUM_STUDIO_CACHE_DIR || path.join(os.homedir(), 'Library', 'Caches', 'Album Studio')
}

/** A short key that changes whenever the file is replaced or edited. */
function fileKey(file, st) {
  return crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16)
}

async function fileStamp(p) {
  const st = await fs.promises.stat(p).catch(() => null)
  return st ? `${st.size}:${Math.round(st.mtimeMs)}` : 'missing'
}

/** Write a file so readers never see half of it. */
async function writeAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await fs.promises.writeFile(tmp, data)
  await fs.promises.rename(tmp, file)
}

module.exports = { cacheRoot, fileKey, fileStamp, writeAtomic }
