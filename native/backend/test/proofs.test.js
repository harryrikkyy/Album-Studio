'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { tmpdir } = require('./fixtures')

process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()

const sharp = require('sharp')
const agpsd = require('ag-psd')
const { templateArt, erode } = require('../lib/psd_template')
const { refreshProofs, proofsSettled, spreadLayout } = require('../lib/proofs')
const { updateAlbum } = require('../lib/project')
const { embeddedJpeg } = require('../lib/raw')

const W = 600
const H = 200

/** RGBA pixels of a w×h box, `alpha(x, y)` deciding each pixel's coverage. */
function box(w, h, rgb, alpha = () => 255) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = alpha(x, y)
    }
  }
  return { width: w, height: h, data }
}

/**
 * A 600×200 template: a grey background, a rectangular H frame on the left, and on the right a
 * round H frame with a 6 px white inside stroke drawn over a V frame (later layers draw on top).
 */
function writeTemplate(file) {
  const circle = (x, y) => ((x - 74.5) ** 2 + (y - 74.5) ** 2 <= 75 ** 2 ? 255 : 0)
  const stroke = { enabled: true, present: true, position: 'inside', fillType: 'color', blendMode: 'normal', opacity: 1, size: { units: 'Pixels', value: 6 }, color: { r: 255, g: 255, b: 255 } }
  // What Photoshop stores as the flattened image: the frames' placeholders and the white ring.
  const composite = box(W, H, [90, 90, 90])
  const paint = (x, y, rgb) => composite.data.set([...rgb, 255], (y * W + x) * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= 20 && x < 220 && y >= 20 && y < 170) paint(x, y, [200, 0, 120])
      if (x >= 330 && x < 430 && y >= 10 && y < 190) paint(x, y, [200, 0, 120])
      const d = Math.hypot(x - 474.5, y - 99.5)
      if (d <= 75) paint(x, y, d > 69 ? [255, 255, 255] : [200, 0, 120])
    }
  }
  const psd = {
    width: W,
    height: H,
    imageData: composite,
    children: [
      { name: 'Background', left: 0, top: 0, right: W, bottom: H, imageData: box(W, H, [90, 90, 90]) },
      { name: 'ToolkitHFrame_001', left: 20, top: 20, right: 220, bottom: 170, imageData: box(200, 150, [200, 0, 120]) },
      { name: 'ToolkitVFrame_001', left: 330, top: 10, right: 430, bottom: 190, imageData: box(100, 180, [200, 0, 120]) },
      { name: 'ToolkitHFrame_002', left: 400, top: 25, right: 550, bottom: 175, imageData: box(150, 150, [200, 0, 120], circle), effects: { stroke: [stroke] } },
    ],
  }
  fs.writeFileSync(file, agpsd.writePsdBuffer(psd))
}

/** An album with real photos and two spreads on that template. */
async function makeAlbum() {
  const root = tmpdir()
  const shoot = path.join(root, 'Shoot')
  fs.mkdirSync(shoot, { recursive: true })
  const photo = (name, w, h, rgb) => sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).jpeg().toFile(path.join(shoot, name))
  await photo('A.jpg', 300, 200, [255, 0, 0])
  await photo('B.jpg', 300, 200, [0, 0, 255])
  await photo('C.jpg', 200, 300, [0, 255, 0])
  const tpls = path.join(root, 'Templates')
  fs.mkdirSync(tpls)
  writeTemplate(path.join(tpls, '2h1v_0001.psd'))
  const proj = path.join(root, 'Album')
  fs.mkdirSync(proj)
  const id = (n) => `img_Shoot_${n}_jpg`
  fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({
    version: 1,
    workspace: { imageTokens: [shoot], templateTokens: [tpls], outputToken: path.join(root, 'out') },
    albumPages: {
      1: { photos: [{ id: id('A'), orient: 'h' }, { id: id('B'), orient: 'h' }, { id: id('C'), orient: 'v' }], template: { id: 'tpl_Templates_2h1v_0001_psd', name: '2h1v_0001.psd', h: 2, v: 1 } },
      2: { photos: [{ id: id('B'), orient: 'h' }], template: { id: 'tpl_Templates_2h1v_0001_psd', name: '2h1v_0001.psd', h: 2, v: 1 } },
      3: { photos: [], template: null },
    },
    totalActivePages: 3,
  }))
  return { root, proj, tpls, id }
}

