'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Never read or modify a customer's saved licence during a regression test.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-license-test-'))
process.env.CH_LICENSE_FILE = path.join(dir, 'license.json')
const { getDaysRemaining, licenseFromRecord, saveLicense, loadLicense, validateOfflineLicense, clearLicense, _usePublicKey } = require('../src/license')
const { signLicense } = require('../src/license_signing')
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
_usePublicKey(publicKey)
test.after(() => { clearLicense(); fs.rmdirSync(dir) })

const DAY = 24 * 60 * 60 * 1000
function saveSigned(expiresOn, key = privateKey) {
  const fields = { email: 'ana@studio.in', name: 'Ana Rao', expiresOn, activatedOn: new Date().toISOString() }
  return saveLicense({ ...fields, machineId: 'machine-A', sig: signLicense(fields, key) })
}

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

test('signed offline licences with malformed expiry cannot grant access', () => {
  for (const expiresOn of ['invalid date', '', undefined, '2026-99-99T00:00:00Z']) {
    saveSigned(expiresOn)
    assert.ok(loadLicense(), 'the signature verifies; validation must enforce expiry')
    assert.deepEqual(validateOfflineLicense('machine-A', 'ana@studio.in'), { allowed: false, reason: 'expired' })
    assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
  }
})

test('a licence forged with the secret older builds shipped never grants offline access', () => {
  const data = { email: 'ana@studio.in', name: 'Ana Rao', machineId: 'machine-A', expiresOn: new Date(Date.now() + 3650 * DAY).toISOString(), activatedOn: new Date().toISOString(), savedAt: new Date().toISOString() }
  const checksum = crypto.createHmac('sha256', 'CH-TOOLKIT-PRO-2025-SECRET').update(JSON.stringify(data)).digest('hex')
  fs.writeFileSync(process.env.CH_LICENSE_FILE, JSON.stringify({ ...data, checksum }))
  assert.equal(loadLicense(), null)
  assert.deepEqual(validateOfflineLicense('machine-A', 'ana@studio.in'), { allowed: false, reason: 'no_internet' })
})

test('only a signature from the bundled key, over the saved fields, verifies', () => {
  saveSigned(new Date(Date.now() + 30 * DAY).toISOString(), crypto.generateKeyPairSync('ed25519').privateKey)
  assert.equal(loadLicense(), null, 'another key pair signed it')
  saveSigned(new Date(Date.now() + 30 * DAY).toISOString())
  const saved = JSON.parse(fs.readFileSync(process.env.CH_LICENSE_FILE, 'utf8'))
  fs.writeFileSync(process.env.CH_LICENSE_FILE, JSON.stringify({ ...saved, expiresOn: new Date(Date.now() + 3650 * DAY).toISOString() }))
  assert.equal(loadLicense(), null, 'its expiry was extended after signing')
})

test('saving an unsigned licence keeps no offline access and removes the saved one', () => {
  saveSigned(new Date(Date.now() + 30 * DAY).toISOString())
  assert.equal(saveLicense({ email: 'ana@studio.in', name: 'Ana Rao', machineId: 'machine-A', expiresOn: new Date(Date.now() + 30 * DAY).toISOString(), activatedOn: new Date().toISOString() }), false)
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
})

test('valid signed licences retain machine, account and whole-day offline policy', () => {
  const write = saveSigned
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

test('a record renamed after signing still opens offline: the signed name is kept in licName', () => {
  for (const [signedName, nameNow] of [['Ana Rao', 'Ana Mehta'], ['', 'Ana Rao']]) {
    const expiresOn = new Date(Date.now() + 30 * DAY).toISOString(), activatedOn = new Date().toISOString()
    const signed = { email: 'ana@studio.in', name: signedName, expiresOn, activatedOn }
    // The record as the admin panel left it, after a sign-in rewrote `name` with the Google name.
    const record = {
      email: { stringValue: signed.email }, name: { stringValue: nameNow }, licName: { stringValue: signedName },
      licExpiresOn: { stringValue: expiresOn }, licActivatedOn: { stringValue: activatedOn }, sig: { stringValue: signLicense(signed, privateKey) },
    }
    saveLicense(licenseFromRecord(record, 'ana@studio.in', 'machine-A'))
    assert.equal(validateOfflineLicense('machine-A', 'ana@studio.in').allowed, true, `signed as "${signedName}", now "${nameNow}"`)
  }
})
