'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const ag = require('ag-psd')
const sharp = require('../../../src/sharp_config').getSharp()
const { tmpdir } = require('./fixtures')
const f = require('./color_edge_fixtures')
const { PhotoCraftSession } = require('../lib/photocraft')
const { exportSheet } = require('../lib/deliver')
const { psdPixels } = require('../lib/color')

function layerOnly(profile, pixels, psb) {
  const bytes = ag.writePsdBuffer({ width: f.W, height: f.H,
    children: [{ name: 'Synthetic colour patches', left: 0, top: 0, right: f.W, bottom: f.H, imageData: { width: f.W, height: f.H, data: new Uint8ClampedArray(pixels) } }],
    imageResources: { versionInfo: { hasRealMergedData: false, writerName: 'Album Studio synthetic test', readerName: 'Synthetic', fileVersion: 1 } },
  }, { psb })
  const at = 30 + bytes.readUInt32BE(26), length = bytes.readUInt32BE(at), block = f.resource(1039, profile), nextLength = Buffer.alloc(4)
  nextLength.writeUInt32BE(length + block.length)
  return Buffer.concat([bytes.subarray(0, at), nextLength, bytes.subarray(at + 4, at + 4 + length), block, bytes.subarray(at + 4 + length)])
}

const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

for (const psb of [false, true]) test(`real-engine ${psb ? 'PSB' : 'PSD'} fallback consumes verified bytes across an A-to-B-to-A source race`, async (t) => {
  const dir = tmpdir(), file = path.join(dir, `source.${psb ? 'psb' : 'psd'}`), output = path.join(dir, 'output.jpg')
  const profile = await f.icc('p3'), pixels = f.rgbPixels([210, 110, 75, 255])
  const a = layerOnly(profile, pixels, psb), b = layerOnly(profile, f.rgbPixels([0, 255, 0, 255]), psb)
  fs.writeFileSync(file, a)
  const call = PhotoCraftSession.prototype.call
  let injected = false, openedPath = null, openedDigest = null, openedMode = null
  PhotoCraftSession.prototype.call = async function (method, params) {
    if (method === 'doc.open' && !injected) {
      injected = true
      openedPath = `/${params.path}`
      fs.writeFileSync(file, b)
      try {
        openedDigest = hash(fs.readFileSync(openedPath)); openedMode = fs.statSync(openedPath).mode & 0o777
        return await call.call(this, method, params)
      } finally { fs.writeFileSync(file, a) }
    }
    return call.call(this, method, params)
  }
  try { await exportSheet(file, [{ file: output, quality: 100 }], { size: 'original', heightInches: 1, ppi: 300 }) }
  finally { PhotoCraftSession.prototype.call = call }
  const expectedPng = f.taggedPng(pixels, 4, 8, profile)
  fs.writeFileSync(path.join(dir, 'independent-source.png'), expectedPng)
  const expected = await sharp(expectedPng).withIccProfile('srgb').flatten({ background: '#fff' }).removeAlpha().raw().toBuffer()
  const actual = await sharp(output).removeAlpha().raw().toBuffer()
  const evidence = { file, output, psb, injected, openedPath, openedMode, sourceDigestBefore: hash(a), sourceDigestAfter: hash(fs.readFileSync(file)), openedDigest,
    expected: [...expected.subarray(0, 3)], actual: [...actual.subarray(0, 3)] }
  const evidenceFile = path.join(dir, 'evidence.json')
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2)); t.diagnostic(`Real-engine fallback snapshot evidence: ${evidenceFile}`)
  assert.ok(evidence.expected.every((v, i) => Math.abs(v - evidence.actual[i]) <= 3), `expected verified A ${evidence.expected}, received ${evidence.actual}`)
  assert.equal(injected, true)
  assert.notEqual(openedPath, file, 'the engine must open the exclusive private snapshot')
  assert.equal(path.extname(openedPath), psb ? '.psb' : '.psd')
  assert.equal(openedMode, 0o400)
  assert.equal(openedDigest, hash(a))
  assert.equal(evidence.sourceDigestAfter, hash(a))
  assert.equal(fs.existsSync(openedPath), false, 'export cleanup removes its private input')
})

test('an explicitly supplied verified buffer remains the engine fallback source', async () => {
  const dir = tmpdir(), file = path.join(dir, 'changed.psd'), profile = await f.icc('p3'), pixels = f.rgbPixels([210, 110, 75, 255])
  const verified = layerOnly(profile, pixels, false)
  fs.writeFileSync(file, layerOnly(profile, f.rgbPixels([0, 255, 0, 255]), false))
  const px = await psdPixels(file, { buffer: verified })
  try {
    const expected = await sharp(f.taggedPng(pixels, 4, 8, profile)).withIccProfile('srgb').flatten({ background: '#fff' }).removeAlpha().raw().toBuffer()
    const actual = await sharp(px.input).withIccProfile('srgb').removeAlpha().raw().toBuffer()
    assert.ok([...expected.subarray(0, 3)].every((v, i) => Math.abs(v - actual[i]) <= 3), `verified buffer ${[...expected.subarray(0, 3)]} differs from ${[...actual.subarray(0, 3)]}`)
  } finally { await px.cleanup() }
})

test('a failed private source write leaves the original intact and cleans its staging directory', async (t) => {
  const dir = tmpdir(), file = path.join(dir, 'source.psd'), profile = await f.icc('p3')
  const bytes = layerOnly(profile, f.rgbPixels([210, 110, 75, 255]), false)
  fs.writeFileSync(file, bytes)
  const mkdtemp = fs.promises.mkdtemp, writeFile = fs.promises.writeFile
  let staging = null, opened = 0
  t.mock.method(fs.promises, 'mkdtemp', async (...args) => {
    const made = await mkdtemp.apply(fs.promises, args)
    if (String(args[0]).includes('as-export-')) staging = made
    return made
  })
  t.mock.method(fs.promises, 'writeFile', async (...args) => {
    if (path.basename(args[0]) === 'source.psd') throw Object.assign(new Error('Synthetic source snapshot disk failure'), { code: 'ENOSPC' })
    return writeFile.apply(fs.promises, args)
  })
  t.mock.method(PhotoCraftSession.prototype, 'call', async () => { opened++; throw new Error('The engine must not receive an unverified source') })
  await assert.rejects(psdPixels(file), { code: 'ENOSPC' })
  assert.equal(opened, 0)
  assert.ok(staging)
  assert.equal(fs.existsSync(staging), false)
  assert.deepEqual(fs.readFileSync(file), bytes)
})