/** Run a refresh and collect its events until it is idle. */
async function refresh(proj) {
  const events = []
  refreshProofs(proj, (event, data) => events.push({ event, ...data }))
  await proofsSettled(proj)
  return events
}

const pixel = async (file, x, y) => {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * info.channels
  return [data[i], data[i + 1], data[i + 2]]
}
const near = (a, b, tol = 40) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

test('a template is read with its frames in drawing order, their shapes and strokes', async () => {
  const dir = tmpdir()
  const file = path.join(dir, 't.psd')
  writeTemplate(file)
  const art = await templateArt(file, 2400)
  assert.deepEqual([art.width, art.height, art.scale], [W, H, 1])
  assert.deepEqual(art.frames.map((f) => [f.name, f.orient, f.x, f.y, f.w, f.h, f.z]), [
    ['ToolkitHFrame_001', 'h', 20, 20, 200, 150, 0],
    ['ToolkitVFrame_001', 'v', 330, 10, 100, 180, 1],
    ['ToolkitHFrame_002', 'h', 400, 25, 150, 150, 2],
  ])
  const [rect, , round] = art.frames
  assert.equal(rect.mask, null, 'a plain rectangle needs no mask')
  assert.ok(round.mask, 'a round frame gets a mask')
  assert.deepEqual(round.stroke, { size: 6, position: 'inside', color: '#ffffff', opacity: 1, revealed: true })
  const m = await sharp(round.mask).extractChannel(3).raw().toBuffer()
  const at = (x, y) => m[y * 150 + x]
  assert.equal(at(75, 75), 255, 'the centre shows the photo')
  assert.equal(at(2, 2), 0, 'the corners outside the circle do not')
  assert.equal(at(75, 3), 0, 'the inside stroke is left for the template to draw')
  assert.equal(at(75, 10), 255)
  assert.ok(fs.existsSync(art.backdrop))

  const again = await templateArt(file, 2400)
  assert.deepEqual(again, JSON.parse(JSON.stringify(art)), 'the second read comes from the cache')
})

test('erode shrinks a mask from its edges by r pixels', () => {
  const a = new Uint8Array(10 * 6).fill(255)
  const out = erode(a, 10, 6, 2)
  assert.equal(out[2 * 10 + 2], 255)
  assert.equal(out[1 * 10 + 5], 0)
  assert.equal(out[3 * 10 + 8], 0)
  assert.deepEqual(erode(a, 10, 6, 0), a)
})

test('proofs: drawn once, kept while nothing changes, moved with their spread, removed when emptied', async () => {
  const { proj, id } = await makeAlbum()
  const live = (n) => path.join(proj, 'proofs', 'pages', `live_page_00${n}.jpg`)

  let ev = await refresh(proj)
  assert.deepEqual(ev.filter((e) => e.event === 'proofs.updated').map((e) => [e.n, e.source]), [[1, 'live'], [2, 'live']])
  assert.deepEqual(ev.at(-1), { event: 'proofs.idle', album: proj, rendered: 2, failed: 0 })
  assert.equal(fs.existsSync(live(3)), false, 'a spread without a template has no proof')

  // Spread 1: A and B fill the H frames by name (A → HFrame_001, B → round HFrame_002), C the V frame.
  assert.ok(near(await pixel(live(1), 120, 95), [255, 0, 0]), 'A in the rectangle')
  assert.ok(near(await pixel(live(1), 475, 100), [0, 0, 255]), 'B in the circle, over the V frame')
  assert.ok(near(await pixel(live(1), 475, 28), [255, 255, 255]), 'the circle\'s white stroke over B')
  assert.ok(near(await pixel(live(1), 405, 30), [0, 255, 0]), 'C shows outside the circle')
  assert.ok(near(await pixel(live(1), 300, 100), [90, 90, 90]), 'the template around the frames')
  assert.ok(near(await pixel(live(2), 120, 95), [0, 0, 255]), 'spread 2: B in the first H frame')
  assert.ok(near(await pixel(live(2), 475, 100), [200, 0, 120]), 'an empty frame keeps its placeholder')

  ev = await refresh(proj)
  assert.deepEqual(ev, [{ event: 'proofs.idle', album: proj, rendered: 0, failed: 0 }], 'nothing changed, nothing drawn')

  const first = fs.readFileSync(live(1))
  await updateAlbum({ album: proj, ops: [{ op: 'moveSpread', from: 1, to: 2 }] })
  ev = await refresh(proj)
  assert.deepEqual(fs.readFileSync(live(2)), first, 'the moved spread took its picture along')
  assert.ok(near(await pixel(live(1), 120, 95), [0, 0, 255]))

  await updateAlbum({ album: proj, ops: [{ op: 'clearSpread', n: 1 }, { op: 'addPhoto', n: 2, id: id('B') }] })
  ev = await refresh(proj)
  assert.equal(fs.existsSync(live(1)), false, 'an emptied spread loses its proof')
  assert.ok(ev.some((e) => e.event === 'proofs.updated' && e.n === 1 && e.proof === null))

  await updateAlbum({ album: proj, ops: [{ op: 'removeSpread', n: 3 }, { op: 'removeSpread', n: 1 }] })
  ev = await refresh(proj)
  assert.deepEqual(fs.readdirSync(path.join(proj, 'proofs', 'pages')).filter((f) => f.endsWith('.jpg')), ['live_page_001.jpg'], 'proofs past the end are removed')
})

