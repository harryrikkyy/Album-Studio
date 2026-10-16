'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const ag = require('ag-psd')
const sharp = require('sharp')
const { tmpdir } = require('./fixtures')
const cache = require('../lib/cache')
function sheet(file) {
  const width = 600, height = 200, data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set([230, 40, 40, 255], i)
  const imageData = { width, height, data }
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ag.writePsdBuffer({ width, height, imageData, children: [{ name: 'ToolkitHFrame_001', left: 0, top: 0, right: width, bottom: height, imageData }] }))
}
function fixture(t) {
  const root = tmpdir(), file = path.join(root, 'sheet.psd'), previous = process.env.ALBUM_STUDIO_CACHE_DIR
  process.env.ALBUM_STUDIO_CACHE_DIR = path.join(root, 'cache'); sheet(file)
  t.after(() => { if (previous === undefined) delete process.env.ALBUM_STUDIO_CACHE_DIR; else process.env.ALBUM_STUDIO_CACHE_DIR = previous; fs.rmSync(root, { recursive: true, force: true }) })
  return { root, file }
}
function deliver(t) { delete require.cache[require.resolve('../lib/deliver')]; t.after(() => { delete require.cache[require.resolve('../lib/deliver')] }); return require('../lib/deliver') }
async function albumFixture(t) {
  const f = fixture(t), proj = path.join(f.root, 'Album'), out = path.join(proj, 'exports'), shoot = path.join(f.root, 'Shoot'), templates = path.join(f.root, 'Templates')
  for (const folder of [out, shoot, templates]) fs.mkdirSync(folder, { recursive: true })
  sheet(path.join(templates, '1h0v.psd')); sheet(path.join(out, 'Page_001.psd'))
  await sharp({ create: { width: 1200, height: 400, channels: 3, background: '#dc2828' } }).jpeg().toFile(path.join(shoot, 'photo.jpg'))
  const ws = { imageTokens: [shoot], templateTokens: [templates], outputToken: out }
  fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({ version: 1, workspace: ws, totalActivePages: 1, albumPages: { 1: { photos: [{ id: 'img_Shoot_photo_jpg', orient: 'h' }], template: { id: 'tpl_Templates_1h0v_psd', name: '1h0v.psd', h: 1, v: 0 } } } }))
  const album = await require('../lib/album').openAlbum({ path: proj }), spread = album.spreads[0], psd = path.join(out, 'Page_001.psd')
  fs.mkdirSync(path.join(out, '.album-studio'))
  fs.writeFileSync(path.join(out, '.album-studio', 'render-cache.json'), JSON.stringify({ 1: { hash: await require('../lib/render_inputs').spreadHash(spread, album, ws), sheet: await cache.fileStamp(psd), sheetDigest: await cache.fileDigest(psd) } }))
  return { ...f, proj, out }
}
async function run(api, proj) {
  let finish
  const done = new Promise(resolve => { finish = resolve })
  await api.startExport({ album: proj, heightInches: 0.5, pdf: false }, { emit: (name, value) => { if (name === 'export.finished') finish(value) } })
  return done
}
test('low-level JPEG export preserves an existing unrelated destination', async t => {
  const f = fixture(t), target = path.join(f.root, 'customer.jpg'); fs.writeFileSync(target, 'manual customer bytes')
  await assert.rejects(deliver(t).exportSheet(f.file, [{ file: target, quality: 90 }], { size: 'original', ppi: 300 }))
  assert.equal(fs.readFileSync(target, 'utf8'), 'manual customer bytes')
})
test('JPEG publication failure retains a substituted private image', async t => {
  const f = fixture(t), target = path.join(f.root, 'new.jpg'), saved = path.join(f.root, 'saved.jpg'), exclusive = require('../lib/exclusive_rename'), originalRename = fs.promises.rename.bind(fs.promises), originalExclusive = exclusive.renameExclusive
  let injected = false
  const intercept = (from, to, action) => { if (to === target && !injected) { injected = true; fs.renameSync(from, saved); fs.writeFileSync(from, 'manual replacement JPEG'); throw Object.assign(new Error('publication interrupted'), { code: 'PUBLICATION_INTERRUPTED' }) }; return action(from, to) }
  t.mock.method(fs.promises, 'rename', async (from, to) => intercept(from, to, originalRename))
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => intercept(from, to, originalExclusive))
  const error = await deliver(t).exportSheet(f.file, [{ file: target, quality: 90 }], { size: 'original', ppi: 300 }).then(() => null, e => e)
  assert.equal(injected, true); assert.equal(error.code, 'PUBLICATION_INTERRUPTED'); assert.ok(error.retainedPath)
  const manual = fs.readdirSync(error.retainedPath).find(n => fs.readFileSync(path.join(error.retainedPath, n), 'utf8') === 'manual replacement JPEG')
  assert.ok(manual); assert.equal(fs.existsSync(target), false)
})
test('pipeline print guard blocks decoded dimensions before low-resolution upsampling', async t => {
  const f = fixture(t), target = path.join(f.root, 'too-large.jpg')
  await assert.rejects(deliver(t).exportSheet(f.file, [{ file: target, quality: 90 }], { size: 'print', heightInches: 1, ppi: 300 }, { expectedDigest: await cache.fileDigest(f.file), n: 1 }), /PPI|print size|resolution/i)
  assert.equal(fs.existsSync(target), false)
})
test('guarded export decodes verified immutable bytes even if its input name changes afterward', async t => {
  const f = fixture(t), target = path.join(f.root, 'verified.jpg'), color = require('../lib/color'), decode = color.psdPixels, original = fs.readFileSync(f.file)
  let immutable = false
  t.mock.method(color, 'psdPixels', async (file, options) => { immutable = Buffer.isBuffer(options?.buffer); fs.writeFileSync(file, 'temporary unrelated input'); try { return await decode(file, options) } finally { fs.writeFileSync(file, original) } })
  await deliver(t).exportSheet(f.file, [{ file: target, quality: 90 }], { size: 'original', ppi: 300 }, { expectedDigest: await cache.fileDigest(f.file), n: 1 })
  assert.equal(immutable, true); assert.equal((await sharp(target).metadata()).width, 600)
})
test('publication handoff retains the transaction stage even before journal creation fails', async t => {
  const f = await albumFixture(t), transaction = require('../lib/delivery_transaction')
  let retained
  t.mock.method(transaction, 'publishDelivery', async (_files, _cache, stage) => { retained = stage; fs.writeFileSync(path.join(stage, 'customer.txt'), 'manual transaction-stage notes'); throw new Error('publication refused before journal') })
  const result = await run(deliver(t), f.proj)
  assert.equal(result.failed, 1); assert.ok(result.error); assert.equal(fs.readFileSync(path.join(retained, 'customer.txt'), 'utf8'), 'manual transaction-stage notes')
})
test('lease finish failure preserves delivered-sheet counts and exposes a finishing warning', async t => {
  const f = await albumFixture(t), jobs = require('../lib/jobs'), release = jobs.releaseJob
  t.mock.method(jobs, 'releaseJob', async lease => { await release(lease); throw new Error('release completion needs review') })
  const result = await run(deliver(t), f.proj)
  assert.equal(result.done, 1); assert.equal(result.failed, 0); assert.match(result.finishingError, /release completion/); assert.ok(result.warnings.length)
  assert.equal(fs.existsSync(path.join(f.proj, 'JPEG-High-Res', 'Page_001.jpg')), true)
})
test('a prepared JPEG changed at handoff is preserved and cannot become delivered evidence', async t => {
  const f = await albumFixture(t), privateWork = require('../lib/private_stage'), create = privateWork.createPrivateStage
  let retained
  t.mock.method(privateWork, 'createPrivateStage', async (...args) => {
    const stage = await create(...args)
    if (args[1] === 'delivery-') {
      const transfer = stage.transfer.bind(stage), cleanup = stage.cleanup.bind(stage)
      stage.transfer = async () => { fs.writeFileSync(path.join(stage.path, 'Page_001-high.jpg'), 'manual prepared JPEG replacement'); return transfer() }
      stage.cleanup = async () => { try { return await cleanup() } catch (e) { retained = e.retainedPath; throw e } }
    }
    return stage
  })
  const result = await run(deliver(t), f.proj)
  assert.equal(result.done, 0); assert.equal(result.failed, 1)
  assert.equal(fs.existsSync(path.join(f.proj, 'JPEG-High-Res', 'Page_001.jpg')), false)
  assert.equal(fs.readFileSync(path.join(retained, 'Page_001-high.jpg'), 'utf8'), 'manual prepared JPEG replacement')
})
