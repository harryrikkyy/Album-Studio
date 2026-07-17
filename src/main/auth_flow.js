// auth_flow.js — Google OAuth sign-in for the login window.
//
// Extracted from app.js (Phase: app.js split). Owns the `google-sign-in`
// IPC handler, the loopback OAuth flow (local callback server on port 9842
// + a dedicated auth BrowserWindow), and the token→profile→Firestore-upsert
// pipeline in handleOAuthRedirect.

const { BrowserWindow, ipcMain } = require('electron')
const fbAuth = require('../firebase_auth')
const session = require('./session')
const {
  apiKey, firestorePath, firestoreAuthHeaders, emailToUserKey, safeJsonParse,
} = require('./firestore_rest')

// Singleton guard: only ONE auth flow (window + local callback server on
// port 9842) may exist at a time. Without this, a second sign-in click opens
// a duplicate window AND fails to bind port 9842, leaving an orphaned,
// uncloseable window that can never receive its callback.
let _authWindow = null
let _authServer = null
function teardownAuthFlow() {
  try { if (_authServer) _authServer.close() } catch (_) {}
  _authServer = null
  try { if (_authWindow && !_authWindow.isDestroyed()) _authWindow.close() } catch (_) {}
  _authWindow = null
}

function registerAuthHandlers() {
  ipcMain.handle('google-sign-in', async () => {
    return new Promise((resolve) => {
      const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
      const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
      const PORT = 9842
      const REDIRECT_URI = `http://127.0.0.1:${PORT}`

      // Guard: without credentials, opening a Google window just yields the
      // opaque "Missing required parameter: client_id" error. Fail fast with a
      // message that points at the real fix instead.
      if (!CLIENT_ID || !CLIENT_SECRET) {
        resolve({ error: 'Sign-in is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to a .env file in the app folder, then restart.' })
        return
      }

      // Singleton: if a sign-in window is already open, focus it instead of
      // spawning a second window + a second (doomed) server bind.
      if (_authWindow && !_authWindow.isDestroyed()) {
        _authWindow.focus()
        resolve({ error: 'A sign-in window is already open.' })
        return
      }
      // Clear any stale server from a previous aborted attempt.
      teardownAuthFlow()

      let resolved = false
      let authWindow = null
      let authTimeout = null

      const safeResolve = (val) => {
        if (resolved) return
        resolved = true
        if (authTimeout) { try { clearTimeout(authTimeout) } catch (_) {} authTimeout = null }
        resolve(val)
      }

      const http = require('http')
      const renderPage = (res, title, color, sub) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(`<html><body style="background:#0a0a0a;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center">
            <h2 style="color:${color}">${title}</h2>
            <p style="color:#888;margin-top:8px">${sub}</p>
          </div></body></html>`)
      }
      let server = http.createServer(async (req, res) => {
        // Ignore favicon and other stray requests the browser makes.
        const urlObj = new URL(req.url, `http://127.0.0.1:${PORT}`)
        const code = urlObj.searchParams.get('code')
        const oauthError = urlObj.searchParams.get('error') // e.g. access_denied

        if (oauthError) {
          renderPage(res, '✕ Sign-in cancelled', '#e31c1c', 'You can close this window.')
          teardownAuthFlow()
          safeResolve({ error: 'Sign in cancelled' })
          return
        }
        if (!code) {
          renderPage(res, '✕ Sign-in failed', '#e31c1c', 'No authorization code received. Close this window and try again.')
          teardownAuthFlow()
          safeResolve({ error: 'No authorization code received. Please try again.' })
          return
        }

        // M7: do the token exchange BEFORE claiming success. Only render the
        // success page if the exchange + profile fetch actually worked.
        let outcome
        try {
          outcome = await handleOAuthRedirect(code, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
        } catch (e) {
          outcome = { error: e.message || 'Sign-in failed' }
        }

        if (outcome && outcome.email) {
          renderPage(res, '✓ Signed in successfully', '#22c55e', 'Return to Creative Hubb Album Toolkit Pro.')
        } else {
          renderPage(res, '✕ Sign-in failed', '#e31c1c', (outcome && outcome.error) || 'Please try again.')
        }
        teardownAuthFlow()
        safeResolve(outcome || { error: 'Sign-in failed' })
      })
      _authServer = server

      server.on('error', (e) => {
        // EADDRINUSE = a previous flow's server is still bound. Reset and tell
        // the user to retry rather than leaving a dead window around.
        teardownAuthFlow()
        const msg = e.code === 'EADDRINUSE'
          ? 'Another sign-in attempt is still finishing. Please wait a moment and try again.'
          : 'Server error: ' + e.message
        safeResolve({ error: msg })
      })

      server.listen(PORT, '127.0.0.1', () => {
        console.log('Auth server listening on port', PORT)
      })

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${CLIENT_ID}&` +
        `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
        `response_type=code&` +
        `scope=${encodeURIComponent('openid email profile')}&` +
        `prompt=select_account`

      authWindow = new BrowserWindow({
        width: 500,
        height: 650,
        show: true,
        // A real title-bar frame guarantees the user can always close the
        // window manually, even if the OAuth flow wedges.
        frame: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
        title: 'Sign in with Google'
      })
      _authWindow = authWindow

      // Google's "use a different account" / account-chooser sometimes triggers
      // a popup (window.open), which Electron would spawn as a SEPARATE OS
      // window — the user's "two sign-in windows, can't close one" bug. Force
      // any such popup to navigate IN-PLACE within this same auth window.
      authWindow.webContents.setWindowOpenHandler(({ url }) => {
        try { if (authWindow && !authWindow.isDestroyed()) authWindow.loadURL(url) } catch (_) {}
        return { action: 'deny' }
      })

      authWindow.loadURL(authUrl)

      // M3: safety timeout. If the user opens Google and walks away, don't leave
      // the server listening and the button spinning forever — reset after 2 min.
      authTimeout = setTimeout(() => {
        teardownAuthFlow()
        safeResolve({ error: 'Sign-in timed out. Please try again.' })
      }, 120000)

      authWindow.on('closed', () => {
        // Clear our module refs (the window is gone) and shut the server.
        if (_authWindow === authWindow) _authWindow = null
        try { server.close() } catch (e) {}
        if (_authServer === server) _authServer = null
        // If the flow hadn't already resolved (success/error), the user closed
        // the window manually → genuine cancellation. Resolve immediately; the
        // old 3s delay just made the window feel unresponsive.
        safeResolve({ error: 'Sign in cancelled' })
      })
    })
  })
}

