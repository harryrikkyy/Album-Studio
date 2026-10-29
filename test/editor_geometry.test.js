'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  layerBox,
  resizeBox,
  boundingBox,
  alignBoxes,
  distributeBoxes,
  snapPosition,
  pickAtPoint,
} = require('../src/editor_geometry')

const box = (x, y, w, h) => ({ x, y, w, h })
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, msg || `${a} !== ${b}`)

// ─── layerBox ────────────────────────────────────────────────────────────────
// The editor canvas, the hit-test, the panel and the exporter all read this.
// If they disagree, a layer renders somewhere other than where it was dragged.

test('layerBox with no edit is the layer itself', () => {
  assert.deepEqual(layerBox(box(100, 200, 300, 400)), box(100, 200, 300, 400))
  assert.deepEqual(layerBox(box(10, 20, 30, 40), {}), box(10, 20, 30, 40))
})

test('layerBox applies offset and scale', () => {
  assert.deepEqual(layerBox(box(100, 200, 300, 400), { dx: 50, dy: -25, sx: 2, sy: 0.5 }), box(150, 175, 600, 200))
})

test('layerBox treats a missing scale as 1, not 0', () => {
  // Defaulting sx/sy to 0 would collapse every unscaled layer to nothing.
  assert.deepEqual(layerBox(box(0, 0, 100, 100), { dx: 5 }), box(5, 0, 100, 100))
})

test('layerBox ignores non-finite edits rather than producing NaN', () => {
  const b = layerBox(box(10, 10, 100, 100), { dx: NaN, sy: undefined })
  assert.deepEqual(b, box(10, 10, 100, 100))
})

// ─── resizeBox ───────────────────────────────────────────────────────────────
// The opposite corner must stay pinned. Dragging north or west moves the
// ORIGIN as well as the size, which is the easy thing to get wrong.

test('resizeBox from the south-east moves only the size', () => {
  const r = resizeBox(box(10, 20, 100, 200), 'se', 40, -50)
  assert.deepEqual(r, box(10, 20, 140, 150))
})

test('resizeBox from the north-west pins the far corner', () => {
  const orig = box(10, 20, 100, 200)
  const r = resizeBox(orig, 'nw', 30, 50)
  // Far corner (110, 220) must not have moved.
  near(r.x + r.w, orig.x + orig.w, 'right edge moved')
  near(r.y + r.h, orig.y + orig.h, 'bottom edge moved')
  assert.deepEqual(r, box(40, 70, 70, 150))
})

test('resizeBox from the north-east pins left and bottom', () => {
  const orig = box(10, 20, 100, 200)
  const r = resizeBox(orig, 'ne', 20, 40)
  near(r.x, orig.x, 'left edge moved')
  near(r.y + r.h, orig.y + orig.h, 'bottom edge moved')
})

test('resizeBox never goes below the minimum, and does not invert', () => {
  const r = resizeBox(box(0, 0, 100, 100), 'se', -500, -500, { min: 2 })
  assert.equal(r.w, 2)
  assert.equal(r.h, 2)
  const nw = resizeBox(box(0, 0, 100, 100), 'nw', 500, 500, { min: 2 })
  assert.ok(nw.w >= 2 && nw.h >= 2, 'no negative sizes')
})

test('resizeBox keeps the aspect ratio when asked', () => {
  const orig = box(0, 0, 100, 50) // 2:1
  const r = resizeBox(orig, 'se', 100, 0, { keepAspect: true })
  near(r.w / r.h, 2, 'ratio drifted')
})

test('aspect-locked resize from the north still pins the bottom edge', () => {
  // Without re-pinning after the height is recomputed, a shift-drag from the
  // north creeps the box downward on every frame of the gesture.
  const orig = box(0, 100, 100, 50)
  const r = resizeBox(orig, 'nw', -50, 0, { keepAspect: true })
  near(r.y + r.h, orig.y + orig.h, 'bottom edge drifted')
})

// ─── boundingBox / alignBoxes ────────────────────────────────────────────────

