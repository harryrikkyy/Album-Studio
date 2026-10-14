'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const sharp = require('../../../src/sharp_config').getSharp()
const { tmpdir } = require('./fixtures')
const { writeJpegPdf } = require('../lib/pdf')

async function jpeg(progressive = false) {
  const width = 128, height = 64, bytes = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bytes.set([(17 + x * 11) % 256, y * 19 % 256, (x * y + 53) % 256], (y * width + x) * 3)
  return sharp(bytes, { raw: { width, height, channels: 3 } }).withIccProfile('p3').jpeg({ quality: 95, progressive }).toBuffer()
}

function headers(bytes) {
  const sections = []
  let at = 2
  while (at < bytes.length) {
    const begin = at
    assert.equal(bytes[at++], 255)
    const marker = bytes[at++], size = bytes.readUInt16BE(at), end = at + size
    sections.push({ begin, marker, end, payload: at + 2 })
    if (marker === 0xda) break
    at = end
  }
  return sections
}

test('missing, malformed and corrupt JPEG scans reject before replacing a previous PDF', async (t) => {
  const good = await jpeg(), sections = headers(good), scan = sections.at(-1)
  const mutate = (edit) => { const copy = Buffer.from(good); edit(copy); return copy }
  const cases = [
    ['missing SOS', Buffer.concat([good.subarray(0, scan.begin), Buffer.from([255, 217])])],
    ['truncated SOS header', Buffer.concat([good.subarray(0, scan.begin + 5), Buffer.from([255, 217])])],
    ['zero scan components', mutate((b) => { b[scan.payload] = 0 })],
    ['unknown scan component', mutate((b) => { b[scan.payload + 1] = 250 })],
    ['duplicate scan component', mutate((b) => { b[scan.payload + 3] = b[scan.payload + 1] })],
    ['invalid spectral selection', mutate((b) => { b[scan.end - 3] = 64 })],
    ['empty entropy', Buffer.concat([good.subarray(0, scan.end), Buffer.from([255, 217])])],
    ['truncated entropy with EOI', Buffer.concat([good.subarray(0, scan.end + Math.floor((good.length - scan.end - 2) / 2)), Buffer.from([255, 217])])],
    ['missing quantization tables', Buffer.concat([good.subarray(0, 2), ...sections.filter((s) => s.marker !== 0xdb).map((s) => good.subarray(s.begin, s.end)), good.subarray(scan.end)])],
  ]
  for (const [name, input] of cases) await t.test(name, async (tt) => {
    const dir = tmpdir(), source = path.join(dir, 'input.jpg'), output = path.join(dir, 'previous.pdf'), previous = Buffer.from('previous verified PDF')
    fs.writeFileSync(source, input); fs.writeFileSync(output, previous)
    let failure = null
    try { await writeJpegPdf(output, [{ path: source }]) } catch (error) { failure = error }
    const preserved = fs.readFileSync(output).equals(previous), evidence = path.join(dir, 'evidence.json')
    fs.writeFileSync(evidence, JSON.stringify({ name, source, output, rejected: !!failure, error: failure && failure.message, previousPdfPreserved: preserved }, null, 2))
    tt.diagnostic(`PDF input validation evidence: ${evidence}`)
    assert.ok(failure, `${name} was accepted as a deliverable JPEG`)
    assert.match(failure.message, /JPEG|scan|entropy/i)
    assert.match(failure.message, /export.*again|restore|save.*again/i, 'recovery guidance is actionable')
    assert.equal(preserved, true)
    assert.deepEqual(fs.readdirSync(dir).filter((p) => p.endsWith('.part')), [])
  })
})

test('valid baseline and progressive JPEGs retain their original bytes and colour intent', async () => {
  const dir = tmpdir(), pages = [], sources = []
  for (const progressive of [false, true]) {
    const bytes = await jpeg(progressive), source = path.join(dir, `${progressive ? 'progressive' : 'baseline'}.jpg`)
    fs.writeFileSync(source, bytes); sources.push(bytes); pages.push({ path: source, ppi: 72 })
  }
  const output = path.join(dir, 'proof.pdf')
  await writeJpegPdf(output, pages)
  const bytes = fs.readFileSync(output), text = bytes.toString('latin1')
  for (const source of sources) assert.ok(bytes.includes(source), 'DCT image bytes are not re-encoded')
  assert.match(text, /\/Count 2/)
  assert.equal((text.match(/\/Intent \/Perceptual/g) || []).length, 2)
})

