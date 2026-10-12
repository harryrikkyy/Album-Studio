// jpeg_size.js — width/height of a JPEG from its header, without decoding it, as it is seen:
// a camera file whose EXIF says "turn 90°" (orientations 5–8) is reported the other way round.
//
// Reads the first 128 KB (the SOF marker sits right after the APP segments in every file our
// thumbnailer writes) and walks the markers. Returns null for anything that is not a baseline
// or progressive JPEG.

'use strict'

const fs = require('fs')

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** The EXIF orientation (1–8) in an APP1 segment's payload `b[start, end)`; 1 when there is none. */
function exifOrientation(b, start, end) {
  if (end - start < 14 || b.toString('latin1', start, start + 6) !== 'Exif\0\0') return 1
  const t = start + 6
  const le = b[t] === 0x49 // "II": little-endian
  const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
  const ifd = t + u32(t + 4)
  if (ifd + 2 > end) return 1
  for (let k = 0, n = u16(ifd); k < n; k++) {
    const e = ifd + 2 + k * 12
    if (e + 12 > end) break
    if (u16(e) === 0x0112) return u16(e + 8) || 1
  }
  return 1
}

/**
 * @param {Buffer} b
 * @param {{stored?: boolean}} [opts]  `stored`: the pixel grid as stored (a PDF embeds it as it is)
 * @returns {{width:number,height:number}|null}
 */
function jpegSizeFromBuffer(b, { stored = false } = {}) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let orientation = 1
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) { i++; continue }          // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    const len = b.readUInt16BE(i + 2)
    if (marker === 0xe1 && i + 2 + len <= b.length) orientation = exifOrientation(b, i + 4, i + 2 + len)
    if (SOF.has(marker)) {
      const height = b.readUInt16BE(i + 5)
      const width = b.readUInt16BE(i + 7)
      return !stored && orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height }
    }
    if (len < 2) return null
    i += 2 + len
  }
  return null
}

/** @param {string} file @returns {Promise<{width:number,height:number}|null>} */
async function jpegSize(file) {
  let fh
  try {
    fh = await fs.promises.open(file, 'r')
    const buf = Buffer.alloc(128 * 1024)
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return jpegSizeFromBuffer(buf.subarray(0, bytesRead))
  } catch (_) {
    return null
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

module.exports = { jpegSize, jpegSizeFromBuffer }
