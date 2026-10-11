// templates.js — the template catalogue of an album's collections: every PSD with its id (the
// Electron app's scheme), its slot counts parsed from the name ("6h1v_0019" → 6 H, 1 V) and its
// preview image. Cached per collection until the collection folder changes or 5 minutes pass.

'use strict'

const fs = require('fs')
const path = require('path')
const { sanitize } = require('./album')

const TTL_MS = 5 * 60 * 1000
const cache = new Map()

async function readdirSafe(dir) {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }) } catch (_) { return [] }
}

/** Slot counts from a template's file name; 0/0 when the name doesn't say. */
function slotsFromName(name) {
  const m = String(name).toLowerCase().match(/(\d+)h(\d+)v/)
  return m ? { h: parseInt(m[1], 10), v: parseInt(m[2], 10) } : { h: 0, v: 0 }
}

async function scanCollection(dir) {
  const display = path.basename(dir)
  const psds = []
  const images = new Map() // lower-case base name → path
  const walk = async (d) => {
    for (const e of await readdirSafe(d)) {
      if (e.name.startsWith('.')) continue
      const full = path.join(d, e.name)
      if (e.isDirectory()) await walk(full)
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
    return { id: 'tpl_' + sanitize(display + '_' + name), name, file, preview, collection: display, ...slotsFromName(name) }
  })
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return list
}

/** All templates of these collection folders. */
async function listTemplates(collections) {
  const out = []
  for (const dir of collections || []) {
    const st = await fs.promises.stat(dir).catch(() => null)
    if (!st) continue
    const hit = cache.get(dir)
    if (hit && hit.mtime === st.mtimeMs && Date.now() - hit.at < TTL_MS) {
      out.push(...hit.list)
      continue
    }
    const list = await scanCollection(dir)
    cache.set(dir, { mtime: st.mtimeMs, at: Date.now(), list })
    out.push(...list)
  }
  return out
}

module.exports = { listTemplates, slotsFromName }
