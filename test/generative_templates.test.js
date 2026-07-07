'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const gt = require('../src/generative_templates')

function allFrames(tpl) {
  return tpl.frames
}

test('gridLayout produces rows*cols frames named by the toolkit convention', () => {
  const tpl = gt.gridLayout({ rows: 2, cols: 3 })
  assert.equal(tpl.frames.length, 6)
  assert.ok(tpl.frames.every((f) => /^toolkit[hv]frame\d+$/.test(f.name)))
})

test('gridLayout frames stay within the canvas bounds', () => {
  const tpl = gt.gridLayout({ rows: 2, cols: 3 })
  for (const f of allFrames(tpl)) {
    assert.ok(f.x >= 0 && f.y >= 0, `frame ${f.name} has negative origin`)
    assert.ok(f.x + f.w <= tpl.canvasWidth + 1, `frame ${f.name} overflows width`)
    assert.ok(f.y + f.h <= tpl.canvasHeight + 1, `frame ${f.name} overflows height`)
  }
})

test('frame() never emits a zero-area box even under degenerate input', () => {
  // A 1x1 grid on a tiny canvas still yields a >=1px frame.
  const tpl = gt.gridLayout({ rows: 1, cols: 1, canvasWidth: 10, canvasHeight: 10, bleed: 4, gutter: 0 })
  for (const f of allFrames(tpl)) {
    assert.ok(f.w >= 1 && f.h >= 1)
  }
})

test('defaultCatalog returns non-empty, well-formed templates', () => {
  const catalog = gt.defaultCatalog()
  assert.ok(Array.isArray(catalog) && catalog.length > 0)
  for (const tpl of catalog) {
    assert.ok(tpl.id && tpl.name, 'template needs id + name')
    assert.ok(Array.isArray(tpl.frames) && tpl.frames.length > 0)
    assert.equal(typeof tpl.canvasWidth, 'number')
    assert.equal(typeof tpl.canvasHeight, 'number')
  }
})

test('catalog h/v counts match the actual frame partition', () => {
  for (const tpl of gt.defaultCatalog()) {
    const h = tpl.frames.filter((f) => f.name.toLowerCase().includes('toolkithframe')).length
    const v = tpl.frames.filter((f) => f.name.toLowerCase().includes('toolkitvframe')).length
    assert.equal(tpl.h, h, `${tpl.name}: h count`)
    assert.equal(tpl.v, v, `${tpl.name}: v count`)
  }
})

test('regen re-hydrates a template from a generator spec', () => {
  const catalog = gt.defaultCatalog()
  const spec = catalog[0]
  const again = gt.regen(spec)
  assert.ok(again, 'regen should return a template for a known generator')
  assert.equal(again.frames.length, spec.frames.length)
})

test('regen returns null/falsy for an unknown generator', () => {
  assert.ok(!gt.regen({ generator: 'does-not-exist' }))
})