async function handleOAuthRedirect(code, clientId, clientSecret, redirectUri) {
  const https = require('https')
  const querystring = require('querystring')
  const postData = querystring.stringify({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  })

  const tokenRes = await new Promise((res) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': postData.length
      }
    }, (response) => {
      let data = ''
      response.on('data', chunk => data += chunk)
      response.on('end', () => res(safeJsonParse(data, {})))
    })
    req.write(postData)
    req.end()
  })

  if (!tokenRes.access_token) {
    return { error: 'Could not complete sign-in with Google (token exchange failed). Please try again.' }
  }

  const userInfo = await new Promise((res) => {
    https.get(
      `https://www.googleapis.com/oauth2/v2/userinfo?access_token=${tokenRes.access_token}`,
      (response) => {
        let data = ''
        response.on('data', chunk => data += chunk)
        response.on('end', () => res(safeJsonParse(data, {})))
      }
    )
  })

  if (!userInfo.email) { return { error: 'Could not read your Google profile. Please try again.' } }

  // ── Establish a real Firebase session ───────────────────────────────
  // Exchange the Google id_token (openid scope) for a Firebase idToken +
  // refreshToken so every Firestore request below is authenticated. Without
  // this, request.auth is null and the tightened rules would refuse the read.
  if (!tokenRes.id_token) {
    return { error: 'Sign-in did not return the expected credentials. Please try again.' }
  }
  try {
    fbAuth.setSession(await fbAuth.exchangeGoogleIdToken(tokenRes.id_token, apiKey()))
  } catch (_) {
    return { error: 'Could not establish a secure session with the server. Please try again.' }
  }

  // ── Upsert the user doc WITHOUT ever resetting `activated`. ──────────
  // C3: the previous code sent `activated:false` on every login and relied
  // solely on the updateMask to protect it — one wrong mask would have
  // deactivated every returning user. We now check whether the doc exists
  // first; `activated:false` is only sent when CREATING a brand-new doc.
  const userKey = emailToUserKey(userInfo.email)

  let docExists = false
  try {
    const authHeaders = await firestoreAuthHeaders()
    const existing = await new Promise((res) => {
      https.get({ hostname: 'firestore.googleapis.com', path: firestorePath(`/users/${userKey}`), headers: authHeaders }, (r) => {
        let d = ''; r.on('data', c => d += c); r.on('end', () => res(safeJsonParse(d, null)))
      }).on('error', () => res(null))
    })
    docExists = !!(existing && existing.fields)
  } catch (_) {}

  // Returning user: only touch login-time fields. New user: seed the doc
  // with activated:false so the owner can activate it later.
  const fields = {
    email: { stringValue: userInfo.email },
    name: { stringValue: userInfo.name || '' },
    photoURL: { stringValue: userInfo.picture || '' },
    lastLogin: { timestampValue: new Date().toISOString() }
  }
  const mask = ['email', 'name', 'photoURL', 'lastLogin']
  if (!docExists) {
    fields.activated = { booleanValue: false }
    mask.push('activated')
  }
  const userData = JSON.stringify({ fields })
  const writeHeaders = await firestoreAuthHeaders()

  await new Promise((res) => {
    const req = https.request({
      hostname: 'firestore.googleapis.com',
      path: firestorePath(`/users/${userKey}`, mask),
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(userData), ...writeHeaders }
    }, (response) => {
      let data = ''
      response.on('data', chunk => data += chunk)
      response.on('end', () => res(safeJsonParse(data, {})))
    })
    req.write(userData)
    req.end()
  })

  session.setUser({ email: userInfo.email, name: userInfo.name, photo: userInfo.picture })
  return { email: userInfo.email, name: userInfo.name }
}

module.exports = { registerAuthHandlers, teardownAuthFlow }
