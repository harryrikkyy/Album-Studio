// raw.js — RAW photos for rendering. PhotoCraft 0.6.0 develops Sony/Canon/Nikon RAW with a
// neutral profile (measured: about 45 levels darker than Camera Raw on the Wedding album);
// macOS's own RAW engine (`sips`) lands within ~6 levels. Developed files are cached by source
// path, size and modification time, so each RAW is developed once.

'use strict'

const { execFile } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const RAW_EXT = /\.(arw|cr2|cr3|nef|dng|raf|orf|rw2|srw|pef)$/i
const SRGB = '/System/Library/ColorSync/Profiles/sRGB Profile.icc'

function isRaw(file) {
  return RAW_EXT.test(file)
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)} failed: ${(stderr || err.message).toString().trim()}`))
      else resolve(stdout)
    })
  })
}

/**
 * The file to place for `file`: itself, or for a RAW its developed sRGB JPEG in `cacheDir`.
 * @param {string} file
 * @param {string} cacheDir
 */
async function placeable(file, cacheDir) {
  if (!isRaw(file)) return file
  const st = await fs.promises.stat(file)
  const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16)
  const out = path.join(cacheDir, `${path.basename(file).replace(/\.[^.]+$/, '')}-${key}.jpg`)
  try {
    await fs.promises.access(out)
    return out
  } catch (_) { /* not developed yet */ }
  await fs.promises.mkdir(cacheDir, { recursive: true })
  const tmp = out + '.part.jpg'
  await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '95', '-m', SRGB, file, '--out', tmp])
  await fs.promises.rename(tmp, out)
  return out
}

/** Degrees to turn an image upright, from a TIFF/EXIF orientation value. */
const ORIENT_DEG = { 1: 0, 3: 180, 6: 90, 8: 270 }

/**
 * The largest JPEG a TIFF-based RAW (ARW, NEF, CR2, DNG, …) carries for previews, and the
 * orientation the camera recorded. Reads only the first megabyte to find it. Null when the file
 * has no embedded JPEG (CR3, RAF and some DNGs aren't TIFF-based).
 */
async function embeddedJpeg(file) {
  const fh = await fs.promises.open(file, 'r')
  try {
    const head = Buffer.alloc(1 << 20)
    const { bytesRead } = await fh.read(head, 0, head.length, 0)
    const order = head.toString('latin1', 0, 2)
    if (bytesRead < 16 || (order !== 'II' && order !== 'MM')) return null
    const le = order === 'II'
    const u16 = (o) => (o + 2 <= bytesRead ? (le ? head.readUInt16LE(o) : head.readUInt16BE(o)) : 0)
    const u32 = (o) => (o + 4 <= bytesRead ? (le ? head.readUInt32LE(o) : head.readUInt32BE(o)) : 0)
    const found = []
    let orientation = 1
    const seen = new Set()
    const walk = (off, depth) => {
      if (!off || off + 2 > bytesRead || seen.has(off) || depth > 4 || seen.size > 32) return
      seen.add(off)
      const count = u16(off)
      let at = 0
      let len = 0
      const subs = []
      for (let i = 0; i < count; i++) {
        const e = off + 2 + i * 12
        if (e + 12 > bytesRead) break
        const tag = u16(e)
        const n = u32(e + 4)
        const val = u32(e + 8)
        if (tag === 0x0201) at = val
        else if (tag === 0x0202) len = val
        else if (tag === 0x0112 && depth === 0) orientation = u16(e + 8)
        else if (tag === 0x014a) {
          if (n === 1) subs.push(val)
          else for (let k = 0; k < Math.min(n, 8); k++) subs.push(u32(val + k * 4))
        }
      }
      if (at && len) found.push({ at, len })
      for (const s of subs) walk(s, depth + 1)
      walk(u32(off + 2 + count * 12), depth)
    }
    walk(u32(4), 0)
    const best = found.sort((a, b) => b.len - a.len)[0]
    if (!best || best.len < 1024) return null
    const jpeg = Buffer.alloc(best.len)
    await fh.read(jpeg, 0, best.len, best.at)
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null
    return { jpeg, rotation: ORIENT_DEG[orientation] || 0 }
  } finally {
    await fh.close()
  }
}

/**
 * A quick stand-in for a RAW in previews: its developed JPEG when rendering already made one,
 * else the camera's embedded preview (milliseconds, versus about 1.5 s to develop), else a fresh
 * develop. `rotation` is what the file needs to be upright (embedded previews carry no EXIF).
 * @returns {Promise<{ file: string, rotation: number }>}
 */
async function previewable(file, { developedDir, previewDir, minEdge = 1000 }) {
  if (!isRaw(file)) return { file, rotation: 0 }
  const st = await fs.promises.stat(file)
  const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16)
  const base = path.basename(file).replace(/\.[^.]+$/, '')
  const developed = path.join(developedDir, `${base}-${key}.jpg`)
  if (await fs.promises.access(developed).then(() => true, () => false)) return { file: developed, rotation: 0 }
  const out = path.join(previewDir, `${base}-${key}.preview.jpg`)
  const meta = `${out}.json`
  try {
    const { rotation } = JSON.parse(await fs.promises.readFile(meta, 'utf8'))
    await fs.promises.access(out)
    return { file: out, rotation }
  } catch (_) { /* not extracted yet */ }
  const emb = await embeddedJpeg(file).catch(() => null)
  const size = emb ? require('./jpeg_size').jpegSizeFromBuffer(emb.jpeg) : null
  if (emb && size && Math.max(size.width, size.height) >= minEdge) {
    await fs.promises.mkdir(previewDir, { recursive: true })
    await fs.promises.writeFile(out + '.part', emb.jpeg)
    await fs.promises.rename(out + '.part', out)
    await fs.promises.writeFile(meta, JSON.stringify({ rotation: emb.rotation }))
    return { file: out, rotation: emb.rotation }
  }
  return { file: await placeable(file, developedDir), rotation: 0 }
}

module.exports = { isRaw, placeable, previewable, embeddedJpeg }
