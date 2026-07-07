'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { getDaysRemaining } = require('../src/license')

const DAY = 24 * 60 * 60 * 1000

test('getDaysRemaining floors whole days until expiry', () => {
  const in3Days = new Date(Date.now() + 3 * DAY + 60 * 1000).toISOString()
  assert.equal(getDaysRemaining(in3Days), 3)
})

test('getDaysRemaining returns 0 for an already-expired date (no phantom day)', () => {
  const yesterday = new Date(Date.now() - DAY).toISOString()
  assert.equal(getDaysRemaining(yesterday), 0)
})

test('getDaysRemaining returns 0 exactly at expiry', () => {
  assert.equal(getDaysRemaining(new Date(Date.now()).toISOString()), 0)
})
