'use strict'

// End-to-end contract between the owner's admin panel (which signs) and the
// desktop app (which verifies offline). This guards the two alignment traps
// that would otherwise lock out paying customers:
//   1. The panel signs only the fields it knows at activation time — machineId
//      is NOT among them (the device binds later), so moving devices must not
//      break the signature.
//   2. The panel stores the exact signed date-strings and the app saves those
//      same strings, so timestamp formatting can never drift the signature.

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')

const { signLicense, verifyLicenseSignature } = require('../src/license_signing')

test('panel-signed license verifies in the app after the device binds', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')

  // 1. Admin panel at activation time — fields it fully controls, as strings.
  const activatedOn = new Date().toISOString()
  const expiresOn = new Date(Date.now() + 365 * 864e5).toISOString()
  const signed = { email: 'buyer@example.com', name: 'Buyer', expiresOn, activatedOn }
  const sig = signLicense(signed, privateKey) // machineId intentionally absent

  // 2. Desktop app (saveLicense) — same signed strings, plus the now-bound
  //    device and local bookkeeping. Must verify.
  const savedLocally = {
    email: 'buyer@example.com',
    name: 'Buyer',
    expiresOn,
    activatedOn,
    machineId: 'device-bound-after-activation',
    savedAt: new Date().toISOString(),
  }
  assert.equal(verifyLicenseSignature(savedLocally, sig, publicKey), true)

  // 3. Machine move is allowed by the signature (machineId unsigned)…
  assert.equal(verifyLicenseSignature({ ...savedLocally, machineId: 'another-device' }, sig, publicKey), true)
  // …but forging a longer expiry is rejected…
  assert.equal(verifyLicenseSignature({ ...savedLocally, expiresOn: '2099-01-01T00:00:00.000Z' }, sig, publicKey), false)
  // …and so is reusing it under a different account.
  assert.equal(verifyLicenseSignature({ ...savedLocally, email: 'pirate@example.com' }, sig, publicKey), false)
})
