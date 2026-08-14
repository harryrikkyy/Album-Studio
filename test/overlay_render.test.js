'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildOverlaySvg,
  overlayCacheKey,
  wrapText,
  estimateTextWidth,
  esc,
  safeColor,
  safeFont,
} = require('../src/overlay_render')

const textLayer = (over = {}) => ({
  id: 't1', type: 'text', x: 0.1, y: 0.1, w: 0.5, h: 0.2,
  text: 'Hello', size: 0.05, color: '#fff', ...over,
})

// ─── escaping / sanitizing ───────────────────────────────────────────────────

test('esc neutralizes the XML metacharacters', () => {
  assert.equal(esc(`<tspan>&"'`), '&lt;tspan&gt;&amp;&quot;&apos;')
  assert.equal(esc(null), '')
  assert.equal(esc(undefined), '')
})

test('user text cannot inject markup into the SVG', () => {
  const svg = buildOverlaySvg([textLayer({ text: '</text><script>alert(1)</script>' })], 100, 100)
  assert.ok(!svg.includes('<script>'), 'script tag must be escaped')
  assert.ok(svg.includes('&lt;/text&gt;'))
})

test('safeColor rejects values that would break out of the attribute', () => {
  assert.equal(safeColor('#ff0000', '#000'), '#ff0000')
  assert.equal(safeColor('rgba(0,0,0,0.5)', '#000'), 'rgba(0,0,0,0.5)')
  assert.equal(safeColor('red', '#000'), 'red')
  // Quote-escape attempts and junk fall back rather than being interpolated.
  assert.equal(safeColor('#fff" onload="x', '#000'), '#000')
  assert.equal(safeColor('url(#x)', '#000'), '#000')
  assert.equal(safeColor(undefined, '#123'), '#123')
})

test('safeFont rejects families containing quotes or markup', () => {
  assert.equal(safeFont('Helvetica Neue'), 'Helvetica Neue')
  assert.equal(safeFont("Georgia'; x:y"), 'Helvetica Neue')
  assert.equal(safeFont(undefined), 'Helvetica Neue')
})

// ─── empty / skip cases ──────────────────────────────────────────────────────

test('buildOverlaySvg returns empty string when there is nothing to draw', () => {
  assert.equal(buildOverlaySvg([], 100, 100), '')
  assert.equal(buildOverlaySvg(null, 100, 100), '')
  assert.equal(buildOverlaySvg([textLayer({ hidden: true })], 100, 100), '')
  // Whitespace-only text draws nothing.
  assert.equal(buildOverlaySvg([textLayer({ text: '   ' })], 100, 100), '')
})

// ─── resolution independence ─────────────────────────────────────────────────
// The whole WYSIWYG guarantee rests on this: the same layer at two output
// sizes must place text at proportionally identical coordinates.

test('geometry scales proportionally with output size', () => {
  const L = textLayer({ x: 0.25, y: 0.5, size: 0.1, align: 'left', valign: 'top' })
  const small = buildOverlaySvg([L], 1000, 1000)
  const large = buildOverlaySvg([L], 4000, 4000)

  const xSmall = Number(/<tspan x="([\d.]+)"/.exec(small)[1])
  const xLarge = Number(/<tspan x="([\d.]+)"/.exec(large)[1])
  assert.equal(xLarge, xSmall * 4)

  const ySmall = Number(/<tspan x="[\d.]+" y="([\d.]+)"/.exec(small)[1])
  const yLarge = Number(/<tspan x="[\d.]+" y="([\d.]+)"/.exec(large)[1])
  assert.equal(yLarge, ySmall * 4)

  const sizeSmall = Number(/font-size:([\d.]+)px/.exec(small)[1])
  const sizeLarge = Number(/font-size:([\d.]+)px/.exec(large)[1])
  assert.equal(sizeLarge, sizeSmall * 4)
})

test('font size is a fraction of canvas HEIGHT, independent of width', () => {
  const L = textLayer({ size: 0.1 })
  const wide = buildOverlaySvg([L], 4000, 1000)
  const tall = buildOverlaySvg([L], 1000, 1000)
  assert.equal(/font-size:([\d.]+)px/.exec(wide)[1], /font-size:([\d.]+)px/.exec(tall)[1])
})

