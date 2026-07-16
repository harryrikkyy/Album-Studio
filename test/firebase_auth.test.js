'use strict'

// Unit tests for the pure logic of the Firebase Auth session module: token
// response mapping, expiry math, and refresh-token persistence. The live
// network exchanges (signInWithIdp / securetoken) need a real Google login and
// are validated by signing into the running app.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Point persistence at a temp file BEFORE requiring the module.
const TMP = path.join(os.tmpdir(), `ch_session_test_${process.pid}`)
process.env.CH_SESSION_FILE = TMP

const auth = require('../src/firebase_auth')

test.after(() => { try { fs.unlinkSync(TMP) } catch (_) {} })

test('mapSignInResponse extracts tokens and computes expiry (with skew)', () => {
  const now = 1_000_000
  const s = auth.mapSignInResponse({ idToken: 'ID', refreshToken: 'RT', email: 'a@b.com', expiresIn: '3600' }, now)
  assert.equal(s.idToken, 'ID')
  assert.equal(s.refreshToken, 'RT')
  assert.equal(s.email, 'a@b.com')
  // 3600s minus 60s skew.
  assert.equal(s.expiresAt, now + 3600_000 - 60_000)
})

test('mapSignInResponse throws on an error/empty response (no silent bad session)', () => {
  assert.throws(() => auth.mapSignInResponse({ error: { message: 'INVALID_IDP_RESPONSE' } }))
  assert.throws(() => auth.mapSignInResponse({ idToken: 'ID' })) // missing refreshToken
  assert.throws(() => auth.mapSignInResponse(null))
})

test('mapRefreshResponse maps snake_case and keeps prior refresh token when omitted', () => {
  const now = 2_000_000
  const s = auth.mapRefreshResponse({ id_token: 'ID2', expires_in: '3600' }, 'PREV_RT', 'a@b.com', now)
  assert.equal(s.idToken, 'ID2')
  assert.equal(s.refreshToken, 'PREV_RT') // reused because response omitted it
  assert.equal(s.email, 'a@b.com')
  assert.equal(s.expiresAt, now + 3600_000 - 60_000)
})

test('mapRefreshResponse throws when no id_token comes back', () => {
  assert.throws(() => auth.mapRefreshResponse({ error: { message: 'TOKEN_EXPIRED' } }, 'RT', ''))
})

test('save/load/clear persists only the refresh token + email', () => {
  auth.saveSession({ idToken: 'SECRET_ID', refreshToken: 'RT', email: 'a@b.com', expiresAt: 999 })
  const raw = JSON.parse(fs.readFileSync(TMP, 'utf8'))
  assert.deepEqual(Object.keys(raw).sort(), ['email', 'refreshToken'])
  assert.equal(raw.refreshToken, 'RT')
  assert.ok(!('idToken' in raw), 'short-lived idToken must not be persisted')

  assert.equal(auth.loadSession().refreshToken, 'RT')
  auth.clearSession()
  assert.equal(auth.loadSession(), null)
})

test('getValidIdToken returns null when there is no session at all', async () => {
  auth.clearSession()
  const tok = await auth.getValidIdToken('fake-api-key')
  assert.equal(tok, null) // caller falls back to offline license
})

test('getValidIdToken returns the cached idToken while it is still fresh', async () => {
  auth.setSession({ idToken: 'CACHED', refreshToken: 'RT', email: 'a@b.com', expiresAt: Date.now() + 5 * 60 * 1000 })
  const tok = await auth.getValidIdToken('fake-api-key')
  assert.equal(tok, 'CACHED') // no network call needed
  auth.clearSession()
})
