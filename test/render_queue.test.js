'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStore } = require('../src/state/store')
const { createRenderQueue } = require('../src/features/render_queue')

// A queue wired to a bare store with a scriptable fake bridge. `failures`
// maps a channel to an error it should throw (once set, every call fails).
function harness({ failures = {} } = {}) {
  const store = createStore()
  const calls = { invokes: [], notifies: [], toasts: [], persisted: 0 }
  const rq = createRenderQueue(store, {
    invoke: async (channel, payload) => {
      calls.invokes.push({ channel, payload })
      if (failures[channel]) throw new Error(failures[channel])
      return { success: true }
    },
    updateBadge: () => {},
    setStatus: () => {},
    notify: (msg, kind) => { calls.notifies.push({ msg, kind }) },
    toast: (msg, kind) => { calls.toasts.push({ msg, kind }) },
    persistHashes: () => { calls.persisted++ },
    bakeAdjustments: async () => 0,
    useAdjLayers: () => false,
  })
  return { store, calls, queueRender: rq.queueRender }
}

// queueRender returns before the worker drains; wait for it to go idle.
async function drained(store) {
  while (store.get('renderActive') || store.get('renderQueue').length > 0) {
    await new Promise(r => setImmediate(r))
  }
  // One more tick so the worker's post-loop notify/reset has run.
  await new Promise(r => setImmediate(r))
}

function exportData(outputPath, pages) {
  return { outputPath, pages }
}
function page(templatePath, name) {
  return { templatePath, photos: [{ filePath: `/src/${name}.jpg`, orient: 'H', baseName: name }] }
}

test('an empty range toasts and never starts the worker', async () => {
  const { store, calls, queueRender } = harness()
  await queueRender(exportData('/out', {}))
  assert.equal(calls.invokes.length, 0)
  assert.equal(store.get('renderActive'), false)
  assert.match(calls.toasts[0].msg, /No complete pages/)
})

test('consecutive same-template pages chunk into one batch call', async () => {
  const { store, calls, queueRender } = harness()
  await queueRender(exportData('/out', {
    1: page('/tpl-a.psd', 'a'), 2: page('/tpl-a.psd', 'b'), 3: page('/tpl-a.psd', 'c'),
  }))
  await drained(store)

  assert.equal(calls.invokes.length, 1)
  assert.equal(calls.invokes[0].channel, 'build-pages-batch')
  assert.deepEqual(calls.invokes[0].payload.pages.map(p => p.pageName), ['001', '002', '003'])
  assert.equal(Object.keys(store.get('renderHashes')).length, 3)
  assert.equal(calls.persisted, 1)
  assert.match(calls.notifies[0].msg, /Render complete · 3 fresh/)
  // Stats reset for the next batch.
  assert.deepEqual(store.get('renderStats'),
    { total: 0, done: 0, skipped: 0, failed: 0, cancelled: false })
})

test('a template change splits the chunk', async () => {
  const { store, calls, queueRender } = harness()
  await queueRender(exportData('/out', {
    1: page('/tpl-a.psd', 'a'), 2: page('/tpl-b.psd', 'b'),
  }))
  await drained(store)
  assert.equal(calls.invokes.length, 2)
  assert.equal(calls.invokes[0].payload.templatePath, '/tpl-a.psd')
  assert.equal(calls.invokes[1].payload.templatePath, '/tpl-b.psd')
})

test('unchanged pages are served from the render cache — the bridge is not called', async () => {
  const { store, calls, queueRender } = harness()
  const data = () => exportData('/out', { 1: page('/tpl-a.psd', 'a'), 2: page('/tpl-a.psd', 'b') })
  await queueRender(data())
  await drained(store)
  assert.equal(calls.invokes.length, 1)

  await queueRender(data())
  await drained(store)
  assert.equal(calls.invokes.length, 1) // still just the first call
  assert.match(calls.notifies[1].msg, /Render complete · 0 fresh, 2 cached/)
})

test('a failed batch falls back to per-page renders', async () => {
  const { store, calls, queueRender } = harness({ failures: { 'build-pages-batch': 'PS crashed' } })
  await queueRender(exportData('/out', { 1: page('/tpl-a.psd', 'a'), 2: page('/tpl-a.psd', 'b') }))
  await drained(store)

  const channels = calls.invokes.map(i => i.channel)
  assert.deepEqual(channels, ['build-pages-batch', 'build-page', 'build-page'])
  assert.equal(Object.keys(store.get('renderHashes')).length, 2)
  assert.match(calls.notifies[0].msg, /Render complete · 2 fresh/)
})

test('per-page failures count as failed and toast, without killing the queue', async () => {
  const { store, calls, queueRender } = harness({
    failures: { 'build-pages-batch': 'PS crashed', 'build-page': 'still broken' },
  })
  await queueRender(exportData('/out', { 1: page('/tpl-a.psd', 'a'), 2: page('/tpl-a.psd', 'b') }))
  await drained(store)

  assert.equal(store.get('renderActive'), false)
  assert.equal(Object.keys(store.get('renderHashes')).length, 0)
  assert.equal(calls.toasts.filter(t => t.kind === 'error').length, 2)
  assert.match(calls.notifies[0].msg, /finished with 2 failures/)
})

test('cancellation stops the worker without notifying success', async () => {
  const { store, calls, queueRender } = harness()
  // Cancel before the worker picks anything up. (The badge's cancel button
  // also empties the queue; the worker itself only stops consuming.)
  store.get('renderStats').cancelled = true
  await queueRender(exportData('/out', { 1: page('/tpl-a.psd', 'a') }))
  assert.equal(store.get('renderActive'), false)
  assert.equal(store.get('renderQueue').length, 1) // left unconsumed
  assert.equal(calls.invokes.length, 0)
  assert.match(calls.notifies[0].msg, /Render cancelled/)
})
