'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { tmpdir } = require('./fixtures')

process.env.ALBUM_STUDIO_DATA_DIR = tmpdir()
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()

const sharp = require('sharp')
const agpsd = require('ag-psd')
const { exportPlan, startExport, exportSheet } = require('../lib/deliver')
const { writeJpegPdf, jpegComponents } = require('../lib/pdf')
const { openAlbum } = require('../lib/album')
const { spreadHash } = require('../lib/render')
const { fileStamp } = require('../lib/cache')

/** A "rendered sheet": a 600×200 PSD whose stored composite is a red left half, blue right half. */
function writeSheet(file, right = [0, 0, 255], scale = 1) {
  const width = 600 * scale, height = 200 * scale, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(x < width / 2 ? [255, 0, 0, 255] : [...right, 255], (y * width + x) * 4)
  }
  const img = { width, height, data }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, agpsd.writePsdBuffer({ width, height, imageData: img, children: [{ name: 'ToolkitHFrame_001', left: 0, top: 0, right: width, bottom: height, imageData: img }] }))
}

/** A complete planned album with full originals and verified render records for all three sheets. */
async function makeAlbum() {
  const root = tmpdir()
  const proj = path.join(root, 'Wedding Album')
  const out = path.join(proj, 'exports')
  fs.mkdirSync(out, { recursive: true })
  const shoot = path.join(root, 'Shoot'), templates = path.join(root, 'Templates')
  fs.mkdirSync(shoot); fs.mkdirSync(templates)
  await sharp({ create: { width: 2400, height: 800, channels: 3, background: '#ad5b32' } }).jpeg().toFile(path.join(shoot, 'photo.jpg'))
  writeSheet(path.join(templates, '1h0v.psd'))
  const ws = { imageTokens: [shoot], templateTokens: [templates], outputToken: out }
  const page = () => ({ photos: [{ id: 'img_Shoot_photo_jpg', orient: 'h' }], template: { id: 'tpl_Templates_1h0v_psd', name: '1h0v.psd', h: 1, v: 0 } })
  fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({
    version: 1,
    workspace: ws,
    albumPages: { 1: page(), 2: page(), 3: page() },
    totalActivePages: 3,
  }))
  writeSheet(path.join(out, 'Page_001.psd'), [0, 0, 255], 3)
  writeSheet(path.join(out, 'Page_002.psd'), [0, 255, 0], 3)
  writeSheet(path.join(out, 'Page_003.psd'), [0, 0, 255], 3)
  const album = await openAlbum({ path: proj }), cache = {}
  for (const sp of album.spreads) cache[sp.n] = { hash: await spreadHash(sp, album, ws), sheet: await fileStamp(sp.sheet) }
  fs.mkdirSync(path.join(out, '.album-studio'))
  fs.writeFileSync(path.join(out, '.album-studio', 'render-cache.json'), JSON.stringify(cache))
  return { root, proj, out }
}

async function run(p) {
  const events = []
  const done = new Promise((resolve) => {
    startExport(p, { emit: (e, d) => { events.push({ e, ...d }); if (e === 'export.finished') resolve() } }).catch((err) => { events.push({ e: 'error', error: err.message }); resolve() })
  })
  await done
  return { events, finished: events.find((x) => x.e === 'export.finished'), error: events.find((x) => x.e === 'error') }
}

const px = async (file, x, y) => {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * info.channels
  return [data[i], data[i + 1], data[i + 2]]
}
const near = (a, b, tol = 30) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

test('a sheet exports at the print size and resolution, from the PSD’s own flattened image', async () => {
  const dir = tmpdir()
  writeSheet(path.join(dir, 'Page_001.psd'))
  const r = await exportSheet(path.join(dir, 'Page_001.psd'), [{ file: path.join(dir, 'hi.jpg'), quality: 97 }, { file: path.join(dir, 'lo.jpg'), quality: 25 }], { size: 'print', heightInches: 1, ppi: 300 })
  assert.deepEqual(r, { width: 900, height: 300 })
  const m = await sharp(path.join(dir, 'hi.jpg')).metadata()
  assert.deepEqual([m.width, m.height, m.density, m.chromaSubsampling, !!m.icc], [900, 300, 300, '4:4:4', true])
  assert.ok(near(await px(path.join(dir, 'hi.jpg'), 100, 150), [255, 0, 0]))
  assert.ok(near(await px(path.join(dir, 'lo.jpg'), 800, 150), [0, 0, 255]))
  assert.ok(fs.statSync(path.join(dir, 'lo.jpg')).size < fs.statSync(path.join(dir, 'hi.jpg')).size)
  const orig = await exportSheet(path.join(dir, 'Page_001.psd'), [{ file: path.join(dir, 'o.jpg'), quality: 90 }], { size: 'original', heightInches: 1, ppi: 300 })
  assert.deepEqual(orig, { width: 600, height: 200 }, 'original size: no resampling')
})

