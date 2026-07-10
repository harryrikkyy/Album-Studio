'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStore } = require('../src/state/store')
const { createExportActions } = require('../src/features/export_actions')

function fakeBtn() {
  const handlers = []
  return {
    checked: false,
    value: '',
    innerText: '',
    addEventListener: (_t, fn) => handlers.push(fn),
    fire: () => handlers[0] && handlers[0](),
  }
}

function setup({ storeOverrides, adjFlag } = {}) {
  const els = {
    chkAdjLayers: fakeBtn(),
    btnAutoThis: fakeBtn(),
    btnOutput: fakeBtn(),
    btnSetFinalOutput: fakeBtn(),
    btnExport: fakeBtn(),
    btnRenderFinalAlbum: fakeBtn(),
    exportStart: fakeBtn(),
    exportEnd: fakeBtn(),
    finalOutputText: fakeBtn(),
  }
  global.document = /** @type {any} */ ({ getElementById: (id) => els[id] || null })
  global.localStorage = /** @type {any} */ ({
    data: { adt_adj_layers: adjFlag },
    getItem(k) { return this.data[k] ?? null },
    setItem(k, v) { this.data[k] = String(v) },
  })
  const store = createStore(storeOverrides)
  const calls = []
  const deps = {
    buildExportData: (start, end) => ({ pages: buildPages(start, end) }),
    bakeExportAdjustments: async () => calls.push('bake'),
    queueRender: (d) => calls.push(['queue', d]),
    invoke: async (ch, payload) => calls.push(['invoke', ch, payload]),
    pickFolder: async () => ({ name: 'Out', nativePath: '/out' }),
    createToken: async () => 'tok-1',
    saveState: () => calls.push('save'),
    setStatus: () => {},
    notify: (msg) => calls.push(['notify', msg]),
    toast: (msg) => calls.push(['toast', msg]),
    showAlert: (msg) => calls.push(['alert', msg]),
  }
  let buildPages = (start, end) => {
    const pages = {}
    const album = store.get('albumPages')
    for (let i = start; i <= end; i++) {
      if (album[i]) pages[i] = { templatePath: '/t.psd', photos: album[i].photos }
    }
    return pages
  }
  const actions = createExportActions(store, deps)
  return { els, store, calls, actions }
}

test.afterEach(() => { delete global.document; delete global.localStorage })

test('the J1 flag seeds from localStorage and persists toggles', () => {
  const { els, actions } = setup({ adjFlag: '1' })
  assert.equal(actions.useAdjLayers(), true)
  assert.equal(els.chkAdjLayers.checked, true)
  els.chkAdjLayers.checked = false
  els.chkAdjLayers.fire()
  assert.equal(actions.useAdjLayers(), false)
  assert.equal(global.localStorage.data.adt_adj_layers, '0')
})

test('build-this-page bakes adjustments and invokes the bridge', async () => {
  const { els, calls } = setup({
    storeOverrides: {
      currentPage: 2,
      albumPages: { 2: { template: { id: 't' }, photos: [{ id: 'p1' }] } },
    },
  })
  await els.btnAutoThis.fire()
  assert.deepEqual(calls[0], 'bake')
  const [, channel, payload] = calls[1]
  assert.equal(channel, 'build-page')
  assert.equal(payload.pageName, '002')
  assert.equal(payload.useAdjustmentLayers, false)
  assert.deepEqual(calls[2], ['notify', 'Page 2 built successfully'])
})

test('build-this-page skips the bake when J1 is on', async () => {
  const { els, calls } = setup({
    adjFlag: '1',
    storeOverrides: {
      albumPages: { 1: { template: { id: 't' }, photos: [{ id: 'p1' }] } },
    },
  })
  await els.btnAutoThis.fire()
  assert.ok(!calls.includes('bake'))
  assert.equal(calls[0][2].useAdjustmentLayers, true)
})

test('build-this-page guards: empty page, then missing template', async () => {
  const { els, calls, store } = setup()
  await els.btnAutoThis.fire()
  assert.deepEqual(calls.pop(), ['alert', 'Pull photos into Green Box first!'])
  store.set('albumPages', { 1: { template: null, photos: [{ id: 'p1' }] } })
  await els.btnAutoThis.fire()
  assert.deepEqual(calls.pop(), ['alert', 'Select a template from PSD Library!'])
})

test('picking an output folder stores it with a persistent token', async () => {
  const { els, calls, store } = setup()
  await els.btnOutput.fire()
  assert.equal(store.get('outputFolder').name, 'Out')
  assert.equal(store.get('projectData').outputToken, 'tok-1')
  assert.ok(calls.includes('save'))
  assert.equal(els.finalOutputText.innerText, 'Out')
})

test('range export validates the output folder and the page range', () => {
  const { els, calls, store } = setup()
  els.btnExport.fire()
  assert.deepEqual(calls.pop(), ['alert', 'Please select an Output Folder first!'])
  store.set('outputFolder', { name: 'Out' })
  els.exportStart.value = '5'
  els.exportEnd.value = '2'
  els.btnExport.fire()
  assert.deepEqual(calls.pop(), ['alert', 'Invalid Start/End pages.'])
})

test('render-full-album queues every complete page', () => {
  const { els, calls } = setup({
    storeOverrides: {
      outputFolder: { name: 'Out' },
      totalActivePages: 2,
      albumPages: {
        1: { template: { id: 't' }, photos: [{ id: 'p1' }] },
        2: { template: { id: 't' }, photos: [{ id: 'p2' }] },
      },
    },
  })
  els.btnRenderFinalAlbum.fire()
  const [tag, data] = calls.pop()
  assert.equal(tag, 'queue')
  assert.deepEqual(Object.keys(data.pages), ['1', '2'])
})
