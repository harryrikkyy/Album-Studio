'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStore } = require('../src/state/store')
const { seedRenderHashes, saveRenderHashes } = require('../src/state/render_hashes')

function fakeLocalStorage(initial) {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v) },
  }
}

test.afterEach(() => { delete global.localStorage })

test('seed loads the persisted hash map into the store', () => {
  global.localStorage = /** @type {any} */ (fakeLocalStorage({
    adt_render_hashes: '{"p1":"abc","p2":"def"}',
  }))
  const store = createStore()
  seedRenderHashes(store)
  assert.deepEqual(store.get('renderHashes'), { p1: 'abc', p2: 'def' })
})

test('seed falls back to an empty map when nothing is stored or JSON is corrupt', () => {
  global.localStorage = /** @type {any} */ (fakeLocalStorage({}))
  const store = createStore()
  seedRenderHashes(store)
  assert.deepEqual(store.get('renderHashes'), {})

  global.localStorage = /** @type {any} */ (fakeLocalStorage({ adt_render_hashes: '{oops' }))
  seedRenderHashes(store)
  assert.deepEqual(store.get('renderHashes'), {})
})

test('save persists the current store slice as JSON', () => {
  const ls = fakeLocalStorage({})
  global.localStorage = /** @type {any} */ (ls)
  const store = createStore({ renderHashes: { p9: 'zzz' } })
  saveRenderHashes(store)
  assert.equal(ls.data.adt_render_hashes, '{"p9":"zzz"}')
})

test('save swallows storage failures (quota, private mode)', () => {
  global.localStorage = /** @type {any} */ ({ setItem: () => { throw new Error('quota') } })
  const store = createStore()
  assert.doesNotThrow(() => saveRenderHashes(store))
})
