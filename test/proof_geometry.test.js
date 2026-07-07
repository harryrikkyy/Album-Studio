'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { proofDims, partitionFrames } = require('../src/proof_renderer')

test('proofDims: no upscaling when canvas already within maxEdge', () => {
  const d = proofDims(1000, 800, 1500)
  assert.deepEqual(d, { width: 1000, height: 800, scale: 1 })
})

test('proofDims: scales the longest edge down to maxEdge, preserving aspect', () => {
  const d = proofDims(3000, 2000, 1500)
  assert.equal(d.width, 1500)
  assert.equal(d.height, 1000)
  assert.equal(d.scale, 0.5)
})

test('proofDims: portrait uses height as the longest edge', () => {
  const d = proofDims(2000, 4000, 1000)
  assert.equal(d.height, 1000)
  assert.equal(d.width, 500)
  assert.equal(d.scale, 0.25)
})

test('proofDims: rounds fractional dimensions to whole pixels', () => {
  const d = proofDims(1333, 1000, 1000)
  assert.ok(Number.isInteger(d.width))
  assert.ok(Number.isInteger(d.height))
  assert.equal(d.height, 750)
})

test('partitionFrames: splits h/v by the layer-name convention', () => {
  const { h, v } = partitionFrames([
    { name: 'toolkitvframe1' },
    { name: 'toolkithframe1' },
    { name: 'toolkithframe2' },
  ])
  assert.deepEqual(h.map((f) => f.name), ['toolkithframe1', 'toolkithframe2'])
  assert.deepEqual(v.map((f) => f.name), ['toolkitvframe1'])
})

test('partitionFrames: sorts by name so placement order is deterministic', () => {
  const { h } = partitionFrames([
    { name: 'toolkithframe10' },
    { name: 'toolkithframe2' },
    { name: 'toolkithframe1' },
  ])
  // localeCompare string sort (matches build_page.jsx): "1","10","2"
  assert.deepEqual(h.map((f) => f.name), [
    'toolkithframe1',
    'toolkithframe10',
    'toolkithframe2',
  ])
})

test('partitionFrames: is case-insensitive and ignores non-toolkit layers', () => {
  const { h, v } = partitionFrames([
    { name: 'ToolkitHFrame1' },
    { name: 'background' },
    { name: 'TOOLKITVFRAME1' },
  ])
  assert.equal(h.length, 1)
  assert.equal(v.length, 1)
})

test('partitionFrames: does not mutate its input array', () => {
  const input = [{ name: 'toolkithframe2' }, { name: 'toolkithframe1' }]
  const snapshot = input.map((f) => f.name)
  partitionFrames(input)
  assert.deepEqual(input.map((f) => f.name), snapshot)
})
