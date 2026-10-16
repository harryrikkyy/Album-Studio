'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { tmpdir } = require('./fixtures')
const f = require('./color_edge_fixtures')
const { profiledRgba, psdPixels } = require('../lib/color')
function fixture(t) {
  const root = tmpdir(), previous = process.env.ALBUM_STUDIO_CACHE_DIR
  process.env.ALBUM_STUDIO_CACHE_DIR = path.join(root, 'cache')
  t.after(() => { if (previous === undefined) delete process.env.ALBUM_STUDIO_CACHE_DIR; else process.env.ALBUM_STUDIO_CACHE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }) })
  return root
}
test('profile conversion cleanup preserves an unknown customer file beside its TIFF', async t => {
  fixture(t)
  const px = await profiledRgba(Buffer.from([200, 80, 40, 255]), 1, 1, await f.icc('srgb'))
  fs.writeFileSync(path.join(path.dirname(px.input), 'customer.txt'), 'unknown colour work')
  const error = await px.cleanup().then(() => null, e => e)
  assert.equal(error?.code, 'PRIVATE_STAGE_PRESERVED'); assert.equal(fs.readFileSync(path.join(error.retainedPath, 'customer.txt'), 'utf8'), 'unknown colour work')
})
test('profile conversion cleanup preserves an edited TIFF instead of deleting it', async t => {
  fixture(t)
  const px = await profiledRgba(Buffer.from([200, 80, 40, 255]), 1, 1, await f.icc('srgb'))
  fs.chmodSync(px.input, 0o600)
  fs.writeFileSync(px.input, 'manual colour TIFF edits')
  const error = await px.cleanup().then(() => null, e => e)
  assert.equal(error?.code, 'PRIVATE_STAGE_PRESERVED'); assert.equal(fs.readFileSync(path.join(error.retainedPath, 'composite.tif'), 'utf8'), 'manual colour TIFF edits')
})
test('a partial colour write preserves its replacement and the primary disk error', async t => {
  const root = fixture(t), open = fs.promises.open.bind(fs.promises), displaced = path.join(root, 'displaced.tif')
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    const handle = await open(file, ...args)
    if (path.basename(file) === 'composite.tif' && args[0] === 'wx') {
      const write = handle.writeFile.bind(handle); let writes = 0
      handle.writeFile = async bytes => { if (++writes === 2) { fs.renameSync(file, displaced); fs.writeFileSync(file, 'manual replacement TIFF'); throw Object.assign(new Error('colour disk full'), { code: 'ENOSPC' }) }; return write(bytes) }
    }
    return handle
  })
  const error = await profiledRgba(Buffer.from([200, 80, 40, 255]), 1, 1, await f.icc('srgb')).then(() => null, e => e)
  assert.equal(error.code, 'ENOSPC'); assert.ok(error.retainedPath)
  assert.equal(fs.readFileSync(path.join(error.retainedPath, 'composite.tif'), 'utf8'), 'manual replacement TIFF'); assert.ok(fs.statSync(displaced).size)
})
test('an engine-open failure keeps its primary error when closing also fails', async t => {
  const root = fixture(t), file = path.join(root, 'layers.psd'), ag = require('ag-psd'), photocraft = require('../lib/photocraft'), engine = photocraft.PhotoCraftSession
  const imageData = { width: 2, height: 1, data: new Uint8ClampedArray([200, 80, 40, 255, 40, 80, 200, 255]) }
  fs.writeFileSync(file, ag.writePsdBuffer({ width: 2, height: 1, children: [{ name: 'Layer', left: 0, top: 0, right: 2, bottom: 1, imageData }], imageResources: { versionInfo: { hasRealMergedData: false, writerName: 'Fixture', readerName: 'Fixture', fileVersion: 1 } } }))
  // A protocol failure stub exercises both terminal errors without leaving a live child.
  class FailingEngine {
    static readPath = engine.readPath
    async call() { throw Object.assign(new Error('primary engine-open error'), { code: 'ENGINE_OPEN' }) }
    async close() { throw Object.assign(new Error('secondary engine-close error'), { code: 'ENGINE_CLOSE' }) }
  }
  t.mock.property(photocraft, 'PhotoCraftSession', FailingEngine)
  const error = await psdPixels(file).then(() => null, e => e)
  assert.equal(error.code, 'ENGINE_OPEN'); assert.match(error.message, /secondary engine-close error/); assert.ok(error.retainedPath)
  assert.equal(fs.existsSync(file), true)
})
