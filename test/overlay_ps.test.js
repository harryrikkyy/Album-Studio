'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildPsTextLayers, hasShapeOverlays, resolvePsFont, hexToRgb } = require('../src/overlay_ps')
const { buildOverlaySvg, wrapText } = require('../src/overlay_render')

const textLayer = (over = {}) => ({
  id: 't1',
  type: 'text',
  x: 0.1,
  y: 0.1,
  w: 0.5,
  h: 0.2,
  text: 'Hello',
  size: 0.05,
  color: '#ffffff',
  font: 'Georgia',
  ...over,
})

// ─── font resolution ─────────────────────────────────────────────────────────

test('resolvePsFont returns the PostScript name, not the CSS family', () => {
  assert.equal(resolvePsFont('Georgia', 400, false).name, 'Georgia')
  assert.equal(resolvePsFont('Georgia', 700, false).name, 'Georgia-Bold')
  assert.equal(resolvePsFont('Times New Roman', 400, false).name, 'TimesNewRomanPSMT')
})

test('resolvePsFont picks the nearest available weight', () => {
  // Georgia ships only 400/700 — a 500 request must land on one of them.
  assert.equal(resolvePsFont('Georgia', 500, false).name, 'Georgia')
  assert.equal(resolvePsFont('Georgia', 600, false).name, 'Georgia-Bold')
  // Helvetica Neue has a real 300 cut.
  assert.equal(resolvePsFont('Helvetica Neue', 300, false).name, 'HelveticaNeue-Light')
})

test('resolvePsFont uses the italic cut when the family has one', () => {
  const r = resolvePsFont('Georgia', 400, true)
  assert.equal(r.name, 'Georgia-Italic')
  assert.equal(r.fauxItalic, false, 'a real italic cut must not also be faux-slanted')
})

test('resolvePsFont falls back to faux italic when the family has no italic', () => {
  // American Typewriter ships no italic cut.
  const r = resolvePsFont('American Typewriter', 400, true)
  assert.equal(r.name, 'AmericanTypewriter')
  assert.equal(r.fauxItalic, true, 'italics must not silently render upright')
})

test('resolvePsFont returns null for an unmapped family so the JSX keeps its default', () => {
  assert.equal(resolvePsFont('Nonexistent Face', 400, false).name, null)
})

// ─── colour ──────────────────────────────────────────────────────────────────

test('hexToRgb handles both short and long form', () => {
  assert.deepEqual(hexToRgb('#fff'), { r: 255, g: 255, b: 255 })
  assert.deepEqual(hexToRgb('#ff8000'), { r: 255, g: 128, b: 0 })
})

test('hexToRgb rejects anything that is not a hex colour', () => {
  assert.equal(hexToRgb('red'), null)
  assert.equal(hexToRgb('rgba(0,0,0,0.5)'), null)
  assert.equal(hexToRgb(undefined), null)
})

test('a non-hex colour falls back to near-black rather than crashing', () => {
  const [L] = buildPsTextLayers([textLayer({ color: 'rebeccapurple' })], 1000, 1000)
  assert.deepEqual(L.color, { r: 17, g: 17, b: 17 })
})

// ─── selection ───────────────────────────────────────────────────────────────

test('buildPsTextLayers takes text layers only — shapes stay rasterized', () => {
  const layers = buildPsTextLayers(
    [
      textLayer({ id: 'a' }),
      { id: 'b', type: 'rect', x: 0, y: 0, w: 0.5, h: 0.5, fill: '#000' },
      { id: 'c', type: 'line', x: 0, y: 0, w: 0.5, h: 0.01, stroke: '#000' },
    ],
    1000,
    1000,
  )
  assert.equal(layers.length, 1)
})

test('hidden and empty text layers are skipped', () => {
  assert.equal(buildPsTextLayers([textLayer({ hidden: true })], 1000, 1000).length, 0)
  assert.equal(buildPsTextLayers([textLayer({ text: '   ' })], 1000, 1000).length, 0)
})

test('hasShapeOverlays distinguishes pages that still need a raster', () => {
  assert.equal(hasShapeOverlays([textLayer()]), false)
  assert.equal(hasShapeOverlays([textLayer(), { id: 's', type: 'rect' }]), true)
  assert.equal(hasShapeOverlays([{ id: 's', type: 'rect', hidden: true }]), false)
  assert.equal(hasShapeOverlays([]), false)
})

// ─── the guarantee: Photoshop never re-wraps ─────────────────────────────────
// This is the whole reason native PS text is safe here. If `contents` ever
// stopped carrying pre-broken lines, Photoshop would re-flow the copy against
// its own metrics and the delivered PSD would silently disagree with the proof.

