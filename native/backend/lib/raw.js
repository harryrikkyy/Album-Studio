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

module.exports = { isRaw, placeable }