test('boundingBox spans every input', () => {
  assert.deepEqual(boundingBox([box(10, 10, 10, 10), box(50, 5, 20, 40)]), box(10, 5, 60, 40))
  assert.equal(boundingBox([]), null)
})

test('a single box aligns to the PAGE', () => {
  const page = box(0, 0, 1000, 500)
  assert.equal(alignBoxes([box(10, 10, 100, 50)], 'left', page)[0].x, 0)
  assert.equal(alignBoxes([box(10, 10, 100, 50)], 'right', page)[0].x, 900)
  assert.equal(alignBoxes([box(10, 10, 100, 50)], 'hcenter', page)[0].x, 450)
  assert.equal(alignBoxes([box(10, 10, 100, 50)], 'bottom', page)[0].y, 450)
  assert.equal(alignBoxes([box(10, 10, 100, 50)], 'vcenter', page)[0].y, 225)
})

test('several boxes align to their own bounding box, not the page', () => {
  const boxes = [box(100, 0, 50, 10), box(200, 0, 50, 10), box(400, 0, 50, 10)]
  const left = alignBoxes(boxes, 'left', box(0, 0, 1000, 500))
  for (const b of left) assert.equal(b.x, 100, 'aligned to the leftmost selected box')
  const right = alignBoxes(boxes, 'right', box(0, 0, 1000, 500))
  for (const b of right) assert.equal(b.x + b.w, 450, 'aligned to the rightmost edge')
})

test('alignBoxes preserves input order and leaves the other axis alone', () => {
  const boxes = [box(300, 7, 10, 10), box(100, 9, 10, 10)]
  const out = alignBoxes(boxes, 'left')
  assert.equal(out.length, 2)
  assert.equal(out[0].y, 7, 'y untouched')
  assert.equal(out[1].y, 9)
})

// ─── distributeBoxes ─────────────────────────────────────────────────────────
// Equal GAPS, not equal centres — with different-sized boxes, equal centres
// still read as uneven.

test('distributeBoxes equalises the gaps between differently sized boxes', () => {
  const boxes = [box(0, 0, 10, 5), box(30, 0, 50, 5), box(200, 0, 20, 5)]
  const out = distributeBoxes(boxes, 'h')
  const gap1 = out[1].x - (out[0].x + out[0].w)
  const gap2 = out[2].x - (out[1].x + out[1].w)
  near(gap1, gap2, 'gaps differ')
})

test('distributeBoxes never moves the outermost two', () => {
  const boxes = [box(0, 0, 10, 5), box(30, 0, 50, 5), box(200, 0, 20, 5)]
  const out = distributeBoxes(boxes, 'h')
  assert.equal(out[0].x, 0)
  assert.equal(out[2].x + out[2].w, 220)
})

test('distributeBoxes works on the vertical axis too', () => {
  const boxes = [box(0, 0, 5, 10), box(0, 30, 5, 50), box(0, 200, 5, 20)]
  const out = distributeBoxes(boxes, 'v')
  near(out[1].y - (out[0].y + out[0].h), out[2].y - (out[1].y + out[1].h))
})

test('distributeBoxes preserves INPUT order even when given unsorted boxes', () => {
  // The caller maps results back positionally; reordering would assign one
  // layer's new position to a different layer.
  const boxes = [box(200, 0, 20, 5), box(0, 0, 10, 5), box(30, 0, 50, 5)]
  const out = distributeBoxes(boxes, 'h')
  assert.equal(out.length, 3)
  assert.equal(out[0].w, 20, 'entry 0 is still the 20-wide box')
  assert.equal(out[1].w, 10)
  assert.equal(out[2].w, 50)
})

test('distributeBoxes leaves fewer than three boxes untouched', () => {
  const two = [box(0, 0, 10, 10), box(100, 0, 10, 10)]
  assert.deepEqual(distributeBoxes(two, 'h'), two)
  assert.deepEqual(distributeBoxes([], 'h'), [])
})

// ─── snapPosition ────────────────────────────────────────────────────────────

