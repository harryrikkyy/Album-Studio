'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')

const { signLicense, verifyLicenseSignature, canonicalLicenseBytes, SIGNED_FIELDS } =
  require('../src/license_signing')

const keys = () => crypto.generateKeyPairSync('ed25519')

const LICENSE = {
  email: 'customer@example.com',
  name: 'Customer',
  machineId: 'abc123',
  expiresOn: '2027-01-01T00:00:00.000Z',
  activatedOn: '2026-07-11T00:00:00.000Z',
}

test('sign → verify round-trips with the matching public key', () => {
  const { publicKey, privateKey } = keys()
  const sig = signLicense(LICENSE, privateKey)
  assert.equal(verifyLicenseSignature(LICENSE, sig, publicKey), true)
})

test('any tampered signed field invalidates the signature', () => {
  const { publicKey, privateKey } = keys()
  const sig = signLicense(LICENSE, privateKey)
  for (const field of SIGNED_FIELDS) {
    const tampered = { ...LICENSE, [field]: 'changed' }
    assert.equal(verifyLicenseSignature(tampered, sig, publicKey), false, field)
  }
  // Especially the one that matters commercially:
  const extended = { ...LICENSE, expiresOn: '2099-01-01T00:00:00.000Z' }
  assert.equal(verifyLicenseSignature(extended, sig, publicKey), false)
})

test('unsigned bookkeeping fields (savedAt) do not affect verification', () => {
  const { publicKey, privateKey } = keys()
  const sig = signLicense(LICENSE, privateKey)
  assert.equal(verifyLicenseSignature({ ...LICENSE, savedAt: 'whenever' }, sig, publicKey), true)
})

test('a signature from a different key is rejected', () => {
  const { privateKey } = keys()
  const other = keys()
  const sig = signLicense(LICENSE, privateKey)
  assert.equal(verifyLicenseSignature(LICENSE, sig, other.publicKey), false)
})

test('malformed signatures are invalid, never throw', () => {
  const { publicKey } = keys()
  assert.equal(verifyLicenseSignature(LICENSE, 'not base64!!!', publicKey), false)
  assert.equal(verifyLicenseSignature(LICENSE, '', publicKey), false)
})

test('canonical bytes are stable regardless of input key order', () => {
  const shuffled = { name: LICENSE.name, expiresOn: LICENSE.expiresOn, email: LICENSE.email,
    activatedOn: LICENSE.activatedOn, machineId: LICENSE.machineId }
  assert.deepEqual(canonicalLicenseBytes(shuffled), canonicalLicenseBytes(LICENSE))
  // Missing fields canonicalize to null (matches the server's normalization).
  const noName = { ...LICENSE }
  delete noName.name
  assert.match(canonicalLicenseBytes(noName).toString(), /"name":null/)
})
