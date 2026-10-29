'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { applyAdjust, renderPageProof } = require('../src/proof_renderer')

// A minimal sharp-pipeline stand-in that records the ops applied to it. Each
// op returns `this` so the fluent chain works, exactly like a real sharp
// pipeline — but nothing decodes an image.
function mockPipeline() {
  const calls = []
  const pipe = {
    calls,
    modulate(arg) {
      calls.push(['modulate', arg])
      return pipe
    },
    linear(slopes, inter) {
      calls.push(['linear', slopes, inter])
      return pipe
    },
  }
  return pipe
}

test('applyAdjust is a no-op when adj is null/undefined', () => {
  const p = mockPipeline()
  assert.equal(applyAdjust(null, p, null), p)
  assert.equal(p.calls.length, 0)
})

test('applyAdjust is a no-op when all sliders are zero', () => {
  const p = mockPipeline()
  applyAdjust(null, p, { exposure: 0, saturation: 0, contrast: 0, warmth: 0 })
  assert.equal(p.calls.length, 0)
})

test('exposure maps ±100 to ±1 stop (2x / 0.5x brightness)', () => {
  const p = mockPipeline()
  applyAdjust(null, p, { exposure: 100 })
  const [, arg] = p.calls.find((c) => c[0] === 'modulate')
  assert.equal(arg.brightness, 2) // 2^(100/100)
  assert.equal(arg.saturation, 1) // untouched
})

test('saturation of -100 fully desaturates (clamped at 0)', () => {
  const p = mockPipeline()
  applyAdjust(null, p, { saturation: -100 })
  const [, arg] = p.calls.find((c) => c[0] === 'modulate')
  assert.equal(arg.saturation, 0)
})

test('saturation never goes negative even past -100', () => {
  const p = mockPipeline()
  applyAdjust(null, p, { saturation: -500 })
  const [, arg] = p.calls.find((c) => c[0] === 'modulate')
  assert.ok(arg.saturation >= 0)
})

test('warmth pushes R up and B down symmetrically around green', () => {
  const p = mockPipeline()
  applyAdjust(null, p, { warmth: 100 })
  const linear = p.calls.find((c) => c[0] === 'linear')
  assert.ok(linear, 'warmth should produce a linear() pass')
  const slopes = linear[1]
  // gains = [1+w, 1, 1-w] with w = 100/200 = 0.5, contrast s = 1
  assert.equal(slopes[0], 1.5) // R
  assert.equal(slopes[1], 1) // G
  assert.equal(slopes[2], 0.5) // B
})

test('contrast + warmth fold into a single linear pass', () => {
  const p = mockPipeline()
  applyAdjust(null, p, { contrast: 50, warmth: 20 })
  assert.equal(p.calls.filter((c) => c[0] === 'linear').length, 1)
})

test("a skipped photo leaves the next photo in its own frame's place in an edited template stack", async (t) => {
  const sharp = require('../src/sharp_config').getSharp()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-stack-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const solid = async (name, width, height, background) => {
    const file = path.join(dir, name)
    await sharp({ create: { width, height, channels: 3, background } })
      .png()
      .toFile(file)
    return file
  }
  const green = await solid('green.png', 120, 120, { r: 0, g: 200, b: 0 })
  const red = await solid('red.png', 200, 200, { r: 220, g: 0, b: 0 })
  const white = await solid('white.png', 400, 300, { r: 255, g: 255, b: 255 })
  const first = { name: 'toolkithframe1', x: 20, y: 20, w: 100, h: 100 }
  const second = { name: 'toolkithframe2', x: 220, y: 120, w: 100, h: 100 }
  const job = {
    templatePath: path.join(dir, 'template.psd'),
    frames: [first, second],
    canvasWidth: 400,
    canvasHeight: 300,
    maxEdge: 400,
    // The first photo can't be read. The second belongs in the second frame, above the red art.
    photos: [
      { filePath: path.join(dir, 'missing.png'), orient: 'h' },
      { filePath: green, orient: 'h' },
    ],
    psdLayers: [
      { id: '0', name: 'Paper', kind: 'raster', visible: true, opacity: 1, x: 0, y: 0, w: 400, h: 300, png: white },
      { id: '1', ...first, kind: 'raster', isFrame: true, visible: true, opacity: 1 },
      { id: '2', name: 'Red art', kind: 'raster', visible: true, opacity: 1, x: 200, y: 100, w: 200, h: 200, png: red },
      { id: '3', ...second, kind: 'raster', isFrame: true, visible: true, opacity: 1 },
    ],
    layerEdits: { 2: { opacity: 1 } },
    outputPath: path.join(dir, 'page.jpg'),
  }
  const result = await renderPageProof(job)
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(
    result.skipped.map((s) => s.frame),
    ['toolkithframe1'],
  )
  // The middle of the second frame shows the green photo, drawn above the art beneath it.
  const pixel = await sharp(job.outputPath).extract({ left: 270, top: 170, width: 1, height: 1 }).raw().toBuffer()
  assert.ok(pixel[1] > 150 && pixel[0] < 80, `expected the green photo, got rgb(${[...pixel]})`)
})
