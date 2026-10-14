'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const ag = require('ag-psd')
const { tmpdir } = require('./fixtures')
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()
const { openAlbum } = require('../lib/album')
const { updateAlbum } = require('../lib/project')
const { fileStamp, fileDigest } = require('../lib/cache')
const { spreadHash, renderPlan, startRender } = require('../lib/render')
const { startExport, exportPlan, cancelExport } = require('../lib/deliver')

function writeSheet(file, rgb) {
  const data = new Uint8ClampedArray(600 * 200 * 4)
  for (let i = 0; i < 600 * 200; i++) data.set(i % 600 < 300 ? [...rgb, 255] : [20, 20, 220, 255], i * 4)
  const imageData = { width: 600, height: 200, data }
  fs.writeFileSync(file, ag.writePsdBuffer({ width: 600, height: 200, imageData, children: [{ name: 'ToolkitHFrame_001', left: 0, top: 0, right: 600, bottom: 200, imageData }] }))
}
async function fixture({ missing = false } = {}) {
  const root = tmpdir(), proj = path.join(root, 'Album'), shoot = path.join(root, 'Shoot'), templates = path.join(root, 'Templates'), out = path.join(proj, 'exports')
  for (const folder of [shoot, templates, out]) fs.mkdirSync(folder, { recursive: true })
  const colors = [[230, 30, 30], [30, 230, 30], [30, 30, 230]]
  const pages = {}, tpl = { id: 'tpl_Templates_1h0v_psd', name: '1h0v.psd', h: 1, v: 0 }
  writeSheet(path.join(templates, '1h0v.psd'), [80, 80, 80])
  for (let n = 1; n <= 3; n++) {
    await sharp({ create: { width: 1200, height: 400, channels: 3, background: { r: colors[n - 1][0], g: colors[n - 1][1], b: colors[n - 1][2] } } }).jpeg().toFile(path.join(shoot, `${n}.jpg`))
    pages[n] = { photos: [{ id: `img_Shoot_${n}_jpg`, orient: 'h' }], template: { ...tpl } }
    if (!(missing && n === 3)) writeSheet(path.join(out, `Page_00${n}.psd`), colors[n - 1])
  }
  const ws = { imageTokens: [shoot], templateTokens: [templates], outputToken: out }
  fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({ version: 1, workspace: ws, totalActivePages: 3, albumPages: pages }))
  const album = await openAlbum({ path: proj }), cache = {}
  for (const spread of album.spreads) if (!(missing && spread.n === 3)) cache[spread.n] = { hash: await spreadHash(spread, album, ws), sheet: await fileStamp(spread.sheet), sheetDigest: await fileDigest(spread.sheet) }
  fs.mkdirSync(path.join(out, '.album-studio'))
  fs.writeFileSync(path.join(out, '.album-studio', 'render-cache.json'), JSON.stringify(cache))
  return { root, proj, out }
}
async function run(params, observe = () => {}) {
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  await startExport({ heightInches: 0.5, ...params }, { emit: (event, data) => { observe(event, data); if (event === 'export.finished') finish(data) } })
  const result = await done
  await new Promise((resolve) => setImmediate(resolve))
  return result
}
async function render(params) {
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  await startRender(params, { emit: (event, data) => { if (event === 'render.finished') finish(data) } })
  return done
}

test('a Plan edit invalidates export readiness and production export refuses the old sheet', async () => {
  const { proj } = await fixture()
  assert.equal((await run({ album: proj })).failed, 0)
  await updateAlbum({ album: proj, ops: [{ op: 'placePhoto', id: 'img_Shoot_1_jpg', scale: 1.25 }] })
  const plan = await exportPlan({ album: proj, heightInches: 0.5 })
  assert.equal(plan.spreads[0].state, 'blocked')
  await assert.rejects(run({ album: proj }), /changed|render|stale/i)
})

test('same-size/preserved-time original edits block old rendered-sheet delivery', async () => {
  const { proj } = await fixture()
  assert.equal((await run({ album: proj })).failed, 0)
  const album = await openAlbum({ path: proj }), file = album.photos.img_Shoot_1_jpg.original
  const bytes = fs.readFileSync(file), st = fs.statSync(file), stamp = await fileStamp(file)
  const quantization = bytes.indexOf(Buffer.from([255, 219]))
  assert.ok(quantization >= 0)
  bytes[quantization + 5] = bytes[quantization + 5] === 1 ? 2 : 1
  fs.writeFileSync(file, bytes); fs.utimesSync(file, st.atime, st.mtime)
  await sharp(file, { failOn: 'warning' }).raw().toBuffer()
  assert.equal(await fileStamp(file), stamp)
  assert.equal((await exportPlan({ album: proj, heightInches: 0.5 })).spreads[0].state, 'blocked')
  await assert.rejects(run({ album: proj }), /changed|content history|render/i)
})

