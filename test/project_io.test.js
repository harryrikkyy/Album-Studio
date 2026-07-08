'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { createStore } = require('../src/state/store')
const { createProjectIO } = require('../src/features/project_io')

// Project IO wired to a bare store with fake IPC, storage, and processors.
// `ipc` maps channel → response value (or a function of the args); throw by
// passing an Error instance.
function harness({ ipc = {}, overrides = {}, entries = {} } = {}) {
  const store = createStore(overrides)
  const calls = {
    invokes: [], processed: [], resets: 0, afterRestores: 0,
    labels: [], notifies: [], toasts: [], generative: 0, persistedHashes: 0,
  }
  const storageData = {}
  const io = createProjectIO(store, {
    invoke: async (channel, ...args) => {
      calls.invokes.push({ channel, args })
      const r = ipc[channel]
      if (r instanceof Error) throw r
      return typeof r === 'function' ? r(...args) : r
    },
    storage: {
      getItem: (k) => (k in storageData ? storageData[k] : null),
      setItem: (k, v) => { storageData[k] = v },
    },
    getEntryForToken: async (t) => {
      const e = entries[String(t)]
      if (e instanceof Error) throw e
      // Folders have no _Thumbnails unless the stub provides getEntry.
      return e || { name: `folder-${t}`, getEntry: async () => { throw new Error('no _Thumbnails') } }
    },
    processors: {
      image: async (f, hr, t) => { calls.processed.push({ kind: 'image', token: t }) },
      template: async (f, t) => { calls.processed.push({ kind: 'template', token: t }) },
      wallpaper: async (f, hr, name, t) => { calls.processed.push({ kind: 'wallpaper', name, token: t }) },
      png: async (f, t) => { calls.processed.push({ kind: 'png', token: t }) },
      masked: async (f, t) => { calls.processed.push({ kind: 'masked', token: t }) },
    },
    resetSourceViews: () => { calls.resets++ },
    setOutputFolderLabel: (text) => { calls.labels.push(text) },
    ensureGenerativeTemplates: async () => { calls.generative++ },
    afterRestore: () => { calls.afterRestores++ },
    persistHashes: () => { calls.persistedHashes++ },
    setStatus: () => {},
    notify: (msg, kind) => { calls.notifies.push({ msg, kind }) },
    toast: (msg, kind) => { calls.toasts.push({ msg, kind }) },
  })
  return { store, calls, storageData, io }
}

test('saveStateToStorage debounces into one compact write', async () => {
  const { store, storageData, io } = harness({
    overrides: {
      albumPages: { 1: { template: { id: 't1', url: 'heavy', _generative: false }, photos: [{ id: 'p1', orient: 'H', url: 'blob:heavy' }] } },
      totalActivePages: 1,
      projectData: { imageRotations: { p1: 90 } },
    },
  })
  io.saveStateToStorage()
  io.saveStateToStorage() // coalesced
  assert.equal('adt_album' in storageData, false) // not yet — debounced
  await new Promise(r => setTimeout(r, 900))

  const album = JSON.parse(storageData.adt_album)
  assert.deepEqual(album.albumPages[1].photos, [{ id: 'p1', orient: 'H' }]) // url stripped
  assert.equal(album.albumPages[1].template.id, 't1')
  assert.equal('url' in album.albumPages[1].template, false) // compact template
  assert.equal(JSON.parse(storageData.adt_workspace).imageRotations.p1, 90)
})

test('buildProjectPayload strips file entries and carries the render cache', () => {
  const { store, io } = harness({
    overrides: {
      albumPages: { 1: { template: { id: 't1', file: { nativePath: '/tpl.psd' } }, photos: [] } },
      renderHashes: { '/out|1': 'abc' },
    },
  })
  const payload = io.buildProjectPayload()
  assert.equal(payload.albumPages[1].template.id, 't1')
  assert.equal('file' in payload.albumPages[1].template, false)
  assert.deepEqual(payload.renderHashes, { '/out|1': 'abc' })
  assert.equal(payload.workspace, store.get('projectData'))
})

test('saveProject prompts when no path is known, then saves in place', async () => {
  const { store, calls, io } = harness({
    ipc: {
      'project-pick-save': '/projects/album',
      'project-write': (target) => ({ ok: true, path: target }),
    },
  })
  assert.equal(await io.saveProject(false), true)
  assert.equal(store.get('currentProjectPath'), '/projects/album')
  assert.match(calls.notifies[0].msg, /Project saved · album/)

  // Second save: no picker, straight to write.
  assert.equal(await io.saveProject(false), true)
  const picks = calls.invokes.filter(i => i.channel === 'project-pick-save')
  assert.equal(picks.length, 1)
})

test('saveProject returns false when the picker is cancelled, toasts on write failure', async () => {
  const cancelled = harness({ ipc: { 'project-pick-save': null } })
  assert.equal(await cancelled.io.saveProject(false), false)
  assert.equal(cancelled.calls.toasts.length, 0) // cancel is silent

  const failing = harness({
    ipc: { 'project-pick-save': '/p', 'project-write': { ok: false } },
  })
  assert.equal(await failing.io.saveProject(false), false)
  assert.match(failing.calls.toasts[0].msg, /Save error/)
})

