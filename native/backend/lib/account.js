// account.js — signing in with a Creative Hubb account, and the subscription check. The same
// accounts and rules as the Electron app:
//   - Google sign-in in the user's own browser (Google refuses sign-in inside an app's web view);
//     a page on 127.0.0.1:9842 receives the answer, which becomes a Firebase session;
//   - the user's record in Firestore: activated, an expiry date, one machine;
//   - the licence saved on this Mac (signed by Creative Hubb, or the older checksum), so the app
//     also opens offline until it expires.
// The saved licence and session are the Electron app's own files (~/.ch_toolkit_license,
// ~/.ch_toolkit_session), so signing in to either app signs in to both.
//
// Until the check passes, the helper answers account.* and system.* calls only (`permits`).

'use strict'

const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const { dataDir } = require('./recent')

// Sign-in settings (Firebase project, Google OAuth client, the older licences' key): each from
// the environment or the first of these files that gives it a value: Album Studio's data folder,
// the app itself (built in on request; the repository root when run from source), the Album
// Toolkit's folder. A key left empty in one file is looked for in the next.
const SETTINGS = ['FIREBASE_API_KEY', 'FIREBASE_PROJECT_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'LICENSE_SECRET_KEY']
const settingsFiles = () => [
  path.join(dataDir(), '.env'),
  path.resolve(__dirname, '../../../.env'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Creative Hubb Album Toolkit Pro', '.env'),
]
function loadSettings(files = settingsFiles()) {
  for (const file of files) {
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch (_) { continue }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim()
      const eq = line.indexOf('=')
      if (!line || line.startsWith('#') || eq < 1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (value.length > 1 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1)
      if (SETTINGS.includes(key) && value && !process.env[key]) process.env[key] = value
    }
  }
}
loadSettings()

// After the settings: the licence module reads its key as it loads.
const fbAuth = require('../../../src/firebase_auth')
const licence = require('../../../src/license')
const { apiKey, emailToUserKey, firestoreAuthHeaders, firestorePath } = require('../../../src/main/firestore_rest')

const FIRESTORE = 'https://firestore.googleapis.com'
const PORT = 9842 // the redirect address registered for the Google OAuth client
const SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000

const deps = {
  fetch: (...a) => fetch(...a),
  // node-machine-id runs `ioreg` (in /usr/sbin) through the shell: make sure the system folders are
  // on the PATH, whatever the app was started with.
  machineId: () => {
    const dirs = (process.env.PATH || '').split(':').filter(Boolean)
    for (const d of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) if (!dirs.includes(d)) dirs.push(d)
    process.env.PATH = dirs.join(':')
    return require('node-machine-id').machineId()
  },
  open: (url) => new Promise((resolve) => execFile('/usr/bin/open', [url], () => resolve())),
  port: PORT,
}

/** Tests replace the network, the machine id, the browser and the port. */
function _setDeps(d) { Object.assign(deps, d) }

const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.FIREBASE_API_KEY)
const signedOut = () => ({ state: 'signedOut', configured: configured() })
const allowed = (email, name, daysLeft, offline) => ({ state: 'allowed', email, name: name || '', daysLeft, offline: !!offline, configured: configured() })
const blocked = (reason, email, extra = {}) => ({ state: 'blocked', reason, email: email || '', ...extra, configured: configured() })

/** Developers and tests may skip the check — never in the packaged app. */
const bypass = () => process.env.ALBUM_STUDIO_ACCOUNT === 'skip' && !__dirname.includes('.app/Contents/')

let current = null
let checking = null
let flow = null

/** Whether the helper may answer `method` now. */
function permits(method) {
  return /^(account|system)\./.test(method) || current?.state === 'allowed' || bypass()
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/** JSON from a response, or null when the request or the parse fails (offline, a proxy page). */
async function json(url, init = {}) {
  try {
    const r = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) })
    return await r.json()
  } catch (_) {
    return null
  }
}
const postJson = (url, body, headers = {}) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const postForm = (url, params) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() })
const patchDoc = async (userKey, fields, mask) => json(FIRESTORE + firestorePath(`/users/${userKey}`, mask), {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', ...(await firestoreAuthHeaders()) },
  body: JSON.stringify({ fields }),
})