test('same-size/preserved-time manual sheet changes invalidate delivery readiness and remain protected', async () => {
  const { proj } = await fixture()
  assert.equal((await run({ album: proj })).failed, 0)
  const album = await openAlbum({ path: proj }), sheet = album.spreads[0].sheet, st = fs.statSync(sheet), stamp = await fileStamp(sheet)
  writeSheet(sheet, [30, 230, 30]); assert.equal(fs.statSync(sheet).size, st.size)
  fs.utimesSync(sheet, st.atime, st.mtime)
  assert.equal(await fileStamp(sheet), stamp)
  assert.equal((await exportPlan({ album: proj, heightInches: 0.5 })).spreads[0].state, 'stale')
  assert.equal((await renderPlan({ album: proj })).spreads[0].edited, true)
  const before = fs.readFileSync(sheet)
  assert.equal((await render({ album: proj, spreads: [1], force: true })).skipped, 1)
  assert.deepEqual(fs.readFileSync(sheet), before)
  assert.equal((await run({ album: proj })).failed, 0)
})

test('historical stamp-only render records retain their files but cannot claim current production content', async () => {
  const { proj, out } = await fixture(), file = path.join(out, '.album-studio', 'render-cache.json')
  const cache = JSON.parse(fs.readFileSync(file, 'utf8'))
  for (const e of Object.values(cache)) { e.hash = 'a'.repeat(64); delete e.sheetDigest }
  fs.writeFileSync(file, JSON.stringify(cache))
  const originals = [1, 2, 3].map((n) => path.join(out, `Page_00${n}.psd`)), bytes = originals.map((p) => fs.readFileSync(p))
  const plan = await exportPlan({ album: proj, heightInches: 0.5 })
  assert.ok(plan.spreads.every((s) => s.state === 'blocked'))
  await assert.rejects(run({ album: proj }), /content history|render/i)
  assert.equal((await render({ album: proj, force: true })).skipped, 3)
  originals.forEach((p, i) => assert.deepEqual(fs.readFileSync(p), bytes[i]))
})

test('delivery follows stable spread ownership after reorder, including edited PSDs', async () => {
  const { proj, out } = await fixture()
  fs.appendFileSync(path.join(out, 'Page_001.psd'), Buffer.from([0]))
  await updateAlbum({ album: proj, ops: [{ op: 'moveSpread', from: 1, to: 2 }] })
  const result = await run({ album: proj, pdf: false })
  assert.equal(result.failed, 0)
  const pixels = await sharp(path.join(proj, 'JPEG-High-Res', 'Page_001.jpg')).raw().toBuffer()
  assert.ok(pixels[1] > pixels[0] + 100, 'new first spread exports the green B sheet, not old red A')
})

test('PDF-only export refuses stale review JPEGs and preserves the previous PDF', async () => {
  const { proj } = await fixture()
  const before = await run({ album: proj })
  const pdfBytes = fs.readFileSync(before.pdf.path)
  const album = await openAlbum({ path: proj })
  fs.appendFileSync(album.spreads[0].sheet, Buffer.from([0]))
  await assert.rejects(run({ album: proj, jpegs: false, pdf: true }), /JPEG|review|changed|stale/i)
  assert.deepEqual(fs.readFileSync(before.pdf.path), pdfBytes)
})

test('preserved-size and timestamp JPEG edits invalidate readiness and cannot be overwritten as owned output', async () => {
  const { proj } = await fixture(), previous = await run({ album: proj })
  const file = path.join(proj, 'JPEG-Low-Res', 'Page_001.jpg'), st = fs.statSync(file), beforeStamp = await fileStamp(file)
  const edited = fs.readFileSync(file)
  edited[edited.length - 10] ^= 1
  fs.writeFileSync(file, edited); fs.utimesSync(file, st.atime, st.mtime)
  assert.equal(await fileStamp(file), beforeStamp, 'the regression bypasses stamp-only readiness')
  assert.equal((await exportPlan({ album: proj, heightInches: 0.5 })).spreads[0].state, 'stale')
  const pdfBytes = fs.readFileSync(previous.pdf.path)
  await assert.rejects(run({ album: proj, jpegs: false }), /stale|missing/i)
  const retry = await run({ album: proj, force: true })
  assert.equal(retry.failed, 1)
  assert.match(retry.error, /edited|unowned/i)
  assert.deepEqual(fs.readFileSync(file), edited)
  assert.deepEqual(fs.readFileSync(previous.pdf.path), pdfBytes)
})

test('production delivery refuses incomplete albums instead of silently omitting missing sheets', async () => {
  const { proj } = await fixture({ missing: true })
  await assert.rejects(run({ album: proj }), /spread 3|not rendered|missing/i)
  assert.equal(fs.existsSync(path.join(proj, 'Album - Low Res.pdf')), false)
})

