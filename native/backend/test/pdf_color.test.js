'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const sharp = require('../../../src/sharp_config').getSharp()
const { tmpdir } = require('./fixtures')
const { writeJpegPdf } = require('../lib/pdf')

const image = () => sharp({ create: { width: 90, height: 30, channels: 3, background: '#a54c30' } })
const jpeg = async (profile) =>
  profile ? image().withIccProfile(profile).jpeg().toBuffer() : image().jpeg().toBuffer()
const profile = async (name) => (await sharp(await jpeg(name)).metadata()).icc
function app2(data, sequence, total) {
  const payload = Buffer.concat([Buffer.from('ICC_PROFILE\0'), Buffer.from([sequence, total]), data])
  const header = Buffer.alloc(4)
  header.writeUInt16BE(0xffe2)
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([header, payload])
}
const tagged = (bytes, chunks) => Buffer.concat([bytes.subarray(0, 2), ...chunks, bytes.subarray(2)])

/** Inspect the actual classic xref and length-delimited binary objects, independently of writer. */
function pdfObjects(bytes) {
  const text = bytes.toString('latin1')
  const start = Number(text.match(/startxref\n(\d+)\n%%EOF/)[1])
  assert.equal(text.slice(start, start + 4), 'xref')
  const match = text.slice(start).match(/^xref\n0 (\d+)\n([\s\S]*?)trailer\n/)
  const count = Number(match[1]),
    lines = match[2].trimEnd().split('\n')
  assert.equal(lines.length, count)
  const offsets = lines.slice(1).map((line) => Number(line.slice(0, 10)))
  const objects = new Map()
  for (let i = 0; i < offsets.length; i++) {
    const at = offsets[i]
    assert.equal(text.slice(at, at + `${i + 1} 0 obj\n`.length), `${i + 1} 0 obj\n`)
    const end = text.indexOf('\nendobj', at)
    const stream = text.indexOf('\nstream\n', at)
    const header = text.slice(at, stream >= 0 && stream < end ? stream : end)
    const length = header.match(/\/Length (\d+)/)
    objects.set(i + 1, { header, bytes: length ? bytes.subarray(stream + 8, stream + 8 + Number(length[1])) : null })
  }
  return { text, objects }
}

test('PDF images declare their exact embedded RGB ICC profiles, with correct xrefs and unchanged JPEG bytes', async () => {
  const dir = tmpdir(),
    pages = [],
    expected = []
  for (const [i, name] of ['p3', 'srgb', 'p3'].entries()) {
    const bytes = await jpeg(name),
      file = path.join(dir, `${i}.jpg`)
    fs.writeFileSync(file, bytes)
    pages.push({ path: file, ppi: 300 })
    expected.push({ bytes, icc: (await sharp(bytes).metadata()).icc })
  }
  const file = path.join(dir, 'proof.pdf')
  await writeJpegPdf(file, pages)
  const { text, objects } = pdfObjects(fs.readFileSync(file))
  assert.match(text, /\/MediaBox \[0 0 21\.6 7\.2\]/)
  const imageObjects = [...objects.values()].filter((o) => o.header.includes('/Subtype /Image'))
  assert.equal(imageObjects.length, 3)
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(imageObjects[i].bytes, expected[i].bytes)
    const id = Number(imageObjects[i].header.match(/\/ColorSpace \[\/ICCBased (\d+) 0 R\]/)[1])
    assert.match(objects.get(id).header, /\/N 3 \/Alternate \/DeviceRGB/)
    assert.deepEqual(objects.get(id).bytes, expected[i].icc)
  }
  assert.equal(
    [...objects.values()].filter((o) => /\/N 3 \/Alternate/.test(o.header)).length,
    2,
    'identical profiles share one stream',
  )
})

test('ICC APP2 chunks are reconstructed by their declared sequence, including reversed physical order', async () => {
  const dir = tmpdir(),
    bytes = await jpeg(),
    icc = await profile('p3'),
    cut = Math.floor(icc.length / 2)
  const source = path.join(dir, 'chunks.jpg'),
    output = path.join(dir, 'chunks.pdf')
  fs.writeFileSync(source, tagged(bytes, [app2(icc.subarray(cut), 2, 2), app2(icc.subarray(0, cut), 1, 2)]))
  await writeJpegPdf(output, [{ path: source }])
  const { objects } = pdfObjects(fs.readFileSync(output))
  assert.ok([...objects.values()].some((o) => /\/N 3 \/Alternate/.test(o.header) && o.bytes.equals(icc)))
})

