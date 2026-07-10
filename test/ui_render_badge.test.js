'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStore } = require('../src/state/store')
const { createRenderBadge } = require('../src/ui_render_badge')

// The badge only reads/creates one element, so a stub document that tracks a
// single #renderBadge node is enough.
function makeDocumentStub() {
  const doc = {
    badge: null,
    toolbarChildren: [],
    getElementById: (id) => (id === 'renderBadge' ? doc.badge : null),
    createElement() {
      const el = {
        id: '', className: '', innerHTML: '', removed: false,
        remove() { el.removed = true; doc.badge = null },
        querySelector: () => el.cancelBtn,
        cancelBtn: { onclick: null },
      }
      doc.badge = el
      return el
    },
    querySelector: (sel) =>
      sel === '#tab-export .export-toolbar'
        ? { appendChild: (el) => doc.toolbarChildren.push(el) }
        : null,
    body: { appendChild() {} },
  }
  return doc
}

test.afterEach(() => { delete global.document })

test('idle queue removes the badge; active queue mounts it in the toolbar', () => {
  const doc = makeDocumentStub()
  global.document = /** @type {any} */ (doc)
  const store = createStore({
    renderQueue: [{}, {}],
    renderActive: true,
    renderStats: { total: 10, done: 3, skipped: 2, failed: 0, cancelled: false },
  })
  const { updateBadge } = createRenderBadge(store)

  updateBadge()
  assert.equal(doc.toolbarChildren.length, 1)
  assert.match(doc.badge.innerHTML, /width:50%/)     // (3+2)/10
  assert.match(doc.badge.innerHTML, /5 \/ 10/)
  assert.match(doc.badge.innerHTML, /2 cached/)
  assert.doesNotMatch(doc.badge.innerHTML, /failed/)

  store.set('renderQueue', [])
  store.set('renderActive', false)
  const el = doc.badge
  updateBadge()
  assert.equal(el.removed, true)
})

test('failures show in the badge text', () => {
  const doc = makeDocumentStub()
  global.document = /** @type {any} */ (doc)
  const store = createStore({
    renderQueue: [{}],
    renderActive: false,
    renderStats: { total: 4, done: 1, skipped: 0, failed: 2, cancelled: false },
  })
  createRenderBadge(store).updateBadge()
  assert.match(doc.badge.innerHTML, /2 failed/)
})

test('the cancel button flags cancellation and drains the live queue array', () => {
  const doc = makeDocumentStub()
  global.document = /** @type {any} */ (doc)
  const queue = [{}, {}, {}]
  const stats = { total: 3, done: 0, skipped: 0, failed: 0, cancelled: false }
  const store = createStore({ renderQueue: queue, renderActive: true, renderStats: stats })
  createRenderBadge(store).updateBadge()

  doc.badge.cancelBtn.onclick()
  assert.equal(stats.cancelled, true)
  assert.equal(queue.length, 0)
})
