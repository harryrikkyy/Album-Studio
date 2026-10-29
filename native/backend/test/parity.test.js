'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const sharp = require('sharp')
const { buildSheet } = require('../lib/sheet')
const { PhotoCraftSession, cliPath } = require('../lib/photocraft')
const { bakeAdjustments, pairLayers } = require('../lib/parity')

const haveEngine = fs.existsSync(cliPath())
const cli = (...args) => execFileSync(cliPath(), args, { encoding: 'utf8' })

test('editor layer ids (PSD order) line up with the engine’s layers (top first), by name', () => {
  const ag = [{ name: 'Background' }, { name: 'Group', children: [{ name: 'A' }, { name: 'B' }] }, { name: 'Top' }]
  const engine = [
    { id: 9, name: 'Top' },
    {
      id: 8,
      name: 'Group',
      children: [
        { id: 7, name: 'B' },
        { id: 6, name: 'A' },
      ],
    },
    { id: 5, name: 'Background' },
  ]
  const m = pairLayers(ag, engine)
  assert.deepEqual(
    [...m].map(([k, v]) => [k, v.pc && v.pc.id]),
    [
      ['0', 5],
      ['1', 8],
      ['1/0', 6],
      ['1/1', 7],
      ['2', 9],
    ],
  )
  const renamed = pairLayers(
    [{ name: 'Background' }, { name: 'Other' }],
    [
      { id: 2, name: 'Top' },
      { id: 1, name: 'Background' },
    ],
  )
  assert.equal(
    renamed.get('1').pc,
    null,
    'a layer whose name changed is not matched (the edit is skipped, not misapplied)',
  )
})

test('colour adjustments are baked into a copy of the photo, cached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-adj-'))
  const src = path.join(dir, 'p.jpg')
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#d02020' } })
    .jpeg()
    .toFile(src)
  assert.equal(await bakeAdjustments(src, null, dir), src, 'no adjustment: the original')
  assert.equal(await bakeAdjustments(src, { vignette: 40 }, dir), src, 'a vignette alone is preview-only')
  const out = await bakeAdjustments(src, { saturation: -100 }, path.join(dir, 'adj'))
  assert.notEqual(out, src)
  const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
  assert.ok(Math.abs(data[0] - data[1]) < 6 && Math.abs(data[1] - data[2]) < 6, 'saturation -100 is grey')
  assert.equal(
    await bakeAdjustments(src, { saturation: -100 }, path.join(dir, 'adj')),
    out,
    'the same settings reuse the copy',
  )
})

/** 1200×400: an H frame, a V frame, then a band and a strip above them (made by PhotoCraft). */
function makeTemplate(dir) {
  const file = path.join(dir, 'tpl.psd')
  const steps = [
    ['layer.new.layer', { name: 'ToolkitHFrame_001' }],
    ['select.rect', { x: 100, y: 100, width: 400, height: 230 }],
    ['edit.fill', { contents: 'color', color: '#808080' }],
    ['select.deselect', {}],
    ['layer.new.layer', { name: 'ToolkitVFrame_001' }],
    ['select.rect', { x: 700, y: 50, width: 200, height: 300 }],
    ['edit.fill', { contents: 'color', color: '#606060' }],
    ['select.deselect', {}],
    ['layer.new.layer', { name: 'Band' }],
    ['select.rect', { x: 0, y: 0, width: 1200, height: 40 }],
    ['edit.fill', { contents: 'color', color: '#203040' }],
    ['select.deselect', {}],
    ['layer.new.layer', { name: 'Strip' }],
    ['select.rect', { x: 20, y: 60, width: 40, height: 300 }],
    ['edit.fill', { contents: 'color', color: '#402010' }],
    ['select.deselect', {}],
  ]
  const args = ['run', '--new', JSON.stringify({ width: 1200, height: 400, background: 'white' })]
  for (const [cmd, params] of steps) args.push('--cmd', cmd, '--params', JSON.stringify(params))
  cli(...args, '--out', file)
  return file
}

test(
  'a sheet carries the spread editor’s layer overrides, text and shapes',
  { skip: !haveEngine && 'PhotoCraft engine not built' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-parity-'))
    const template = makeTemplate(dir)
    const photo = path.join(dir, 'land.jpg')
    cli('run', '--new', JSON.stringify({ width: 1800, height: 1200, background: 'black' }), '--out', photo)
    const pc = new PhotoCraftSession({ writeRoot: dir })
    try {
      const outPsd = path.join(dir, 'Page_001.psd')
      const r = await buildSheet(pc, {
        template,
        outPsd,
        photos: [{ file: photo, orient: 'h', name: 'land' }],
        // PSD order: 0 Background, 1 H frame, 2 V frame, 3 Band, 4 Strip.
        layerEdits: { 3: { hidden: true }, 4: { dx: 100, dy: 0, sx: 2, sy: 0.5 }, 9: { hidden: true } },
        overlays: [
          {
            id: 't',
            type: 'text',
            text: 'Asha & Ravi',
            x: 0.5,
            y: 0.8,
            w: 0.4,
            h: 0.15,
            size: 0.08,
            font: 'Helvetica Neue',
            weight: 700,
            color: '#ffffff',
            align: 'center',
          },
          { id: 's', type: 'rect', x: 0.1, y: 0.9, w: 0.3, h: 0.02, fill: '#ff0000' },
        ],
      })
      assert.deepEqual(r.warnings, [
        "a template layer edited in the spread editor (9) wasn't found in the template; that edit was left out",
      ])
      const info = JSON.parse(cli('info', outPsd, '--compact'))
      const flat = []
      const walk = (ls) => {
        for (const l of ls || []) {
          flat.push(l)
          walk(l.children || l.layers)
        }
      }
      walk(info.layers)
      const by = (name) => flat.find((l) => l.name === name)
      assert.equal(by('Band').visible, false, 'the hidden layer is hidden')
      // Moved by 100 px, twice as wide, half as tall, top-left kept (resampling soft-edges a pixel).
      const [sx, sy, sw, sh] = by('Strip').bounds
      assert.ok(
        Math.abs(sx - 120) <= 2 && Math.abs(sy - 60) <= 2 && Math.abs(sw - 80) <= 3 && Math.abs(sh - 150) <= 3,
        `strip bounds ${by('Strip').bounds}`,
      )
      const text = by('Asha & Ravi')
      assert.ok(text, 'the text is a layer of its own')
      assert.match(String(text.kind || text.type), /type|text/i, 'live type, not pixels')
      assert.ok(by('Album Studio — text & shapes'), 'the shapes are one layer')
      assert.equal(info.layers[0].name, 'Asha & Ravi', 'text on top')
      assert.equal(info.layers[1].name, 'Album Studio — text & shapes', 'shapes under the text')
      assert.equal((await pc.call('session.list', {})).documents.length, 0, 'nothing left open')
    } finally {
      await pc.close()
    }
  },
)