test('grey and CMYK profiles use matching ICCBased channel counts', async () => {
  const dir = tmpdir()
  const grey = await image().toColourspace('b-w').jpeg().toBuffer()
  // Portable original gamma/XYZ profile generated from the public ICC tag definitions.
  const greyProfile = require('./color_edge_fixtures').grayGammaProfile()
  const cmyk = await jpeg('cmyk'),
    cmykProfile = (await sharp(cmyk).metadata()).icc
  const sources = [tagged(grey, [app2(greyProfile, 1, 1)]), cmyk]
  const pages = sources.map((bytes, i) => {
    const file = path.join(dir, `${i}.jpg`)
    fs.writeFileSync(file, bytes)
    return { path: file }
  })
  await writeJpegPdf(path.join(dir, 'channels.pdf'), pages)
  const { objects } = pdfObjects(fs.readFileSync(path.join(dir, 'channels.pdf')))
  assert.ok(
    [...objects.values()].some((o) => /\/N 1 \/Alternate \/DeviceGray/.test(o.header) && o.bytes.equals(greyProfile)),
  )
  assert.ok(
    [...objects.values()].some((o) => /\/N 4 \/Alternate \/DeviceCMYK/.test(o.header) && o.bytes.equals(cmykProfile)),
  )
})

test('invalid ICC chunk sequences, bounds, profiles and channel mismatches reject without replacing an existing PDF', async (t) => {
  const bytes = await jpeg(),
    icc = await profile('p3'),
    cut = Math.floor(icc.length / 2)
  const grey = await image().toColourspace('b-w').jpeg().toBuffer()
  const cases = [
    ['zero sequence', tagged(bytes, [app2(icc, 0, 1)])],
    ['zero count', tagged(bytes, [app2(icc, 1, 0)])],
    ['sequence past count', tagged(bytes, [app2(icc, 2, 1)])],
    ['duplicate sequence', tagged(bytes, [app2(icc, 1, 1), app2(icc, 1, 1)])],
    ['missing chunk', tagged(bytes, [app2(icc.subarray(0, cut), 1, 2)])],
    ['inconsistent count', tagged(bytes, [app2(icc.subarray(0, cut), 1, 2), app2(icc.subarray(cut), 2, 3)])],
    ['invalid profile', tagged(bytes, [app2(Buffer.from('broken'), 1, 1)])],
    ['channel mismatch', tagged(grey, [app2(icc, 1, 1)])],
    ['truncated APP2 header', tagged(bytes, [Buffer.from([0xff, 0xe2, 0, 14]), Buffer.from('ICC_PROFILE\0')])],
  ]
  for (const [name, input] of cases)
    await t.test(name, async () => {
      const dir = tmpdir(),
        source = path.join(dir, 'input.jpg'),
        output = path.join(dir, 'proof.pdf')
      fs.writeFileSync(source, input)
      fs.writeFileSync(output, 'previous PDF')
      await assert.rejects(writeJpegPdf(output, [{ path: source }]), /ICC|profile|JPEG/i)
      assert.equal(fs.readFileSync(output, 'utf8'), 'previous PDF')
      assert.deepEqual(fs.readdirSync(dir).sort(), ['input.jpg', 'proof.pdf'])
    })
})

test('malformed or truncated JPEG data and invalid page resolution reject cleanly', async (t) => {
  const bytes = await jpeg()
  const cases = [
    ['not JPEG', Buffer.from('not a jpeg')],
    ['missing end marker', bytes.subarray(0, bytes.length - 2)],
    ['truncated marker length', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff])],
    ['segment exceeds file', Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0xff, 0xff, 8, 0, 1, 0, 1, 3, 0xff, 0xd9])],
  ]
  for (const [name, input] of cases)
    await t.test(name, async () => {
      const dir = tmpdir(),
        source = path.join(dir, 'input.jpg'),
        output = path.join(dir, 'proof.pdf')
      fs.writeFileSync(source, input)
      await assert.rejects(writeJpegPdf(output, [{ path: source }]), /JPEG/i)
      assert.equal(fs.existsSync(output), false)
      assert.deepEqual(fs.readdirSync(dir), ['input.jpg'])
    })
  const dir = tmpdir(),
    source = path.join(dir, 'input.jpg')
  fs.writeFileSync(source, bytes)
  await assert.rejects(writeJpegPdf(path.join(dir, 'proof.pdf'), [{ path: source, ppi: Infinity }]), /resolution/i)
})

test('an unwritable destination rejects through the promise without an uncaught stream error or hang', async () => {
  const dir = tmpdir(),
    source = path.join(dir, 'input.jpg')
  fs.writeFileSync(source, await jpeg())
  const script = `require(${JSON.stringify(require.resolve('../lib/pdf'))}).writeJpegPdf(process.argv[1], [{path:process.argv[2]}]).then(()=>process.exit(2)).catch(e=>{process.stdout.write(e.code || e.message);process.exit(0)})`
  const result = spawnSync(process.execPath, ['-e', script, path.join(dir, 'absent', 'proof.pdf'), source], {
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr || String(result.error))
  assert.match(result.stdout, /ENOENT/)
})

test('concurrent standalone PDF writes use separate staging files and leave a valid complete result', async () => {
  const dir = tmpdir(),
    source = path.join(dir, 'input.jpg'),
    output = path.join(dir, 'proof.pdf')
  fs.writeFileSync(source, await jpeg('srgb'))
  await Promise.all([
    writeJpegPdf(output, [{ path: source }]),
    writeJpegPdf(output, [{ path: source }, { path: source }]),
  ])
  const { text } = pdfObjects(fs.readFileSync(output))
  assert.match(text, /\/Type \/Pages \/Count [12]/)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['input.jpg', 'proof.pdf'])
})
