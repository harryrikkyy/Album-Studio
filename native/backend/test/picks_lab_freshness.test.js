'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const sharp = require('../../../src/sharp_config').getSharp()
const { analyzePhotos } = require('../lib/picks')
const { ensureThumbnails } = require('../lib/thumbs')
const { listSheets } = require('../lib/labnaming')

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-picks-lab-content-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const previous = process.env.ALBUM_STUDIO_CACHE_DIR
  process.env.ALBUM_STUDIO_CACHE_DIR = path.join(dir, 'cache')
  t.after(() => { if (previous === undefined) delete process.env.ALBUM_STUDIO_CACHE_DIR; else process.env.ALBUM_STUDIO_CACHE_DIR = previous })
  const folder = path.join(dir, 'photos'); fs.mkdirSync(folder)
  return { dir, folder }
}
async function buffers(colors) {
  const values = await Promise.all(colors.map((background) => sharp({ create: { width: 640, height: 480, channels: 3, background } }).png({ compressionLevel: 0 }).toBuffer()))
  assert.equal(values[0].length, values[1].length)
  return values
}
const rewrite = (file, bytes) => { fs.writeFileSync(file, bytes); fs.utimesSync(file, 1700000000, 1700000000) }
const context = { emit: () => {} }

test('picks changes its content evidence even when original and thumbnail-directory timestamps stay equal', async (t) => {
  const { folder } = fixture(t), source = path.join(folder, 'Photo.png'), [white, black] = await buffers(['#f0f0f0', '#020202'])
  rewrite(source, white)
  await ensureThumbnails(folder)
  const thumbDir = path.join(folder, '_Thumbnails')
  fs.utimesSync(thumbDir, 1700000000, 1700000000)
  const first = await analyzePhotos({ folders: [folder] }, context)
  const stamp = fs.statSync(thumbDir)
  rewrite(source, black)
  assert.deepEqual(await ensureThumbnails(folder), { made: 1, failed: [] })
  fs.utimesSync(thumbDir, stamp.atime, stamp.mtime)
  const second = await analyzePhotos({ folders: [folder] }, context)
  assert.equal(first.photos[0].blackPct, 0)
  assert.equal(second.photos[0].blackPct, 1, 'cached white-frame scores must not survive the black original')
})

test('picks refuses a failed thumbnail refresh and preserves the edited proxy', async (t) => {
  const { folder } = fixture(t), source = path.join(folder, 'Photo.png'), [white, black] = await buffers(['#f0f0f0', '#020202'])
  rewrite(source, white)
  await analyzePhotos({ folders: [folder] }, context)
  const target = path.join(folder, '_Thumbnails', 'Photo.jpg'), manual = await sharp(black).jpeg().toBuffer()
  fs.writeFileSync(target, manual)
  await assert.rejects(analyzePhotos({ folders: [folder] }, context), /thumbnail|preview|edited|preserv/i)
  assert.deepEqual(fs.readFileSync(target), manual)
})

test('picks scores only verified source-backed proxies and preserves orphan previews', async (t) => {
  const { folder } = fixture(t), source = path.join(folder, 'Photo.png'), [white, black] = await buffers(['#f0f0f0', '#020202'])
  rewrite(source, white)
  await ensureThumbnails(folder)
  const orphan = path.join(folder, '_Thumbnails', 'Deleted-photo.jpg'), bytes = await sharp(black).jpeg().toBuffer()
  fs.writeFileSync(orphan, bytes)
  const result = await analyzePhotos({ folders: [folder] }, context)
  assert.deepEqual(result.photos.map((photo) => photo.base), ['Photo'])
  assert.deepEqual(fs.readFileSync(orphan), bytes)
})

test('picks source changes during scoring reject cache publication', async (t) => {
  const { folder } = fixture(t), source = path.join(folder, 'Photo.png'), [white, black] = await buffers(['#f0f0f0', '#020202'])
  rewrite(source, white)
  const curation = require('../../../src/curation'), original = curation.analyzeFolder
  t.mock.method(curation, 'analyzeFolder', async (...args) => { const result = await original(...args); rewrite(source, black); return result })
  await assert.rejects(analyzePhotos({ folders: [folder] }, context), /changed|refresh|raced/i)
})

