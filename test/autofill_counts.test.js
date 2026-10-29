'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { planAutoFillCounts } = require('../src/autofill_counts')

test('planAutoFillCounts places every photo exactly once — range mode', () => {
  for (const total of [1, 5, 17, 100, 999]) {
    const r = planAutoFillCounts(total, { mode: 'range', min: 4, max: 6 })
    assert.equal(r.error, null)
    assert.equal(
      r.counts.reduce((a, b) => a + b, 0),
      total,
      `total ${total}`,
    )
  }
})

test('planAutoFillCounts keeps range counts within bounds, bar the remainder', () => {
  const r = planAutoFillCounts(100, { mode: 'range', min: 4, max: 6 })
  const body = r.counts.slice(0, -1)
  for (const c of body) assert.ok(c >= 4 && c <= 6, `count ${c} outside 4..6`)
  assert.ok(r.counts[r.counts.length - 1] <= 6, 'last page takes what is left')
})

test('planAutoFillCounts spreads evenly across exactly N sheets — desired mode', () => {
  const r = planAutoFillCounts(100, { mode: 'desired', desiredSheets: 8 })
  assert.equal(r.counts.length, 8)
  assert.equal(
    r.counts.reduce((a, b) => a + b, 0),
    100,
  )
  // 100/8 = 12.5, so every sheet is 12 or 13 and never further apart.
  assert.ok(Math.max(...r.counts) - Math.min(...r.counts) <= 1, 'sheets differ by at most one')
})

test('planAutoFillCounts caps sheets at the photo count', () => {
  const r = planAutoFillCounts(3, { mode: 'desired', desiredSheets: 40 })
  assert.equal(r.counts.length, 3, 'no empty sheets')
  assert.equal(r.cappedTo, 3, 'and it says so, so the UI can tell the user')
  assert.deepEqual(r.counts, [1, 1, 1])
})

test('planAutoFillCounts divides exactly when it can', () => {
  const r = planAutoFillCounts(24, { mode: 'desired', desiredSheets: 6 })
  assert.deepEqual(r.counts, [4, 4, 4, 4, 4, 4])
  assert.equal(r.cappedTo, null)
})

test('the desired-mode remainder is spread, not front-loaded', () => {
  // Deterministic rng that reverses the shuffle, so the +1 lands on the LAST
  // sheets. Front-loading was the behaviour this shuffle exists to avoid.
  const r = planAutoFillCounts(10, { mode: 'desired', desiredSheets: 4 }, () => 0.999999)
  assert.equal(
    r.counts.reduce((a, b) => a + b, 0),
    10,
  )
  assert.equal(r.counts.filter((c) => c === 3).length, 2, 'two sheets get the +1')
})

test('planAutoFillCounts refuses min=max=0 instead of looping forever', () => {
  const r = planAutoFillCounts(50, { mode: 'range', min: 0, max: 0 })
  assert.deepEqual(r.counts, [])
  assert.match(r.error, /at least 1/)
})

test('planAutoFillCounts survives a zero minimum with a usable maximum', () => {
  const r = planAutoFillCounts(50, { mode: 'range', min: 0, max: 5 })
  assert.equal(r.error, null)
  assert.equal(
    r.counts.reduce((a, b) => a + b, 0),
    50,
  )
  for (const c of r.counts) assert.ok(c >= 1, 'a page never takes zero photos')
})

test('planAutoFillCounts rejects negative bounds rather than growing `remaining`', () => {
  const r = planAutoFillCounts(50, { mode: 'range', min: -5, max: -1 })
  assert.deepEqual(r.counts, [])
  assert.ok(r.error)
})

test('planAutoFillCounts terminates even with a hostile rng', () => {
  // An rng pinned at 0 would make every draw the minimum; pinned at 1, the
  // maximum. Neither may stall the loop.
  for (const rng of [() => 0, () => 1, () => NaN]) {
    const r = planAutoFillCounts(37, { mode: 'range', min: 1, max: 5 }, rng)
    assert.equal(
      r.counts.reduce((a, b) => a + b, 0),
      37,
    )
  }
})

test('planAutoFillCounts reports bad input instead of guessing', () => {
  assert.match(planAutoFillCounts(0, { mode: 'range', min: 1, max: 5 }).error, /No photos/)
  assert.match(planAutoFillCounts(10, { mode: 'range', min: 9, max: 2 }).error, /Invalid/)
  assert.match(planAutoFillCounts(10, { mode: 'desired', desiredSheets: 0 }).error, /desired sheets/)
  assert.match(planAutoFillCounts(10, { mode: 'desired', desiredSheets: NaN }).error, /desired sheets/)
})
