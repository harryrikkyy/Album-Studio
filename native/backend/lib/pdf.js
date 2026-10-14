// pdf.js — a PDF of JPEG pages (the client proof): each page is one image, its JPEG bytes
// embedded as they are (DCTDecode), so the PDF is barely larger than the JPEGs and nothing is
// re-compressed. Pages are sized from the image's pixels and resolution. Written as a stream, so
// a 200 MB album never sits in memory at once.

'use strict'

const fs = require('fs')
const crypto = require('crypto')
const { jpegSizeFromBuffer } = require('./jpeg_size')
const { validateProfile, assertProfileUsable } = require('./color')

/** Validate JPEG markers before handing binary bytes to PDF's decoder; gather ICC APP2 chunks. */
function jpegInfo(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) throw new Error('Invalid JPEG signature.')
  let at = 2, frame = null, ended = false, chunks = null, chunkCount = 0
  while (at < buf.length) {
    if (buf[at++] !== 0xff) throw new Error('Invalid JPEG marker.')
    while (buf[at] === 0xff) at++
    const marker = buf[at++]
    if (marker === 0xd9) { ended = true; break }
    if (marker === 0xd8 || marker === 0 || marker === undefined) throw new Error('Invalid JPEG marker.')
    if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue
    if (at + 2 > buf.length) throw new Error('Truncated JPEG marker length.')
    const length = buf.readUInt16BE(at)
    if (length < 2 || at + length > buf.length) throw new Error('Truncated JPEG segment.')
    const payload = buf.subarray(at + 2, at + length)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (payload.length < 6 || payload[0] !== 8 || ![1, 3, 4].includes(payload[5]) || payload.length < 6 + payload[5] * 3) throw new Error('Unsupported or malformed JPEG frame.')
      frame = payload[5]
    }
    if (marker === 0xe2 && payload.subarray(0, 12).equals(Buffer.from('ICC_PROFILE\0'))) {
      if (payload.length < 14) throw new Error('Truncated JPEG ICC header.')
      const sequence = payload[12], total = payload[13]
      if (!sequence || !total || sequence > total || chunkCount && chunkCount !== total) throw new Error('Invalid JPEG ICC chunk sequence.')
      if (!chunks) { chunks = new Map(); chunkCount = total }
      if (chunks.has(sequence)) throw new Error('Duplicate JPEG ICC chunk.')
      chunks.set(sequence, payload.subarray(14))
    }
    at += length
    if (marker === 0xda) {
      // Skip entropy bytes, escaped FFs and restart markers; next marker may start another scan.
      while (at < buf.length) {
        if (buf[at] !== 0xff) { at++; continue }
        const next = buf[at + 1]
        if (next === 0 || next >= 0xd0 && next <= 0xd7) { at += 2; continue }
        break
      }
    }
  }
  if (!ended || !frame) throw new Error('Truncated JPEG data or missing frame.')
  const size = jpegSizeFromBuffer(buf, { stored: true })
  if (!size || !size.width || !size.height) throw new Error('Invalid JPEG dimensions.')
  let profile = null
  if (chunks) {
    if (chunks.size !== chunkCount) throw new Error('Missing JPEG ICC chunk.')
    profile = validateProfile(Buffer.concat(Array.from({ length: chunkCount }, (_, i) => chunks.get(i + 1))))
    const expected = { 1: 'GRAY', 3: 'RGB ', 4: 'CMYK' }[frame]
    if (profile.toString('ascii', 16, 20) !== expected) throw new Error('JPEG ICC profile channel mismatch.')
  }
  return { ...size, components: frame, profile }
}

/** Number of colour channels in a JPEG's frame header (1 grey, 3 RGB/YCbCr, 4 CMYK). */
function jpegComponents(buf) {
  return jpegInfo(buf).components
}

/**
 * Write `file` with one page per JPEG.
 * @param {string} file
 * @param {{ path: string, ppi?: number }[]} pages   in order; ppi sets the page size (default 300)
 * @param {{ title?: string, onPage?: (i: number) => void }} [opts]
 */
async function writeJpegPdf(file, pages, opts = {}) {
  if (!pages.length) throw new Error('There are no pages for the PDF.')
  const tmp = `${file}.${crypto.randomUUID()}.part`
  const out = await fs.promises.open(tmp, 'wx', 0o600)
  let offset = 0
  const offsets = []
  const write = async (data) => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data
    offset += buf.length
    await out.writeFile(buf)
  }
  const obj = async (n, body) => { offsets[n] = offset; await write(`${n} 0 obj\n${body}\nendobj\n`) }

  // Objects: 1 catalog, 2 pages, 3 info; then per page: page, contents, image.
  const pageObj = (i) => 4 + i * 3
  const profiles = new Map()
  let count = pageObj(pages.length)
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '?')
  try {
    await write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    await obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
    await obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`)
    await obj(3, `<< /Producer (Album Studio) /Title (${esc(opts.title || 'Album')}) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`)
    for (let i = 0; i < pages.length; i++) {
      const jpeg = await fs.promises.readFile(pages[i].path)
      const size = jpegInfo(jpeg)
      const ppi = pages[i].ppi === undefined ? 300 : pages[i].ppi
      if (!Number.isFinite(ppi) || ppi <= 0) throw new Error('The PDF page resolution must be a finite positive number.')
      const w = +(size.width / ppi * 72).toFixed(2)
      const h = +(size.height / ppi * 72).toFixed(2)
      const comps = size.components
      const alternate = comps === 1 ? '/DeviceGray' : comps === 4 ? '/DeviceCMYK' : '/DeviceRGB'
      let space = alternate
      if (size.profile) {
        await assertProfileUsable(size.profile)
        const hash = crypto.createHash('sha256').update(size.profile).digest('hex')
        if (!profiles.has(hash)) {
          const id = count++
          profiles.set(hash, id)
          offsets[id] = offset
          await write(`${id} 0 obj\n<< /N ${comps} /Alternate ${alternate} /Length ${size.profile.length} >>\nstream\n`)
          await write(size.profile)
          await write('\nendstream\nendobj\n')
        }
        space = `[/ICCBased ${profiles.get(hash)} 0 R]`
      }
      if (comps === 4) space += ' /Decode [1 0 1 0 1 0 1 0]'
      const n = pageObj(i)
      await obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im${i} ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`)
      const content = `q ${w} 0 0 ${h} 0 0 cm /Im${i} Do Q`
      await obj(n + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
      offsets[n + 2] = offset
      // Match the source-to-sRGB proof policy. PDF's default relative colourimetric
      // intent changes LUT-profile CMYK colours compared with perceptual conversion.
      await write(`${n + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} /ColorSpace ${space} /Intent /Perceptual /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`)
      await write(jpeg)
      await write('\nendstream\nendobj\n')
      if (opts.onPage) opts.onPage(i + 1)
    }
    const xref = offset
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`
    for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
    await write(table)
    await write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
    await out.sync()
    await out.close()
    await fs.promises.rename(tmp, file)
  } catch (e) {
    await out.close().catch(() => {})
    await fs.promises.unlink(tmp).catch(() => {})
    throw e
  }
}

module.exports = { writeJpegPdf, jpegComponents }