test('snapPosition snaps the leading edge to a nearby line', () => {
  const r = snapPosition(box(0, 0, 0.2, 0.1), 0.503, 0.4, { xs: [0.5], ys: [] }, 0.01)
  near(r.x, 0.5)
  assert.equal(r.guideX, 0.5)
  assert.equal(r.y, 0.4, 'the other axis is untouched')
  assert.equal(r.guideY, null)
})

test('snapPosition can snap by the CENTRE or the trailing edge', () => {
  // Centre: box is 0.2 wide, so a left edge of 0.4 centres on 0.5.
  const c = snapPosition(box(0, 0, 0.2, 0.1), 0.402, 0, { xs: [0.5] }, 0.01)
  near(c.x, 0.4)
  // Trailing edge: left 0.3 puts the right edge on 0.5.
  const t = snapPosition(box(0, 0, 0.2, 0.1), 0.298, 0, { xs: [0.5] }, 0.01)
  near(t.x, 0.3)
})

test('snapPosition ignores lines beyond the tolerance', () => {
  const r = snapPosition(box(0, 0, 0.2, 0.1), 0.4, 0.4, { xs: [0.9], ys: [0.9] }, 0.01)
  assert.equal(r.x, 0.4)
  assert.equal(r.guideX, null)
})

test('snapPosition prefers the closest of several candidates', () => {
  const r = snapPosition(box(0, 0, 0.2, 0.1), 0.5, 0, { xs: [0.49, 0.505, 0.4] }, 0.02)
  near(r.x, 0.505, 'should take the nearest line, not the first')
})

test('snapPosition handles no targets at all', () => {
  const r = snapPosition(box(0, 0, 0.2, 0.1), 0.33, 0.44, {}, 0.01)
  assert.deepEqual([r.x, r.y, r.guideX, r.guideY], [0.33, 0.44, null, null])
})

// ─── pickAtPoint ─────────────────────────────────────────────────────────────

const L = (id, x, y, w, h) => ({ id, x, y, w, h })

test('pickAtPoint returns nothing when the point is outside everything', () => {
  const r = pickAtPoint([L('a', 0, 0, 10, 10)], 50, 50, null)
  assert.equal(r.hit, null)
  assert.deepEqual(r.hits, [])
})

test('pickAtPoint prefers the SMALLEST box containing the point', () => {
  // The background covers everything; the click means the small thing on top.
  const layers = [L('bg', 0, 0, 1000, 1000), L('art', 90, 90, 40, 40)]
  assert.equal(pickAtPoint(layers, 100, 100, null).hit.id, 'art')
})

test('pickAtPoint cycles down the stack on a repeat click at the same spot', () => {
  const layers = [L('bg', 0, 0, 1000, 1000), L('mid', 50, 50, 200, 200), L('art', 90, 90, 40, 40)]
  const first = pickAtPoint(layers, 100, 100, null)
  assert.equal(first.hit.id, 'art')
  const second = pickAtPoint(layers, 100, 100, { x: 100, y: 100, index: first.index })
  assert.equal(second.hit.id, 'mid')
  const third = pickAtPoint(layers, 100, 100, { x: 100, y: 100, index: second.index })
  assert.equal(third.hit.id, 'bg')
  // …and wraps back round rather than getting stuck at the bottom.
  const fourth = pickAtPoint(layers, 100, 100, { x: 100, y: 100, index: third.index })
  assert.equal(fourth.hit.id, 'art')
})

test('pickAtPoint restarts at the top when the click moves elsewhere', () => {
  const layers = [L('bg', 0, 0, 1000, 1000), L('art', 90, 90, 40, 40)]
  const r = pickAtPoint(layers, 100, 100, { x: 900, y: 900, index: 1 })
  assert.equal(r.hit.id, 'art', 'a click somewhere else is a fresh pick')
})

test('pickAtPoint treats a near-identical point as the same spot', () => {
  const layers = [L('bg', 0, 0, 1000, 1000), L('art', 90, 90, 40, 40)]
  const r = pickAtPoint(layers, 101, 101, { x: 100, y: 100, index: 0 }, 5)
  assert.equal(r.hit.id, 'bg', 'a 1px wobble should still cycle, not reset')
})
