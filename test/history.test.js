'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStore } = require('../src/state/store')
const { createHistory } = require('../src/state/history')

// A history wired to a seeded store with recording deps. The template lives
// in templateLibrary and the photo in photoCache so snapshot hydration can
// re-link them, exactly like the renderer's live collections.
function harness() {
  const template = { id: 't1', name: 'Tpl' }
  const store = createStore({
    albumPages: { 1: { template, photos: [{ id: 'p1', orient: 'H' }] } },
    totalActivePages: 1,
    currentPage: 1,
    templateLibrary: [template],
    photoCache: { p1: { url: 'blob:p1' } },
    projectData: { imageRotations: { p1: 90 } },
  })
  const calls = { afterApply: 0, persist: 0, toasts: [] }
  const history = createHistory(store, {
    afterApply: () => { calls.afterApply++ },
    persist: () => { calls.persist++ },
    toast: (msg) => { calls.toasts.push(msg) },
  })
  return { store, history, calls }
}

test('mutate runs the fn, returns its result, and pushes one undo snapshot', () => {
  const { store, history, calls } = harness()
  const r = history.mutate('add page', () => {
    store.get('albumPages')[2] = { template: null, photos: [] }
    store.set('totalActivePages', 2)
    return 'ok'
  })
  assert.equal(r, 'ok')
  assert.equal(store.get('historyUndo').length, 1)
  assert.equal(store.get('historyUndo')[0].label, 'add page')
  assert.equal(store.get('historyRedo').length, 0)
  assert.equal(calls.persist, 1)
})

test('undo restores the pre-mutation state exactly; redo re-applies', () => {
  const { store, history, calls } = harness()
  history.mutate('clear', () => {
    store.set('albumPages', { 1: { template: null, photos: [] } })
    store.set('totalActivePages', 1)
    store.set('currentPage', 1)
    store.get('projectData').imageRotations = {}
  })

  history.undo()
  const pages = store.get('albumPages')
  assert.equal(pages[1].photos.length, 1)
  assert.equal(pages[1].photos[0].id, 'p1')
  assert.equal(pages[1].photos[0].url, 'blob:p1') // re-hydrated from photoCache
  assert.equal(pages[1].template.name, 'Tpl') // re-linked from templateLibrary
  assert.deepEqual(store.get('projectData').imageRotations, { p1: 90 })
  assert.equal(calls.afterApply, 1)
  assert.ok(calls.toasts[0].startsWith('Undo'))

  history.redo()
  assert.equal(store.get('albumPages')[1].photos.length, 0)
  assert.equal(store.get('historyUndo').length, 1)
  assert.equal(store.get('historyRedo').length, 0)
})

test('a new mutation invalidates the redo stack', () => {
  const { store, history } = harness()
  history.mutate('a', () => { store.set('currentPage', 2) })
  history.undo()
  assert.equal(store.get('historyRedo').length, 1)
  history.mutate('b', () => { store.set('currentPage', 3) })
  assert.equal(store.get('historyRedo').length, 0)
})

test('nested mutate pushes a snapshot per level (characterization)', () => {
  const { store, history } = harness()
  history.mutate('outer', () => {
    history.mutate('inner', () => { store.set('currentPage', 5) })
  })
  // Pins current behavior: the muted guard only covers undo/redo applies,
  // so nested calls each push (the pre-split comment claimed outermost-only
  // "atomic transactions", but that was never implemented). Undo therefore
  // takes two steps to fully unwind a nested mutation.
  assert.equal(store.get('historyUndo').length, 2)
})

test('mutate during an undo apply does not push history', () => {
  const { store, calls } = harness()
  let history
  history = createHistory(store, {
    // A view re-sync that itself mutates (the real renderGreenBox path).
    afterApply: () => { history.mutate('from-view', () => {}) },
    persist: () => {},
    toast: () => {},
  })
  history.mutate('change', () => { store.set('currentPage', 2) })
  const before = store.get('historyUndo').length
  history.undo()
  // The afterApply mutate must not have pushed a snapshot.
  assert.equal(store.get('historyUndo').length, before - 1)
  assert.equal(store.get('historyMuted'), 0)
  void calls
})

test('the undo stack is capped at 80 entries', () => {
  const { store, history } = harness()
  for (let i = 0; i < 85; i++) {
    history.mutate('m' + i, () => { store.set('currentPage', i + 2) })
  }
  assert.equal(store.get('historyUndo').length, 80)
  assert.equal(store.get('historyUndo')[0].label, 'm5') // oldest 5 dropped
})

test('a throwing mutator rolls state back and pushes nothing', () => {
  const { store, history } = harness()
  assert.throws(() => history.mutate('boom', () => {
    store.set('totalActivePages', 99)
    throw new Error('boom')
  }), /boom/)
  assert.equal(store.get('totalActivePages'), 1)
  assert.equal(store.get('historyUndo').length, 0)
  assert.equal(store.get('historyMuted'), 0)
})

test('undo/redo on empty stacks toast and do nothing', () => {
  const { store, history, calls } = harness()
  history.undo()
  history.redo()
  assert.deepEqual(calls.toasts, ['Nothing to undo', 'Nothing to redo'])
  assert.equal(store.get('albumPages')[1].photos.length, 1)
})
