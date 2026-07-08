'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const { createStore } = require('../src/state/store')
const { createExportData } = require('../src/features/export_data')

// Export assembly wired to a seeded store. `dirs` maps folder path → file
// list for the HR scan; `ipc` maps channel → response (Error to throw).
function harness({ overrides = {}, dirs = {}, ipc = {} } = {}) {
  const store = createStore({
    outputFolder: { nativePath: '/out' },
    ...overrides,
  })
  const calls = { invokes: [], readDirs: [] }
  const io = createExportData(store, {
    invoke: async (channel, payload) => {
      calls.invokes.push({ channel, payload })
      const r = ipc[channel]
      if (r instanceof Error) throw r
      return typeof r === 'function' ? r(payload) : r
    },
    readDir: (p) => {
      calls.readDirs.push(p)
      if (!(p in dirs)) throw new Error('ENOENT')
      return dirs[p]
    },
  })
  return { store, calls, io }
}

const tpl = { id: 't1', file: { nativePath: '/tpl.psd' } }

test('buildExportData resolves photos with edits and skips incomplete pages', () => {
  const { io } = harness({
    overrides: {
      albumPages: {
        1: { template: tpl, photos: [{ id: 'p1', orient: 'H' }, { id: 'missing', orient: 'V' }] },
        2: { template: null, photos: [{ id: 'p1' }] }, // no template → skipped
        3: { template: tpl, photos: [] },              // no photos → skipped
      },
      photoCache: { p1: { file: { nativePath: '/src/p1.jpg' }, baseName: 'p1' } },
      projectData: {
        imageRotations: { p1: 90 },
        imageAdjustments: { p1: { exposure: 1 } },
        imagePlacements: {},
      },
    },
  })
  const data = io.buildExportData(1, 3)
  assert.equal(data.outputPath, '/out')
  assert.deepEqual(Object.keys(data.pages), ['1'])
  assert.equal(data.pages[1].templatePath, '/tpl.psd')
  // The un-cached photo is dropped; the cached one carries its edits.
  assert.equal(data.pages[1].photos.length, 1)
  const p = data.pages[1].photos[0]
  assert.equal(p.filePath, '/src/p1.jpg')
  assert.equal(p.rotation, 90)
  assert.deepEqual(p.adjust, { exposure: 1 })
  assert.equal(p.placement, null)
})

test('an attached HR folder upgrades the file path, one scan per folder', () => {
  const { calls, io } = harness({
    overrides: {
      albumPages: {
        1: { template: tpl, photos: [{ id: 'a' }, { id: 'b' }] },
      },
      photoCache: {
        a: { file: { nativePath: '/thumbs/a.jpg' }, baseName: 'IMG_001', hrFolder: { nativePath: '/master' } },
        b: { file: { nativePath: '/thumbs/b.jpg' }, baseName: 'IMG_002', hrFolder: { nativePath: '/master' } },
      },
      projectData: {},
    },
    dirs: { '/master': ['img_001.CR3', 'IMG_002.tif', 'other.txt'] },
  })
  const data = io.buildExportData(1, 1)
  const [a, b] = data.pages[1].photos
  assert.equal(a.filePath, path.join('/master', 'img_001.CR3')) // case-insensitive prefix match
  assert.equal(b.filePath, path.join('/master', 'IMG_002.tif'))
  assert.equal(calls.readDirs.length, 1) // memoized scan
})

test('a missing HR folder falls back to the thumbnail path', () => {
  const { io } = harness({
    overrides: {
      albumPages: { 1: { template: tpl, photos: [{ id: 'a' }] } },
      photoCache: { a: { file: { nativePath: '/thumbs/a.jpg' }, baseName: 'a', hrFolder: { nativePath: '/gone' } } },
      projectData: {},
    },
    dirs: {}, // readDir throws → treated as empty
  })
  assert.equal(io.buildExportData(1, 1).pages[1].photos[0].filePath, '/thumbs/a.jpg')
})

test('generative templates get the sentinel templatePath', () => {
  const { io } = harness({
    overrides: {
      albumPages: { 1: { template: { id: 'gen_grid', _generative: true }, photos: [{ id: 'a' }] } },
      photoCache: { a: { file: { nativePath: '/src/a.jpg' }, baseName: 'a' } },
      projectData: {},
    },
  })
  assert.equal(io.buildExportData(1, 1).pages[1].templatePath, 'generative://gen_grid')
})

test('bakeExportAdjustments bakes only adjusted photos on PSD pages', async () => {
  const { calls, io } = harness({
    ipc: { 'bake-adjusted-source': (p) => ({ ok: true, path: p.srcPath + '.baked.jpg' }) },
  })
  const data = {
    outputPath: '/out',
    pages: {
      1: { templatePath: '/tpl.psd', photos: [
        { filePath: '/a.jpg', adjust: { exposure: 1 } },
        { filePath: '/b.jpg', adjust: null },
      ] },
      2: { templatePath: 'generative://g', photos: [{ filePath: '/c.jpg', adjust: { exposure: 2 } }] },
    },
  }
  const baked = await io.bakeExportAdjustments(data)
  assert.equal(baked, 1)
  assert.equal(data.pages[1].photos[0].filePath, '/a.jpg.baked.jpg') // re-pointed
  assert.equal(data.pages[1].photos[1].filePath, '/b.jpg')           // untouched
  assert.equal(data.pages[2].photos[0].filePath, '/c.jpg')           // generative skipped
  assert.equal(calls.invokes.length, 1)
})

test('a failed bake falls back to the unadjusted original', async () => {
  const { io } = harness({ ipc: { 'bake-adjusted-source': new Error('sharp exploded') } })
  const data = {
    outputPath: '/out',
    pages: { 1: { templatePath: '/tpl.psd', photos: [{ filePath: '/a.jpg', adjust: { exposure: 1 } }] } },
  }
  const baked = await io.bakeExportAdjustments(data)
  assert.equal(baked, 0)
  assert.equal(data.pages[1].photos[0].filePath, '/a.jpg')
})
