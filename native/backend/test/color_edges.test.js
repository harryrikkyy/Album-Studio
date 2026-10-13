'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const sharp = require('../../../src/sharp_config').getSharp()
const { tmpdir } = require('./fixtures')
const f = require('./color_edge_fixtures')
const { exportSheet } = require('../lib/deliver')
const { validateProfile, assertProfileUsable, decodeCmykComposite, MAX_COMPOSITE_BYTES } = require('../lib/color')

const settings = { size: 'original', ppi: 300, heightInches: 1 }
const sample = (data, x) => [...data.subarray((12 * f.W + x) * 3, (12 * f.W + x) * 3 + 3)]
async function oracle(input) { return sharp(input).withIccProfile('srgb').flatten({ background: '#fff' }).removeAlpha().raw().toBuffer() }
async function compare(input, expected, tolerance = 3) {
  const output = path.join(path.dirname(input), 'output.jpg')
  await exportSheet(input, [{ file: output, quality: 100 }], settings)
  const actual = await sharp(output).removeAlpha().raw().toBuffer()
  for (const x of [8, 36]) assert.ok(sample(expected, x).every((v, i) => Math.abs(v - sample(actual, x)[i]) <= tolerance), `at ${x}: expected ${sample(expected, x)}, received ${sample(actual, x)}`)
  const icc = (await sharp(output).metadata()).icc
  assert.deepEqual(icc, await f.icc('srgb'))
}

for (const [version, profileClass] of [[2, 'mntr'], [4, 'mntr'], [2, 'scnr'], [4, 'prtr']]) {
  test(`Adobe RGB compatible v${version} ${profileClass} source matches independent tagged PNG`, async () => {
    const input = path.join(tmpdir(), 'adobe-compatible.psd'), profile = f.adobeCompatibleProfile(version, profileClass), pixels = f.rgbPixels()
    f.taggedPsd8(input, profile, pixels)
    await compare(input, await oracle(f.taggedPng(pixels, 4, 8, profile)))
  })
}

for (const version of [2, 4]) test(`valid v${version} LUT source is preserved and converted through native CMS`, async () => {
  const profile = f.rgbLutProfile(version), input = path.join(tmpdir(), 'lut.psd'), pixels = f.rgbPixels()
  await assertProfileUsable(profile)
  f.taggedPsd8(input, profile, pixels)
  await compare(input, await oracle(f.taggedPng(pixels, 4, 8, profile)))
})

test('an explicit real tagged black compatibility composite needs no engine fallback', async () => {
  const input = path.join(tmpdir(), 'black.psd'), profile = await f.icc('p3'), pixels = f.rgbPixels([0, 0, 0, 255])
  f.taggedPsd8(input, profile, pixels)
  const previous = process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI
  process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI = '/definitely/missing/photocraft'
  try { await compare(input, await oracle(f.taggedPng(pixels, 4, 8, profile))) }
  finally { if (previous === undefined) delete process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI; else process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI = previous }
})

for (const withComposite of [false, true]) {
  test(`a declared absent real composite uses actual layer pixels (${withComposite ? 'non-black placeholder' : 'black placeholder'})`, async () => {
    const input = path.join(tmpdir(), 'absent.psd'), profile = await f.icc('p3'), pixels = f.rgbPixels()
    f.taggedPsd8(input, profile, pixels, { realMerged: false, withComposite, compositePixels: f.rgbPixels([240, 230, 20, 255]) })
    await compare(input, await oracle(f.taggedPng(pixels, 4, 8, profile)))
  })
}

test('a 16-bit tagged RGB PSD matches independently encoded 16-bit PNG patches', async () => {
  const profile = f.adobeCompatibleProfile(), input = path.join(tmpdir(), 'sixteen.psd'), values = new Uint16Array(f.W * f.H * 3)
  for (let i = 0; i < f.W * f.H; i++) values.set(i % f.W < f.W / 2 ? [54321, 28321, 19234] : [12789, 36789, 51432], i * 3)
  f.rawPsd(input, { values, profile })
  await compare(input, await oracle(f.taggedPng(values, 3, 16, profile)))
})

test('a tagged CMYK PSD matches an independent direct-ink TIFF oracle', async () => {
  const profile = await f.icc('cmyk'), input = path.join(tmpdir(), 'cmyk.psd'), values = Buffer.alloc(f.W * f.H * 4)
  for (let i = 0; i < f.W * f.H; i++) values.set(i % f.W < f.W / 2 ? [40, 120, 180, 20] : [170, 50, 20, 80], i * 4)
  f.rawPsd(input, { depth: 8, mode: 4, values, profile })
  await compare(input, await oracle(f.taggedCmykTiff(values, profile)), 4)
})

for (const version of [1, 2]) for (const depth of [8, 16]) for (const compression of [0, 1, 2, 3]) {
  test(`native CMYK ${version === 1 ? 'PSD' : 'PSB'} ${depth}-bit compression ${compression} preserves ink samples and colour`, async () => {
    const profile = await f.icc('cmyk'), input = path.join(tmpdir(), 'native.psd'), maximum = depth === 8 ? 255 : 65535
    const values = depth === 8 ? Buffer.alloc(f.W * f.H * 4) : new Uint16Array(f.W * f.H * 4)
    for (let i = 0; i < f.W * f.H; i++) values.set((i % f.W < f.W / 2 ? [0.15, 0.45, 0.7, 0.08] : [0.65, 0.2, 0.1, 0.3]).map((v) => Math.round(v * maximum)), i * 4)
    f.rawPsd(input, { depth, mode: 4, values, profile, version, compression })
    const decoded = decodeCmykComposite(fs.readFileSync(input))
    if (depth === 8) assert.deepEqual(decoded.data, values)
    else for (let i = 0; i < values.length; i++) assert.equal(decoded.data.readUInt16LE(i * 2), values[i])
    await compare(input, await oracle(f.taggedCmykTiff(values, profile, { depth })))
  })
}

