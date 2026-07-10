'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createSourceDrag } = require('../src/ui_source_drag')

function fakeImg(id) {
  const img = {
    id,
    src: `thumb:${id}`,
    classes: new Set(),
    classList: {
      toggle: (c) => img.classes.has(c) ? img.classes.delete(c) : img.classes.add(c),
      contains: (c) => img.classes.has(c),
    },
    closest: (sel) => (sel === '.thumb-red' ? img : null),
  }
  return img
}

function setup() {
  const listeners = { redBox: {}, photosGrid: {} }
  const imgs = { a: fakeImg('a'), b: fakeImg('b'), c: fakeImg('c') }
  const redBox = {
    addEventListener: (t, fn) => { listeners.redBox[t] = fn },
    querySelectorAll: () => Object.values(imgs).filter(i => i.classes.has('selected')),
  }
  const photosGrid = {
    addEventListener: (t, fn) => { listeners.photosGrid[t] = fn },
  }
  global.document = /** @type {any} */ ({
    getElementById: (id) => (id === 'redBox' ? redBox : id === 'photosGrid' ? photosGrid : null),
  })
  const calls = []
  createSourceDrag({
    prepareAndMove: (items) => calls.push(['move', items]),
    setActiveMatchPanel: (p) => calls.push(['panel', p]),
    scheduleFilterUpdate: () => calls.push(['filter']),
    photoNativePath: (id) => (id === 'c' ? null : `/hr/${id}.jpg`),
    startNativeDrag: (paths) => calls.push(['drag', paths]),
  })
  // A pointerup on the wrapper around `img`.
  const wrapperEvent = (img) => ({
    target: {
      closest: (sel) => (sel === '.img-wrapper-red'
        ? { querySelector: () => img }
        : null),
    },
  })
  const dragEvent = (el) => ({
    target: { closest: (sel) => el.closest(sel) },
    prevented: false,
    preventDefault() { this.prevented = true },
  })
  return { listeners, imgs, calls, wrapperEvent, dragEvent }
}

test.afterEach(() => { delete global.document })

test('a single click toggles selection and re-runs template matching', async () => {
  const { listeners, imgs, calls, wrapperEvent } = setup()
  listeners.redBox.pointerup(wrapperEvent(imgs.a))
  assert.deepEqual(calls, []) // nothing until the double-click window closes
  await new Promise(r => setTimeout(r, 320))
  assert.equal(imgs.a.classes.has('selected'), true)
  assert.deepEqual(calls, [['panel', 'source'], ['filter']])
})

test('a double click places the photo instead of selecting it', async () => {
  const { listeners, imgs, calls, wrapperEvent } = setup()
  listeners.redBox.pointerup(wrapperEvent(imgs.a))
  listeners.redBox.pointerup(wrapperEvent(imgs.a))
  await new Promise(r => setTimeout(r, 320))
  assert.equal(imgs.a.classes.has('selected'), false)
  assert.deepEqual(calls, [['move', [{ id: 'a', url: 'thumb:a' }]]])
})

test('clicks on the rotate button are ignored', async () => {
  const { listeners, calls } = setup()
  listeners.redBox.pointerup({ target: { closest: (sel) => (sel === '.btn-rotate-red' ? {} : null) } })
  await new Promise(r => setTimeout(r, 320))
  assert.deepEqual(calls, [])
})

test('dragging a selected thumb drags the whole selected set, skipping unresolvable files', () => {
  const { listeners, imgs, calls, dragEvent } = setup()
  imgs.a.classes.add('selected')
  imgs.b.classes.add('selected')
  imgs.c.classes.add('selected') // photoNativePath → null: dropped
  const e = dragEvent(imgs.a)
  listeners.redBox.dragstart(e)
  assert.equal(e.prevented, true)
  assert.deepEqual(calls, [['drag', ['/hr/a.jpg', '/hr/b.jpg']]])
})

test('dragging an unselected thumb drags only itself', () => {
  const { listeners, imgs, calls, dragEvent } = setup()
  imgs.b.classes.add('selected')
  listeners.redBox.dragstart(dragEvent(imgs.a))
  assert.deepEqual(calls, [['drag', ['/hr/a.jpg']]])
})

test('a drag with no resolvable files keeps the default drag (no preventDefault)', () => {
  const { listeners, imgs, calls, dragEvent } = setup()
  const e = dragEvent(imgs.c)
  listeners.redBox.dragstart(e)
  assert.equal(e.prevented, false)
  assert.deepEqual(calls, [])
})

test('Photos-tab cards drag out their original file by photoId', () => {
  const { listeners, calls } = setup()
  const card = { dataset: { photoId: 'b' } }
  const e = {
    target: { closest: (sel) => (sel === '.wp-card' ? card : null) },
    prevented: false,
    preventDefault() { this.prevented = true },
  }
  listeners.photosGrid.dragstart(e)
  assert.equal(e.prevented, true)
  assert.deepEqual(calls, [['drag', ['/hr/b.jpg']]])
})
