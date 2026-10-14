'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const sharp = require('../../../src/sharp_config').getSharp()
const { tmpdir } = require('./fixtures')
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()
const { snapshotFile } = require('../lib/cache')
const f = require('./color_edge_fixtures')

test('a cache changed after verification cannot supply pixels to a newly accepted proof', async (t) => {
  const dir = tmpdir(), template = path.join(dir, 'template.psd'), out = path.join(dir, 'proof.jpg')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  f.taggedPsd8(template, await f.icc('srgb'), f.rgbPixels([210, 110, 75, 255]))
  const templates = require('../lib/psd_template'), original = templates.templateArt
  templates.templateArt = async (...args) => {
    const art = await original(...args)
    const replacement = await sharp({ create: { width: f.W, height: f.H, channels: 3, background: '#00ff00' } }).withIccProfile('srgb').jpeg().toBuffer()
    fs.writeFileSync(art.backdrop, replacement)
    return art
  }
  delete require.cache[require.resolve('../lib/proofs')]
  try {
    const { drawProof } = require('../lib/proofs')
    await assert.rejects(drawProof({ n: 1, photoIds: [], template: { file: template } }, { photos: {} }, {}, out), /changed|snapshot/i)
    assert.equal(fs.existsSync(out), false)
  } finally { templates.templateArt = original; delete require.cache[require.resolve('../lib/proofs')] }
})

test('a temporary source mutation during copy cannot hide behind content restored before validation', async (t) => {
  const dir = tmpdir(), file = path.join(dir, 'source.jpg'), stage = path.join(dir, 'private'), original = Buffer.from('ORIGINAL')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, original)
  const expected = crypto.createHash('sha256').update(original).digest('hex'), open = fs.promises.open
  let injected = false
  t.mock.method(fs.promises, 'open', async (target, ...args) => {
    const handle = await open(target, ...args)
    if (target === file) {
      const read = handle.read.bind(handle)
      handle.read = async (...call) => {
        if (injected || call[3] !== 0) return read(...call)
        injected = true; fs.writeFileSync(file, 'REPLACED')
        try { return await read(...call) } finally { fs.writeFileSync(file, original) }
      }
    }
    return handle
  })
  await assert.rejects(snapshotFile(file, stage, expected), /changed|snapshot/i)
  assert.equal(injected, true)
  assert.deepEqual(fs.readFileSync(file), original)
  assert.deepEqual(fs.readdirSync(stage), [])
})
