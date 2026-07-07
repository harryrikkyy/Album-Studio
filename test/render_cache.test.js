'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { partitionByRenderCache, _hashPage } = require('../src/renderer_pure')

// A render job as the queue builds it.
function job(pageNum, outputPath, pageData) {
  return { pageNum, outputPath, pageData }
}
function page(templatePath, photos = []) {
  return { templatePath, photos }
}

test('empty cache → every job is fresh, none skipped', () => {
  const jobs = [
    job(1, '/out', page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a' }])),
    job(2, '/out', page('/t.psd', [{ filePath: '/b', orient: 'v', baseName: 'b' }])),
  ]
  const { fresh, skipped } = partitionByRenderCache(jobs, {})
  assert.equal(fresh.length, 2)
  assert.equal(skipped.length, 0)
})

test('a job whose stored hash matches the current hash is skipped', () => {
  const p = page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a' }])
  const j = job(1, '/out', p)
  const cache = { '/out|1': _hashPage(p) } // pre-seed the exact current hash
  const { fresh, skipped } = partitionByRenderCache([j], cache)
  assert.equal(fresh.length, 0)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0], j)
})

test('a page whose data changed since last render is re-rendered', () => {
  const before = page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a' }])
  const cache = { '/out|1': _hashPage(before) }
  // Same page, but a photo adjustment changed → different hash → must re-render.
  const after = page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a', adjust: { exposure: 10 } }])
  const { fresh, skipped } = partitionByRenderCache([job(1, '/out', after)], cache)
  assert.equal(skipped.length, 0)
  assert.equal(fresh.length, 1)
})

test('fresh jobs carry the computed hash + cacheKey (ready to store)', () => {
  const p = page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a' }])
  const { fresh } = partitionByRenderCache([job(7, '/out', p)], {})
  assert.equal(fresh[0].cacheKey, '/out|7')
  assert.equal(fresh[0].hash, _hashPage(p))
})

test('cacheKey scopes by BOTH outputPath and pageNum', () => {
  const p = page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a' }])
  // Same page number, different output paths → independent cache entries.
  const cache = { '/outA|1': _hashPage(p) } // only outA/page1 is cached
  const res = partitionByRenderCache(
    [job(1, '/outA', p), job(1, '/outB', p)],
    cache
  )
  assert.equal(res.skipped.length, 1) // /outA|1 hit
  assert.equal(res.fresh.length, 1)   // /outB|1 miss
  assert.equal(res.fresh[0].cacheKey, '/outB|1')
})

test('mixed batch partitions correctly and preserves order within each list', () => {
  const p1 = page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a' }])
  const p2 = page('/t.psd', [{ filePath: '/b', orient: 'v', baseName: 'b' }])
  const p3 = page('/t.psd', [{ filePath: '/c', orient: 'h', baseName: 'c' }])
  const cache = { '/out|2': _hashPage(p2) } // only page 2 is unchanged
  const { fresh, skipped } = partitionByRenderCache(
    [job(1, '/out', p1), job(2, '/out', p2), job(3, '/out', p3)],
    cache
  )
  assert.deepEqual(fresh.map((j) => j.pageNum), [1, 3])
  assert.deepEqual(skipped.map((j) => j.pageNum), [2])
})
