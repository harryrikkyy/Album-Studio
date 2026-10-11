'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { tmpdir } = require('./fixtures')

process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()

const sharp = require('sharp')
const { analyzePhotos, copyPicks } = require('../lib/picks')

/** A shoot: a detailed photo, a blurred copy of it, a near-black frame, and a RAW+JPEG pair. */
async function makeShoot() {
  const dir = path.join(tmpdir(), 'haldi')
  fs.mkdirSync(dir)
  const detail = await sharp({ create: { width: 900, height: 600, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 70 } } }).jpeg().toBuffer()
  await sharp(detail).toFile(path.join(dir, 'A.jpg'))
  await sharp(detail).blur(25).toFile(path.join(dir, 'B.jpg'))
  await sharp({ create: { width: 600, height: 900, channels: 3, background: '#020202' } }).jpeg().toFile(path.join(dir, 'C.jpg'))
  await sharp(detail).toFile(path.join(dir, 'D.jpg'))
  fs.writeFileSync(path.join(dir, 'D.ARW'), 'raw bytes')
  return dir
}

test('a shoot is scored from its thumbnails: sharp beats blurred, a black frame scores badly', async () => {
  const dir = await makeShoot()
  const stages = new Set()
  const r = await analyzePhotos({ folders: [dir] }, { emit: (_e, d) => stages.add(d.stage) })
  const by = Object.fromEntries(r.photos.map((p) => [p.base, p]))
  assert.deepEqual(Object.keys(by).sort(), ['A', 'B', 'C', 'D'])
  assert.ok(by.A.sharpness > by.B.sharpness * 2, `sharp ${by.A.sharpness} vs blurred ${by.B.sharpness}`)
  assert.ok(by.C.exposure < 0.2 && by.A.exposure > 0.5)
  assert.equal(by.C.orient, 'v')
  assert.equal(by.A.hash, by.D.hash, 'the same picture: the same hash')
  assert.deepEqual([...stages].sort(), ['score', 'thumbs'], 'thumbnails made first, then scored')
  const again = []
  await analyzePhotos({ folders: [dir] }, { emit: (_e, d) => again.push(d.stage) })
  assert.deepEqual(again, [], 'a second look comes from the cache')
})

test('picks are copied with every file of the same name (RAW and JPEG together), once', async () => {
  const dir = await makeShoot()
  const r = await copyPicks({ picks: [{ folder: dir, base: 'D' }, { folder: dir, base: 'A' }] })
  assert.equal(r.copied, 3)
  assert.deepEqual(fs.readdirSync(path.join(dir, '_Selected')).sort(), ['A.jpg', 'D.ARW', 'D.jpg'])
  const again = await copyPicks({ picks: [{ folder: dir, base: 'A' }] })
  assert.deepEqual([again.copied, again.skipped], [0, 1], 'already there: left alone')
})
