'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Never read or modify a customer's saved licence during a regression test.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-license-test-'))
process.env.CH_LICENSE_FILE = path.join(dir, 'license.json')
process.env.LICENSE_SECRET_KEY = 'isolated-test-license-key'
const { getDaysRemaining, saveLicense, loadLicense, validateOfflineLicense, clearLicense } = require('../src/license')
test.after(() => { clearLicense(); fs.rmdirSync(dir) })

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

test('malformed or nonfinite expiry dates report zero remaining days', () => {
  for (const expiry of ['invalid date', '', undefined, Number.NaN, Infinity, -Infinity, '2026-99-99T00:00:00Z']) {
    assert.equal(getDaysRemaining(expiry), 0, `expiry ${String(expiry)} must fail closed`)
  }
})

test('legacy offline licences with malformed expiry cannot grant access', () => {
  for (const expiresOn of ['invalid date', '', undefined, '2026-99-99T00:00:00Z']) {
    saveLicense({ email: 'ana@studio.in', name: 'Ana Rao', machineId: 'machine-A', expiresOn, activatedOn: new Date().toISOString() })
    assert.ok(loadLicense(), 'the saved checksum remains compatible; validation must enforce expiry')
    assert.deepEqual(validateOfflineLicense('machine-A', 'ana@studio.in'), { allowed: false, reason: 'expired' })
    assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
  }
})

test('valid legacy licences retain machine, account and whole-day offline policy', () => {
  const write = (expiresOn) => saveLicense({ email: 'ana@studio.in', name: 'Ana Rao', machineId: 'machine-A', expiresOn, activatedOn: new Date().toISOString() })
  write(new Date(Date.now() + 30 * DAY).toISOString())
  assert.deepEqual(validateOfflineLicense('machine-B', 'ana@studio.in'), { allowed: false, reason: 'wrong_machine' })
  assert.deepEqual(validateOfflineLicense('machine-A', 'other@studio.in'), { allowed: false, reason: 'wrong_account' })
  const valid = validateOfflineLicense('machine-A', 'ana@studio.in')
  assert.equal(valid.allowed, true)
  assert.equal(valid.offline, true)
  assert.ok(Number.isFinite(valid.daysLeft) && valid.daysLeft >= 29)
  write(new Date(Date.now() + DAY / 2).toISOString())
  assert.deepEqual(validateOfflineLicense('machine-A', 'ana@studio.in'), { allowed: false, reason: 'expired' })
})