// ── The subscription check ─────────────────────────────────────────────────

/**
 * Online first: the Firestore record decides (activated, not expired, this machine; a machine is
 * bound on first use) and the licence is saved for offline use. Only when the record can't be
 * reached does the saved licence decide. The same rules as the Electron app's verifyLicense.
 */
async function verify(email) {
  try {
    const machine = await deps.machineId()
    const userKey = emailToUserKey(email)
    const headers = await firestoreAuthHeaders()
    // No session (signed out elsewhere, or offline): an unauthenticated read would be refused and
    // misread as "not activated", so go straight to the saved licence.
    const doc = headers.Authorization ? await json(FIRESTORE + firestorePath(`/users/${userKey}`), { headers }) : null

    if (doc && doc.fields) {
      const f = doc.fields
      const expiresOn = f.expiresOn?.timestampValue
      if (!f.activated?.booleanValue || !expiresOn) { licence.clearLicense(); return blocked('not_activated', email) }
      if (new Date(expiresOn) <= new Date()) { licence.clearLicense(); return blocked('expired', email) }
      const bound = f.machineId?.stringValue
      if (bound && bound !== machine) {
        licence.clearLicense()
        return blocked('wrong_machine', email, { machineName: f.machineName?.stringValue || '' })
      }
      if (!bound) await patchDoc(userKey, { ...f, machineId: { stringValue: machine }, machineName: { stringValue: os.hostname() } }, ['machineId', 'machineName'])
      // A signed record carries the exact signed strings; save those so the offline check
      // verifies the bytes that were signed.
      const sig = f.sig?.stringValue
      const activatedOn = f.activatedOn?.timestampValue || new Date().toISOString()
      licence.saveLicense({
        email,
        name: f.name?.stringValue || '',
        machineId: machine,
        expiresOn: sig ? (f.licExpiresOn?.stringValue || expiresOn) : expiresOn,
        activatedOn: sig ? (f.licActivatedOn?.stringValue || activatedOn) : activatedOn,
        sig,
      })
      return allowed(email, f.name?.stringValue, licence.getDaysRemaining(expiresOn), false)
    }
    // The read worked but there is no record: not activated (not "offline").
    if (doc !== null) return blocked('not_activated', email)

    const saved = licence.validateOfflineLicense(machine, email)
    return saved.allowed ? allowed(saved.email, '', saved.daysLeft, true) : blocked(saved.reason, email)
  } catch (e) {
    return blocked('error', email, { message: e.message })
  }
}

/** Who is signed in and whether the app may open; checked once, then on request. */
async function status({ refresh } = {}) {
  if (bypass()) return { ...allowed('developer', 'Developer', 999, true), bypass: true }
  if (current && !refresh) return current
  if (!checking) {
    checking = (async () => {
      const saved = licence.loadLicense()
      current = saved && saved.email && saved.expiresOn ? await verify(saved.email) : signedOut()
      return current
    })().finally(() => { checking = null })
  }
  return checking
}

/** Check again for the account last seen (e.g. "I've been activated"). */
async function retry() {
  const email = current?.email
  if (!email) throw new Error('Sign in first.')
  current = await verify(email)
  return current
}

async function signOut() {
  cancelSignIn()
  licence.clearLicense()
  fbAuth.clearSession()
  current = signedOut()
  return current
}

// ── Google sign-in ─────────────────────────────────────────────────────────

