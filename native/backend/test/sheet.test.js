'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const { pairFrames, coverQuad, embedScale, findFrames, buildSheet, outputName } = require('../lib/sheet')
const { PhotoCraftSession, cliPath } = require('../lib/photocraft')

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps

test('frames pair with photos by orientation, in name order', () => {
  const layers = [
    { id: 9, name: 'ToolkitHFrame_002' },
    {
      id: 8,
      name: 'Group',
      children: [
        { id: 7, name: 'ToolkitVFrame_001' },
        { id: 6, name: 'ToolkitHFrame_001' },
      ],
    },
    { id: 5, name: 'Background' },
  ]
  assert.deepEqual(
    findFrames(layers, 'toolkithframe').map((l) => l.id),
    [6, 9],
  )
  const photos = [
    { name: 'a', orient: 'h' },
    { name: 'b', orient: 'v' },
    { name: 'c', orient: 'h' },
    { name: 'd', orient: 'h' },
  ]
  const { pairs, frames, unplaced } = pairFrames(layers, photos)
  assert.deepEqual(
    pairs.map((p) => [p.frame.id, p.photo.name]),
    [
      [6, 'a'],
      [9, 'c'],
      [7, 'b'],
    ],
  )
  assert.deepEqual(frames, { h: 2, v: 1 })
  assert.equal(unplaced, 1, 'a fourth photo with no frame left is reported, not dropped silently')
})

test('cover: no edit fills the frame exactly, centred', () => {
  const frame = { x: 100, y: 50, w: 300, h: 200 }
  const { quad, scale } = coverQuad(frame, { w: 600, h: 300 })
  // 600x300 covers 300x200 at scale max(0.5, 0.667) = 0.667 → 400x200, centred on (250, 150).
  assert.ok(near(scale, 2 / 3))
  assert.ok(near(quad[0][0], 50) && near(quad[0][1], 50))
  assert.ok(near(quad[2][0], 450) && near(quad[2][1], 250))
})

test('cover: pan moves within the overflow only; zoom below 1 is ignored', () => {
  const frame = { x: 0, y: 0, w: 100, h: 100 }
  // As in build_pages_batch.jsx: ox = 1 moves the photo left by half the overflow, so its right
  // edge meets the frame's right edge; ox = -1 shows the left edge.
  const right = coverQuad(frame, { w: 200, h: 100 }, { ox: 1 }).quad
  assert.ok(near(right[1][0], 100) && near(right[0][0], -100), 'ox = 1 shows the right edge')
  const left = coverQuad(frame, { w: 200, h: 100 }, { ox: -5 }).quad
  assert.ok(near(left[0][0], 0), 'pan is clamped to -1, showing the left edge')
  assert.equal(coverQuad(frame, { w: 200, h: 100 }, { scale: 0.5 }).scale, coverQuad(frame, { w: 200, h: 100 }).scale)
})

test('cover: a 90° rotation swaps the photo’s width and height', () => {
  const frame = { x: 0, y: 0, w: 100, h: 200 }
  const { quad, scale } = coverQuad(frame, { w: 300, h: 150 }, { rotation: 90 })
  assert.ok(near(scale, 200 / 300))
  // Rotated clockwise: the source's top-left lands at the top-right.
  assert.ok(near(quad[0][0], 100) && near(quad[0][1], 0))
})

test('embed scale keeps 25% more pixels than the frame needs, never enlarges', () => {
  assert.ok(near(embedScale({ w: 1000, h: 500 }, { w: 6000, h: 4000 }), (1000 / 6000) * 1.25))
  assert.equal(embedScale({ w: 1000, h: 500 }, { w: 800, h: 600 }), 1)
  assert.equal(outputName(7), 'Page_007')
})

// ── with the real engine ──────────────────────────────────────────────────

const haveEngine = fs.existsSync(cliPath())

function cli(...args) {
  return execFileSync(cliPath(), args, { encoding: 'utf8' })
}

/** A 1200x400 template with one H frame and one V frame (filled rectangles), made by PhotoCraft. */
function makeTemplate(dir) {
  const file = path.join(dir, 'tpl_1h1v.psd')
  const steps = [
    ['layer.new.layer', { name: 'ToolkitHFrame_001' }],
    ['select.rect', { x: 100, y: 100, width: 400, height: 230 }],
    ['edit.fill', { contents: 'color', color: '#808080' }],
    ['select.deselect', {}],
    ['layer.new.layer', { name: 'ToolkitVFrame_001' }],
    ['select.rect', { x: 700, y: 50, width: 200, height: 300 }],
    ['edit.fill', { contents: 'color', color: '#606060' }],
    ['select.deselect', {}],
  ]
  const args = ['run', '--new', JSON.stringify({ width: 1200, height: 400, background: 'white' })]
  for (const [cmd, params] of steps) args.push('--cmd', cmd, '--params', JSON.stringify(params))
  cli(...args, '--out', file)
  return file
}

function makePhoto(dir, name, w, h, color) {
  const file = path.join(dir, name)
  cli('run', '--new', JSON.stringify({ width: w, height: h, background: color }), '--out', file)
  return file
}

test(
  'builds a real sheet: photos clipped to frames, covering them',
  { skip: !haveEngine && 'PhotoCraft engine not built' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-sheet-'))
    const template = makeTemplate(dir)
    const land = makePhoto(dir, 'land.jpg', 1800, 1200, 'black')
    const port = makePhoto(dir, 'port.jpg', 1200, 1800, 'black')
    const pc = new PhotoCraftSession({ writeRoot: dir })
    try {
      const outPsd = path.join(dir, 'Page_001.psd')
      const r = await buildSheet(pc, {
        template,
        outPsd,
        outJpg: path.join(dir, 'Page_001.jpg'),
        photos: [
          { file: land, orient: 'h', name: 'land' },
          { file: port, orient: 'v', name: 'port' },
        ],
      })
      assert.equal(r.placed, 2)
      assert.deepEqual(r.warnings, [])
      const info = JSON.parse(cli('info', outPsd, '--compact'))
      const flat = []
      const walk = (ls) => {
        for (const l of ls || []) {
          flat.push(l)
          walk(l.children || l.layers)
        }
      }
      walk(info.layers)
      const landL = flat.find((l) => l.name === 'land')
      const portL = flat.find((l) => l.name === 'port')
      assert.ok(landL && portL, 'both photos are layers in the sheet')
      assert.equal(landL.clipped, true)
      assert.equal(portL.clipped, true)
      // The landscape photo (3:2) covers the 400x230 frame: at least as wide and tall, centred.
      const [x, y, w, h] = landL.bounds
      assert.ok(x <= 100 && y <= 100 && x + w >= 500 && y + h >= 330, `bounds ${landL.bounds}`)
      assert.ok(Math.abs(x + w / 2 - 300) <= 1 && Math.abs(y + h / 2 - 215) <= 1)
      assert.ok(fs.statSync(path.join(dir, 'Page_001.jpg')).size > 1000, 'a JPEG of the sheet was written')
      // Nothing left open in the engine.
      assert.equal((await pc.call('session.list', {})).documents.length, 0)
    } finally {
      await pc.close()
    }
  },
)
