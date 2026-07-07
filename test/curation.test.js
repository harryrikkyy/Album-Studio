'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { curate, hamming, clusterDuplicates } = require('../src/curation')

// A 16-hex-char (64-bit) pHash helper.
const H = (hex) => hex.padStart(16, '0')

function feat(overrides = {}) {
  return {
    filePath: '/x.jpg',
    baseName: 'x',
    orient: 'h',
    sharpness: 200,
    exposureScore: 0.8,
    pHash: H('0'),
    ...overrides,
  }
}

test('hamming counts differing bits across 64-bit hex hashes', () => {
  assert.equal(hamming(H('0'), H('0')), 0)
  assert.equal(hamming(H('1'), H('0')), 1) // 0001 vs 0000
  assert.equal(hamming(H('f'), H('0')), 4) // 1111 vs 0000
  assert.equal(hamming(H('ff'), H('00')), 8)
})

test('clusterDuplicates groups within threshold, keeps sharpest as rep', () => {
  const a = feat({ filePath: '/a', pHash: H('00'), sharpness: 100 })
  const b = feat({ filePath: '/b', pHash: H('01'), sharpness: 300 }) // 1 bit from a
  const c = feat({ filePath: '/c', pHash: H('ffff'), sharpness: 150 }) // far away
  const clusters = clusterDuplicates([a, b, c], 8)
  assert.equal(clusters.length, 2)
  // a and b cluster together; sharpest (b) becomes representative.
  const ab = clusters.find((cl) => cl.members.length === 2)
  assert.equal(ab.rep.filePath, '/b')
})

test('curate drops blurry and badly-exposed photos', () => {
  const good = feat({ filePath: '/good', sharpness: 200, exposureScore: 0.9 })
  const blurry = feat({ filePath: '/blurry', sharpness: 10 })
  const dark = feat({ filePath: '/dark', exposureScore: 0.05 })
  const res = curate([good, blurry, dark], { dupThreshold: 0 })
  assert.equal(res.stats.droppedBlur, 1)
  assert.equal(res.stats.droppedExposure, 1)
  assert.equal(res.stats.kept, 1)
  assert.equal(res.keepers[0].filePath, '/good')
})

test('curate dedupes near-identical frames, keeping one per cluster', () => {
  const a = feat({ filePath: '/a', pHash: H('00'), sharpness: 100 })
  const b = feat({ filePath: '/b', pHash: H('01'), sharpness: 300 })
  const res = curate([a, b], { dupThreshold: 8 })
  assert.equal(res.stats.kept, 1)
  assert.equal(res.stats.droppedDuplicates, 1)
  assert.equal(res.keepers[0].filePath, '/b') // sharpest survives
})

test('curate honors orientation caps (targetH / targetV)', () => {
  const feats = [
    feat({ filePath: '/h1', orient: 'h', pHash: H('1000'), sharpness: 100 }),
    feat({ filePath: '/h2', orient: 'h', pHash: H('2000'), sharpness: 300 }),
    feat({ filePath: '/v1', orient: 'v', pHash: H('4000'), sharpness: 250 }),
  ]
  const res = curate(feats, { dupThreshold: 0, targetH: 1, targetV: 5 })
  const kept = res.keepers.map((k) => k.filePath).sort()
  // Only the sharpest H (h2) survives the cap; the single V passes.
  assert.deepEqual(kept, ['/h2', '/v1'])
})

test('curate counts decode errors separately and never keeps them', () => {
  const res = curate([feat(), feat({ filePath: '/bad', error: 'decode failed' })], {
    dupThreshold: 0,
  })
  assert.equal(res.stats.droppedError, 1)
  assert.ok(res.keepers.every((k) => !k.error))
})
