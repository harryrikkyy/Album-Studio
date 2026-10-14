'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const sharp = require('../../../src/sharp_config').getSharp()
const { tmpdir } = require('./fixtures')
const f = require('./color_edge_fixtures')
const { exportSheet } = require('../lib/deliver')
const { psdPixels, decodeCmykComposite } = require('../lib/color')

const settings = { size: 'original', ppi: 300, heightInches: 1 }
const layerSectionAt = (buf) => {
  const at = 30 + buf.readUInt32BE(26)
  return at + 4 + buf.readUInt32BE(at)
}

function rgbAuxiliary(file, { declared = true, channels = 4, depth = 8 } = {}) {
  const maximum = depth === 8 ? 255 : 65535
  const values = depth === 8 ? Buffer.alloc(f.W * f.H * channels) : new Uint16Array(f.W * f.H * channels)
  for (let i = 0; i < f.W * f.H; i++) values.set([100, 50, 200, ...Array(channels - 3).fill(64)].map((v) => Math.round(v / 255 * maximum)), i * channels)
  f.rawPsd(file, { depth, mode: 3, channels, values, profile: f.adobeCompatibleProfile(), alphaDeclared: declared, realMerged: true })
  if (declared) {
    const buf = fs.readFileSync(file)
    // A positive layer count explicitly means the fourth channel is an auxiliary
    // saved selection, not the transparency of the merged image (Adobe PSD spec).
    buf.writeInt16BE(1, layerSectionAt(buf) + 8)
    fs.writeFileSync(file, buf)
  }
}

for (const depth of [8, 16]) test(`RGB ${depth}-bit auxiliary channel keeps the compatibility image opaque`, async () => {
  const dir = tmpdir(), file = path.join(dir, 'auxiliary.psd'), output = path.join(dir, 'output.jpg')
  rgbAuxiliary(file, { depth })
  await exportSheet(file, [{ file: output, quality: 100 }], settings)
  const opaque = Buffer.alloc(f.W * f.H * 3)
  for (let i = 0; i < f.W * f.H; i++) opaque.set([100, 50, 200], i * 3)
  const expected = await sharp(f.taggedPng(opaque, 3, 8, f.adobeCompatibleProfile())).withIccProfile('srgb').raw().toBuffer()
  const actual = await sharp(output).raw().toBuffer()
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(actual[i] - expected[i]) <= 3, `${[...actual.subarray(0, 3)]} differs from opaque ${[...expected.subarray(0, 3)]}`)
})

test('unknown RGB fourth-channel provenance and unsupported extra channels fail before replacing output', async (t) => {
  for (const [name, options] of [['layerless fourth channel', { declared: false }], ['multiple auxiliary channels', { channels: 5 }]]) {
    await t.test(name, async () => {
      const dir = tmpdir(), file = path.join(dir, 'ambiguous.psd'), output = path.join(dir, 'previous.jpg')
      rgbAuxiliary(file, options)
      fs.writeFileSync(output, 'previous verified result')
      await assert.rejects(exportSheet(file, [{ file: output, quality: 100 }], settings), /channel|transparency/i)
      assert.equal(fs.readFileSync(output, 'utf8'), 'previous verified result')
    })
  }
})

test('an explicitly negative RGB layer count preserves real merged transparency', async () => {
  const file = path.join(tmpdir(), 'transparency.psd'), pixels = f.rgbPixels([100, 50, 200, 64]), profile = await f.icc('srgb')
  f.taggedPsd8(file, profile, pixels)
  const px = await psdPixels(file)
  try {
    const decoded = await sharp(px.input, px.raw ? { raw: px.raw } : {}).raw().toBuffer()
    assert.equal(decoded[3], 64)
  } finally { if (px.cleanup) await px.cleanup() }
})

for (const version of [1, 2]) test(`CMYK ${version === 1 ? 'PSD' : 'PSB'} transparency in global Lr16 info remains identifiable`, async () => {
  const file = path.join(tmpdir(), 'global-layer-info.psd'), values = new Uint16Array(f.W * f.H * 5)
  for (let i = 0; i < f.W * f.H; i++) values.set([13107, 29491, 45875, 6554, 32768], i * 5)
  f.rawPsd(file, { depth: 16, mode: 4, channels: 5, values, version, profile: await f.icc('cmyk') })
  const buf = fs.readFileSync(file), at = layerSectionAt(buf), sizeBytes = version === 2 ? 8 : 4
  const length = Number(version === 2 ? buf.readBigUInt64BE(at) : buf.readUInt32BE(at))
  const info = buf.subarray(at + sizeBytes * 2, at + sizeBytes + length - 4)
  const block = Buffer.alloc(8 + sizeBytes)
  block.write('8BIM'); block.write('Lr16', 4)
  if (version === 2) block.writeBigUInt64BE(BigInt(info.length), 8); else block.writeUInt32BE(info.length, 8)
  const body = Buffer.concat([Buffer.alloc(sizeBytes + 4), block, info]), lengthField = Buffer.alloc(sizeBytes)
  if (version === 2) lengthField.writeBigUInt64BE(BigInt(body.length)); else lengthField.writeUInt32BE(body.length)
  const fixture = Buffer.concat([buf.subarray(0, at), lengthField, body, buf.subarray(at + sizeBytes + length)])
  fs.writeFileSync(file, fixture)
  const decoded = decodeCmykComposite(fixture)
  assert.equal(decoded.alpha, true)
  assert.equal(decoded.data.readUInt16LE(8), 32768)
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(decoded.data.readUInt16LE(i * 2) - values[i]) <= 1)
})

test('oversized RGB is rejected before ag-psd allocation or engine fallback', () => {
  // Run the instrumented allocator in its own process. It throws before allocating
  // any large memory, so this remains safe even against the unfixed decoder.
  const script = `
    const fs = require('fs'), os = require('os'), path = require('path'), ag = require('ag-psd');
    const init = ag.initializeCanvas.bind(ag); let attempted = 0;
    Object.defineProperty(ag, 'initializeCanvas', { configurable: true, value: factory => init(factory, (w,h) => { attempted = w*h*4; throw Error('allocation sentinel'); }) });
    process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI = '/definitely/missing/photocraft';
    const { psdPixels } = require('./native/backend/lib/color');
    const buf = Buffer.alloc(40); buf.write('8BPS'); buf.writeUInt16BE(1,4); buf.writeUInt16BE(3,12);
    buf.writeUInt32BE(15000,14); buf.writeUInt32BE(15000,18); buf.writeUInt16BE(8,22); buf.writeUInt16BE(3,24);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'as-bounded-rgb-')), file = path.join(dir,'oversized.psd'); fs.writeFileSync(file,buf);
    psdPixels(file).then(() => console.log(JSON.stringify({ attempted, error: null })), e => console.log(JSON.stringify({ attempted, error: e.message }))).finally(() => fs.rmSync(dir,{recursive:true,force:true}));
  `
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8', timeout: 10000 }))
  assert.equal(result.attempted, 0, 'oversized source reached the pixel allocator')
  assert.match(result.error, /512 MiB|decoding limit/i)
})