test('export: JPEG folders and the PDF beside the sheets, unchanged sheets skipped, changed ones redone', async () => {
  const { proj, out } = await makeAlbum()
  const plan0 = await exportPlan({ album: proj, heightInches: 1 })
  assert.deepEqual(plan0.spreads.map((s) => s.state), ['todo', 'todo', 'todo'])
  assert.equal(plan0.paths.high, path.join(proj, 'JPEG-High-Res'))
  assert.equal(plan0.paths.pdf, path.join(proj, 'Wedding Album - Low Res.pdf'))

  let r = await run({ album: proj, heightInches: 1 })
  assert.deepEqual([r.finished.done, r.finished.skipped, r.finished.failed], [3, 0, 0])
  assert.deepEqual(r.finished.missingSheets, [])
  assert.deepEqual(fs.readdirSync(path.join(proj, 'JPEG-High-Res')).sort(), ['Page_001.jpg', 'Page_002.jpg', 'Page_003.jpg'])
  assert.deepEqual(fs.readdirSync(path.join(proj, 'JPEG-Low-Res')).sort(), ['Page_001.jpg', 'Page_002.jpg', 'Page_003.jpg'])
  assert.deepEqual([r.finished.pdf.pages, r.finished.pdf.path], [3, path.join(proj, 'Wedding Album - Low Res.pdf')])
  assert.deepEqual((await exportPlan({ album: proj, heightInches: 1 })).spreads.map((s) => s.state), ['ready', 'ready', 'ready'])

  r = await run({ album: proj, heightInches: 1, pdf: false })
  assert.deepEqual([r.finished.done, r.finished.skipped], [0, 3], 'nothing changed: nothing made again')

  // Sheet 2 is rendered again (edited): only it is exported again.
  await new Promise((res) => setTimeout(res, 20))
  writeSheet(path.join(out, 'Page_002.psd'), [255, 255, 0], 3)
  assert.deepEqual((await exportPlan({ album: proj, heightInches: 1 })).spreads.map((s) => s.state), ['ready', 'stale', 'ready'])
  r = await run({ album: proj, heightInches: 1, pdf: false })
  assert.deepEqual([r.finished.done, r.finished.skipped], [1, 2])
  assert.ok(near(await px(path.join(proj, 'JPEG-High-Res', 'Page_002.jpg'), 800, 150), [255, 255, 0]))

  // Other settings make other files.
  r = await run({ album: proj, heightInches: 2, pdf: false })
  assert.equal(r.finished.done, 3)
  assert.equal((await sharp(path.join(proj, 'JPEG-High-Res', 'Page_001.jpg')).metadata()).height, 600)
})

test('export refuses without rendered sheets', async () => {
  const root = tmpdir()
  const proj = path.join(root, 'Empty')
  fs.mkdirSync(proj)
  fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({ version: 1, workspace: { imageTokens: [], templateTokens: [] }, albumPages: { 1: { photos: [], template: null } }, totalActivePages: 1 }))
  await assert.rejects(startExport({ album: proj }, { emit() {} }), /Render the album first/)
})

test('the PDF: one page per JPEG, sized by resolution, offsets that point where they should', async () => {
  const dir = tmpdir()
  await sharp({ create: { width: 900, height: 300, channels: 3, background: '#c00' } }).jpeg().toFile(path.join(dir, 'a.jpg'))
  await sharp({ create: { width: 600, height: 600, channels: 3, background: '#00c' } }).toColourspace('b-w').jpeg().toFile(path.join(dir, 'b.jpg'))
  const file = path.join(dir, 'x.pdf')
  await writeJpegPdf(file, [{ path: path.join(dir, 'a.jpg'), ppi: 300 }, { path: path.join(dir, 'b.jpg'), ppi: 150 }], { title: 'Album (Low Res)' })
  const pdf = fs.readFileSync(file).toString('latin1')
  assert.ok(pdf.startsWith('%PDF-1.4'))
  assert.ok(pdf.trimEnd().endsWith('%%EOF'))
  assert.match(pdf, /\/Type \/Pages \/Count 2/)
  assert.match(pdf, /\/MediaBox \[0 0 216 72\]/, '900×300 px at 300 ppi = 3 × 1 in')
  assert.match(pdf, /\/MediaBox \[0 0 288 288\]/, '600 px at 150 ppi = 4 in')
  assert.match(pdf, /\/ColorSpace \/DeviceGray/, 'a grey JPEG stays grey')
  assert.match(pdf, /\/Title \(Album \\\(Low Res\\\)\)/)
  const startxref = Number(pdf.match(/startxref\n(\d+)/)[1])
  assert.equal(pdf.slice(startxref, startxref + 4), 'xref')
  for (const m of pdf.matchAll(/(\d{10}) 00000 n /g)) assert.match(pdf.slice(Number(m[1])), /^\d+ 0 obj/)
  assert.equal(jpegComponents(fs.readFileSync(path.join(dir, 'a.jpg'))), 3)
  assert.equal(fs.existsSync(file + '.part'), false)
})