test('a spread layout says where each frame is and which photo fills it', async () => {
  const { proj, id } = await makeAlbum()
  const l = await spreadLayout({ album: proj, n: 1 })
  assert.deepEqual([l.width, l.height], [W, H])
  assert.deepEqual(l.frames.map((f) => [f.name, f.photoId]), [
    ['ToolkitHFrame_001', id('A')],
    ['ToolkitVFrame_001', id('C')],
    ['ToolkitHFrame_002', id('B')],
  ])
  assert.deepEqual(l.frames[0], { name: 'ToolkitHFrame_001', orient: 'h', x: 20 / W, y: 20 / H, w: 200 / W, h: 150 / H, z: 0, photoId: id('A') })
  assert.deepEqual(l.unplaced, [])
  const two = await spreadLayout({ album: proj, n: 2 })
  assert.deepEqual(two.frames.map((f) => f.photoId), [id('B'), null, null], 'empty frames are listed too')
  const three = await spreadLayout({ album: proj, n: 3 })
  assert.deepEqual(three.frames, [], 'no template, no frames')
})

test('proofs made elsewhere are trusted once, not redrawn', async () => {
  const { proj } = await makeAlbum()
  await refresh(proj)
  fs.unlinkSync(path.join(proj, 'proofs', 'pages', '.album-studio-proofs.json'))
  // A new helper process: forget what this one knew.
  delete require.cache[require.resolve('../lib/proofs')]
  const fresh = require('../lib/proofs')
  const events = []
  fresh.refreshProofs(proj, (event, data) => events.push({ event, ...data }))
  await fresh.proofsSettled(proj)
  assert.deepEqual(events, [{ event: 'proofs.idle', album: proj, rendered: 0, failed: 0 }])
})

test('the JPEG a TIFF-based RAW embeds is found, with its orientation', async () => {
  const dir = tmpdir()
  const jpeg = await sharp({ create: { width: 320, height: 160, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg().toBuffer()
  // A little-endian TIFF: one IFD with Orientation 6 and the JPEG's offset and length.
  const ifd = Buffer.alloc(2 + 3 * 12 + 4)
  ifd.writeUInt16LE(3, 0)
  const entry = (i, tag, type, value) => { const o = 2 + i * 12; ifd.writeUInt16LE(tag, o); ifd.writeUInt16LE(type, o + 2); ifd.writeUInt32LE(1, o + 4); ifd.writeUInt32LE(value, o + 8) }
  const jpegAt = 8 + ifd.length
  entry(0, 0x0112, 3, 6)
  entry(1, 0x0201, 4, jpegAt)
  entry(2, 0x0202, 4, jpeg.length)
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0])
  const file = path.join(dir, 'X.ARW')
  fs.writeFileSync(file, Buffer.concat([head, ifd, jpeg]))
  const r = await embeddedJpeg(file)
  assert.equal(r.rotation, 90)
  assert.deepEqual(r.jpeg, jpeg)
  fs.writeFileSync(path.join(dir, 'Y.ARW'), Buffer.from('not a raw at all'))
  assert.equal(await embeddedJpeg(path.join(dir, 'Y.ARW')), null)
})