test('restoreWorkspace rebuilds state, processes folders, and relinks templates', async () => {
  const { store, calls, io } = harness()
  // The template processor populates the library, like the real one.
  const libTemplate = { id: 't1', name: 'relinked' }
  const data = {
    workspace: { imageTokens: ['i1'], templateTokens: ['t-tok'], outputToken: 'out-tok' },
    albumPages: { 1: { template: { id: 't1' }, photos: [] } },
    totalActivePages: 1,
  }
  // Seed templateLibrary when the template processor runs.
  const origPush = calls.processed.push.bind(calls.processed)
  calls.processed.push = (entry) => {
    if (entry.kind === 'template') store.get('templateLibrary').push(libTemplate)
    return origPush(entry)
  }

  await io.restoreWorkspace(data)

  assert.equal(calls.resets, 1)
  assert.deepEqual(calls.processed.map(p => p.kind).sort(), ['image', 'template'])
  assert.equal(store.get('albumPages')[1].template, libTemplate) // relinked by id
  assert.ok(store.get('outputFolder'))
  assert.equal(calls.labels[0], 'folder-out-tok')
  assert.equal(calls.afterRestores, 1)
  assert.equal(calls.generative, 0) // nothing generative in this album
  assert.match(calls.notifies.at(-1).msg, /Workspace ready/)
  // Defaults filled for a legacy payload.
  assert.deepEqual(store.get('projectData').imageRotations, {})
})

test('restoreWorkspace aggregates folder failures into one toast + telemetry event', async () => {
  const { calls, io } = harness({
    entries: { i1: new Error('gone'), i2: new Error('gone too'), 'w1': new Error('moved') },
  })
  await io.restoreWorkspace({
    workspace: { imageTokens: ['i1', 'i2'], wallpaperTokens: ['w1'] },
  })
  const tele = calls.invokes.find(i => i.channel === 'telemetry-event' && i.args[0] === 'workspace_restore_failures')
  assert.ok(tele)
  assert.equal(tele.args[1].total, 3)
  assert.deepEqual(tele.args[1].byKind, { images: 2, wallpapers: 1 })
  assert.match(calls.toasts[0].msg, /3 folders couldn't be restored \(2 images, 1 wallpapers\)/)
  assert.equal(calls.toasts[0].kind, 'warning')
})

test('restoreWorkspace enables generative templates when the album needs them', async () => {
  const { calls, io } = harness()
  await io.restoreWorkspace({
    workspace: {},
    albumPages: { 1: { template: { id: 'gen_grid', _generative: true }, photos: [] } },
  })
  assert.equal(calls.generative, 1)
})

test('a missing output folder is surfaced, not fatal', async () => {
  const { store, calls, io } = harness({ entries: { 'out-tok': new Error('unmounted') } })
  await io.restoreWorkspace({ workspace: { outputToken: 'out-tok' } })
  assert.equal(store.get('outputFolder'), null)
  assert.match(calls.labels[0], /missing/)
  assert.ok(calls.invokes.some(i => i.args[0] === 'output_folder_restore_failed'))
  assert.match(calls.notifies.at(-1).msg, /Workspace ready/) // restore continued
})

test('loadProjectFromDisk re-hydrates the render cache and restores', async () => {
  const { store, calls, io } = harness({
    ipc: {
      'project-pick-open': '/projects/album',
      'project-read': { ok: true, projectPath: '/projects/album', data: { workspace: {}, renderHashes: { k: 'h' } } },
    },
  })
  await io.loadProjectFromDisk()
  assert.equal(store.get('currentProjectPath'), '/projects/album')
  assert.deepEqual(store.get('renderHashes'), { k: 'h' })
  assert.equal(calls.persistedHashes, 1)
  assert.match(calls.notifies.at(-1).msg, /Project loaded/)
})

test('loadProjectFromDisk falls back to the legacy file picker, and toasts on read error', async () => {
  const fallback = harness({
    ipc: {
      'project-pick-open': null,
      'pick-file-open': '/old/project.json',
      'project-read': { ok: true, projectPath: null, data: { workspace: {} } },
    },
  })
  await fallback.io.loadProjectFromDisk()
  assert.ok(fallback.calls.invokes.some(i => i.channel === 'pick-file-open'))
  assert.match(fallback.calls.notifies.at(-1).msg, /Project loaded/)

  const broken = harness({
    ipc: { 'project-pick-open': '/p', 'project-read': { ok: false, error: 'corrupt' } },
  })
  await broken.io.loadProjectFromDisk()
  assert.match(broken.calls.toasts[0].msg, /Load error: corrupt/)
})

test('bootRestore restores the autosaved workspace; a fresh session is a no-op', async () => {
  const seeded = harness()
  seeded.storageData.adt_workspace = JSON.stringify({ imageRotations: { p1: 45 } })
  seeded.storageData.adt_album = JSON.stringify({
    albumPages: { 1: { template: null, photos: [{ id: 'p1', orient: 'V' }] } },
    totalActivePages: 3,
  })
  await seeded.io.bootRestore()
  assert.equal(seeded.store.get('totalActivePages'), 3)
  assert.equal(seeded.store.get('projectData').imageRotations.p1, 45)
  assert.equal(seeded.calls.afterRestores, 1)

  const fresh = harness()
  await fresh.io.bootRestore()
  assert.equal(fresh.calls.afterRestores, 0)
  assert.equal(fresh.calls.resets, 0)
})
