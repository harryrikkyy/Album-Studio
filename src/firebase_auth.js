'use strict'

// ─────────────────────────────────────────────────────────────────────────────
// Firebase Auth session for the desktop app.
//
// The app signs in with Google (OAuth) and receives a Google `id_token`. On its
// own that does NOT authenticate Firestore. Here we exchange it for a real
// Firebase session via Identity Toolkit (`accounts:signInWithIdp`), which yields
// a Firebase `idToken` + long-lived `refreshToken`. Attaching the `idToken` as a
// Bearer header to Firestore requests populates `request.auth`, so the security
// rules can restrict each user to their own record.
//
// The `idToken` expires ~hourly; we mint fresh ones from the `refreshToken` via
// securetoken.googleapis.com. The refreshToken is persisted locally so the app
// re-authenticates on boot WITHOUT a new Google sign-in — same model as any
// Firebase client. It lives beside the license file, on the user's own machine.
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Overridable for tests.
const SESSION_FILE = process.env.CH_SESSION_FILE || path.join(os.homedir(), '.ch_toolkit_session')

// Refresh a minute early so a token never expires mid-request.
const EXPIRY_SKEW_MS = 60 * 1000

// ── Pure response mappers (unit-tested) ──────────────────────────────────────

// Identity Toolkit signInWithIdp response → our session shape.
function mapSignInResponse(r, now = Date.now()) {
  if (!r || !r.idToken || !r.refreshToken) {
    throw new Error((r && r.error && r.error.message) || 'signInWithIdp: no tokens returned')
  }
  return {
    idToken: r.idToken,
    refreshToken: r.refreshToken,
    email: r.email || '',
    expiresAt: now + (Number(r.expiresIn || 3600) * 1000) - EXPIRY_SKEW_MS,
  }
}

// securetoken refresh response (snake_case) → our session shape.
function mapRefreshResponse(r, prevRefresh, prevEmail, now = Date.now()) {
  if (!r || !r.id_token) {
    throw new Error((r && r.error && r.error.message) || 'token refresh: no id_token returned')
  }
  return {
    idToken: r.id_token,
    refreshToken: r.refresh_token || prevRefresh,
    email: prevEmail || '',
    expiresAt: now + (Number(r.expires_in || 3600) * 1000) - EXPIRY_SKEW_MS,
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function httpsPostJson(hostname, urlPath, bodyObj) {
  const body = JSON.stringify(bodyObj)
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (_) { reject(new Error('non-JSON response')) } })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function httpsPostForm(hostname, urlPath, params) {
  const body = new URLSearchParams(params).toString()
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (_) { reject(new Error('non-JSON response')) } })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// ── Network calls ────────────────────────────────────────────────────────────

async function exchangeGoogleIdToken(googleIdToken, apiKey) {
  const r = await httpsPostJson('identitytoolkit.googleapis.com', `/v1/accounts:signInWithIdp?key=${apiKey}`, {
    postBody: `id_token=${googleIdToken}&providerId=google.com`,
    requestUri: 'http://localhost',
    returnSecureToken: true,
  })
  return mapSignInResponse(r)
}

async function refreshSession(refreshToken, apiKey, email = '') {
  const r = await httpsPostForm('securetoken.googleapis.com', `/v1/token?key=${apiKey}`, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  return mapRefreshResponse(r, refreshToken, email)
}

// ── Persistence (only the refreshToken + email need to survive restarts) ──────

function saveSession(session) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ refreshToken: session.refreshToken, email: session.email || '' }), { mode: 0o600 })
  } catch (_) { /* best-effort */ }
}

function loadSession() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) } catch (_) { return null }
}

function clearSession() {
  _mem = null
  try { fs.unlinkSync(SESSION_FILE) } catch (_) {}
}

// ── In-memory session + token accessor ───────────────────────────────────────

let _mem = null // { idToken, refreshToken, email, expiresAt }

// Called right after a fresh Google sign-in with the exchanged session.
function setSession(session) {
  _mem = session
  saveSession(session)
}

// Returns a valid Firebase idToken, refreshing from the persisted refreshToken
// when needed (e.g. app boot). Returns null when there is no session at all, so
// callers can fall back to the offline license path.
async function getValidIdToken(apiKey) {
  if (_mem && _mem.idToken && _mem.expiresAt > Date.now()) return _mem.idToken

  const refreshToken = (_mem && _mem.refreshToken) || (loadSession() || {}).refreshToken
  if (!refreshToken) return null
  const email = (_mem && _mem.email) || (loadSession() || {}).email || ''

  try {
    _mem = await refreshSession(refreshToken, apiKey, email)
    saveSession(_mem)
    return _mem.idToken
  } catch (_) {
    return null // let the caller degrade gracefully (offline / re-login)
  }
}

module.exports = {
  SESSION_FILE,
  mapSignInResponse,
  mapRefreshResponse,
  exchangeGoogleIdToken,
  refreshSession,
  saveSession,
  loadSession,
  clearSession,
  setSession,
  getValidIdToken,
}
