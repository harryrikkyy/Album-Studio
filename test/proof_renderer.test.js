'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { applyAdjust } = require('../src/proof_renderer')

// A minimal sharp-pipeline stand-in that records the ops applied to it. Each
// op returns `this` so the fluent chain works, exactly like a real sharp
// pipeline — but nothing decodes an image.
function mockPipeline() {
  const calls = []
  const pipe = {
    calls,
    modulate(arg) { calls.push(['modulate', arg]); return pipe },
    linear(slopes, inter) { calls.push(['linear', slopes, inter]); return pipe },
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
