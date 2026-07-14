// @ts-check
// license_signing.js — Ed25519 license signatures, shared by the app
// (verification with the bundled PUBLIC key) and server/ (signing with the
// private key, which never ships). Replaces the HMAC checksum, whose secret
// had to ship inside the app and was therefore forgeable by construction.

const crypto = require('crypto')

// The exact fields covered by a signature, in canonical order. savedAt and
// other local bookkeeping are deliberately NOT signed. machineId is also NOT
// signed: at activation time the customer's device is not bound yet, so the
// signer cannot know it. Machine-lock is still enforced separately — the app
// compares the saved machineId to the current device, and Firestore holds the
// authoritative binding — it just is not part of the cryptographic proof.
const SIGNED_FIELDS = /** @type {const} */ (['activatedOn', 'email', 'expiresOn', 'name'])

/**
 * Canonical byte representation of a license: the signed fields only, in
 * fixed key order, so signer and verifier can never disagree on layout.
 * @param {Record<string, any>} data
 */
function canonicalLicenseBytes(data) {
  /** @type {Record<string, any>} */
  const subset = {}
  for (const k of SIGNED_FIELDS) subset[k] = data[k] === undefined ? null : data[k]
  return Buffer.from(JSON.stringify(subset), 'utf8')
}

/**
 * Sign a license payload. Returns the base64 signature.
 * @param {Record<string, any>} data
 * @param {string | crypto.KeyObject} privateKey  PEM or KeyObject (Ed25519)
 */
function signLicense(data, privateKey) {
  return crypto.sign(null, canonicalLicenseBytes(data), privateKey).toString('base64')
}

/**
 * Verify a license signature. Never throws — malformed input is just invalid.
 * @param {Record<string, any>} data
 * @param {string} signatureB64
 * @param {string | crypto.KeyObject} publicKey  PEM or KeyObject (Ed25519)
 */
function verifyLicenseSignature(data, signatureB64, publicKey) {
  try {
    return crypto.verify(null, canonicalLicenseBytes(data), publicKey, Buffer.from(signatureB64, 'base64'))
  } catch (_) {
    return false
  }
}

module.exports = { SIGNED_FIELDS, canonicalLicenseBytes, signLicense, verifyLicenseSignature }
