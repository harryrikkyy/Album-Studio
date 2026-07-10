'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const g = require('../src/ipc_guards')

test('reqString enforces type, emptiness, bounds, and NUL bytes', () => {
  assert.equal(g.reqString('ok', 'x', 'ch'), 'ok')
  assert.throws(() => g.reqString(42, 'x', 'ch'), /\[ipc:ch\] x must be a string/)
  assert.throws(() => g.reqString('', 'x', 'ch'), /must not be empty/)
  assert.equal(g.reqString('', 'x', 'ch', { allowEmpty: true }), '')
  assert.throws(() => g.reqString('a'.repeat(11), 'x', 'ch', { max: 10 }), /exceeds 10/)
  assert.throws(() => g.reqString('a\0b', 'x', 'ch'), /NUL/)
})

test('reqAbsPath normalizes and rejects relative paths', () => {
  assert.equal(g.reqAbsPath('/a/b/../c', 'x', 'ch'), '/a/c')
  assert.throws(() => g.reqAbsPath('relative/path', 'x', 'ch'), /absolute/)
  assert.throws(() => g.reqAbsPath('../../etc/passwd', 'x', 'ch'), /absolute/)
  assert.throws(() => g.reqAbsPath(null, 'x', 'ch'), /string/)
})

test('reqBaseName rejects separators and traversal', () => {
  assert.equal(g.reqBaseName('photo.jpg', 'x', 'ch'), 'photo.jpg')
  assert.throws(() => g.reqBaseName('../evil.jpg', 'x', 'ch'), /bare file name/)
  assert.throws(() => g.reqBaseName('a/b.jpg', 'x', 'ch'), /bare file name/)
  assert.throws(() => g.reqBaseName('..', 'x', 'ch'), /bare file name/)
  assert.throws(() => g.reqBaseName('.', 'x', 'ch'), /bare file name/)
})

test('reqNumber enforces finiteness and range', () => {
  assert.equal(g.reqNumber(5, 'x', 'ch', { min: 0, max: 10 }), 5)
  assert.throws(() => g.reqNumber('5', 'x', 'ch'), /finite number/)
  assert.throws(() => g.reqNumber(NaN, 'x', 'ch'), /finite number/)
  assert.throws(() => g.reqNumber(Infinity, 'x', 'ch'), /finite number/)
  assert.throws(() => g.reqNumber(-1, 'x', 'ch', { min: 0 }), /≥ 0/)
  assert.throws(() => g.reqNumber(11, 'x', 'ch', { max: 10 }), /≤ 10/)
})

test('reqObject accepts plain objects only', () => {
  const o = { a: 1 }
  assert.equal(g.reqObject(o, 'x', 'ch'), o)
  for (const bad of [null, [], 'str', 42, undefined]) {
    assert.throws(() => g.reqObject(bad, 'x', 'ch'), /must be an object/)
  }
})

test('reqArray bounds length; reqEnum whitelists values', () => {
  assert.deepEqual(g.reqArray([1], 'x', 'ch'), [1])
  assert.throws(() => g.reqArray({}, 'x', 'ch'), /array/)
  assert.throws(() => g.reqArray([1, 2, 3], 'x', 'ch', { max: 2 }), /exceeds 2 items/)
  assert.equal(g.reqEnum('all', 'x', 'ch', ['active', 'all']), 'all')
  assert.throws(() => g.reqEnum('other', 'x', 'ch', ['active', 'all']), /one of active, all/)
})
