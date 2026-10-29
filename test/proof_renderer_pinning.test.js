'use strict'

// Pins the proof renderer's output as it stood before its stages were split: the exact sharp
// calls each adjustment makes, and the bytes of each photo layer and rendered page. The images
// are small generated gradients, so a crop, rotation or colour step that lands one pixel off
// changes a hash. CI renders on the same platform (macOS on Apple silicon) as these were taken.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { applyAdjust, buildPhotoLayer, renderPageProof } = require('../src/proof_renderer')
const sharp = require('../src/sharp_config').getSharp()

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

// A stand-in pipeline that records every call in order and returns itself, as sharp does.
function recorder() {
  const calls = []
  const pipe = new Proxy(
    {},
    {
      get: (_, name) =>
        name === 'calls'
          ? calls
          : (...args) => {
              calls.push([name, ...args])
              return pipe
            },
    },
  )
  return pipe
}

test('applyAdjust makes the same sharp calls, in the same order, for each adjustment', () => {
  const box = { width: 300, height: 200 }
  for (const [name, adjust, dims, expected] of [
    ['no adjustment', null, box, []],
    [
      'all sliders at zero',
      { exposure: 0, saturation: 0, contrast: 0, warmth: 0, tint: 0, fade: 0, bw: false },
      undefined,
      [],
    ],
    ['exposure', { exposure: 50 }, undefined, [['modulate', { brightness: 1.4142135623730951, saturation: 1 }]]],
    ['saturation', { saturation: -30 }, undefined, [['modulate', { brightness: 1, saturation: 0.7 }]]],
    [
      'contrast',
      { contrast: 40 },
      undefined,
      [['linear', [1.4, 1.4, 1.4], [-51.19999999999999, -51.19999999999999, -51.19999999999999]]],
    ],
    ['warmth', { warmth: 25 }, undefined, [['linear', [1.125, 1, 0.875], [0, 0, 0]]]],
    ['tint', { tint: -20 }, undefined, [['linear', [0.9, 1.1, 0.9], [0, 0, 0]]]],
    ['fade', { fade: 30 }, undefined, [['linear', [1, 1, 1], [19.2, 19.2, 19.2]]]],
    ['clarity', { clarity: 60 }, box, [['clahe', { width: 25, height: 25, maxSlope: 4 }]]],
    ['clarity without a box', { clarity: 60 }, undefined, []],
    ['clarity on a box with no height', { clarity: 60 }, { width: 300, height: 0 }, []],
    ['sharpen', { sharpen: 50 }, box, [['sharpen', { sigma: 0.4375 }]]],
    ['sharpen on a box with no height', { sharpen: 50 }, { width: 300, height: 0 }, [['sharpen', { sigma: 1.25 }]]],
    ['blur', { blur: 20 }, { width: 3000, height: 2000 }, [['blur', 4.800000000000001]]],
    ['black and white', { bw: true }, undefined, [['greyscale']]],
    ['black and white ignores saturation', { bw: true, saturation: 50 }, undefined, [['greyscale']]],
    [
      'black and white with exposure and warmth',
      { bw: true, exposure: -40, warmth: 30 },
      undefined,
      [
        ['greyscale'],
        ['modulate', { brightness: 0.757858283255199, saturation: 1 }],
        ['linear', [1.15, 1, 0.85], [0, 0, 0]],
      ],
    ],
    [
      'every slider',
      {
        exposure: 30,
        saturation: 20,
        contrast: -25,
        warmth: -40,
        tint: 15,
        fade: 10,
        clarity: 100,
        sharpen: 100,
        blur: 10,
      },
      { width: 1200, height: 800 },
      [
        ['modulate', { brightness: 1.2311444133449163, saturation: 1.2 }],
        ['linear', [0.65625, 0.6937500000000001, 0.9562499999999999], [34.4, 36, 47.199999999999996]],
        ['clahe', { width: 100, height: 100, maxSlope: 6 }],
        ['sharpen', { sigma: 1.6 }],
        ['blur', 0.9600000000000002],
      ],
    ],
    [
      'extremes',
      { exposure: -100, saturation: -500, contrast: -200, clarity: 100, sharpen: 100, blur: 100 },
      { width: 16, height: 16 },
      [
        ['modulate', { brightness: 0.5, saturation: 0 }],
        ['linear', [0, 0, 0], [128, 128, 128]],
        ['clahe', { width: 3, height: 3, maxSlope: 6 }],
        ['sharpen', { sigma: 0.7 }],
        ['blur', 4.199999999999999],
      ],
    ],
    ['negative detail sliders', { clarity: -50, sharpen: -50, blur: -50 }, box, []],
  ]) {
    const pipe = recorder()
    applyAdjust(sharp, pipe, adjust, dims)
    assert.deepEqual(pipe.calls, expected, name)
  }
})

