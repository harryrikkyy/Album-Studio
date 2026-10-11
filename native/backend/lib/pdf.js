// pdf.js — a PDF of JPEG pages (the client proof): each page is one image, its JPEG bytes
// embedded as they are (DCTDecode), so the PDF is barely larger than the JPEGs and nothing is
// re-compressed. Pages are sized from the image's pixels and resolution. Written as a stream, so
// a 200 MB album never sits in memory at once.

'use strict'

const fs = require('fs')
const { jpegSizeFromBuffer } = require('./jpeg_size')

/** Number of colour channels in a JPEG's frame header (1 grey, 3 RGB/YCbCr, 4 CMYK). */
function jpegComponents(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return buf[i + 9]
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
    i += 2 + buf.readUInt16BE(i + 2)
  }
  return 3
}

/**
 * Write `file` with one page per JPEG.
 * @param {string} file
 * @param {{ path: string, ppi?: number }[]} pages   in order; ppi sets the page size (default 300)
 * @param {{ title?: string, onPage?: (i: number) => void }} [opts]
 */
async function writeJpegPdf(file, pages, opts = {}) {
  if (!pages.length) throw new Error('There are no pages for the PDF.')
  const tmp = `${file}.part`
  const out = fs.createWriteStream(tmp)
  let offset = 0
  const offsets = []
  const write = (data) => new Promise((resolve, reject) => {
    const buf = typeof data === 'string' ? Buffer.from(data, 'latin1') : data
    offset += buf.length
    out.write(buf, (err) => (err ? reject(err) : resolve()))
  })
  const obj = async (n, body) => { offsets[n] = offset; await write(`${n} 0 obj\n${body}\nendobj\n`) }

  // Objects: 1 catalog, 2 pages, 3 info; then per page: page, contents, image.
  const pageObj = (i) => 4 + i * 3
  const esc = (s) => String(s).replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '?')
  try {
    await write('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    await obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
    await obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`)
    await obj(3, `<< /Producer (Album Studio) /Title (${esc(opts.title || 'Album')}) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`)
    for (let i = 0; i < pages.length; i++) {
      const jpeg = await fs.promises.readFile(pages[i].path)
      const size = jpegSizeFromBuffer(jpeg)
      if (!size) throw new Error(`${pages[i].path} isn't a JPEG that can go in a PDF.`)
      const ppi = pages[i].ppi || 300
      const w = +(size.width / ppi * 72).toFixed(2)
      const h = +(size.height / ppi * 72).toFixed(2)
      const comps = jpegComponents(jpeg)
      const space = comps === 1 ? '/DeviceGray' : comps === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB'
      const n = pageObj(i)
      await obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im${i} ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`)
      const content = `q ${w} 0 0 ${h} 0 0 cm /Im${i} Do Q`
      await obj(n + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
      offsets[n + 2] = offset
      await write(`${n + 2} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${size.width} /Height ${size.height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`)
      await write(jpeg)
      await write('\nendstream\nendobj\n')
      if (opts.onPage) opts.onPage(i + 1)
    }
    const xref = offset
    const count = pageObj(pages.length)
    let table = `xref\n0 ${count}\n0000000000 65535 f \n`
    for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`
    await write(table)
    await write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
    await fs.promises.rename(tmp, file)
  } catch (e) {
    out.destroy()
    await fs.promises.unlink(tmp).catch(() => {})
    throw e
  }
}

module.exports = { writeJpegPdf, jpegComponents }
