// @ts-check
// autofill_counts.js: how many photos each page takes in an Auto-Fill run, the Electron app's
// tested counting reused by the backend's whole-album planner.
'use strict'

/**
 * Decide how many photos land on each page in an Auto-Fill run.
 *
 * Two modes:
 *   desired — spread ALL photos across exactly N sheets. Every sheet gets
 *             floor(total/N); the remainder is handed out one-per-sheet to a
 *             shuffled subset, so the heavy pages aren't always the first few.
 *   range   — take a random count in [min, max] per page until photos run out.
 *
 * `rng` is injectable purely so the distribution can be tested deterministically.
 *
 * Guarantees, whatever the input: the counts sum to exactly `total` (no photo
 * lost or placed twice) and the function always terminates. The previous
 * inline version did neither — min = max = 0 passed validation (0 > 0 is
 * false), pushed a 0 forever and never decremented the remaining count, so
 * the app hung and the array grew until it ran out of memory. Negative values
 * were worse: `remaining` grew.
 *
 * @param {number} total  photos available to place
 * @param {{ mode?: 'desired'|'range', desiredSheets?: number, min?: number, max?: number }} opts
 * @param {() => number} [rng]
 * @returns {{ counts: number[], cappedTo: number|null, error: string|null }}
 */
function planAutoFillCounts(total, opts, rng = Math.random) {
  const n = Math.floor(Number(total) || 0)
  if (n <= 0) return { counts: [], cappedTo: null, error: 'No photos available to place.' }
  return opts && opts.mode === 'desired' ? desiredCounts(n, opts.desiredSheets, rng) : rangeCounts(n, opts, rng)
}

/**
 * Desired mode: all `n` photos across exactly `desiredSheets` sheets.
 * @param {number} n @param {number | undefined} desiredSheets @param {() => number} rng
 * @returns {{ counts: number[], cappedTo: number|null, error: string|null }}
 */
function desiredCounts(n, desiredSheets, rng) {
  const want = Math.floor(Number(desiredSheets))
  if (!Number.isFinite(want) || want < 1) {
    return { counts: [], cappedTo: null, error: 'Enter a valid number of desired sheets (1 or more).' }
  }
  // Never more sheets than photos — an empty sheet helps nobody.
  const sheets = Math.min(want, n)
  const base = Math.floor(n / sheets)
  const remainder = n - base * sheets

  const order = Array.from({ length: sheets }, (_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    // Fisher–Yates
    const j = Math.floor(rng() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  const bonus = new Set(order.slice(0, remainder))
  const counts = []
  for (let i = 0; i < sheets; i++) counts.push(base + (bonus.has(i) ? 1 : 0))
  return { counts, cappedTo: sheets < want ? sheets : null, error: null }
}

/**
 * Range mode: a random count in [min, max] per page until all `n` photos are placed.
 * @param {number} n @param {{ min?: number, max?: number } | undefined} opts @param {() => number} rng
 * @returns {{ counts: number[], cappedTo: number|null, error: string|null }}
 */
function rangeCounts(n, opts, rng) {
  const min = Math.floor(Number(opts && opts.min))
  const max = Math.floor(Number(opts && opts.max))
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    return { counts: [], cappedTo: null, error: 'Invalid Min/Max values.' }
  }
  // A page must take at least one photo, or the loop below cannot converge.
  if (max < 1) {
    return { counts: [], cappedTo: null, error: 'Max photos per page must be at least 1.' }
  }
  const lo = Math.max(1, min)

  const counts = []
  let remaining = n
  while (remaining > 0) {
    let take = Math.floor(rng() * (max - lo + 1)) + lo
    // Belt and braces: even a misbehaving rng cannot stall this loop.
    if (!Number.isFinite(take) || take < 1) take = 1
    if (take > remaining) take = remaining
    counts.push(take)
    remaining -= take
  }
  return { counts, cappedTo: null, error: null }
}

module.exports = { planAutoFillCounts }
