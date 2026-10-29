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
const REQUEST_TIMEOUT_MS = 20 * 1000

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
    expiresAt: now + Number(r.expiresIn || 3600) * 1000 - EXPIRY_SKEW_MS,
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
    expiresAt: now + Number(r.expires_in || 3600) * 1000 - EXPIRY_SKEW_MS,
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

// The deadline covers DNS, connection and the complete response, including a server
// that opens a socket but never finishes. A session change can abort a refresh sooner.
function httpsPost(hostname, urlPath, body, contentType, signal) {
  return new Promise((resolve, reject) => {
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline
    let req
    let response
    let finished = false
    const finish = (error, value) => {
      if (finished) return
      finished = true
      cancellation.removeEventListener('abort', abort)
      if (error) {
        req?.destroy(error)
        response?.destroy(error)
        reject(error)
      } else resolve(value)
    }
    const abort = () => {
      const error =
        cancellation.reason instanceof Error ? cancellation.reason : new Error('Firebase request cancelled.')
      finish(error)
    }
    cancellation.addEventListener('abort', abort, { once: true })
    if (cancellation.aborted) {
      abort()
      return
    }
    try {
      req = https.request(
        {
          hostname,
          path: urlPath,
          method: 'POST',
          headers: { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          if (finished) {
            res.destroy()
            return
          }
          response = res
          let d = ''
          res.on('error', (error) => finish(error))
          res.on('aborted', () => finish(new Error('Firebase response interrupted.')))
          res.on('data', (c) => (d += c))
          res.on('end', () => {
            try {
              const parsed = JSON.parse(d)
              if (!(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300)) {
                finish(new Error(parsed?.error?.message || `Firebase request failed (${res.statusCode}).`))
              } else finish(null, parsed)
            } catch (_) {
              finish(new Error('non-JSON response'))
            }
          })
        },
      )
      req.on('error', (error) => finish(error))
      req.write(body)
      req.end()
    } catch (error) {
      finish(error)
    }
  })
}

function httpsPostJson(hostname, urlPath, bodyObj) {
  return httpsPost(hostname, urlPath, JSON.stringify(bodyObj), 'application/json')
}

function httpsPostForm(hostname, urlPath, params, signal) {
  return httpsPost(
    hostname,
    urlPath,
    new URLSearchParams(params).toString(),
    'application/x-www-form-urlencoded',
    signal,
  )
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

async function refreshSession(refreshToken, apiKey, email = '', signal) {
  const r = await httpsPostForm(
    'securetoken.googleapis.com',
    `/v1/token?key=${apiKey}`,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    signal,
  )
  return mapRefreshResponse(r, refreshToken, email)
}

// ── Persistence (only the refreshToken + email need to survive restarts) ──────

function saveSession(session) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ refreshToken: session.refreshToken, email: session.email || '' }), {
      mode: 0o600,
    })
  } catch (_) {
    /* best-effort */
  }
}

function loadSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
  } catch (_) {
    return null
  }
}

function clearSession() {
  invalidateRefresh()
  _mem = null
  try {
    fs.unlinkSync(SESSION_FILE)
  } catch (_) {}
}

// ── In-memory session + token accessor ───────────────────────────────────────

let _mem = null // { idToken, refreshToken, email, expiresAt }
let _generation = 0
let _refresh = null

function invalidateRefresh() {
  _generation += 1
  const pending = _refresh
  _refresh = null
  pending?.controller.abort(new Error('Firebase session changed.'))
}

// Called right after a fresh Google sign-in with the exchanged session.
function setSession(session) {
  invalidateRefresh()
  _mem = session
  saveSession(session)
}

// Returns a valid Firebase idToken, refreshing from the persisted refreshToken
// when needed (e.g. app boot). Returns null when there is no session at all, so
// callers can fall back to the offline license path.
async function getValidIdToken(apiKey) {
  if (_mem && _mem.idToken && _mem.expiresAt > Date.now()) return _mem.idToken
  if (_refresh) return _refresh.promise

  const persisted = loadSession() || {}
  const refreshToken = (_mem && _mem.refreshToken) || persisted.refreshToken
  if (!refreshToken) return null
  const email = (_mem && _mem.email) || persisted.email || ''

  const pending = {
    generation: _generation,
    controller: new AbortController(),
    promise: /** @type {Promise<string | null> | null} */ (null),
  }
  pending.promise = (async () => {
    try {
      const session = await refreshSession(refreshToken, apiKey, email, pending.controller.signal)
      if (_generation !== pending.generation || pending.controller.signal.aborted) return null
      _mem = session
      saveSession(session)
      return session.idToken
    } catch (_) {
      return null // let the caller degrade gracefully (offline / re-login)
    } finally {
      if (_refresh === pending) _refresh = null
    }
  })()
  _refresh = pending
  return pending.promise
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