// ─── fixtures ────────────────────────────────────────────────────────────────

// Gradients, so a crop or rotation that lands one pixel off changes the bytes.
async function gradient(file, width, height, pixel, jpegOrientation) {
  const data = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(pixel(x, y, width, height), (y * width + x) * 3)
  const image = sharp(data, { raw: { width, height, channels: 3 } })
  if (jpegOrientation) await image.jpeg({ quality: 95 }).withMetadata({ orientation: jpegOrientation }).toFile(file)
  else await image.png().toFile(file)
  return file
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-pinning-'))
test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
let FIXTURES = null
async function fixtures() {
  if (FIXTURES) return FIXTURES
  const at = (name) => path.join(dir, name)
  const rgb = (x, y, w, h) => [Math.round((x * 255) / (w - 1)), Math.round((y * 255) / (h - 1)), 128]
  FIXTURES = {
    dir,
    landscape: await gradient(at('landscape.png'), 120, 80, rgb),
    portrait: await gradient(at('portrait.png'), 80, 120, (x, y, w, h) => [
      Math.round((x * 255) / (w - 1)),
      64,
      Math.round((y * 255) / (h - 1)),
    ]),
    // Stored landscape, tagged to display as portrait.
    sideways: await gradient(at('sideways.jpg'), 96, 64, rgb, 6),
    preview: await gradient(at('preview.png'), 400, 300, (x, y) => [x % 256, y % 256, (x + y) % 256]),
    decor: await gradient(at('decor.png'), 100, 50, (x) => [200, 40, x * 2]),
    missing: at('missing.png'),
  }
  return FIXTURES
}

// ─── photo layers ────────────────────────────────────────────────────────────

test('buildPhotoLayer places, crops and encodes each photo exactly as before', async () => {
  const f = await fixtures()
  const frame = { x: 10, y: 20, w: 100, h: 100 }
  const landscapeInSquare = '43a7d6c4789e7aff350b7bf10c094646166788cbb8ba2635acde8f4e67f22062'
  for (const [name, photo, box, scale, smartCrop, expected] of [
    [
      'landscape covering a square frame',
      { filePath: f.landscape },
      frame,
      0.5,
      false,
      { top: 10, left: 5, size: [50, 50], sha256: landscapeInSquare },
    ],
    [
      'portrait turned 90 degrees, cropped by attention',
      { filePath: f.portrait, rotation: 90 },
      { x: 0, y: 0, w: 160, h: 90 },
      1,
      true,
      { top: 0, left: 0, size: [160, 90], sha256: '74138923b2e8577277d5ea79f237f54131459a3fb6d5e494735b44153d3fabec' },
    ],
    [
      'focal point near the edge',
      { filePath: f.landscape, focal: { x: 0.8, y: 0.2, confidence: 0.9 } },
      { x: 5, y: 7, w: 60, h: 90 },
      1,
      true,
      { top: 7, left: 5, size: [60, 90], sha256: '27c370d343bb62595b30d07dc0dddd7af36736d9825eb55f35c984ce756ae06b' },
    ],
    [
      'focal point away from the edges',
      { filePath: f.landscape, focal: { x: 0.6, y: 0.5, confidence: 0.5 } },
      { x: 5, y: 7, w: 60, h: 90 },
      1,
      true,
      { top: 7, left: 5, size: [60, 90], sha256: 'eb968f59082019495d2a026ec7cc9fd3f0e9b792167a6acc0aa68cda51391b7d' },
    ],
    [
      'focal point in a portrait photo',
      { filePath: f.portrait, focal: { x: 0.5, y: 0.3, confidence: 0.5 } },
      { x: 0, y: 0, w: 90, h: 60 },
      1,
      true,
      { top: 0, left: 0, size: [90, 60], sha256: '46068ec0a12e8e6b2d407f5e1ba92988551ec21e24de5cb6c8133c1a8b7dd856' },
    ],
    [
      'uncertain focal point',
      { filePath: f.landscape, focal: { x: 0.8, y: 0.2, confidence: 0.1 } },
      { x: 5, y: 7, w: 60, h: 90 },
      1,
      true,
      { top: 7, left: 5, size: [60, 90], sha256: 'f06f454865753728d69ca3aa28248137a076f46fe8d1fa5b9023cbfdc4b6d28b' },
    ],
    [
      'zoom and pan',
      { filePath: f.landscape, placement: { scale: 1.5, ox: 0.5, oy: -2 } },
      frame,
      0.75,
      false,
      { top: 15, left: 8, size: [75, 75], sha256: 'a9aab691ce090e984c95f9318a7372c1169eb2abac9a937e70e632ae09b64155' },
    ],
    [
      'EXIF orientation',
      { filePath: f.sideways },
      { x: 3, y: 4, w: 50, h: 80 },
      1,
      false,
      { top: 4, left: 3, size: [50, 80], sha256: '6b0e3a1a2bfc11529dd04dde05ffcb94e69a2664a00f8fe803843452e6051e48' },
    ],
    [
      'adjusted with a vignette, fast encode',
      { filePath: f.portrait, adjust: { exposure: 20, contrast: 10, vignette: 60 }, fastEncode: true },
      { x: 0, y: 0, w: 70, h: 100 },
      1,
      false,
      { top: 0, left: 0, size: [70, 100], sha256: '485e13aa7f209075767ae6b81a01a5a2283031cf6da8332552c5bbc82c699ab6' },
    ],
    [
      'falls back to the proxy',
      { filePath: f.missing, fallbackPath: f.landscape },
      frame,
      0.5,
      false,
      { top: 10, left: 5, size: [50, 50], sha256: landscapeInSquare },
    ],
  ]) {
    const layer = await buildPhotoLayer(sharp, photo, box, scale, smartCrop)
    const { width, height } = await sharp(layer.input).metadata()
    assert.deepEqual(
      { top: layer.top, left: layer.left, size: [width, height], sha256: sha256(layer.input) },
      expected,
      name,
    )
  }
})

test('buildPhotoLayer names every source it tried when none can be read', async () => {
  const f = await fixtures()
  const photo = { filePath: f.missing, fallbackPath: path.join(f.dir, 'also-missing.png') }
  await assert.rejects(buildPhotoLayer(sharp, photo, { x: 0, y: 0, w: 10, h: 10 }, 1, false), (error) => {
    assert.equal(
      error.message.split(f.dir).join('<dir>'),
      'unreadable source [missing.png / also-missing.png]: Input file is missing: <dir>/also-missing.png',
    )
    assert.ok(error.cause instanceof Error)
    return true
  })
})

// ─── pages ───────────────────────────────────────────────────────────────────

test('renderPageProof writes the same page for each job', async () => {
  const f = await fixtures()
  const frames = [
    { name: 'toolkitvframe1', x: 250, y: 40, w: 100, h: 200 },
    { name: 'toolkithframe1', x: 30, y: 60, w: 180, h: 120 },
  ]
  const common = { templatePath: path.join(f.dir, 'template.psd'), frames, canvasWidth: 400, canvasHeight: 300 }
  const output = (name) => path.join(f.dir, 'out', name)
  for (const [name, job, expected] of [
    [
      'two photos on the template preview, with a shape overlay',
      {
        ...common,
        templatePreviewPath: f.preview,
        photos: [
          { filePath: f.portrait, orient: 'v' },
          { filePath: f.landscape, orient: 'h', adjust: { warmth: 40 } },
        ],
        overlays: [{ id: 'o1', type: 'rect', x: 0.05, y: 0.8, w: 0.5, h: 0.1, fill: '#204080' }],
        maxEdge: 200,
        outputPath: output('page1.jpg'),
      },
      { size: [200, 150], sha256: '939fdb2e57e86829b973b1723d5f125d9ba3a7e6dfb61e8ef70eb0792fae100d' },
    ],
    [
      'a missing photo is skipped on a plain background',
      {
        ...common,
        pageBackground: '#336699',
        smartCrop: false,
        photos: [
          { filePath: f.missing, orient: 'v' },
          { filePath: f.landscape, orient: 'h', placement: { scale: 2, ox: -0.5 } },
        ],
        maxEdge: 300,
        outputPath: output('page2.jpg'),
      },
      {
        size: [300, 225],
        sha256: '8e70b9a54e6575d88d14474407f9b421730223174477d118fcb23d9e60b69003',
        skipped: [
          {
            frame: 'toolkitvframe1',
            error: 'unreadable source [missing.png]: Input file is missing: <dir>/missing.png',
          },
        ],
      },
    ],
    [
      'edited template layers rebuild the page from its stack',
      {
        ...common,
        templatePreviewPath: f.preview,
        photos: [{ filePath: f.landscape, orient: 'h' }],
        psdLayers: [
          {
            id: '0',
            name: 'Paper',
            kind: 'raster',
            visible: true,
            opacity: 1,
            x: 0,
            y: 0,
            w: 400,
            h: 300,
            png: f.preview,
          },
          {
            id: '1',
            name: 'toolkithframe1',
            kind: 'raster',
            isFrame: true,
            visible: true,
            opacity: 1,
            x: 30,
            y: 60,
            w: 180,
            h: 120,
          },
          {
            id: '2',
            name: 'Ribbon',
            kind: 'raster',
            visible: true,
            opacity: 1,
            blendMode: 'multiply',
            x: 20,
            y: 150,
            w: 100,
            h: 50,
            png: f.decor,
          },
          {
            id: '3',
            name: 'Ribbon shade',
            kind: 'raster',
            visible: true,
            opacity: 1,
            clipped: true,
            x: 40,
            y: 160,
            w: 100,
            h: 50,
            png: f.decor,
          },
          {
            id: '4',
            name: 'Stamp',
            kind: 'raster',
            visible: true,
            opacity: 1,
            x: 300,
            y: 10,
            w: 100,
            h: 50,
            png: f.decor,
          },
        ],
        layerEdits: { 2: { opacity: 0.5, dx: 10 }, 4: { hidden: true } },
        maxEdge: 200,
        outputPath: output('page3.jpg'),
      },
      { size: [200, 150], sha256: '03f00513a8ed0bb24f6097bf54496b288a5734f7811f0676552ee16e3e07820f' },
    ],
  ]) {
    const result = await renderPageProof(job)
    assert.equal(result.ok, true, `${name}: ${result.error}`)
    assert.equal(result.outputPath, job.outputPath, name)
    const { width, height } = await sharp(job.outputPath).metadata()
    const page = { size: [width, height], sha256: sha256(fs.readFileSync(job.outputPath)) }
    if (result.skipped)
      page.skipped = result.skipped.map((s) => ({ frame: s.frame, error: s.error.split(f.dir).join('<dir>') }))
    assert.deepEqual(page, expected, name)
    // The input hash names the same inputs the same way on every render.
    assert.match(result.hash, /^[0-9a-f]{16}$/)
    assert.equal((await renderPageProof({ ...job, outputPath: job.outputPath + '.again.jpg' })).hash, result.hash, name)
  }
})
