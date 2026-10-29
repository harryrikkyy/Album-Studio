'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseExifDateFromBuffer } = require('../src/exif_date')

// ─── parseExifDateFromBuffer ────────────────────────────────────────────────
// Build a minimal big-endian JPEG with an APP1/EXIF block carrying one
// DateTimeOriginal (0x9003) tag, to exercise the parser end-to-end.
function buildJpegWithExifDate(dateStr /* "YYYY:MM:DD HH:MM:SS" */) {
  const tiffHeader = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]) // 'MM', 42, IFD0 @ 8
  // IFD0: 1 entry -> ExifIFD pointer (0x8769)
  const ifd0 = Buffer.alloc(2 + 12 + 4)
  ifd0.writeUInt16BE(1, 0)
  ifd0.writeUInt16BE(0x8769, 2) // tag
  ifd0.writeUInt16BE(4, 4) // type LONG
  ifd0.writeUInt32BE(1, 6) // count
  const exifIfdOffset = 8 + ifd0.length
  ifd0.writeUInt32BE(exifIfdOffset, 10) // value/offset field (entry byte 8 = buffer pos 10)
  // Exif IFD: 1 entry -> DateTimeOriginal (0x9003), ASCII, 20 bytes, value offset after IFD
  const exifIfd = Buffer.alloc(2 + 12 + 4)
  exifIfd.writeUInt16BE(1, 0)
  exifIfd.writeUInt16BE(0x9003, 2)
  exifIfd.writeUInt16BE(2, 4) // type ASCII
  exifIfd.writeUInt32BE(20, 6) // count
  const valOffset = exifIfdOffset + exifIfd.length
  exifIfd.writeUInt32BE(valOffset, 10) // value/offset field (entry byte 8 = buffer pos 10)
  const valBuf = Buffer.from(dateStr + '\0'.repeat(20 - dateStr.length), 'ascii')
  const tiff = Buffer.concat([tiffHeader, ifd0, exifIfd, valBuf])
  const exifPayload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff])
  const app1 = Buffer.alloc(4)
  app1[0] = 0xff
  app1[1] = 0xe1
  app1.writeUInt16BE(exifPayload.length + 2, 2) // segment size includes the 2 size bytes
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, exifPayload, Buffer.from([0xff, 0xd9])])
}

test('parseExifDateFromBuffer reads DateTimeOriginal from a real APP1 block', () => {
  const jpeg = buildJpegWithExifDate('2026:07:04 13:45:30')
  const ts = parseExifDateFromBuffer(jpeg)
  assert.equal(ts, new Date('2026-07-04T13:45:30').getTime())
})

test('parseExifDateFromBuffer returns null for a non-JPEG buffer', () => {
  assert.equal(parseExifDateFromBuffer(Buffer.from([0x00, 0x01, 0x02, 0x03])), null)
})

test('parseExifDateFromBuffer returns null for a JPEG with no EXIF date', () => {
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  assert.equal(parseExifDateFromBuffer(plain), null)
})
