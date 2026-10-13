'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const sharp = require('sharp')
const ag = require('ag-psd')
const { tmpdir } = require('./fixtures')
const { exportSheet, sheetPixels } = require('../lib/deliver')
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()

const W = 120, H = 40
function pixels() {
  const data = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    data.set(x < W / 2 ? [210, 110, 75, 255] : [50, 140, 200, 255], (y * W + x) * 4)
  }
  return data
}
async function icc(name) {
  const encoded = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#c00' } }).withIccProfile(name).jpeg().toBuffer()
  return (await sharp(encoded).metadata()).icc
}
function psdWithProfile(file, profile, input = pixels()) {
  const img = { width: W, height: H, data: new Uint8ClampedArray(input) }
  const buf = ag.writePsdBuffer({ width: W, height: H, imageData: img, children: [{ name: 'image', left: 0, top: 0, right: W, bottom: H, imageData: img }] })
  if (!profile) { fs.writeFileSync(file, buf); return }
  const block = Buffer.alloc(12 + profile.length + profile.length % 2)
  block.write('8BIM', 0, 'ascii'); block.writeUInt16BE(1039, 4)
  block.writeUInt32BE(profile.length, 8); profile.copy(block, 12)
  const at = 30 + buf.readUInt32BE(26)
  const len = buf.readUInt32BE(at)
  const size = Buffer.alloc(4); size.writeUInt32BE(len + block.length)
  fs.writeFileSync(file, Buffer.concat([buf.subarray(0, at), size, buf.subarray(at + 4, at + 4 + len), block, buf.subarray(at + 4 + len)]))
}
/** Independent tagged PNG oracle: same RGB values, with the source ICC embedded as iCCP. */
async function oracle(profile, input = pixels()) {
  const png = await sharp(input, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer()
  const data = Buffer.concat([Buffer.from('Source profile\0\0'), zlib.deflateSync(profile)])
  const type = Buffer.from('iCCP'), len = Buffer.alloc(4), crc = Buffer.alloc(4)
  len.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])))
  const tagged = Buffer.concat([png.subarray(0, 33), len, type, data, crc, png.subarray(33)])
  return sharp(tagged).withIccProfile('srgb').flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer()
}
const at = (buf, x) => [...buf.subarray((20 * W + x) * 3, (20 * W + x) * 3 + 3)]

for (const source of ['p3', 'srgb']) {
  test(`export converts ${source} PSD pixels into tagged sRGB, matching a separate PNG oracle`, async () => {
    const dir = tmpdir(), input = path.join(dir, 'sheet.psd'), output = path.join(dir, 'sheet.jpg')
    const profile = await icc(source)
    psdWithProfile(input, profile)
    const expected = await oracle(profile)
    await exportSheet(input, [{ file: output, quality: 100 }], { size: 'original', ppi: 300, heightInches: 1 })
    const actual = await sharp(output).removeAlpha().raw().toBuffer()
    for (const x of [20, 100]) {
      assert.ok(at(expected, x).every((v, i) => Math.abs(v - at(actual, x)[i]) <= 2), `${source} colour at ${x}: expected ${at(expected, x)}, received ${at(actual, x)}`)
    }
    const meta = await sharp(output).metadata()
    assert.deepEqual([meta.width, meta.height, meta.density], [W, H, 300])
    assert.deepEqual(meta.icc, await icc('srgb'), 'the delivered file declares the actual output profile')
  })
}

test('sheet pixels retain a usable source profile for saved-sheet previews', async () => {
  const file = path.join(tmpdir(), 'sheet.psd'), profile = await icc('p3')
  psdWithProfile(file, profile)
  const px = await sheetPixels(file)
  try {
    const pipe = sharp(px.input, px.raw ? { raw: px.raw } : {})
    const meta = await pipe.metadata()
    assert.deepEqual(meta.icc, profile)
    const actual = await sharp(px.input, px.raw ? { raw: px.raw } : {}).withIccProfile('srgb').removeAlpha().raw().toBuffer()
    assert.deepEqual(at(actual, 20), at(await oracle(profile), 20))
  } finally { if (px.cleanup) await px.cleanup() }
})

test('an invalid embedded ICC profile blocks export rather than silently assigning sRGB', async () => {
  const dir = tmpdir(), input = path.join(dir, 'invalid.psd'), output = path.join(dir, 'output.jpg')
  psdWithProfile(input, Buffer.from('not an ICC profile'))
  await assert.rejects(exportSheet(input, [{ file: output, quality: 97 }], { size: 'original', ppi: 300, heightInches: 1 }), /profile/i)
  assert.equal(fs.existsSync(output), false)
})

test('an untagged RGB composite follows the documented sRGB policy', async () => {
  const file = path.join(tmpdir(), 'untagged.psd')
  psdWithProfile(file, null)
  const px = await sheetPixels(file)
  try {
    const actual = await sharp(px.input, px.raw ? { raw: px.raw } : {}).removeAlpha().raw().toBuffer()
    assert.deepEqual(at(actual, 20), [210, 110, 75])
  } finally { if (px.cleanup) await px.cleanup() }
})

test('template backdrop pixels use the template source profile', async () => {
  const file = path.join(tmpdir(), 'template.psd'), profile = await icc('p3')
  psdWithProfile(file, profile)
  const art = await require('../lib/psd_template').templateArt(file)
  const actual = await sharp(art.backdrop).removeAlpha().raw().toBuffer()
  const expected = await oracle(profile)
  assert.ok(at(expected, 20).every((v, i) => Math.abs(v - at(actual, 20)[i]) <= 3), 'the backdrop must show the converted source colours')
})

test('a flat tagged RGB composite preserves its source colour without requiring the engine', async () => {
  const dir = tmpdir(), input = path.join(dir, 'flat.psd'), output = path.join(dir, 'flat.jpg'), profile = await icc('p3'), values = pixels()
  for (let i = 0; i < W * H; i++) values.set([210, 110, 75, 255], i * 4)
  psdWithProfile(input, profile, values)
  await exportSheet(input, [{ file: output, quality: 100 }], { size: 'original', ppi: 300, heightInches: 1 })
  const expected = await oracle(profile, values), actual = await sharp(output).raw().toBuffer()
  assert.ok(at(expected, 20).every((v, i) => Math.abs(v - at(actual, 20)[i]) <= 2))
})

test('tagged transparent sheet pixels flatten onto white paper before JPEG encoding', async () => {
  const dir = tmpdir(), input = path.join(dir, 'alpha.psd'), output = path.join(dir, 'alpha.jpg'), profile = await icc('p3'), values = pixels()
  for (let i = 0; i < W * H; i++) values[i * 4 + 3] = i % W < W / 2 ? 128 : 0
  psdWithProfile(input, profile, values)
  await exportSheet(input, [{ file: output, quality: 100 }], { size: 'original', ppi: 300, heightInches: 1 })
  const expected = await oracle(profile, values), actual = await sharp(output).raw().toBuffer()
  for (const x of [20, 100]) assert.ok(at(expected, x).every((v, i) => Math.abs(v - at(actual, x)[i]) <= 2), `paper colour at ${x}: ${at(actual, x)} vs ${at(expected, x)}`)
})
