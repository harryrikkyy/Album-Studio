// thumbnailer.js
//
// Fast batch thumbnail generation. Runs in the Electron main process.
//
// The old pipeline opened EVERY image — including ordinary JPEGs — through
// Photoshop one at a time, holding the Photoshop bridge for the entire run
// (tens of minutes for a 2,000-file shoot) with no progress feedback.
//
// This module splits the work by file type:
//   • Non-RAW (jpg/png/tif/heic/webp/avif): decoded + resized by sharp/
//     libvips, in parallel, in this process — never touches Photoshop.
//     ~50–100× faster and leaves the Photoshop bridge free.
//   • RAW (cr2/nef/arw/dng/raw/rw2): genuinely needs Camera Raw, so those
//     paths are reported back to the caller to be handled by the existing
//     Photoshop JSX lane.
//
// Output matches the previous contract: a `_Thumbnails` subfolder of the
// source folder containing `<basename>.jpg` proxies, longest edge 400px.

const fs = require('fs')
const path = require('path')
const { getSharp } = require('./sharp_config')

// Proxy contract — keep these in one place (replaces the magic 400 / quality 6
// that were inlined in the JSX).
const THUMB_MAX_EDGE = 400
const THUMB_QUALITY = 70 // sharp 0..100; ≈ Photoshop JPEG quality 6

const SHARP_DECODABLE = /\.(jpe?g|png|tiff?|webp|heic|heif|avif)$/i
const RAW_EXT = /\.(cr2|nef|arw|dng|raw|rw2|cr3|orf|raf|srw)$/i

/**
 * Generate thumbnails for every sharp-decodable image in `folderPath`.
 * RAW files are NOT processed here — their names are returned in `rawFiles`
 * so the caller can route them through the Photoshop lane.
 *
 * @param {string} folderPath
 * @param {(p:{done:number,total:number,current:string}) => void} onProgress
 * @returns {Promise<{ok:boolean, processed:number, failed:number, total:number,
 *                     rawFiles:string[], errors:string[], thumbDir:string}>}
 */
async function generateThumbnails(folderPath, onProgress) {
  const sharp = getSharp()
  const thumbDir = path.join(folderPath, '_Thumbnails')
  fs.mkdirSync(thumbDir, { recursive: true })

  let entries = []
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true })
  } catch (e) {
    return { ok: false, error: e.message, processed: 0, failed: 0, total: 0, rawFiles: [], errors: [], thumbDir }
  }

  const sharpFiles = []
  const rawFiles = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (SHARP_DECODABLE.test(e.name)) sharpFiles.push(e.name)
    else if (RAW_EXT.test(e.name)) rawFiles.push(e.name)
  }

  const total = sharpFiles.length
  let processed = 0
  let failed = 0
  const errors = []

  // Bounded parallelism. sharp/libvips already uses an internal threadpool
  // per operation, so we keep the JS-level concurrency modest (8) to overlap
  // I/O without oversubscribing memory on large TIFF/HEIC inputs.
  const POOL = 8
  let cursor = 0

  async function worker() {
    while (cursor < sharpFiles.length) {
      const name = sharpFiles[cursor++]
      const src = path.join(folderPath, name)
      const base = name.replace(/\.[^/.]+$/, '')
      const dest = path.join(thumbDir, base + '.jpg')
      try {
        await sharp(src, { failOn: 'none' })
          .rotate() // honor EXIF orientation so proxies match the source
          .resize(THUMB_MAX_EDGE, THUMB_MAX_EDGE, {
            fit: 'inside',          // longest edge = 400, preserve aspect
            withoutEnlargement: true,
          })
          .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
          .toFile(dest)
        processed++
      } catch (err) {
        failed++
        if (errors.length < 20) errors.push(`${name}: ${err.message}`)
      }
      if (onProgress && (processed + failed) % 5 === 0) {
        try { onProgress({ done: processed + failed, total, current: name }) } catch (_) {}
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(POOL, total || 1) }, worker))
  if (onProgress) {
    try { onProgress({ done: processed + failed, total, current: 'done' }) } catch (_) {}
  }

  return { ok: true, processed, failed, total, rawFiles, errors, thumbDir }
}

module.exports = {
  generateThumbnails,
  THUMB_MAX_EDGE,
  THUMB_QUALITY,
  SHARP_DECODABLE,
  RAW_EXT,
}
