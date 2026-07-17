'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStore } = require('../src/state/store')
const { createPhotoPageMap } = require('../src/state/photo_page_map')

// A map wired to a store whose albumPages places p1 on pages 1 & 2 and p2 on
// page 2 — the shape rebuild() indexes.
function harness() {
  const store = createStore({
    albumPages: {
      1: { template: null, photos: [{ id: 'p1', orient: 'H' }] },
      2: { template: null, photos: [{ id: 'p1', orient: 'H' }, { id: 'p2', orient: 'V' }] },
    },
  })
  return { store, ppm: createPhotoPageMap(store) }
}

test('add() indexes a photo onto a page; get() returns the page Set', () => {
  const { ppm } = harness()
  ppm.add('p9', 5)
  assert.ok(ppm.get('p9') instanceof Set)
  assert.deepEqual([...ppm.get('p9')], [5])
})

test('add() is idempotent per page and accumulates distinct pages', () => {
  const { ppm } = harness()
  ppm.add('p9', 5)
  ppm.add('p9', 5)
  ppm.add('p9', 7)
  assert.deepEqual([...ppm.get('p9')].sort(), [5, 7])
})

test('remove() drops one page without disturbing the others', () => {
  const { ppm } = harness()
  ppm.add('p9', 5)
  ppm.add('p9', 7)
  ppm.remove('p9', 5)
  assert.deepEqual([...ppm.get('p9')], [7])
})

test('remove() on an unknown photo is a no-op (no throw)', () => {
  const { ppm } = harness()
  assert.doesNotThrow(() => ppm.remove('nope', 1))
  assert.equal(ppm.get('nope'), undefined)
})

test('get() on an un-indexed photo is undefined', () => {
  const { ppm } = harness()
  assert.equal(ppm.get('missing'), undefined)
})

test('rebuild() indexes every placement from albumPages as numeric page keys', () => {
  const { ppm } = harness()
  ppm.rebuild()
  // p1 sits on pages 1 and 2, p2 only on page 2 — keys are numbers, not strings.
  assert.deepEqual([...ppm.get('p1')].sort((a, b) => a - b), [1, 2])
  assert.deepEqual([...ppm.get('p2')], [2])
  assert.ok([...ppm.get('p1')].every((n) => typeof n === 'number'))
})

test('rebuild() discards any stale entries from a prior album', () => {
  const { store, ppm } = harness()
  ppm.add('ghost', 99)
  ppm.rebuild()
  assert.equal(ppm.get('ghost'), undefined)
  // Re-pointing the album and rebuilding reflects only the new state.
  store.set('albumPages', { 1: { template: null, photos: [{ id: 'pX' }] } })
  ppm.rebuild()
  assert.equal(ppm.get('p1'), undefined)
  assert.deepEqual([...ppm.get('pX')], [1])
})

test('clear() empties the whole index', () => {
  const { ppm } = harness()
  ppm.rebuild()
  ppm.clear()
  assert.equal(ppm.get('p1'), undefined)
  assert.equal(ppm.get('p2'), undefined)
})

test('rebuild() tolerates pages with no photos array', () => {
  const { store, ppm } = harness()
  store.set('albumPages', { 1: { template: null }, 2: null, 3: { template: null, photos: [{ id: 'p3' }] } })
  assert.doesNotThrow(() => ppm.rebuild())
  assert.deepEqual([...ppm.get('p3')], [3])
})
