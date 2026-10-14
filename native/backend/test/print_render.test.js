'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const ag = require('ag-psd')
const sharp = require('sharp')
const { tmpdir } = require('./fixtures')
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()
const { buildSheet } = require('../lib/sheet')
const { PhotoCraftSession, cliPath } = require('../lib/photocraft')
const { startRender, renderPlan } = require('../lib/render')
const { startExport } = require('../lib/deliver')
const { openAlbum } = require('../lib/album')
const { printCanvas, printSettings } = require('../lib/print_settings')

async function fixture(t, { low = false } = {}) {
  const root = tmpdir(), templates = path.join(root, 'Templates'), shoot = path.join(root, 'Shoot'), album = path.join(root, 'Album'), output = path.join(album, 'exports')
  for (const dir of [templates, shoot, output]) fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const photo = path.join(shoot, 'photo.jpg'), template = path.join(templates, '1h0v.psd')
  const width = low ? 80 : 640, height = width / 2, data = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) data.set(i % width < width / 2 ? [220, 40, 30] : [30, 180, 60], i * 3)
  await sharp(data, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toFile(photo)
  const pixels = (w, h, color) => {
    const values = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) values.set([...color, 255], i * 4)
    return { width: w, height: h, data: values }
  }
  fs.writeFileSync(template, ag.writePsdBuffer({ width: 200, height: 100, imageData: pixels(200, 100, [255, 255, 255]), children: [
    { name: 'Background', left: 0, top: 0, right: 200, bottom: 100, imageData: pixels(200, 100, [255, 255, 255]) },
    { name: 'ToolkitHFrame_001', left: 20, top: 10, right: 180, bottom: 90, imageData: pixels(160, 80, [100, 100, 100]) },
    { name: 'Top band', left: 0, top: 0, right: 200, bottom: 5, imageData: pixels(200, 5, [20, 40, 80]) },
  ] }))
  fs.writeFileSync(path.join(album, 'project.json'), JSON.stringify({ version: 1, workspace: { imageTokens: [shoot], templateTokens: [templates], outputToken: output }, totalActivePages: 1,
    albumPages: { 1: { photos: [{ id: 'img_Shoot_photo_jpg', orient: 'h' }], template: { id: 'tpl_Templates_1h0v_psd', name: '1h0v.psd', h: 1, v: 0 } } } }))
  return { root, template, photo, album, output }
}
async function render(p) {
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  await startRender(p, { emit: (event, data) => { if (event === 'render.finished') finish(data) } })
  return done
}
async function exportFiles(p) {
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  await startExport(p, { emit: (event, data) => { if (event === 'export.finished') finish(data) } })
  return done
}
function dimensions(file) { const b = fs.readFileSync(file); return [b.readUInt32BE(18), b.readUInt32BE(14)] }

test('a print-sized sheet has the requested canvas and full-detail photos on scaled frames', async (t) => {
  assert.ok(fs.existsSync(cliPath()), 'the real engine is required for print-render verification')
  const f = await fixture(t), pc = new PhotoCraftSession({ writeRoot: f.root }), out = path.join(f.root, 'print.psd')
  try {
    const result = await buildSheet(pc, { template: f.template, outPsd: out, photos: [{ file: f.photo, name: 'photo', orient: 'h' }], printSettings: { size: 'print', heightInches: 1, ppi: 300 } })
    assert.deepEqual(result.warnings, [])
    assert.deepEqual(dimensions(out), [600, 300])
    await pc.call('doc.open', { path: PhotoCraftSession.readPath(out) })
    const doc = await pc.call('doc.inspect', {})
    const frame = doc.layers.find((l) => l.name === 'ToolkitHFrame_001')
    assert.deepEqual(frame.bounds, [60, 30, 480, 240])
    assert.equal(doc.resolution, 300)
    const photo = doc.layers.find((l) => l.name === 'photo')
    assert.ok(photo, 'the original photograph remains a separate embedded smart object')
    await pc.run('layer.smartObjects.editContents', { layer: photo.id })
    const embedded = await pc.call('doc.inspect', {})
    assert.deepEqual([embedded.width, embedded.height], [600, 300], 'embedding uses the scaled frame plus headroom, preserving original detail')
    const px = await require('../lib/deliver').sheetPixels(out)
    try {
      const { data, info } = await sharp(px.input, { ...(px.raw ? { raw: px.raw } : {}) }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)]
      const close = (actual, expected) => actual.every((v, i) => Math.abs(v - expected[i]) <= 3)
      assert.ok(close(pixel(300, 5), [20, 40, 80]), 'scaled decoration stays in place')
      assert.ok(close(pixel(100, 100), [220, 40, 30]), 'left original pixels land within the scaled frame')
      assert.ok(close(pixel(500, 100), [30, 180, 60]), 'right original pixels land within the scaled frame')
    } finally { if (px.cleanup) await px.cleanup() }
  } finally { await pc.close() }
})

