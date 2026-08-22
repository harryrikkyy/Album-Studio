'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { dockRect } = require('../src/tools_bar_geometry')

// The two display layouts that matter on this machine: the primary at the
// origin, and a second display to its LEFT with a negative x origin.
const PRIMARY = { x: 0, y: 25, width: 1920, height: 1175 }      // menu bar excluded
const LEFT_DISPLAY = { x: -1920, y: 0, width: 1920, height: 1200 }

const BAR = { barHeight: 44 }
const bottomOf = (r) => r.y + r.height
const rightOf = (r) => r.x + r.width

// ─── the normal case ─────────────────────────────────────────────────────────

test('a floating window gets the bar docked directly beneath it', () => {
  const ps = { x: 200, y: 100, w: 1000, h: 600 }
  const r = dockRect(ps, PRIMARY, BAR)
  assert.equal(r.x, 200, 'matches PS x')
  assert.equal(r.width, 1000, 'matches PS width')
  assert.equal(r.y, 700, 'top edge sits on PS bottom edge')
  assert.equal(r.height, 44)
})

test('an open dropdown grows the window upward, not the bar downward', () => {
  const ps = { x: 0, y: 100, w: 800, h: 400 }
  const plain = dockRect(ps, PRIMARY, BAR)
  const open = dockRect(ps, PRIMARY, { barHeight: 44, expansionPx: 160 })
  assert.equal(open.height, 204, 'window is bar + expansion')
  // The bar strip itself must not move: its top edge is `y + expansionPx`.
  assert.equal(open.y + 160, plain.y, 'the bar strip stayed where it was')
})

// ─── the reported bug: a maximised Photoshop ─────────────────────────────────

test('a full-height Photoshop overlays the bar on its bottom strip', () => {
  // PS filling the work area: there is no room underneath it at all.
  const ps = { x: 0, y: 25, w: 1920, h: 1175 }
  const r = dockRect(ps, PRIMARY, BAR)
  assert.equal(bottomOf(r), bottomOf(PRIMARY), 'bar bottom is flush with PS bottom')
  assert.equal(r.y, 1156, 'bar overlays the last 44px of PS')
})

test('a full-height Photoshop never puts the bar above its top edge', () => {
  // The old behaviour flipped to `ps.y - totalH` = -19, i.e. under the menu
  // bar and partly off-screen. That is the regression this guards.
  const ps = { x: 0, y: 25, w: 1920, h: 1175 }
  const r = dockRect(ps, PRIMARY, BAR)
  assert.ok(r.y >= PRIMARY.y, `bar must not go above the work area (got y=${r.y})`)
  assert.ok(r.y > ps.y, 'bar must not jump above Photoshop')
})

test('the bar always lands wholly inside the work area', () => {
  const cases = [
    { x: 0, y: 25, w: 1920, h: 1175 },     // maximised
    { x: 0, y: 25, w: 1920, h: 2000 },     // taller than the screen
    { x: 100, y: 1100, w: 600, h: 400 },   // hanging off the bottom
    { x: 100, y: -300, w: 600, h: 400 },   // hanging off the top
  ]
  for (const ps of cases) {
    const r = dockRect(ps, PRIMARY, { barHeight: 44, expansionPx: 120 })
    assert.ok(r.y >= PRIMARY.y, `top inside for ${JSON.stringify(ps)}`)
    assert.ok(bottomOf(r) <= bottomOf(PRIMARY), `bottom inside for ${JSON.stringify(ps)}`)
    assert.ok(r.x >= PRIMARY.x, `left inside for ${JSON.stringify(ps)}`)
    assert.ok(rightOf(r) <= rightOf(PRIMARY), `right inside for ${JSON.stringify(ps)}`)
  }
})

// ─── the negative-origin display ─────────────────────────────────────────────

test('Photoshop on a left-hand display keeps the bar on that display', () => {
  const ps = { x: -1700, y: 100, w: 1200, h: 800 }
  const r = dockRect(ps, LEFT_DISPLAY, BAR)
  assert.equal(r.x, -1700, 'negative origin is preserved, not clamped to 0')
  assert.equal(r.width, 1200)
  assert.ok(r.x >= LEFT_DISPLAY.x && rightOf(r) <= rightOf(LEFT_DISPLAY))
})

test('a window hanging off the left edge is trimmed, not shifted', () => {
  // PS starts 200px left of the display; the bar starts at the display edge
  // and loses that 200px of width so its right edge still tracks PS.
  const ps = { x: -2120, y: 100, w: 1200, h: 800 }
  const r = dockRect(ps, LEFT_DISPLAY, BAR)
  assert.equal(r.x, -1920, 'clamped to the display edge')
  assert.equal(r.width, 1000, 'width trimmed by the overhang')
  assert.equal(rightOf(r), rightOf({ x: -2120, width: 1200 }), 'right edge still tracks PS')
})

test('a window hanging off the right edge is trimmed to the display', () => {
  const ps = { x: 1500, y: 100, w: 1000, h: 500 }
  const r = dockRect(ps, PRIMARY, BAR)
  assert.equal(r.x, 1500)
  assert.equal(rightOf(r), rightOf(PRIMARY), 'stops at the display edge')
})

// ─── degenerate widths ───────────────────────────────────────────────────────

test('a very narrow Photoshop still yields a usable bar', () => {
  const ps = { x: 500, y: 100, w: 40, h: 400 }
  const r = dockRect(ps, PRIMARY, BAR)
  assert.ok(r.width >= 200, 'floor applied')
  assert.ok(rightOf(r) <= rightOf(PRIMARY), 'the floor did not push it off-screen')
})

test('the width floor cannot push the bar off the right edge', () => {
  const ps = { x: 1900, y: 100, w: 10, h: 400 }
  const r = dockRect(ps, PRIMARY, BAR)
  assert.ok(r.width >= 200)
  assert.ok(rightOf(r) <= rightOf(PRIMARY), `right edge ${rightOf(r)} must stay on screen`)
  assert.ok(r.x >= PRIMARY.x)
})
