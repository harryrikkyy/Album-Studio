import test from 'node:test'
import assert from 'node:assert/strict'
import { canDeliver } from '../src/delivery_logic.ts'

test('whole-album delivery blocks missing, blocked and unknown states', () => {
  const kinds = { jpegs: true, pdf: true }
  for (const bad of ['nosheet', 'blocked', 'unknown']) assert.equal(canDeliver(['ready', bad], kinds), false)
  assert.equal(canDeliver(['ready', 'todo', 'stale'], kinds), true)
})
test('PDF-only requires every review JPEG to be current', () => {
  const kinds = { jpegs: false, pdf: true }
  assert.equal(canDeliver(['ready', 'ready'], kinds), true)
  for (const state of ['todo', 'stale', 'nosheet', 'blocked']) assert.equal(canDeliver(['ready', state], kinds), false)
})
test('loading, empty selection and an active heavy job cannot start delivery', () => {
  const kinds = { jpegs: true, pdf: true }
  assert.equal(canDeliver(null, kinds), false)
  assert.equal(canDeliver([], kinds), false)
  assert.equal(canDeliver(['ready'], { jpegs: false, pdf: false }), false)
  assert.equal(canDeliver(['ready'], kinds, true), false)
  assert.equal(canDeliver(['ready'], kinds, false, true), false)
})
