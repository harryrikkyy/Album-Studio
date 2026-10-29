'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const sharp = require('../../../src/sharp_config').getSharp()
const { tmpdir } = require('./fixtures')
const colourCache = tmpdir(),
  previousCache = process.env.ALBUM_STUDIO_CACHE_DIR
process.env.ALBUM_STUDIO_CACHE_DIR = colourCache
test.after(() => {
  if (previousCache === undefined) delete process.env.ALBUM_STUDIO_CACHE_DIR
  else process.env.ALBUM_STUDIO_CACHE_DIR = previousCache
  fs.rmSync(colourCache, { recursive: true, force: true })
})
const f = require('./color_edge_fixtures')
const { exportSheet } = require('../lib/deliver')

const settings = { size: 'original', ppi: 300, heightInches: 1 }

async function compare(file, values, channels, depth, profile) {
  const output = path.join(path.dirname(file), 'output.jpg')
  await exportSheet(file, [{ file: output, quality: 100 }], settings)
  // Independently constructed source PNG has direct, unmatted samples, rather
  // than reading back the decoder's own TIFF or PSD container.
  const expected = await sharp(f.taggedPng(values, channels, depth, profile))
    .withIccProfile('srgb')
    .flatten({ background: '#fff' })
    .removeAlpha()
    .raw()
    .toBuffer()
  const actual = await sharp(output).removeAlpha().raw().toBuffer()
  for (const x of [8, 36]) {
    const at = (12 * f.W + x) * 3,
      want = [...expected.subarray(at, at + 3)],
      got = [...actual.subarray(at, at + 3)]
    assert.ok(
      want.every((v, i) => Math.abs(v - got[i]) <= 3),
      `${want} vs ${got}`,
    )
  }
  assert.deepEqual((await sharp(output).metadata()).icc, await f.icc('srgb'))
}

for (const version of [1, 2])
  for (const depth of [8, 16])
    for (const compression of [0, 1, 2, 3]) {
      test(`RGB ${version === 1 ? 'PSD' : 'PSB'} ${depth}-bit compression ${compression} matches direct source PNG`, async () => {
        const file = path.join(tmpdir(), 'native-rgb.psd'),
          profile = f.adobeCompatibleProfile(),
          maximum = depth === 8 ? 255 : 65535
        const values = depth === 8 ? Buffer.alloc(f.W * f.H * 3) : new Uint16Array(f.W * f.H * 3)
        for (let i = 0; i < f.W * f.H; i++)
          values.set(
            (i % f.W < f.W / 2 ? [0.83, 0.43, 0.29] : [0.19, 0.56, 0.79]).map((v) => Math.round(v * maximum)),
            i * 3,
          )
        f.rawPsd(file, { depth, mode: 3, values, profile, version, compression, realMerged: true })
        const previous = process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI
        process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI = '/definitely/missing/photocraft'
        try {
          await compare(file, values, 3, depth, profile)
        } finally {
          if (previous === undefined) delete process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI
          else process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI = previous
        }
      })

      test(`RGB ${version === 1 ? 'PSD' : 'PSB'} ${depth}-bit compression ${compression} un-mattes declared transparency`, async () => {
        const file = path.join(tmpdir(), 'native-alpha.psd'),
          profile = f.adobeCompatibleProfile(),
          maximum = depth === 8 ? 255 : 65535
        const values = depth === 8 ? Buffer.alloc(f.W * f.H * 4) : new Uint16Array(f.W * f.H * 4)
        const matted = depth === 8 ? Buffer.alloc(values.length) : new Uint16Array(values.length)
        for (let i = 0; i < f.W * f.H; i++) {
          const pixel = (i % f.W < f.W / 2 ? [0.83, 0.43, 0.29, 0.5] : [0.19, 0.56, 0.79, 0]).map((v) =>
            Math.round(v * maximum),
          )
          values.set(pixel, i * 4)
          // Adobe compatibility transparency stores a white matte. The oracle PNG
          // stores the original source colour and alpha independently of that encoding.
          matted.set(
            pixel.map((v, c) => (c === 3 ? v : Math.round((v * pixel[3]) / maximum + maximum - pixel[3]))),
            i * 4,
          )
        }
        f.rawPsd(file, {
          depth,
          mode: 3,
          channels: 4,
          values: matted,
          profile,
          version,
          compression,
          realMerged: true,
          alphaDeclared: true,
        })
        const previous = process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI
        process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI = '/definitely/missing/photocraft'
        try {
          await compare(file, values, 4, depth, profile)
        } finally {
          if (previous === undefined) delete process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI
          else process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI = previous
        }
      })
    }

test('corrupt RGB raw, RLE and ZIP planes fail without replacing previous output', async (t) => {
  const values = Buffer.alloc(f.W * f.H * 3, 100),
    profile = f.adobeCompatibleProfile()
  for (const [name, compression, corrupt] of [
    ['truncated raw', 0, (buf) => buf.subarray(0, buf.length - 1)],
    ['truncated ZIP', 2, (buf) => buf.subarray(0, buf.length - 2)],
    [
      'empty RLE row',
      1,
      (buf) => {
        let at = 30 + buf.readUInt32BE(26)
        at += 4 + buf.readUInt32BE(at)
        at += 4 + buf.readUInt32BE(at) + 2
        const count = buf.readUInt16BE(at),
          dataAt = at + 3 * f.H * 2
        buf.writeUInt16BE(0, at)
        return Buffer.concat([buf.subarray(0, dataAt), buf.subarray(dataAt + count)])
      },
    ],
    [
      'overflowing RLE row',
      1,
      (buf) => {
        let at = 30 + buf.readUInt32BE(26)
        at += 4 + buf.readUInt32BE(at)
        at += 4 + buf.readUInt32BE(at) + 2
        const dataAt = at + 3 * f.H * 2
        buf[dataAt] = 129 // 128 repeats exceed the declared 48-sample row
        return buf
      },
    ],
  ])
    await t.test(name, async () => {
      const dir = tmpdir(),
        file = path.join(dir, 'corrupt.psd'),
        output = path.join(dir, 'previous.jpg')
      f.rawPsd(file, { depth: 8, mode: 3, values, profile, compression, realMerged: true })
      fs.writeFileSync(file, corrupt(fs.readFileSync(file)))
      fs.writeFileSync(output, 'previous verified result')
      await assert.rejects(
        exportSheet(file, [{ file: output, quality: 100 }], settings),
        /composite|truncated|RLE|ZIP/i,
      )
      assert.equal(fs.readFileSync(output, 'utf8'), 'previous verified result')
    })
})