// ─── text wrapping ───────────────────────────────────────────────────────────

test('wrapText breaks on explicit newlines', () => {
  assert.deepEqual(wrapText('a\nb\nc', 0, 10, 400, 0), ['a', 'b', 'c'])
})

test('wrapText greedily fills lines to the box width', () => {
  const lines = wrapText('aaa bbb ccc ddd', 100, 20, 400, 0)
  assert.ok(lines.length > 1, 'should wrap')
  // Every line must fit, which is the property that matters.
  for (const ln of lines) {
    assert.ok(estimateTextWidth(ln, 20, 400, 0) <= 100 + 1e-9, `line too wide: ${ln}`)
  }
  assert.equal(lines.join(' '), 'aaa bbb ccc ddd', 'no words lost or duplicated')
})

test('wrapText hard-splits a single word wider than the box', () => {
  const lines = wrapText('WWWWWWWWWWWWWWWWWWWW', 50, 20, 400, 0)
  assert.ok(lines.length > 1, 'a too-long word must be split, not overflow')
  assert.equal(lines.join(''), 'WWWWWWWWWWWWWWWWWWWW', 'no characters lost')
})

test('wrapText with maxWidth 0 disables wrapping', () => {
  assert.deepEqual(wrapText('a b c d e f g', 0, 20, 400, 0), ['a b c d e f g'])
})

test('tracking widens the estimate and so tightens wrapping', () => {
  const plain = estimateTextWidth('hello', 20, 400, 0)
  const tracked = estimateTextWidth('hello', 20, 400, 0.2)
  assert.ok(tracked > plain)
})

test('wrapped lines each become a tspan', () => {
  const svg = buildOverlaySvg([textLayer({ text: 'a\nb\nc', w: 0 })], 1000, 1000)
  assert.equal((svg.match(/<tspan/g) || []).length, 3)
})

// ─── alignment ───────────────────────────────────────────────────────────────

test('horizontal alignment sets both anchor and x origin', () => {
  const left = buildOverlaySvg([textLayer({ align: 'left', x: 0.1, w: 0.5 })], 1000, 1000)
  const center = buildOverlaySvg([textLayer({ align: 'center', x: 0.1, w: 0.5 })], 1000, 1000)
  const right = buildOverlaySvg([textLayer({ align: 'right', x: 0.1, w: 0.5 })], 1000, 1000)

  assert.ok(left.includes('text-anchor="start"'))
  assert.ok(center.includes('text-anchor="middle"'))
  assert.ok(right.includes('text-anchor="end"'))

  assert.equal(Number(/<tspan x="([\d.]+)"/.exec(left)[1]), 100)
  assert.equal(Number(/<tspan x="([\d.]+)"/.exec(center)[1]), 350) // 100 + 500/2
  assert.equal(Number(/<tspan x="([\d.]+)"/.exec(right)[1]), 600)  // 100 + 500
})

test('vertical alignment shifts the first baseline', () => {
  const base = { y: 0, h: 0.5, size: 0.1, text: 'x', w: 0 }
  const yOf = (valign) => Number(
    /<tspan x="[\d.-]+" y="([\d.-]+)"/.exec(buildOverlaySvg([textLayer({ ...base, valign })], 1000, 1000))[1]
  )
  assert.ok(yOf('top') < yOf('middle'))
  assert.ok(yOf('middle') < yOf('bottom'))
})

test('baselines are explicit, never dominant-baseline', () => {
  // librsvg and Chrome disagree on dominant-baseline, so the generator must
  // not rely on it — that would silently desync preview from export.
  const svg = buildOverlaySvg([textLayer()], 1000, 1000)
  assert.ok(!svg.includes('dominant-baseline'))
})

// ─── shapes ──────────────────────────────────────────────────────────────────