test('contents carries the SAME pre-wrapped lines the SVG renders', () => {
  const long = 'The wedding of the year, a very long caption that certainly wraps'
  const L = textLayer({ text: long, w: 0.4, size: 0.04 })

  const [ps] = buildPsTextLayers([L], 2000, 1500)
  const svg = buildOverlaySvg([L], 2000, 1500)

  const svgLines = [...svg.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((m) => m[1])
  const psLines = ps.contents.split('\r')

  assert.ok(psLines.length > 1, 'this fixture must actually wrap')
  assert.deepEqual(psLines, svgLines, 'PS lines must match the rendered SVG lines exactly')
})

test('contents uses \\r between lines (ExtendScript hard break)', () => {
  const [ps] = buildPsTextLayers([textLayer({ text: 'one\ntwo\nthree', w: 0 })], 1000, 1000)
  assert.equal(ps.contents, 'one\rtwo\rthree')
  assert.ok(!ps.contents.includes('\n'), 'a raw \\n would render as a literal box in Photoshop')
})

test('explicit newlines survive into the Photoshop payload', () => {
  const [ps] = buildPsTextLayers([textLayer({ text: 'Sarah\n&\nJames', w: 0 })], 1000, 1000)
  assert.equal(ps.contents.split('\r').length, 3)
})

// ─── geometry ────────────────────────────────────────────────────────────────

test('the anchor matches the SVG text anchor for every alignment', () => {
  for (const align of ['left', 'center', 'right']) {
    const L = textLayer({ align, x: 0.1, w: 0.5, text: 'x' })
    const [ps] = buildPsTextLayers([L], 1000, 1000)
    const svg = buildOverlaySvg([L], 1000, 1000)
    const svgX = Number(/<tspan x="([\d.-]+)"/.exec(svg)[1])
    assert.equal(ps.x, svgX, `anchor mismatch for align=${align}`)
    assert.equal(ps.justification, align)
  }
})

test('y is the first baseline, matching the SVG', () => {
  const L = textLayer({ valign: 'middle', y: 0.2, h: 0.4, text: 'x' })
  const [ps] = buildPsTextLayers([L], 1000, 1000)
  const svg = buildOverlaySvg([L], 1000, 1000)
  assert.equal(ps.y, Number(/<tspan x="[\d.-]+" y="([\d.-]+)"/.exec(svg)[1]))
})

test('geometry scales with canvas size (same layer, bigger page)', () => {
  const L = textLayer({ x: 0.25, y: 0.5, size: 0.1 })
  const [small] = buildPsTextLayers([L], 1000, 1000)
  const [large] = buildPsTextLayers([L], 4000, 4000)
  assert.equal(large.x, small.x * 4)
  assert.equal(large.y, small.y * 4)
  assert.equal(large.sizePx, small.sizePx * 4)
  assert.equal(large.leadingPx, small.leadingPx * 4)
})

test('tracking converts from em-fraction to Photoshop 1/1000 em', () => {
  const [ps] = buildPsTextLayers([textLayer({ tracking: 0.08 })], 1000, 1000)
  assert.equal(ps.tracking, 80)
})

test('leading follows line height', () => {
  const [a] = buildPsTextLayers([textLayer({ size: 0.1, lineHeight: 1 })], 1000, 1000)
  const [b] = buildPsTextLayers([textLayer({ size: 0.1, lineHeight: 2 })], 1000, 1000)
  assert.equal(b.leadingPx, a.leadingPx * 2)
})

test('opacity is expressed as a Photoshop percentage', () => {
  const [ps] = buildPsTextLayers([textLayer({ opacity: 0.5 })], 1000, 1000)
  assert.equal(ps.opacity, 50)
  const [full] = buildPsTextLayers([textLayer({})], 1000, 1000)
  assert.equal(full.opacity, 100)
})

test('the rotation pivot is the layer BOX centre, not the text centre', () => {
  // Photoshop can only rotate about a layer's own bounds, so the JSX needs the
  // box centre explicitly to reproduce the preview's rotation.
  const [ps] = buildPsTextLayers([textLayer({ x: 0.2, y: 0.2, w: 0.4, h: 0.2, rot: 30 })], 1000, 1000)
  assert.equal(ps.rot, 30)
  assert.equal(ps.pivotX, 400)
  assert.equal(ps.pivotY, 300)
})

test('layer order is preserved so the PSD stack matches the editor', () => {
  const layers = buildPsTextLayers(
    [textLayer({ id: 'a', text: 'first' }), textLayer({ id: 'b', text: 'second' })],
    1000,
    1000,
  )
  assert.deepEqual(
    layers.map((l) => l.contents),
    ['first', 'second'],
  )
})

test('the layer name is derived from the copy and stays bounded', () => {
  const [ps] = buildPsTextLayers([textLayer({ text: 'x'.repeat(200), w: 0 })], 1000, 1000)
  assert.ok(ps.name.length <= 40)
})

// ─── wrap helper agreement ───────────────────────────────────────────────────

test('the payload wraps with the same helper the SVG uses', () => {
  const text = 'aaa bbb ccc ddd eee fff ggg hhh'
  const L = textLayer({ text, w: 0.3, size: 0.04 })
  const [ps] = buildPsTextLayers([L], 1000, 1000)
  const expected = wrapText(text, 0.3 * 1000, 0.04 * 1000, 400, 0)
  assert.deepEqual(ps.contents.split('\r'), expected)
})