for (const depth of [8, 16]) {
  test(`CMYK ${depth}-bit transparency un-mattes the compatibility samples before white-paper flattening`, async () => {
    const profile = await f.icc('cmyk'), input = path.join(tmpdir(), 'alpha.psd'), maximum = depth === 8 ? 255 : 65535
    const values = depth === 8 ? Buffer.alloc(f.W * f.H * 5) : new Uint16Array(f.W * f.H * 5)
    for (let i = 0; i < f.W * f.H; i++) values.set([0.2, 0.45, 0.7, 0.1, i % f.W < f.W / 2 ? 0.5 : 0].map((v) => Math.round(v * maximum)), i * 5)
    f.rawPsd(input, { depth, mode: 4, channels: 5, values, profile, compression: 3 })
    await compare(input, await oracle(f.taggedCmykTiff(values, profile, { depth, channels: 5 })))
  })
}

test('CMYK missing composites, extra inks, mismatched profiles and malformed planes fail without delivering a substitute', async (t) => {
  const profile = await f.icc('cmyk'), values = Buffer.alloc(f.W * f.H * 4, 64)
  for (const [name, make] of [
    ['declared absent composite', (file) => f.rawPsd(file, { depth: 8, mode: 4, values, profile, realMerged: false })],
    ['extra spot inks', (file) => { f.rawPsd(file, { depth: 8, mode: 4, values, profile }); const b = fs.readFileSync(file); b.writeUInt16BE(6, 12); fs.writeFileSync(file, b) }],
    ['unidentified fifth ink plane', (file) => f.rawPsd(file, { depth: 8, mode: 4, channels: 5, alphaDeclared: false, values: Buffer.alloc(f.W * f.H * 5, 64), profile })],
    ['RGB profile on CMYK', async (file) => f.rawPsd(file, { depth: 8, mode: 4, values, profile: await f.icc('p3') })],
    ['truncated raw planes', (file) => { f.rawPsd(file, { depth: 8, mode: 4, values, profile }); fs.truncateSync(file, fs.statSync(file).size - 1) }],
    ['truncated RLE rows', (file) => { f.rawPsd(file, { depth: 8, mode: 4, values, profile, compression: 1 }); fs.truncateSync(file, fs.statSync(file).size - 1) }],
    ['truncated ZIP stream', (file) => { f.rawPsd(file, { depth: 8, mode: 4, values, profile, compression: 2 }); fs.truncateSync(file, fs.statSync(file).size - 2) }],
  ]) await t.test(name, async () => {
    const input = path.join(tmpdir(), 'bad.psd'), output = path.join(path.dirname(input), 'output.jpg')
    await make(input)
    await assert.rejects(exportSheet(input, [{ file: output, quality: 100 }], settings), /CMYK|composite/i)
    assert.equal(fs.existsSync(output), false)
  })
})

test('native composite allocation and ZIP output have strict limits before publication', async () => {
  const input = path.join(tmpdir(), 'small.psd'), values = Buffer.alloc(f.W * f.H * 4, 1)
  f.rawPsd(input, { depth: 8, mode: 4, values, profile: await f.icc('cmyk'), compression: 2 })
  const bytes = fs.readFileSync(input)
  const oversized = Buffer.from(bytes); oversized.writeUInt32BE(15000, 14); oversized.writeUInt32BE(15000, 18)
  assert.ok(15000 * 15000 * 4 > MAX_COMPOSITE_BYTES)
  assert.throws(() => decodeCmykComposite(oversized), /512 MiB/)
  const tooSmall = Buffer.from(bytes); tooSmall.writeUInt32BE(1, 14); tooSmall.writeUInt32BE(1, 18)
  assert.throws(() => decodeCmykComposite(tooSmall), /ZIP/)
})

test('native LittleCMS verification accepts a portable gray profile and rejects an invalid CMYK LUT', async () => {
  await assertProfileUsable(f.grayGammaProfile())
  const profile = await f.icc('cmyk')
  await assertProfileUsable(profile)
  const bad = Buffer.from(profile)
  let changed = false
  for (let i = 0; i < bad.readUInt32BE(128); i++) {
    const at = 132 + i * 12
    if (bad.toString('ascii', at, at + 4).startsWith('A2B')) { bad.write('BAD!', bad.readUInt32BE(at + 4)); changed = true }
  }
  assert.equal(changed, true)
  await assert.rejects(assertProfileUsable(bad), /profile/)
})

test('semantic ICC corruption cannot silently fall back to labelled sRGB', async (t) => {
  const original = await f.icc('p3')
  const mutations = [
    ['invalid PCS', (p) => p.write('ABCD', 20)],
    ['unsupported version', (p) => { p[8] = 99 }],
    ['device-link source', (p) => p.write('link', 12)],
    ['unknown curve function', (p) => {
      for (let i = 0; i < p.readUInt32BE(128); i++) { const at = 132 + i * 12; if (p.toString('ascii', at, at + 4) === 'rTRC') { p.writeUInt16BE(99, p.readUInt32BE(at + 4) + 8); break } }
    }],
  ]
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const profile = Buffer.from(original); mutate(profile)
    const input = path.join(tmpdir(), 'invalid.psd'), output = path.join(path.dirname(input), 'output.jpg')
    f.taggedPsd8(input, profile)
    await assert.rejects(exportSheet(input, [{ file: output, quality: 100 }], settings), /profile|ICC/i)
    assert.equal(fs.existsSync(output), false)
    assert.throws(() => validateProfile(profile), /profile|ICC/i)
  })
})