test('rect honours fill, stroke and corner radius', () => {
  const svg = buildOverlaySvg([{
    id: 's', type: 'rect', x: 0.1, y: 0.1, w: 0.5, h: 0.25,
    fill: '#ff0000', stroke: '#00ff00', strokeWidth: 0.01, radius: 0.02,
  }], 1000, 1000)
  assert.ok(svg.includes('<rect'))
  assert.ok(svg.includes('fill="#ff0000"'))
  assert.ok(svg.includes('stroke="#00ff00"'))
  assert.ok(svg.includes('stroke-width="10"'))
  assert.ok(svg.includes('rx="20"'))
})

test('rect with fill none stays unfilled', () => {
  const svg = buildOverlaySvg([{ id: 's', type: 'rect', x: 0, y: 0, w: 0.5, h: 0.5, fill: 'none', stroke: '#000', strokeWidth: 0.01 }], 1000, 1000)
  assert.ok(svg.includes('fill="none"'))
})

test('ellipse is centered in its box', () => {
  const svg = buildOverlaySvg([{ id: 's', type: 'ellipse', x: 0.2, y: 0.2, w: 0.4, h: 0.4, fill: '#000' }], 1000, 1000)
  assert.ok(svg.includes('cx="400"'))
  assert.ok(svg.includes('cy="400"'))
  assert.ok(svg.includes('rx="200"'))
})

test('line spans the box midline', () => {
  const svg = buildOverlaySvg([{ id: 's', type: 'line', x: 0.1, y: 0.2, w: 0.6, h: 0.1, stroke: '#000', strokeWidth: 0.005 }], 1000, 1000)
  assert.ok(svg.includes('x1="100"'))
  assert.ok(svg.includes('x2="700"'))
  assert.ok(svg.includes('y1="250"'))
  assert.ok(svg.includes('y2="250"'))
})

// ─── transforms ──────────────────────────────────────────────────────────────

test('rotation is applied about the layer center', () => {
  const svg = buildOverlaySvg([textLayer({ x: 0.2, y: 0.2, w: 0.4, h: 0.2, rot: 45 })], 1000, 1000)
  assert.ok(svg.includes('rotate(45 400 300)'), svg)
})

test('opacity wraps the layer, and 1 adds no wrapper', () => {
  assert.ok(buildOverlaySvg([textLayer({ opacity: 0.5 })], 100, 100).includes('opacity="0.5"'))
  assert.ok(!buildOverlaySvg([textLayer({ opacity: 1 })], 100, 100).includes('opacity='))
})

test('the shadow filter is defined once and only when used', () => {
  const none = buildOverlaySvg([textLayer()], 100, 100)
  assert.ok(!none.includes('ovShadow'))
  const two = buildOverlaySvg([textLayer({ id: 'a', shadow: 1 }), textLayer({ id: 'b', shadow: 1 })], 100, 100)
  assert.equal((two.match(/<filter id="ovShadow"/g) || []).length, 1)
  assert.equal((two.match(/filter="url\(#ovShadow\)"/g) || []).length, 2)
})

// ─── clamping ────────────────────────────────────────────────────────────────