test('unreasonable canvas requests are rejected before allocating pixels', () => {
  for (const p of [{ heightInches: Infinity }, { ppi: '300' }, { ppi: 10001 }, { size: 'unknown' }, { heightInches: 0 }]) assert.throws(() => printSettings(p))
  for (const size of [{ width: 200, height: 100, heightInches: 100, ppi: 300 }, { width: 0, height: 100, heightInches: 1, ppi: 300 }, { width: 200, height: 100, heightInches: 0.00001, ppi: 1 }]) {
    assert.throws(() => printCanvas(size.width, size.height, { size: 'print', heightInches: size.heightInches, ppi: size.ppi }), /dimensions|limit/)
  }
})

test('render and delivery agree on print intent, rerender for higher resolution and preserve adequate sheets', async (t) => {
  const f = await fixture(t)
  let result = await render({ album: f.album, size: 'print', heightInches: 1, ppi: 300 })
  assert.equal(result.failed, 0, JSON.stringify(result)); assert.equal(result.done, 1)
  const album = await openAlbum({ path: f.album })
  assert.deepEqual(dimensions(album.spreads[0].sheet), [600, 300])
  assert.equal((await renderPlan({ album: f.album, size: 'print', heightInches: 1, ppi: 300 })).spreads[0].state, 'current')
  assert.equal((await renderPlan({ album: f.album, size: 'print', heightInches: 2, ppi: 300 })).spreads[0].state, 'stale')
  result = await exportFiles({ album: f.album, size: 'print', heightInches: 1, ppi: 300 })
  assert.equal(result.failed, 0, JSON.stringify(result)); assert.equal(result.pdf.pages, 1)
  assert.deepEqual([...(await sharp(path.join(f.album, 'JPEG-High-Res', 'Page_001.jpg')).metadata()).icc].length > 0, true)
  result = await render({ album: f.album, size: 'print', heightInches: 0.5, ppi: 300 })
  assert.equal(result.skipped, 1, 'a higher-resolution owned sheet need not be downsampled and replaced')
})

test('print-sized rendering refuses insufficient original detail without publishing a sheet', async (t) => {
  const f = await fixture(t, { low: true })
  const result = await render({ album: f.album, size: 'print', heightInches: 1, ppi: 300 })
  assert.equal(result.failed, 1)
  assert.match(result.results[0].error, /PPI|resolution/i)
  assert.equal((await openAlbum({ path: f.album })).spreads[0].sheet, null)
})

test('a manual PSD edit at the atomic replacement boundary is captured and restored without overwrite', async (t) => {
  const f = await fixture(t)
  assert.equal((await render({ album: f.album })).failed, 0)
  const album = await openAlbum({ path: f.album }), file = album.spreads[0].sheet
  const cache = path.join(f.output, '.album-studio', 'render-cache.json'), cacheBytes = fs.readFileSync(cache)
  const exclusive = require('../lib/exclusive_rename'), move = exclusive.renameExclusive
  const edit = Buffer.from('An external manual sheet edit at the capture boundary')
  let injected = false
  exclusive.renameExclusive = async (from, to) => {
    if (!injected && from === file && to.includes('render-history')) { injected = true; fs.writeFileSync(file, edit) }
    return move(from, to)
  }
  let result
  try { result = await render({ album: f.album, force: true }) }
  finally { exclusive.renameExclusive = move }
  assert.equal(injected, true)
  assert.equal(result.failed, 1)
  assert.equal(result.done, 0)
  assert.deepEqual(fs.readFileSync(file), edit)
  assert.deepEqual(fs.readFileSync(cache), cacheBytes)
})
