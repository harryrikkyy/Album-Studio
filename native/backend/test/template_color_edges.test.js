'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const sharp = require('../../../src/sharp_config').getSharp()
const { tmpdir } = require('./fixtures')
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()
const f = require('./color_edge_fixtures')
const { templateArt } = require('../lib/psd_template')

async function compare(file, oracle) {
  const art = await templateArt(file, f.W)
  assert.ok(art.backdrop, 'a verified flat or coloured original composite remains a backdrop')
  assert.deepEqual([art.width, art.height], [f.W, f.H])
  const expected = await sharp(oracle)
    .withIccProfile('srgb')
    .flatten({ background: '#fff' })
    .removeAlpha()
    .raw()
    .toBuffer()
  const actual = await sharp(art.backdrop).removeAlpha().raw().toBuffer()
  for (const x of [8, 36]) {
    const at = (12 * f.W + x) * 3
    const want = [...expected.subarray(at, at + 3)],
      received = [...actual.subarray(at, at + 3)]
    assert.ok(
      want.every((v, i) => Math.abs(v - received[i]) <= 4),
      `template patch ${x}: ${want} vs ${received}`,
    )
  }
  assert.deepEqual((await sharp(art.backdrop).metadata()).icc, await f.icc('srgb'))
}

for (const depth of [8, 16])
  test(`CMYK ${depth}-bit template backdrop matches independent ink TIFF`, async () => {
    const file = path.join(tmpdir(), 'template.psd'),
      profile = await f.icc('cmyk'),
      max = depth === 8 ? 255 : 65535
    const values = depth === 8 ? Buffer.alloc(f.W * f.H * 4) : new Uint16Array(f.W * f.H * 4)
    for (let i = 0; i < f.W * f.H; i++)
      values.set(
        (i % f.W < f.W / 2 ? [0.15, 0.45, 0.7, 0.08] : [0.65, 0.2, 0.1, 0.3]).map((v) => Math.round(v * max)),
        i * 4,
      )
    f.rawPsd(file, { depth, mode: 4, values, profile, compression: 1 })
    await compare(file, f.taggedCmykTiff(values, profile, { depth }))
  })

test('16-bit RGB template backdrop retains source precision and profile', async () => {
  const file = path.join(tmpdir(), 'template.psd'),
    profile = f.adobeCompatibleProfile(),
    values = new Uint16Array(f.W * f.H * 3)
  for (let i = 0; i < f.W * f.H; i++)
    values.set(i % f.W < f.W / 2 ? [54321, 28321, 19234] : [12789, 36789, 51432], i * 3)
  f.rawPsd(file, { values, profile })
  await compare(file, f.taggedPng(values, 3, 16, profile))
})

test('an explicit real black template composite remains usable without the engine', async () => {
  const file = path.join(tmpdir(), 'black.psd'),
    profile = await f.icc('p3'),
    pixels = f.rgbPixels([0, 0, 0, 255])
  f.taggedPsd8(file, profile, pixels)
  const previous = process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI
  process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI = '/definitely/missing/photocraft'
  try {
    await compare(file, f.taggedPng(pixels, 4, 8, profile))
  } finally {
    if (previous === undefined) delete process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI
    else process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI = previous
  }
})

test('a declared placeholder template composite is replaced by its actual layer render', async () => {
  const file = path.join(tmpdir(), 'placeholder.psd'),
    profile = await f.icc('p3'),
    pixels = f.rgbPixels()
  f.taggedPsd8(file, profile, pixels, { realMerged: false, compositePixels: f.rgbPixels([240, 230, 20, 255]) })
  await compare(file, f.taggedPng(pixels, 4, 8, profile))
})

test('unprofiled CMYK template backdrop fails with a recovery instruction', async () => {
  const file = path.join(tmpdir(), 'unknown.psd')
  f.rawPsd(file, { depth: 8, mode: 4, values: Buffer.alloc(f.W * f.H * 4, 64), compression: 1 })
  await assert.rejects(templateArt(file), /CMYK.*profile|source profile/i)
  assert.equal(
    fs.readdirSync(process.env.ALBUM_STUDIO_CACHE_DIR).some((name) => name.endsWith('.jpg')),
    false,
  )
})
