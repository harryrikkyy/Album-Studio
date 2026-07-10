'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

// createTabs only touches `document`, so a small stub over fake elements is
// enough to unit-test the switching + lazy-paint logic without a real DOM.
function fakeEl(id) {
  const listeners = {}
  const el = {
    id,
    attrs: {},
    dataset: {},
    oninput: null,
    classes: new Set(),
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
      contains: (c) => el.classes.has(c),
    },
    getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn) },
    click: () => (listeners.click || []).forEach(fn => fn({ target: el })),
  }
  return el
}

function makeDom() {
  const byId = {}
  const targets = ['tab-album', 'tab-tools', 'tab-photos', 'tab-export']
  const buttons = targets.map(t => {
    const b = fakeEl('btn-' + t)
    b.attrs['data-target'] = t
    return b
  })
  const panes = targets.map(t => { byId[t] = fakeEl(t); return byId[t] })
  const docListeners = {}
  const doc = {
    byId,
    buttons,
    panes,
    docListeners,
    documentElement: Object.assign(fakeEl('html'), {
      style: { props: {}, setProperty(k, v) { this.props[k] = v } },
    }),
    querySelectorAll: (sel) =>
      sel === '.tab-btn' ? buttons : sel === '.tab-pane' ? panes : [],
    getElementById: (id) => byId[id] || null,
    addEventListener: (type, fn) => { (docListeners[type] ||= []).push(fn) },
  }
  return doc
}

function setup() {
  const doc = makeDom()
  global.document = /** @type {any} */ (doc)
  const calls = []
  const deps = {
    renderStoryboard: () => calls.push('storyboard'),
    renderPhotosGrid: () => calls.push('photosGrid'),
    refreshToolsBarStatus: () => calls.push('toolsStatus'),
    refreshLibraryView: () => calls.push('library'),
    refreshPluginsView: () => calls.push('plugins'),
  }
  const { createTabs } = require('../src/ui_tabs')
  const tabs = createTabs(deps)
  const btn = (t) => doc.buttons.find(b => b.attrs['data-target'] === t)
  return { doc, calls, tabs, btn }
}

test.afterEach(() => { delete global.document })

test('clicking a tab activates its button and pane, deactivating the rest', () => {
  const { doc, btn } = setup()
  btn('tab-album').click()
  btn('tab-export').click()
  assert.equal(btn('tab-export').classList.contains('active'), true)
  assert.equal(btn('tab-album').classList.contains('active'), false)
  assert.equal(doc.byId['tab-export'].classList.contains('active'), true)
  assert.equal(doc.byId['tab-album'].classList.contains('active'), false)
})

test('tab-export refreshes the storyboard on every visit', () => {
  const { calls, btn } = setup()
  btn('tab-export').click()
  btn('tab-album').click()
  btn('tab-export').click()
  assert.deepEqual(calls, ['storyboard', 'storyboard'])
})

test('tab-photos builds the grid once; invalidateTab6 forces a rebuild', () => {
  const { calls, tabs, btn } = setup()
  btn('tab-photos').click()
  btn('tab-photos').click()
  assert.deepEqual(calls, ['photosGrid'])
  assert.equal(tabs.isTab6Rendered(), true)
  tabs.invalidateTab6()
  assert.equal(tabs.isTab6Rendered(), false)
  btn('tab-photos').click()
  assert.deepEqual(calls, ['photosGrid', 'photosGrid'])
})

test('tab-tools refreshes status pills on every visit, panels only once', async () => {
  const { calls, btn } = setup()
  btn('tab-tools').click()
  btn('tab-tools').click()
  await new Promise(r => setTimeout(r, 70))
  assert.deepEqual(calls, ['toolsStatus', 'toolsStatus', 'library', 'plugins'])
})

test('empty-state action clicks are forwarded to the named load button', () => {
  const { doc } = setup()
  let loaded = 0
  doc.byId['btnLoadPhotos'] = { click: () => loaded++ }
  const action = { dataset: { load: 'btnLoadPhotos' } }
  const fire = (target) =>
    doc.docListeners.click.forEach(fn => fn({ target }))
  fire({ closest: () => action })
  fire({ closest: () => null }) // click elsewhere: no-op
  assert.equal(loaded, 1)
})

test('slider input writes the mapped CSS custom property', () => {
  const doc = makeDom()
  doc.byId['redSlider'] = fakeEl('redSlider')
  doc.byId['photosSlider'] = fakeEl('photosSlider')
  global.document = /** @type {any} */ (doc)
  const noop = () => {}
  require('../src/ui_tabs').createTabs({
    renderStoryboard: noop, renderPhotosGrid: noop,
    refreshToolsBarStatus: noop, refreshLibraryView: noop, refreshPluginsView: noop,
  })
  doc.byId['redSlider'].oninput({ target: { value: '132' } })
  doc.byId['photosSlider'].oninput({ target: { value: '90' } })
  assert.equal(doc.documentElement.style.props['--red-thumb-size'], '132px')
  assert.equal(doc.documentElement.style.props['--wp-thumb-size'], '90px')
})