test('valid arithmetic sequential and progressive DCT sources retain their exact bytes', async () => {
  // Original synthetic 96x48 PPM: left RGB(180,50,20), right RGB(20,150,210).
  // Encoded with public libjpeg-turbo cjpeg -arithmetic [-progressive] -quality 95.
  // Embedded fixtures keep this format regression independent of an installed encoder.
  const fixtures = [
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/yQARCAAwAGADASIAAhEBAxEB/8wACgAQEAUBEBEF/9oADAMBAAIRAxEAPwD/AN3LSMWLhrYhD8/vU6o5NkzurERpApeHqhh8dZn0bd5aMKDWyhARoHL/2Q==',
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/ygARCAAwAGADASIAAhEBAxEB/8wABgAQARD/2gAMAwEAAhADEAAAAf8Au67U6mVukzTdtOKtqtQnIScawUixSX9mjRkNC8Yq8QL0yoD/zAAEEAX/2gAIAQEAAQUCqP/MAAQRBf/aAAgBAwEBPwGw/8wABBEF/9oACAECAQE/AbD/zAAEEAX/2gAIAQEABj8CqP/MAAQQBf/aAAgBAQABPyGo/9oADAMBAAIAAwAAABBLxv/MAAQRBf/aAAgBAwEBPxCw/8wABBEF/9oACAECAQE/ELD/zAAEEAX/2gAIAQEAAT8QqP/Z',
  ].map((data) => Buffer.from(data, 'base64'))
  const dir = tmpdir(), pages = fixtures.map((bytes, i) => {
    const file = path.join(dir, `${i}.jpg`); fs.writeFileSync(file, bytes); return { path: file, ppi: 72 }
  }), output = path.join(dir, 'arithmetic.pdf')
  await writeJpegPdf(output, pages)
  const pdf = fs.readFileSync(output)
  for (const input of fixtures) assert.ok(pdf.includes(input))
})

test('encoded JPEG source and decoded pixel policies reject before large allocation or decode', async (t) => {
  const dir = tmpdir(), sparse = path.join(dir, 'oversized.jpg'), output = path.join(dir, 'previous.pdf'), previous = Buffer.from('previous verified PDF')
  const fd = fs.openSync(sparse, 'wx')
  fs.ftruncateSync(fd, 512 * 1024 * 1024 + 1); fs.closeSync(fd)
  t.after(() => fs.rmSync(sparse, { force: true }))
  fs.writeFileSync(output, previous)
  const readFile = fs.promises.readFile, open = fs.promises.open
  let unsafeReadAttempted = false, planeReads = 0
  t.mock.method(fs.promises, 'readFile', async (...args) => {
    if (args[0] === sparse) { unsafeReadAttempted = true; throw new Error('Unsafe whole-file read sentinel') }
    return readFile.apply(fs.promises, args)
  })
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open.apply(fs.promises, args)
    if (args[0] === sparse) handle.read = async () => { planeReads++; throw new Error('Unsafe sparse payload read sentinel') }
    return handle
  })
  await assert.rejects(writeJpegPdf(output, [{ path: sparse }]), /512 MiB|source.*limit|source.*policy/i)
  assert.equal(unsafeReadAttempted, false)
  assert.equal(planeReads, 0)
  assert.deepEqual(fs.readFileSync(output), previous)
  const bytes = await jpeg(), frame = headers(bytes).find((s) => s.marker === 0xc0)
  bytes.writeUInt16BE(65535, frame.payload + 1); bytes.writeUInt16BE(65535, frame.payload + 3)
  const enormous = path.join(dir, 'enormous.jpg'); fs.writeFileSync(enormous, bytes)
  await assert.rejects(writeJpegPdf(output, [{ path: enormous }]), /pixel|decod.*limit|megapixel/i)
  assert.deepEqual(fs.readFileSync(output), previous)
})
