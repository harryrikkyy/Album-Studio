'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStore } = require('../src/state/store')

// createShortcuts only touches `document` inside the handler it installs, so a
// tiny stub is enough to unit-test the dispatch logic without a real DOM.
function makeDocumentStub() {
  const clicks = []
  const byId = {}
  const bySelector = {}
  const stub = {
    handler: null,
    clicks,
    openDialogs: [],
    addEventListener(type, fn) {
      if (type === 'keydown') stub.handler = fn
    },
    getElementById(id) {
      if (!(id in byId)) byId[id] = { click: () => clicks.push(id) }
      return byId[id]
    },
    querySelector(sel) {
      if (!(sel in bySelector)) bySelector[sel] = { click: () => clicks.push(sel) }
      return bySelector[sel]
    },
    querySelectorAll(sel) {
      return sel === 'dialog[open]' ? stub.openDialogs : []
    },
    createElement() {
      const el = { id: '', innerHTML: '', shown: 0, showModal() { el.shown++ } }
      return el
    },
    body: { appendChild() {} },
  }
  return stub
}

function key(props) {
  return {
    key: '', metaKey: false, ctrlKey: false, shiftKey: false,
    target: { tagName: 'DIV' },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    ...props,
  }
}

function setup(storeOverrides) {
  const doc = makeDocumentStub()
  global.document = /** @type {any} */ (doc)
  const store = createStore(storeOverrides)
  const calls = []
  const deps = {
    undo: () => calls.push('undo'),
    redo: () => calls.push('redo'),
    changePage: (n) => calls.push(['changePage', n]),
    setPreview: (i, s) => calls.push(['setPreview', i, s]),
    renderStoryboard: () => calls.push('renderStoryboard'),
  }
  const { createShortcuts } = require('../src/ui_shortcuts')
  createShortcuts(store, deps)
  return { doc, store, calls, fire: (e) => doc.handler(e) }
}

test.afterEach(() => { delete global.document })

test('cmd+z / cmd+shift+z dispatch undo and redo', () => {
  const { calls, fire } = setup()
  fire(key({ key: 'z', metaKey: true }))
  fire(key({ key: 'z', metaKey: true, shiftKey: true }))
  assert.deepEqual(calls, ['undo', 'redo'])
})

test('undo still works while an input is focused, but nothing else does', () => {
  const { calls, fire } = setup()
  const inputTarget = { tagName: 'INPUT' }
  fire(key({ key: 'z', ctrlKey: true, target: inputTarget }))
  fire(key({ key: 'j', target: inputTarget }))
  fire(key({ key: 's', ctrlKey: true, target: inputTarget }))
  assert.deepEqual(calls, ['undo'])
})

test('cmd+1..7 clicks the matching tab button', () => {
  const { doc, fire } = setup()
  fire(key({ key: '3', metaKey: true }))
  assert.deepEqual(doc.clicks, ['.tab-btn[data-target="tab-png"]'])
})

test('cmd+s / cmd+o / cmd+e / cmd+shift+e click the real buttons', () => {
  const { doc, fire } = setup()
  fire(key({ key: 's', metaKey: true }))
  fire(key({ key: 'o', metaKey: true }))
  fire(key({ key: 'e', metaKey: true }))
  fire(key({ key: 'e', metaKey: true, shiftKey: true }))
  assert.deepEqual(doc.clicks, [
    'btnSaveWorkspace', 'btnLoadWorkspace', 'btnAutoThis', 'btnRenderFinalAlbum',
  ])
})

test('j/k and arrows page relative to the store currentPage', () => {
  const { calls, fire } = setup({ currentPage: 4 })
  fire(key({ key: 'j' }))
  fire(key({ key: 'k' }))
  fire(key({ key: 'ArrowLeft' }))
  fire(key({ key: 'ArrowRight' }))
  assert.deepEqual(calls, [
    ['changePage', 3], ['changePage', 5], ['changePage', 3], ['changePage', 5],
  ])
})

test('digits 1..5 pick a template only when the filtered list has one', () => {
  const { calls, fire } = setup({ filteredTemplates: [{ id: 'a' }, { id: 'b' }] })
  fire(key({ key: '2' }))
  fire(key({ key: '5' })) // out of range: no-op
  assert.deepEqual(calls, [['setPreview', 1, true]])
})

test('escape closes every open dialog', () => {
  const { doc, fire } = setup()
  let closed = 0
  doc.openDialogs = [{ close: () => closed++ }, { close: () => closed++ }]
  fire(key({ key: 'Escape' }))
  assert.equal(closed, 2)
})

test('? builds the help dialog once and reopens it after', () => {
  const { doc, fire } = setup()
  // The stub caches by id, so both presses see the same element after the
  // first press assigns its id — mirror that by pre-seeding lookup misses.
  const created = []
  const realCreate = doc.createElement
  doc.createElement = () => { const el = realCreate(); created.push(el); return el }
  doc.getElementById = (id) =>
    id === 'shortcutHelpDialog' ? (created[0] && created[0].id === id ? created[0] : null) : null
  fire(key({ key: '?' }))
  fire(key({ key: '?' }))
  assert.equal(created.length, 1)
  assert.equal(created[0].shown, 2)
  assert.match(created[0].innerHTML, /Keyboard Shortcuts/)
})