test('picks rejects an edited private scoring snapshot and preserves its unexpected bytes', async (t) => {
  const { dir, folder } = fixture(t), source = path.join(folder, 'Photo.png'), [white, black] = await buffers(['#f0f0f0', '#020202'])
  rewrite(source, white)
  const curation = require('../../../src/curation'), original = curation.analyzeFolder
  const manual = await sharp(black).jpeg().toBuffer()
  let snapshot
  t.mock.method(curation, 'analyzeFolder', async (stage, ...args) => {
    snapshot = path.join(stage, 'Photo.jpg'); fs.writeFileSync(snapshot, manual)
    return original(stage, ...args)
  })
  await assert.rejects(analyzePhotos({ folders: [folder] }, context), /snapshot|changed/i)
  assert.deepEqual(fs.readFileSync(snapshot), manual)
  assert.deepEqual(fs.readdirSync(path.join(dir, 'cache', 'picks')).filter((name) => !name.startsWith('.')), [], 'no scores are committed from an edited scratch input')
})

test('picks rejects a private snapshot changed and restored around decoding', async (t) => {
  const { dir, folder } = fixture(t), source = path.join(folder, 'Photo.png'), [white, black] = await buffers(['#f0f0f0', '#020202'])
  rewrite(source, white)
  const curation = require('../../../src/curation'), original = curation.analyzeFolder
  let snapshot, snapshotBytes
  t.mock.method(curation, 'analyzeFolder', async (stage, ...args) => {
    const file = path.join(stage, 'Photo.jpg'), prior = fs.readFileSync(file), st = fs.statSync(file)
    snapshot = file; snapshotBytes = prior
    fs.writeFileSync(file, await sharp(black).jpeg().toBuffer())
    const result = await original(stage, ...args)
    fs.writeFileSync(file, prior); fs.utimesSync(file, st.atime, st.mtime)
    return result
  })
  await assert.rejects(analyzePhotos({ folders: [folder] }, context), /snapshot|changed/i)
  assert.deepEqual(fs.readFileSync(snapshot), snapshotBytes, 'a changed-and-restored snapshot is retained for diagnosis')
  assert.deepEqual(fs.readdirSync(path.join(dir, 'cache', 'picks')).filter((name) => !name.startsWith('.')), [], 'no scores are published from transiently changed input')
})

test('lab thumbnails refresh a preserved-size/stamp sheet and retain previous preview bytes', async (t) => {
  const { folder } = fixture(t), source = path.join(folder, 'Page.png'), [red, blue] = await buffers(['#ee1010', '#1010ee'])
  rewrite(source, red)
  const first = (await listSheets({ folder })).sheets[0], prior = fs.readFileSync(first.thumb)
  rewrite(source, blue)
  const second = (await listSheets({ folder })).sheets[0]
  assert.notEqual(second.thumb, first.thumb)
  assert.deepEqual([second.width, second.height], [640, 480])
  const pixel = await sharp(second.thumb).resize(1, 1).raw().toBuffer()
  assert.ok(pixel[2] > pixel[0] + 80)
  assert.deepEqual(fs.readFileSync(first.thumb), prior)
})

test('an edited lab thumbnail is preserved and returns an actionable sheet error', async (t) => {
  const { folder } = fixture(t), source = path.join(folder, 'Page.png'), [red, blue] = await buffers(['#ee1010', '#1010ee'])
  rewrite(source, red)
  const first = (await listSheets({ folder })).sheets[0], manual = await sharp(blue).jpeg().toBuffer()
  fs.writeFileSync(first.thumb, manual)
  const second = (await listSheets({ folder })).sheets[0]
  assert.equal(second.thumb, null)
  assert.match(second.error, /edited|changed|preserv/i)
  assert.deepEqual(fs.readFileSync(first.thumb), manual)
})

test('lab source changes during decoding cannot publish a stale thumbnail', async (t) => {
  const { folder } = fixture(t), source = path.join(folder, 'Page.png'), [red, blue] = await buffers(['#ee1010', '#1010ee'])
  rewrite(source, red)
  const toFile = sharp.prototype.toFile
  t.mock.method(sharp.prototype, 'toFile', async function (...args) { const result = await toFile.apply(this, args); rewrite(source, blue); return result })
  const sheet = (await listSheets({ folder })).sheets[0]
  assert.equal(sheet.thumb, null)
  assert.match(sheet.error, /changed|raced/i)
})

test('corrupt sheets return explicit preview failure rather than silently valid empty metadata', async (t) => {
  const { folder } = fixture(t)
  fs.writeFileSync(path.join(folder, 'Broken.psd'), Buffer.alloc(36, 255))
  const sheet = (await listSheets({ folder })).sheets[0]
  assert.equal(sheet.thumb, null)
  assert.match(sheet.error, /invalid|corrupt|PSD|preview/i)
})
