// templates.js — the template catalogue of an album's collections: every PSD with its id (the
// Electron app's scheme), its slot counts parsed from the name ("6h1v_0019" → 6 H, 1 V), its page
// size (from the verified PSD header) and its preview image. Each inventory includes nested
// changes and source revisions, even when a file's size and timestamps were preserved.
//
// A collection may mix page sizes (Market PSD's has 36×12 and 16×10 pages): an album keeps to one
// page shape, so automatic picks compare shapes (`shapeOf`).

'use strict'

const fs = require('fs')
const path = require('path')
const { sanitize, assignAssetIds } = require('./identity')
const { readFileHeader } = require('./cache')
const { prepareSourceAliases } = require('./source_roots')

async function readdirSafe(dir) {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
}

/** Slot counts from a template's file name; 0/0 when the name doesn't say. */
function slotsFromName(name) {
  const m = String(name).toLowerCase().match(/(\d+)h(\d+)v/)
  return m ? { h: parseInt(m[1], 10), v: parseInt(m[2], 10) } : { h: 0, v: 0 }
}

/** A PSD's canvas size from its header ("8BPS", height at byte 14, width at 18); null if unreadable. */
async function canvasOf(file) {
  try {
    const b = await readFileHeader(file, 26)
    if (b.length < 26 || b.toString('latin1', 0, 4) !== '8BPS' || ![1, 2].includes(b.readUInt16BE(4))) return null
    return { width: b.readUInt32BE(18), height: b.readUInt32BE(14) }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Width ÷ height to two places, so 7200×2400 and 10800×3600 are the same shape; null if unknown. */
function shapeOf(t) {
  return t && t.width && t.height ? Math.round((t.width / t.height) * 100) / 100 : null
}

function shapeCounts(list) {
  const counts = new Map()
  for (const t of list) {
    const s = shapeOf(t)
    if (s) counts.set(s, (counts.get(s) || 0) + 1)
  }
  return counts
}

/** The page shape most of these templates have (ties go to the one `tiebreak` has most); null if none. */
function commonShape(list, tiebreak = []) {
  const counts = shapeCounts(list)
  const second = shapeCounts(tiebreak)
  let best = null
  for (const [s, n] of counts) {
    const b = best === null ? -1 : counts.get(best)
    if (n > b || (n === b && (second.get(s) || 0) > (second.get(best) || 0))) best = s
  }
  return best
}

async function scanCollection(dir) {
  const display = path.basename(dir)
  const psds = []
  const images = new Map() // lower-case base name → path
  let entries = 0
  const walk = async (d, depth = 0) => {
    if (depth > 32) throw new Error(`Template collection ${dir} exceeds the 32-level inventory limit.`)
    for (const e of await readdirSafe(d)) {
      if (++entries > 100000) throw new Error(`Template collection ${dir} exceeds the 100000-entry inventory limit.`)
      if (e.name.startsWith('.')) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) await walk(full, depth + 1)
      else if (/\.psd$/i.test(e.name)) psds.push(full)
      else if (/\.(jpe?g|png)$/i.test(e.name)) images.set(e.name.replace(/\.[^.]+$/, '').toLowerCase(), full)
    }
  }
  await walk(dir)
  const list = psds.map((file) => {
    const name = path.basename(file)
    const base = name.replace(/\.psd$/i, '').toLowerCase()
    // Same matching as the Electron app: the image named like the template, else one whose name
    // contains it.
    let preview = images.get(base) || null
    if (!preview) for (const [k, v] of images) if (k.includes(base)) { preview = v; break }
    return { id: 'tpl_' + sanitize(display + '_' + name), name, file, preview, collection: display, sourceRoot: dir, ...slotsFromName(name), width: null, height: null }
  })
  // Hashing reads are bounded globally; do not enqueue thousands of full-file reads.
  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(list.slice(i, i + 4).map(async (t) => {
      const c = await canvasOf(t.file)
      if (c) { t.width = c.width; t.height = c.height }
    }))
  }
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return list
}

/** All templates of these collection folders. */
async function listTemplates(collections, registry = { version: 1, roots: {}, assets: {} }, { onConflict } = {}) {
  const out = []
  for (const dir of collections || []) {
    const st = await fs.promises.stat(dir).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!st) continue
    const list = await scanCollection(dir)
    out.push(...list)
  }
  const sources = await prepareSourceAliases(out, 'template', registry)
  if (onConflict) sources.conflicts.forEach(onConflict)
  return assignAssetIds(sources.candidates, 'template', registry)
}

module.exports = { listTemplates, slotsFromName, canvasOf, shapeOf, commonShape }
