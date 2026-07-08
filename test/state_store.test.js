'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStore, exposeOnGlobal, defaultState } = require('../src/state/store')

test('a fresh store carries the default slices', () => {
  const store = createStore()
  assert.deepEqual(store.get('albumPages'), {})
  assert.deepEqual(store.get('templateLibrary'), [])
  assert.equal(store.get('previewIndex'), 0)
  assert.equal(store.get('currentPage'), 1)
  assert.equal(store.get('totalActivePages'), 1)
  assert.deepEqual(store.get('projectData').imageRotations, {})
})

test('overrides seed slices without touching the rest', () => {
  const store = createStore({ currentPage: 7, totalActivePages: 15 })
  assert.equal(store.get('currentPage'), 7)
  assert.equal(store.get('totalActivePages'), 15)
  assert.equal(store.get('previewIndex'), 0)
})

test('set replaces a slice and get returns the same reference', () => {
  const store = createStore()
  const pages = { 1: { photos: [], template: null } }
  store.set('albumPages', pages)
  assert.equal(store.get('albumPages'), pages)
})

test('unknown slice names throw on get, set, and subscribe', () => {
  const store = createStore()
  // @ts-expect-error deliberate bad key
  assert.throws(() => store.get('nope'), /unknown state slice/)
  // @ts-expect-error deliberate bad key
  assert.throws(() => store.set('nope', 1), /unknown state slice/)
  // @ts-expect-error deliberate bad key
  assert.throws(() => store.subscribe('nope', () => {}), /unknown state slice/)
})

test('subscribe fires on replacement with (value, prev); unsubscribe stops it', () => {
  const store = createStore()
  const seen = []
  const off = store.subscribe('currentPage', (value, prev) => seen.push([value, prev]))
  store.set('currentPage', 3)
  assert.deepEqual(seen, [[3, 1]])
  off()
  store.set('currentPage', 4)
  assert.deepEqual(seen, [[3, 1]])
})

test('setting the identical value does not notify', () => {
  const store = createStore()
  const pages = {}
  store.set('albumPages', pages)
  let calls = 0
  store.subscribe('albumPages', () => calls++)
  store.set('albumPages', pages)
  assert.equal(calls, 0)
})

test('deep mutation of a slice is allowed and unobserved (history owns undo)', () => {
  const store = createStore()
  let calls = 0
  store.subscribe('albumPages', () => calls++)
  store.get('albumPages')[1] = { photos: [], template: null }
  assert.equal(calls, 0)
  assert.deepEqual(Object.keys(store.get('albumPages')), ['1'])
})

test('keys() lists exactly the default slices', () => {
  const store = createStore()
  assert.deepEqual(store.keys().sort(), Object.keys(defaultState()).sort())
})

test('exposeOnGlobal: bare reads/writes on the target hit the store both ways', () => {
  const store = createStore()
  const target = {}
  exposeOnGlobal(store, ['currentPage', 'albumPages'], target)

  // read through the accessor
  assert.equal(target.currentPage, 1)

  // write through the accessor → store sees it
  target.currentPage = 9
  assert.equal(store.get('currentPage'), 9)

  // write through the store → accessor sees it
  const pages = { 2: { photos: [], template: null } }
  store.set('albumPages', pages)
  assert.equal(target.albumPages, pages)

  // compound assignment (totalActivePages++ style) works through the accessor
  target.currentPage += 1
  assert.equal(store.get('currentPage'), 10)
})

test('exposeOnGlobal accessors are configurable (deletable during the split)', () => {
  const store = createStore()
  const target = {}
  exposeOnGlobal(store, ['currentPage'], target)
  delete target.currentPage
  assert.equal('currentPage' in target, false)
})
