'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStore } = require('../src/state/store')
const { createWorkspaceActions } = require('../src/features/workspace_actions')

function fakeEl(id) {
  const listeners = {}
  const el = {
    id,
    innerHTML: 'stale',
    attrs: {},
    style: {},
    classes: new Set(),
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      contains: (c) => el.classes.has(c),
    },
    setAttribute: (k, v) => { el.attrs[k] = v },
    getBoundingClientRect: () => ({ bottom: 40, right: 300 }),
    addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn) },
    fire: (t, e) => (listeners[t] || []).forEach(fn => fn(e || { stopPropagation() {} })),
  }
  return el
}

function setup({ confirmAnswer = true, pickedPath = '/proj/new.json' } = {}) {
  const ids = ['redBox', 'photosGrid', 'redFolderPanel', 'photosFolderPanel',
    'btnSaveWorkspace', 'btnSaveMenuBtn', 'saveMenu', 'btnSaveAs', 'btnNewProject', 'btnLoadWorkspace']
  const els = {}
  for (const id of ids) els[id] = fakeEl(id)
  const docListeners = {}
  global.document = /** @type {any} */ ({
    getElementById: (id) => els[id] || null,
    addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn) },
    body: { appendChild: () => {} },
  })
  global.window = /** @type {any} */ ({ innerWidth: 1200, addEventListener: () => {} })
  const store = createStore({
    photoCache: { p1: {} },
    activeImageFolders: new Set(['f1']),
    albumPages: { 1: { photos: [{ id: 'p1' }], template: { id: 't' } }, 2: { photos: [], template: null } },
    totalActivePages: 2,
    currentPage: 2,
  })
  store.get('projectData').imageTokens = ['tok']
  store.get('projectData').imageRotations = { p1: 90 }
  const calls = []
  const track = (name) => (...args) => { calls.push([name, ...args]) }
  createWorkspaceActions(store, {
    confirmDialog: () => { calls.push(['confirm']); return confirmAnswer },
    invoke: async (ch, ...args) => { calls.push(['invoke', ch, ...args]); return pickedPath },
    saveProject: track('saveProject'),
    loadProjectFromDisk: track('load'),
    clearPhotoPageMap: track('clearPageMap'),
    resetRenderHashes: track('resetHashes'),
    clearProofs: track('clearProofs'),
    syncViewToState: track('sync'),
    updatePageDropdowns: track('dropdowns'),
    renderGreenBox: track('greenBox'),
    changePage: track('changePage'),
    invalidateTab6: track('invalidateTab6'),
    toast: track('toast'),
  })
  return { els, store, calls, docListeners }
}

test.afterEach(() => { delete global.document; delete global.window })

test('save, save-as, and load buttons route to project_io', () => {
  const { els, calls } = setup()
  els.btnSaveWorkspace.fire('click')
  els.btnSaveAs.fire('click')
  els.btnLoadWorkspace.fire('click')
  assert.deepEqual(calls, [['saveProject', false], ['saveProject', true], ['load']])
})

test('the save menu opens positioned under the button and closes on Escape', () => {
  const { els, docListeners } = setup()
  els.btnSaveMenuBtn.fire('click')
  assert.equal(els.saveMenu.classes.has('open'), true)
  assert.equal(els.btnSaveMenuBtn.attrs['aria-expanded'], 'true')
  assert.equal(els.saveMenu.style.top, '44px') // rect.bottom 40 + 4
  docListeners.keydown.forEach(fn => fn({ key: 'Escape' }))
  assert.equal(els.saveMenu.classes.has('open'), false)
  assert.equal(els.btnSaveMenuBtn.attrs['aria-expanded'], 'false')
})

test('new project clears project state but keeps the library, then saves to the picked file', async () => {
  const { els, store, calls } = setup()
  els.btnNewProject.fire('click')
  await new Promise(r => setImmediate(r))

  assert.deepEqual(store.get('photoCache'), {})
  assert.equal(store.get('activeImageFolders').size, 0)
  assert.deepEqual(store.get('albumPages'), { 1: { photos: [], template: null } })
  assert.equal(store.get('totalActivePages'), 1)
  assert.equal(store.get('currentPage'), 1)
  assert.deepEqual(store.get('projectData').imageTokens, [])
  assert.deepEqual(store.get('projectData').imageRotations, {})
  assert.equal(store.get('currentProjectPath'), '/proj/new.json')
  assert.match(els.redBox.innerHTML, /No photos loaded/)
  assert.equal(els.photosGrid.innerHTML, '')
  assert.notEqual(els.redFolderPanel.innerHTML, 'stale')

  const names = calls.map(c => c[0])
  assert.deepEqual(names.slice(0, 2), ['confirm', 'invoke'])
  for (const n of ['invalidateTab6', 'clearPageMap', 'resetHashes', 'clearProofs', 'sync', 'dropdowns', 'greenBox', 'changePage']) {
    assert.ok(names.includes(n), n + ' called')
  }
  assert.deepEqual(calls.at(-1), ['saveProject', false])
})

test('declining the confirm leaves everything untouched', async () => {
  const { els, store, calls } = setup({ confirmAnswer: false })
  els.btnNewProject.fire('click')
  await new Promise(r => setImmediate(r))
  assert.deepEqual(store.get('photoCache'), { p1: {} })
  assert.deepEqual(calls.filter(c => c[0] !== 'confirm'), [])
})

test('cancelling the file picker aborts before anything is cleared', async () => {
  const { els, store, calls } = setup({ pickedPath: null })
  els.btnNewProject.fire('click')
  await new Promise(r => setImmediate(r))
  assert.deepEqual(store.get('photoCache'), { p1: {} })
  assert.equal(calls.some(c => c[0] === 'saveProject'), false)
})
