// jpeg_size.js — width/height of a JPEG from its header, without decoding it.
//
// Reads the first 128 KB (the SOF marker sits right after the APP segments in every file our
// thumbnailer writes) and walks the markers. Returns null for anything that is not a baseline
// or progressive JPEG.

'use strict'

const fs = require('fs')

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** @param {Buffer} b @returns {{width:number,height:number}|null} */
function jpegSizeFromBuffer(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null
    const marker = b[i + 1]
    if (marker === 0xff) { i++; continue }          // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    const len = b.readUInt16BE(i + 2)
    if (SOF.has(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) }
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