test('simultaneous exports reserve one job before asynchronous preparation', async () => {
  const { proj } = await fixture()
  const done = []
  const context = { emit: (event, value) => { if (event === 'export.finished') done.push(value) } }
  const starts = await Promise.allSettled([startExport({ album: proj, heightInches: 0.5 }, context), startExport({ album: proj, heightInches: 0.5 }, context)])
  assert.equal(starts.filter((r) => r.status === 'fulfilled').length, 1)
  for (let i = 0; i < 200 && !done.length; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(done.length, 1)
  assert.equal(done[0].failed, 0)
})

test('production refuses upsampling a low-resolution sheet to the configured PPI', async () => {
  const { proj } = await fixture()
  await assert.rejects(run({ album: proj, heightInches: 1 }), /200.0 PPI.*300 PPI|larger sheet/i)
})

test('failed publication restores all prior JPEGs, PDF and cache, and the next export can retry', async () => {
  const { proj, out } = await fixture(), previous = await run({ album: proj })
  const targets = [path.join(proj, 'JPEG-High-Res', 'Page_001.jpg'), path.join(proj, 'JPEG-Low-Res', 'Page_001.jpg'), path.join(proj, 'JPEG-High-Res', 'Page_002.jpg'), previous.pdf.path, path.join(out, '.album-studio', 'export-cache.json')]
  const bytes = targets.map((file) => fs.readFileSync(file))
  const failureTarget = await fs.promises.realpath(targets[2])
  const link = fs.promises.link
  let injected = false
  fs.promises.link = async (source, target) => {
    if (!injected && target === failureTarget) { injected = true; throw Object.assign(new Error('Simulated full destination during publication'), { code: 'ENOSPC' }) }
    return link.call(fs.promises, source, target)
  }
  let result
  try { result = await run({ album: proj, force: true }) } finally { fs.promises.link = link }
  assert.equal(injected, true); assert.equal(result.failed, 1); assert.equal(result.done, 0)
  targets.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), bytes[i]))
  assert.equal((await run({ album: proj, force: true })).failed, 0)
})

test('cancellation and source revision changes leave an existing complete delivery untouched', async () => {
  const { proj } = await fixture(), previous = await run({ album: proj })
  const target = path.join(proj, 'JPEG-High-Res', 'Page_001.jpg'), bytes = fs.readFileSync(target), pdf = fs.readFileSync(previous.pdf.path)
  const cancelled = await run({ album: proj, force: true }, (event, data) => { if (event === 'export.progress' && data.state === 'exporting' && data.n === 2) cancelExport({ jobId: data.jobId }) })
  assert.equal(cancelled.cancelled, true); assert.equal(cancelled.done, 0)
  assert.deepEqual(fs.readFileSync(target), bytes); assert.deepEqual(fs.readFileSync(previous.pdf.path), pdf)
  const album = await openAlbum({ path: proj })
  const changed = await run({ album: proj, force: true }, (event, data) => { if (event === 'export.progress' && data.state === 'exporting' && data.n === 2) fs.appendFileSync(album.photos.img_Shoot_1_jpg.original, Buffer.from([0])) })
  assert.equal(changed.failed, 1); assert.match(changed.error, /changed during export/i)
  assert.deepEqual(fs.readFileSync(target), bytes); assert.deepEqual(fs.readFileSync(previous.pdf.path), pdf)
})

test('unrelated or externally edited delivery files are preserved', async () => {
  const { proj } = await fixture(), file = path.join(proj, 'JPEG-High-Res', 'Page_001.jpg')
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'unrelated customer file')
  const result = await run({ album: proj })
  assert.equal(result.failed, 1); assert.match(result.error, /unowned|edited/i)
  assert.equal(fs.readFileSync(file, 'utf8'), 'unrelated customer file')
  assert.equal(fs.existsSync(path.join(proj, 'Album - Low Res.pdf')), false)
})

test('empty, duplicate, invalid and unknown selections cannot accidentally export every spread', async () => {
  const { proj } = await fixture()
  for (const spreads of [[], [1, 1], [NaN], [99], 'all']) await assert.rejects(run({ album: proj, spreads }), /Select existing spreads/i)
})

test('a missing spread renders through the real engine into its persistent canonical sheet', async () => {
  const { proj } = await fixture({ missing: true })
  const { startRender } = require('../lib/render')
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  await startRender({ album: proj, spreads: [3] }, { emit: (event, data) => { if (event === 'render.finished') finish(data) } })
  const result = await done
  assert.equal(result.failed, 0, JSON.stringify(result)); assert.equal(result.done, 1)
  const album = await openAlbum({ path: proj }), sheet = album.spreads[2].sheet
  assert.ok(sheet.endsWith(`${album.spreads[2].id}.psd`)); assert.ok(fs.statSync(sheet).size > 100)
  assert.equal((await run({ album: proj })).failed, 0, 'the finished render immediately releases its lease for delivery')
})