const PAGE_STYLE = 'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif}main{max-width:420px;padding:32px;text-align:center}h1{font-size:20px;font-weight:600;margin:0 0 8px}p{margin:0;color:#aaa}'
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
function page(res, status, title, text) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main>`)
}

/** The answer from Google → a Firebase session, the user's record, and the subscription check. */
async function complete(code, redirectUri) {
  const token = await postForm('https://oauth2.googleapis.com/token', {
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })
  if (!token?.access_token || !token.id_token) throw new Error('Google didn’t finish the sign-in. Try again.')
  const user = await json('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } })
  if (!user?.email) throw new Error('Google didn’t share your email address. Try again, and allow it.')

  // A Firebase session, so Firestore's rules let this user read their own record.
  const fb = await postJson(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${apiKey()}`, {
    postBody: `id_token=${token.id_token}&providerId=google.com`,
    requestUri: 'http://localhost',
    returnSecureToken: true,
  })
  try {
    fbAuth.setSession(fbAuth.mapSignInResponse(fb))
  } catch (_) {
    throw new Error('Album Studio couldn’t open a secure session with Creative Hubb. Try again in a moment.')
  }

  // The user's record: login details always; `activated: false` only for a new record, so a
  // returning user is never deactivated by signing in.
  const userKey = emailToUserKey(user.email)
  const existing = await json(FIRESTORE + firestorePath(`/users/${userKey}`), { headers: await firestoreAuthHeaders() })
  const fields = {
    email: { stringValue: user.email },
    name: { stringValue: user.name || '' },
    photoURL: { stringValue: user.picture || '' },
    lastLogin: { timestampValue: new Date().toISOString() },
  }
  const mask = ['email', 'name', 'photoURL', 'lastLogin']
  if (!existing?.fields) { fields.activated = { booleanValue: false }; mask.push('activated') }
  await patchDoc(userKey, fields, mask)

  current = await verify(user.email)
  if (!current.name && user.name) current.name = user.name
  return current
}

/**
 * Sign in with Google in the browser; answers when it's done (the account's status) or failed.
 * Asked again while waiting, it shows the browser page again and waits for the same sign-in.
 */
async function signIn(_p = {}, { emit } = {}) {
  if (flow) {
    if (flow.url) await deps.open(flow.url)
    return flow.done
  }
  if (!configured()) {
    throw new Error('Sign-in isn’t set up in this copy of Album Studio: its Google and Firebase settings are missing. Ask Creative Hubb for the settings file.')
  }
  const me = { url: null, cancel: () => {}, done: null }
  flow = me
  me.done = run(me, emit).finally(() => { if (flow === me) flow = null })
  me.done.catch(() => {}) // a cancelled sign-in nobody waits for is not an error
  return me.done
}

async function run(me, emit) {
  const state = crypto.randomBytes(16).toString('hex')
  const server = http.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE'
      ? new Error('Something else on this Mac is using the sign-in address (port 9842), perhaps the Album Toolkit’s sign-in window. Close it, then try again.')
      : e))
    server.listen(deps.port, '127.0.0.1', resolve)
  })
  const redirectUri = `http://127.0.0.1:${server.address().port}`
  me.url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    state,
  })

  const answer = new Promise((resolve, reject) => {
    let finished = false
    const finish = (err, value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      server.close()
      if (err) reject(err)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('Sign-in timed out. Try again when you’re ready.')), SIGN_IN_TIMEOUT_MS)
    me.cancel = () => finish(new Error('Sign-in cancelled.'))

    server.on('request', async (req, res) => {
      const u = new URL(req.url, redirectUri)
      if (u.pathname !== '/') { res.writeHead(404).end(); return }
      // An answer to another sign-in (an old tab): say so and keep waiting for this one.
      if (u.searchParams.get('state') !== state) {
        page(res, 400, 'This sign-in page is out of date', 'Go back to Album Studio and choose Sign in with Google again.')
        return
      }
      if (u.searchParams.get('error')) {
        page(res, 200, 'Sign-in cancelled', 'You can close this tab.')
        finish(new Error('Sign-in cancelled.'))
        return
      }
      const code = u.searchParams.get('code')
      if (!code) { page(res, 400, 'Sign-in didn’t finish', 'Go back to Album Studio and try again.'); return }
      try {
        const result = await complete(code, redirectUri)
        page(res, 200, 'You’re signed in', 'Return to Album Studio. You can close this tab.')
        finish(null, result)
      } catch (e) {
        page(res, 200, 'Sign-in didn’t finish', e.message)
        finish(e)
      }
    })
  })

  emit?.('account.signIn', { stage: 'browser' })
  await deps.open(me.url)
  return answer
}

function cancelSignIn() {
  flow?.cancel?.()
  return null
}

/** Tests: forget the session state (not the files). */
function _reset() { current = null; checking = null; cancelSignIn() }

module.exports = { status, signIn, cancelSignIn, retry, signOut, permits, verify, loadSettings, _setDeps, _reset }