test('out-of-range numbers are clamped rather than emitted raw', () => {
  const svg = buildOverlaySvg([textLayer({ opacity: 99, size: 999, rot: 1e6 })], 1000, 1000)
  assert.ok(!svg.includes('NaN'))
  assert.ok(!/opacity="9/.test(svg))
  assert.ok(Number(/font-size:([\d.]+)px/.exec(svg)[1]) <= 500)
})

test('non-finite geometry falls back to defaults instead of emitting NaN', () => {
  const svg = buildOverlaySvg([textLayer({ x: NaN, y: undefined, size: Infinity })], 1000, 1000)
  assert.ok(!svg.includes('NaN'))
  assert.ok(!svg.includes('Infinity'))
})

// ─── cache key ───────────────────────────────────────────────────────────────

test('overlayCacheKey is 0 when nothing renders', () => {
  assert.equal(overlayCacheKey([]), 0)
  assert.equal(overlayCacheKey([textLayer({ hidden: true })]), 0)
})

test('overlayCacheKey changes when a pixel-affecting field changes', () => {
  const a = overlayCacheKey([textLayer({ text: 'A' })])
  const b = overlayCacheKey([textLayer({ text: 'B' })])
  assert.notEqual(a, b)
  const c = overlayCacheKey([textLayer({ text: 'A', color: '#123456' })])
  assert.notEqual(a, c)
})

test('overlayCacheKey ignores fields that do not affect pixels', () => {
  const a = overlayCacheKey([textLayer({ locked: false })])
  const b = overlayCacheKey([textLayer({ locked: true })])
  assert.equal(a, b, 'locking a layer must not invalidate the render cache')
})

test('identical input yields byte-identical SVG (stable hashing)', () => {
  const L = textLayer({ x: 1 / 3, size: 0.0777 })
  assert.equal(buildOverlaySvg([L], 1500, 1000), buildOverlaySvg([L], 1500, 1000))
})

// ─── psdTextOverlay ──────────────────────────────────────────────────────────
// Stand-in geometry for a retyped template text layer. It lives in this shared
// module precisely so the editor window and the main-process renderer cannot
// disagree about where a caption lands.

const { psdTextOverlay } = require('../src/overlay_render')

const psdNode = (over = {}) => ({
  id: '1/0', kind: 'text', name: 'Title', text: 'Original',
  x: 100, y: 200, w: 400, h: 80, effectiveOpacity: 1,
  textStyle: { font: 'Didot', sizePx: 100, color: '#112233', tracking: 0.05, align: 'center', anchorX: 500, anchorY: 300 },
  ...over,
})

test('psdTextOverlay returns null unless the copy actually changed', () => {
  const n = psdNode()
  assert.equal(psdTextOverlay(n, undefined, 1000, 1000), null)
  assert.equal(psdTextOverlay(n, {}, 1000, 1000), null)
  // Typing the original text back is NOT an edit — the layer's own baked
  // pixels render better than any stand-in, so they must be left alone.
  assert.equal(psdTextOverlay(n, { text: 'Original' }, 1000, 1000), null)
  assert.ok(psdTextOverlay(n, { text: 'Changed' }, 1000, 1000))
})

test('psdTextOverlay only applies to text layers', () => {
  assert.equal(psdTextOverlay(psdNode({ kind: 'raster' }), { text: 'x' }, 1000, 1000), null)
})

test('the stand-in anchor matches the PSD anchor for each alignment', () => {
  const W = 1000, H = 1000
  for (const [align, expected] of [['center', 500], ['left', 500], ['right', 500]]) {
    const n = psdNode({ textStyle: { ...psdNode().textStyle, align } })
    const ov = psdTextOverlay(n, { text: 'New' }, W, H)
    // The engine's own anchor for this alignment must land on anchorX.
    const anchor = align === 'center' ? (ov.x + ov.w / 2)
      : align === 'right' ? (ov.x + ov.w) : ov.x
    assert.ok(Math.abs(anchor * W - expected) < 0.001, `${align}: ${anchor * W} != ${expected}`)
  }
})

test('the baseline offset is backed out of the box top', () => {
  const ov = psdTextOverlay(psdNode(), { text: 'New' }, 1000, 1000)
  // anchorY (300) is the BASELINE; the engine draws the first baseline 0.78em
  // below the box top, so the top must sit that far above it.
  assert.ok(Math.abs(ov.y * 1000 - (300 - 100 * 0.78)) < 0.001)
})

test('a moved layer carries its stand-in with it', () => {
  const a = psdTextOverlay(psdNode(), { text: 'New' }, 1000, 1000)
  const b = psdTextOverlay(psdNode(), { text: 'New', dx: 50, dy: -25 }, 1000, 1000)
  assert.ok(Math.abs((b.x - a.x) * 1000 - 50) < 0.001)
  assert.ok(Math.abs((b.y - a.y) * 1000 - (-25)) < 0.001)
})

test('style carries over, and a missing size falls back to the layer height', () => {
  const ov = psdTextOverlay(psdNode(), { text: 'New' }, 1000, 1000)
  assert.equal(ov.font, 'Didot')
  assert.equal(ov.color, '#112233')
  assert.equal(ov.tracking, 0.05)
  assert.equal(ov.size * 1000, 100)

  const noSize = psdTextOverlay(psdNode({ textStyle: { align: 'left' } }), { text: 'New' }, 1000, 1000)
  assert.ok(noSize.size * 1000 > 4, 'must not collapse to an unreadable size')
})
