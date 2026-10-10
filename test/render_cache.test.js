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

// ── The deliverable has to still be there ───────────────────────────────────
// A matching hash only proves the page's INPUTS are unchanged. If the PSD was
// deleted or moved since, "cached" is a lie: the user presses Render selected,
// is told "0 fresh, 5 cached", and the file is still missing.

test('a cached page whose output file is gone is re-rendered', () => {
  const p = page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a' }])
  const cache = { '/out|5': _hashPage(p) } // inputs unchanged since the last render
  const { fresh, skipped } = partitionByRenderCache([job(5, '/out', p)], cache, () => false)
  assert.equal(skipped.length, 0)
  assert.equal(fresh.length, 1)
  // …and it is stamped so the successful render re-caches it.
  assert.equal(fresh[0].cacheKey, '/out|5')
  assert.equal(fresh[0].hash, _hashPage(p))
})

test('a cached page whose output file still exists is skipped', () => {
  const p = page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a' }])
  const cache = { '/out|5': _hashPage(p) }
  const { fresh, skipped } = partitionByRenderCache([job(5, '/out', p)], cache, () => true)
  assert.equal(fresh.length, 0)
  assert.equal(skipped.length, 1)
})

test('the file checked is the one the build script writes: <output>/Page_NNN.psd', () => {
  const p = page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a' }])
  const asked = []
  const cache = { '/out|5': _hashPage(p), '/out|123': _hashPage(p) }
  partitionByRenderCache([job(5, '/out', p), job(123, '/out', p)], cache, (f) => { asked.push(f); return true })
  assert.deepEqual(asked, ['/out/Page_005.psd', '/out/Page_123.psd'])
})

test('a trailing slash on the output folder does not double up', () => {
  const p = page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a' }])
  const asked = []
  partitionByRenderCache([job(2, '/out/', p)], { '/out/|2': _hashPage(p) }, (f) => { asked.push(f); return true })
  assert.deepEqual(asked, ['/out/Page_002.psd'])
})

test('generative pages are written as .jpg, so that is what must exist', () => {
  const p = page('generative://gen_abc', [{ filePath: '/a', orient: 'h', baseName: 'a' }])
  const asked = []
  partitionByRenderCache([job(3, '/out', p)], { '/out|3': _hashPage(p) }, (f) => { asked.push(f); return true })
  assert.deepEqual(asked, ['/out/Page_003.jpg'])
})

test('only matching hashes are checked on disk — changed pages never touch the file system', () => {
  const before = page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a' }])
  const after = page('/t.psd', [{ filePath: '/b', orient: 'h', baseName: 'b' }])
  const asked = []
  const { fresh } = partitionByRenderCache([job(1, '/out', after)], { '/out|1': _hashPage(before) }, (f) => { asked.push(f); return true })
  assert.equal(fresh.length, 1)
  assert.deepEqual(asked, [])
})

test('without an existence check the cache is trusted, as before', () => {
  const p = page('/t.psd', [{ filePath: '/a', orient: 'h', baseName: 'a' }])
  const { skipped } = partitionByRenderCache([job(5, '/out', p)], { '/out|5': _hashPage(p) })
  assert.equal(skipped.length, 1)
})
