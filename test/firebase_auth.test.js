'use strict'

// Isolated unit tests for token mapping, persistence and refresh races. Fake HTTPS
// responses exercise the client lifecycle without using real Google credentials.
// Live Google/Firebase exchanges remain a separate integration requirement.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')
const { EventEmitter } = require('events')

// Point persistence at a temp file BEFORE requiring the module.
const TMP = path.join(os.tmpdir(), `ch_session_test_${process.pid}`)
process.env.CH_SESSION_FILE = TMP

const auth = require('../src/firebase_auth')

test.after(() => {
  try {
    fs.unlinkSync(TMP)
  } catch (_) {}
})

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

function fakeHttps(t) {
  const calls = []
  t.mock.method(https, 'request', (options, callback) => {
    const req = new EventEmitter()
    const call = { options, callback, req, destroyed: false }
    calls.push(call)
    req.write = (body) => {
      call.body = body
    }
    req.end = () => {}
    req.destroy = (error) => {
      call.destroyed = true
      if (error) queueMicrotask(() => req.emit('error', error))
      return req
    }
    call.startResponse = (statusCode = 200) => {
      const res = new EventEmitter()
      res.statusCode = statusCode
      res.destroy = () => {
        call.responseDestroyed = true
      }
      callback(res)
      return res
    }
    call.respond = (body, statusCode = 200) => {
      const res = call.startResponse(statusCode)
      queueMicrotask(() => {
        res.emit('data', JSON.stringify(body))
        res.emit('end')
      })
    }
    return req
  })
  t.after(() => auth.clearSession())
  auth.clearSession()
  auth.saveSession({ refreshToken: 'OLD_REFRESH', email: 'a@b.com' })
  return calls
}

const refreshed = { id_token: 'REFRESHED_ID', refresh_token: 'NEW_REFRESH', expires_in: '3600' }

test('clearing a session aborts a refresh and cannot rewrite tokens from a late response', async (t) => {
  const calls = fakeHttps(t)
  const pending = auth.getValidIdToken('fake-api-key')
  assert.equal(calls.length, 1)
  auth.clearSession()
  calls[0].respond(refreshed)
  assert.equal(await pending, null)
  assert.equal(calls[0].destroyed, true, 'sign-out closes the in-flight request')
  assert.equal(fs.existsSync(TMP), false, 'late completion must not recreate the token file')
  assert.equal(await auth.getValidIdToken('fake-api-key'), null)
})

test('parallel accessors share one refresh and persist its rotated refresh token', async (t) => {
  const calls = fakeHttps(t)
  const a = auth.getValidIdToken('fake-api-key')
  const b = auth.getValidIdToken('fake-api-key')
  for (const call of calls) call.respond(refreshed)
  assert.deepEqual(await Promise.all([a, b]), ['REFRESHED_ID', 'REFRESHED_ID'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.hostname, 'securetoken.googleapis.com')
  assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded')
  assert.equal(new URLSearchParams(calls[0].body).get('refresh_token'), 'OLD_REFRESH')
  assert.equal(auth.loadSession().refreshToken, 'NEW_REFRESH')
})

test('a fresh sign-in supersedes a pending refresh without replacing the new session', async (t) => {
  const calls = fakeHttps(t)
  const pending = auth.getValidIdToken('fake-api-key')
  auth.setSession({
    idToken: 'FRESH_SIGN_IN',
    refreshToken: 'FRESH_REFRESH',
    email: 'new@b.com',
    expiresAt: Date.now() + 3600_000,
  })
  calls[0].respond(refreshed)
  assert.equal(await pending, null)
  assert.equal(await auth.getValidIdToken('fake-api-key'), 'FRESH_SIGN_IN')
  assert.deepEqual(auth.loadSession(), { refreshToken: 'FRESH_REFRESH', email: 'new@b.com' })
})

test('refresh has a total network deadline and closes a stalled request', async (t) => {
  const calls = fakeHttps(t)
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  let requestedTimeout
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    requestedTimeout = ms
    return timeout(10)
  })
  const pending = auth.getValidIdToken('fake-api-key')
  const result = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 60))])
  if (result === 'still waiting') calls[0].respond(refreshed)
  await pending
  assert.equal(result, null, 'offline fallback must not wait indefinitely for HTTPS')
  assert.equal(requestedTimeout, 20_000)
  assert.equal(calls[0].destroyed, true)
  assert.deepEqual(
    auth.loadSession(),
    { refreshToken: 'OLD_REFRESH', email: 'a@b.com' },
    'network failure keeps the existing refresh token',
  )
})

test('a rejected refresh cannot accept a token-shaped error body', async (t) => {
  const calls = fakeHttps(t)
  const pending = auth.getValidIdToken('fake-api-key')
  calls[0].respond(refreshed, 403)
  assert.equal(await pending, null)
  assert.deepEqual(auth.loadSession(), { refreshToken: 'OLD_REFRESH', email: 'a@b.com' })
})

test('an interrupted refresh settles promptly and a subsequent attempt can succeed', async (t) => {
  const calls = fakeHttps(t)
  const pending = auth.getValidIdToken('fake-api-key')
  const response = calls[0].startResponse()
  response.emit('data', '{"id_token":')
  response.emit('aborted')
  assert.equal(await pending, null)
  assert.equal(calls[0].destroyed, true)
  assert.equal(calls[0].responseDestroyed, true)
  const again = auth.getValidIdToken('fake-api-key')
  assert.equal(calls.length, 2)
  calls[1].respond(refreshed)
  assert.equal(await again, 'REFRESHED_ID')
})

test('the total deadline also closes a response that never finishes', async (t) => {
  const calls = fakeHttps(t)
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  t.mock.method(AbortSignal, 'timeout', () => timeout(10))
  const pending = auth.getValidIdToken('fake-api-key')
  const response = calls[0].startResponse()
  response.emit('data', '{"id_token":')
  const result = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 60))])
  assert.equal(result, null)
  assert.equal(calls[0].destroyed, true)
  assert.equal(calls[0].responseDestroyed, true)
})

test('Google token exchange preserves its JSON request and session response format', async (t) => {
  const calls = fakeHttps(t)
  const pending = auth.exchangeGoogleIdToken('google-id', 'fake-api-key')
  assert.equal(calls[0].options.hostname, 'identitytoolkit.googleapis.com')
  assert.equal(calls[0].options.path, '/v1/accounts:signInWithIdp?key=fake-api-key')
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].body), {
    postBody: 'id_token=google-id&providerId=google.com',
    requestUri: 'http://localhost',
    returnSecureToken: true,
  })
  calls[0].respond({
    idToken: 'GOOGLE_EXCHANGED_ID',
    refreshToken: 'GOOGLE_REFRESH',
    email: 'a@b.com',
    expiresIn: '3600',
  })
  const session = await pending
  assert.equal(session.idToken, 'GOOGLE_EXCHANGED_ID')
  assert.equal(session.refreshToken, 'GOOGLE_REFRESH')
  assert.ok(Number.isFinite(session.expiresAt))
})
