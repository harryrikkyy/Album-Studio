// labnaming.js — files for the print lab's naming tool (the Electron app's Renamer): the sheets
// of an order folder with small thumbnails, and a rename that can't collide and can be undone.
// The names themselves are computed by the interface (ui/src/lab_naming.ts).

'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { cacheRoot, fileKey } = require('./cache')
const { jpegSizeFromBuffer } = require('./jpeg_size')

const SHEET = /\.(jpe?g|png|psd|psb)$/i
const THUMB_EDGE = 480
const getSharp = () => require('../../../src/sharp_config').getSharp()

/** The JPEG preview Photoshop stores in a PSD's image resources (id 1036, or 1033), if any. */
function psdThumbnail(buf) {
  if (buf.length < 30 || buf.toString('latin1', 0, 4) !== '8BPS') return null
  let at = 26
  at += 4 + buf.readUInt32BE(at) // colour mode data
  const end = at + 4 + buf.readUInt32BE(at)
  at += 4
  while (at + 12 <= end && at + 12 <= buf.length) {
    if (buf.toString('latin1', at, at + 4) !== '8BIM') return null
    const id = buf.readUInt16BE(at + 4)
    const nameLen = buf[at + 6]
    let p = at + 6 + 1 + nameLen
    if ((1 + nameLen) % 2) p++
    const size = buf.readUInt32BE(p)
    const data = p + 4
    if ((id === 1036 || id === 1033) && size > 28) return buf.subarray(data + 28, data + size)
    at = data + size + (size % 2)
  }
  return null
}

async function readHead(file, bytes) {
  const fh = await fs.promises.open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** A small cached thumbnail of a sheet, and its pixel size. */
async function thumbFor(file, st) {
  const ext = path.extname(file).toLowerCase()
  const dir = path.join(cacheRoot(), 'lab-thumbs')
  const out = path.join(dir, `${fileKey(file, st)}.jpg`)
  const metaFile = `${out}.json`
  try {
    return { thumb: out, ...JSON.parse(await fs.promises.readFile(metaFile, 'utf8')) }
  } catch (_) { /* not made yet */ }
  const sharp = getSharp()
  let width = 0
  let height = 0
  let input = file
  if (ext === '.psd' || ext === '.psb') {
    const head = await readHead(file, 4 << 20)
    if (head.length >= 26) { height = head.readUInt32BE(14); width = head.readUInt32BE(18) }
    input = psdThumbnail(head)
    if (!input) return { thumb: null, width, height }
  } else {
    const meta = await sharp(file, { failOn: 'none' }).metadata().catch(() => ({}))
    width = meta.width || 0
    height = meta.height || 0
  }
  await fs.promises.mkdir(dir, { recursive: true })
  await sharp(input, { failOn: 'none' }).rotate().resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside' }).jpeg({ quality: 78 }).toFile(out)
  await fs.promises.writeFile(metaFile, JSON.stringify({ width, height }))
  return { thumb: out, width, height }
}

/** The sheets of a folder (JPEG, PNG, PSD, PSB), in natural name order. */
async function listSheets({ folder }) {
  if (!folder) throw new Error('missing `folder`')
  const entries = await fs.promises.readdir(folder, { withFileTypes: true }).catch(() => {
    throw new Error(`The folder ${folder} isn’t there. The drive may be disconnected.`)
  })
  const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.') && SHEET.test(e.name)).map((e) => e.name)
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  const out = []
  for (const name of files) {
    const file = path.join(folder, name)
    const st = await fs.promises.stat(file)
    const t = await thumbFor(file, st).catch(() => ({ thumb: null, width: 0, height: 0 }))
    out.push({ path: file, fileName: name, baseName: name.replace(/\.[^.]+$/, ''), ext: path.extname(name), ...t })
  }
  return { folder, name: path.basename(folder), sheets: out }
}

const BAD = /[/:\\\u0000-\u001f]/

/**
 * Rename sheets inside `folder`: `ops` [{fromPath, toBaseName}] keep each file's extension. Two
 * phases (every file to a temporary name, then to its new one), so swapping 00 and 01 works.
 * Returns the reverse operations, to undo it.
 */
async function renameSheets({ folder, ops }) {
  if (!folder || !Array.isArray(ops)) throw new Error('missing `folder` or `ops`')
  const plan = []
  const targets = new Set()
  for (const op of ops) {
    if (path.dirname(op.fromPath) !== folder) throw new Error(`${op.fromPath} isn’t in ${folder}.`)
    const base = String(op.toBaseName || '').trim()
    if (!base || BAD.test(base) || base.startsWith('.')) throw new Error(`“${op.toBaseName}” can’t be a file name.`)
    const ext = path.extname(op.fromPath)
    const to = path.join(folder, base + ext)
    if (targets.has(to.toLowerCase())) throw new Error(`Two sheets would both be called “${base + ext}”.`)
    targets.add(to.toLowerCase())
    if (to !== op.fromPath) plan.push({ from: op.fromPath, to })
  }
  // A target that is an existing file not being renamed would be overwritten: refuse.
  const moving = new Set(plan.map((p) => p.from.toLowerCase()))
  for (const p of plan) {
    if (!moving.has(p.to.toLowerCase()) && (await fs.promises.access(p.to).then(() => true, () => false))) {
      throw new Error(`${path.basename(p.to)} already exists in the folder and isn’t one of the sheets being renamed.`)
    }
  }
  const stamp = crypto.randomBytes(4).toString('hex')
  const temps = []
  try {
    for (let i = 0; i < plan.length; i++) {
      const tmp = path.join(folder, `.as-rename-${stamp}-${i}${path.extname(plan[i].from)}`)
      await fs.promises.rename(plan[i].from, tmp)
      temps.push({ tmp, ...plan[i] })
    }
  } catch (e) {
    // Put back what already moved, then report.
    for (const t of temps.reverse()) await fs.promises.rename(t.tmp, t.from).catch(() => {})
    throw e
  }
  for (const t of temps) await fs.promises.rename(t.tmp, t.to)
  return {
    renamed: plan.length,
    undo: plan.map((p) => ({ fromPath: p.to, toBaseName: path.basename(p.from).replace(/\.[^.]+$/, '') })),
  }
}

module.exports = { listSheets, renameSheets, psdThumbnail }
