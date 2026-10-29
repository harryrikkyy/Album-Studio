// autofill.js — plan a whole album from its photos, as the Electron app's Auto-Fill did:
// photos in capture order (EXIF DateTimeOriginal, else file name), split across exactly N sheets
// ("desired sheets") or a random min–max count per sheet, each sheet given a random template whose
// slots match its photos' orientations. The counting is the Electron app's tested
// planAutoFillCounts, reused as is.

'use strict'

const crypto = require('crypto')
const { readFileHeader, contentKey } = require('./cache')
const { planAutoFillCounts } = require('../../../src/autofill_counts')
const { parseExifDateFromBuffer } = require('../../../src/exif_date')

const exifCache = new Map()
const MAX_EXIF_CACHE = 4096

/** Capture time (ms) from a JPEG's EXIF, or null. Reads the first 256 KB only. */
async function captureTime(file) {
  if (!file) return null
  try {
    const prefix = await readFileHeader(file, 256 * 1024)
    // Only this header is parsed; its digest is a metadata-cache key, never source evidence.
    const key = contentKey(file, crypto.createHash('sha256').update(prefix).digest('hex'))
    if (exifCache.has(key)) {
      const hit = exifCache.get(key)
      exifCache.delete(key)
      exifCache.set(key, hit)
      return hit
    }
    const parsed = parseExifDateFromBuffer(prefix),
      ts = Number.isFinite(parsed) ? parsed : null
    exifCache.set(key, ts)
    if (exifCache.size > MAX_EXIF_CACHE) exifCache.delete(exifCache.keys().next().value)
    return ts
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * Photos in capture order. RAW originals carry EXIF too, but their dates are read from the
 * thumbnail when the original isn't a JPEG (the thumbnailer keeps EXIF). Undated photos keep
 * file-name order after the dated ones, so nothing jumps around unpredictably.
 */
async function chronological(photos) {
  const dated = await Promise.all(
    photos.map(async (p, i) => {
      const jpegOriginal = p.original && /\.jpe?g$/i.test(p.original) ? p.original : null
      const t = (await captureTime(jpegOriginal)) ?? (await captureTime(p.thumb))
      return { p, i, t }
    }),
  )
  dated.sort((a, b) => {
    if (a.t !== null && b.t !== null && a.t !== b.t) return a.t - b.t
    if (a.t === null && b.t !== null) return 1
    if (a.t !== null && b.t === null) return -1
    return a.i - b.i
  })
  return dated.map((d) => d.p)
}

/**
 * @param {object[]} photos       the album's photos (pool order), each with id, orient
 * @param {object[]} templates    the catalogue (listTemplates), each with h, v
 * @param {{mode:'desired'|'range', desiredSheets?:number, min?:number, max?:number, chronological?:boolean}} opts
 * @param {() => number} [rng]
 * @returns {Promise<{ pages: {photoIds:string[], template:object|null}[], unmatched: number, cappedTo: number|null }>}
 */
async function planAlbum(photos, templates, opts, rng = Math.random) {
  if (!photos.length) throw new Error('There are no photos to place. Add a photo folder first.')
  if (!templates.length) throw new Error('There are no templates. Add a template collection first.')
  const ordered = opts.chronological === false ? photos.slice() : await chronological(photos)
  const plan = planAutoFillCounts(
    ordered.length,
    {
      mode: opts.mode === 'range' ? 'range' : 'desired',
      desiredSheets: opts.desiredSheets,
      min: opts.min,
      max: opts.max,
    },
    rng,
  )
  if (plan.error) throw new Error(plan.error)
  const bySlots = new Map()
  for (const t of templates) {
    const k = `${t.h}|${t.v}`
    if (!bySlots.has(k)) bySlots.set(k, [])
    bySlots.get(k).push(t)
  }
  const pages = []
  let at = 0
  let unmatched = 0
  for (const count of plan.counts) {
    const slice = ordered.slice(at, at + count)
    at += count
    const h = slice.filter((p) => p.orient === 'h').length
    const v = slice.length - h
    const matching = bySlots.get(`${h}|${v}`) || []
    const template = matching.length ? matching[Math.floor(rng() * matching.length)] : null
    if (!template) unmatched++
    pages.push({ photoIds: slice.map((p) => p.id), template })
  }
  return { pages, unmatched, cappedTo: plan.cappedTo }
}

module.exports = { planAlbum, chronological, captureTime }
