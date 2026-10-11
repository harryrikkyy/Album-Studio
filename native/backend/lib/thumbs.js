// thumbs.js — the small photo proxies Album Studio works from: `<photo folder>/_Thumbnails/
// <name>.jpg`, longest side 400 px, upright (the Electron app's contract, so both apps share
// them). Ordinary images are resized by sharp; RAW files use the JPEG the camera embedded in them
// (milliseconds) and are developed by macOS (`sips`) only when there is none. Photoshop is never
// involved. Only missing or outdated thumbnails are made, so running it again is cheap.

'use strict'

const fs = require('fs')
const path = require('path')
const { embeddedJpeg, isRaw } = require('./raw')

const THUMB_DIR = '_Thumbnails'
const MAX_EDGE = 400
const QUALITY = 70
const SHARP_READS = /\.(jpe?g|png|tiff?|webp|heic|heif|avif)$/i
const POOL = 6

const getSharp = () => require('../../../src/sharp_config').getSharp()

/** Which files of a folder are photos (the folder's own files only, not subfolders). */
function isPhoto(name) {
  return !name.startsWith('.') && (SHARP_READS.test(name) || isRaw(name))
}

/**
 * Photos of a folder and how many still need a thumbnail.
 * @returns {Promise<{ path: string, name: string, exists: boolean, photos: number, raws: number,
 *   thumbs: number, missing: string[], samples: string[] }>}
 */
async function surveyFolder(folder) {
  const out = { path: folder, name: path.basename(folder), exists: false, photos: 0, raws: 0, thumbs: 0, missing: [], samples: [] }
  let entries
  try {
    entries = await fs.promises.readdir(folder, { withFileTypes: true })
    out.exists = true
  } catch (_) {
    return out
  }
  const thumbDir = path.join(folder, THUMB_DIR)
  const have = new Map()
  for (const e of await fs.promises.readdir(thumbDir, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && /\.jpe?g$/i.test(e.name)) have.set(e.name.replace(/\.[^.]+$/, '').toLowerCase(), path.join(thumbDir, e.name))
  }
  // One thumbnail per base name: a RAW and its same-named JPEG are one photo.
  const bases = new Map()
  for (const e of entries) {
    if (!e.isFile() || !isPhoto(e.name)) continue
    const base = e.name.replace(/\.[^.]+$/, '')
    const prev = bases.get(base.toLowerCase())
    // Prefer a JPEG/TIFF as the source (faster, already developed), as the thumbnailer did.
    if (!prev || (isRaw(prev) && !isRaw(e.name))) bases.set(base.toLowerCase(), e.name)
  }
  for (const [key, name] of bases) {
    out.photos++
    if (isRaw(name)) out.raws++
    const thumb = have.get(key)
    if (!thumb) out.missing.push(name)
    else {
      out.thumbs++
      if (out.samples.length < 8) out.samples.push(thumb)
    }
  }
  out.missing.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return out
}

/** One thumbnail. */
async function makeThumb(src, dest) {
  const sharp = getSharp()
  let input = src
  let rotate = null // null: follow EXIF
  if (isRaw(src)) {
    const emb = await embeddedJpeg(src).catch(() => null)
    if (emb) {
      input = emb.jpeg
      rotate = emb.rotation
    } else {
      input = await require('./raw').placeable(src, path.join(path.dirname(dest), '.develop'))
    }
  }
  const pipe = sharp(input, { failOn: 'none' })
  const upright = rotate === null ? pipe.rotate() : pipe.rotate(rotate)
  const tmp = `${dest}.part.jpg`
  await upright
    .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true })
    .toFile(tmp)
  await fs.promises.rename(tmp, dest)
}

/**
 * Make the folder's missing thumbnails.
 * @param {string} folder
 * @param {(p: { done: number, total: number, current: string }) => void} [onProgress]
 * @param {{ cancelled?: boolean }} [signal]
 * @returns {Promise<{ made: number, failed: string[] }>}
 */
async function ensureThumbnails(folder, onProgress, signal = {}) {
  const survey = await surveyFolder(folder)
  if (!survey.exists) throw new Error(`The photo folder ${folder} isn't there. The drive may be disconnected.`)
  const todo = survey.missing
  const thumbDir = path.join(folder, THUMB_DIR)
  if (todo.length) await fs.promises.mkdir(thumbDir, { recursive: true })
  let next = 0
  let done = 0
  let made = 0
  const failed = []
  let last = 0
  const report = (current) => {
    const now = Date.now()
    if (onProgress && (now - last > 150 || done === todo.length)) {
      last = now
      onProgress({ done, total: todo.length, current })
    }
  }
  const worker = async () => {
    while (next < todo.length && !signal.cancelled) {
      const name = todo[next++]
      try {
        await makeThumb(path.join(folder, name), path.join(thumbDir, name.replace(/\.[^.]+$/, '') + '.jpg'))
        made++
      } catch (e) {
        failed.push(`${name}: ${e && e.message ? e.message : e}`)
      }
      done++
      report(name)
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, todo.length) }, worker))
  await fs.promises.rm(path.join(thumbDir, '.develop'), { recursive: true, force: true })
  return { made, failed }
}

module.exports = { surveyFolder, ensureThumbnails, makeThumb, THUMB_DIR, MAX_EDGE }
