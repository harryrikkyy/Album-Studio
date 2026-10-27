'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { tmpdir } = require('./fixtures')

const dir = tmpdir()
Object.assign(process.env, {
  ALBUM_STUDIO_DATA_DIR: dir,
  CH_LICENSE_FILE: path.join(dir, 'licence'),
  CH_SESSION_FILE: path.join(dir, 'session'),
  FIREBASE_API_KEY: 'test-key',
  FIREBASE_PROJECT_ID: 'test-project',
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
})
delete process.env.ALBUM_STUDIO_ACCOUNT

const account = require('../lib/account')
const { dispatch } = require('../server')
const fbAuth = require('../../../src/firebase_auth')
const licence = require('../../../src/license')
const { signLicense } = require('../../../src/license_signing')
const { publicKey: licenceKey, privateKey: signingKey } = require('crypto').generateKeyPairSync('ed25519')
licence._usePublicKey(licenceKey)

// Google and Firestore, as far as the sign-in uses them. `docs` holds user records by key.
const docs = new Map()
const versions = new Map()
const calls = []
let offline = false
let readHook = null
let patchHook = null
let tokenHook = null
let googleName = 'Ana Rao' // the name on the Google account, which its owner may change
const day = 24 * 3600 * 1000
const field = (v) => (typeof v === 'boolean' ? { booleanValue: v } : { stringValue: v })
/** The fields Creative Hubb's admin panel added when it signed an activation, before it also kept licName. */
function signedFields(expiresOn, activatedOn = new Date().toISOString()) {
  const sig = signLicense({ email: 'ana@studio.in', name: 'Ana Rao', expiresOn, activatedOn }, signingKey)
  return { licExpiresOn: field(expiresOn), licActivatedOn: field(activatedOn), sig: field(sig) }
}

/** Google's token endpoint. PKCE: a code is redeemed only with the verifier behind the challenge the browser was given. */
async function fakeToken(init, reply) {
  if (tokenHook) await tokenHook()
  const p = new URLSearchParams(init.body)
  assert.equal(p.get('client_secret'), 'test-secret')
  const challenge = new URL(opened.at(-1)).searchParams.get('code_challenge')
  const proof = require('crypto').createHash('sha256').update(p.get('code_verifier') || '').digest('base64url')
  return p.get('code') === 'good' && proof === challenge ? reply({ access_token: 'access', id_token: 'google-id' }) : reply({ error: 'invalid_grant' }, 400)
}

async function fakeFetch(url, init = {}) {
  if (offline) throw new TypeError('fetch failed')
  const u = new URL(url)
  const method = init.method || 'GET'
  calls.push(`${method} ${u.hostname}${u.pathname}`)
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status })
  if (u.hostname === 'oauth2.googleapis.com') return fakeToken(init, reply)
  if (u.pathname === '/oauth2/v2/userinfo') return reply({ email: 'ana@studio.in', name: googleName, picture: '' })
  if (u.hostname === 'identitytoolkit.googleapis.com') return reply({ idToken: 'fb-id', refreshToken: 'fb-refresh', email: 'ana@studio.in', expiresIn: '3600' })
  if (u.hostname === 'firestore.googleapis.com') {
    assert.equal(init.headers?.Authorization, 'Bearer fb-id', 'every record read and write is authenticated')
    const key = decodeURIComponent(u.pathname.split('/users/')[1])
    const document = () => ({ fields: structuredClone(docs.get(key)), updateTime: new Date(Date.UTC(2026, 0, 1) + (versions.get(key) || 0) * 1000).toISOString() })
    if (method === 'GET') {
      if (readHook) {
        const response = await readHook({ key, reply, document })
        if (response) return response
      }
      return docs.has(key) ? reply(document()) : reply({ error: { code: 404 } }, 404)
    }
    if (patchHook) {
      const response = await patchHook({ key, reply, document, url: u, init })
      if (response) return response
    }
    // Simulate Firestore's document precondition only. These fake REST tests do not
    // evaluate security rules, establish that deployed rules match, or call a live project.
    const precondition = u.searchParams.get('currentDocument.updateTime')
    if (precondition && precondition !== document().updateTime) return reply({ error: { code: 409, status: 'FAILED_PRECONDITION' } }, 409)
    const mask = u.searchParams.getAll('updateMask.fieldPaths')
    const sent = JSON.parse(init.body).fields
    const doc = docs.get(key) || {}
    for (const f of mask) doc[f] = sent[f]
    docs.set(key, doc)
    versions.set(key, (versions.get(key) || 0) + 1)
    return reply(document())
  }
  throw new Error(`unexpected request ${method} ${url}`)
}

let opened = []
let onOpen = null
account._setDeps({
  fetch: fakeFetch,
  machineId: async () => 'machine-A',
  port: 0,
  open: async (url) => { opened.push(url); onOpen?.(url) },
})

/** Start a sign-in; resolves with its promise and the page Google would send the user back to. */
async function startSignIn() {
  const seen = new Promise((resolve) => { onOpen = resolve })
  const done = account.signIn({}, {})
  done.catch(() => {}) // the tests look at failures after driving the browser side
  const url = new URL(await Promise.race([seen, done.then(() => { throw new Error('Sign-in finished before opening the browser.') })]))
  return { done, back: url.searchParams.get('redirect_uri'), state: url.searchParams.get('state') }
}

test('signed out with nothing saved: only account and system calls are answered', async () => {
  assert.deepEqual(await account.status(), { state: 'signedOut', configured: true })
  assert.equal(account.permits('album.open'), false)
  assert.equal(account.permits('account.signIn'), true)
  assert.equal(account.permits('system.ping'), true)

  const out = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = (s, callback) => { out.push(JSON.parse(String(s))); if (callback) queueMicrotask(callback); return true }
  try {
    await dispatch(JSON.stringify({ id: 1, method: 'album.recent' }))
  } finally {
    process.stdout.write = orig
  }
  assert.deepEqual(out, [{ id: 1, ok: false, error: 'Sign in to Album Studio first.', code: 'signedOut' }])
})

test('sign-in in the browser: a new user gets a record, not yet activated', async () => {
  const { done, back, state } = await startSignIn()
  assert.match(opened[0], /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
  assert.match(back, /^http:\/\/127\.0\.0\.1:\d+$/)
  const pkce = new URL(opened[0]).searchParams
  assert.deepEqual([pkce.get('code_challenge_method'), /^[A-Za-z0-9_-]{43}$/.test(pkce.get('code_challenge'))], ['S256', true])

  const stale = await fetch(`${back}/?code=good&state=old`)
  assert.equal(stale.status, 400, 'an answer for another sign-in is turned away')
  const page = await fetch(`${back}/?code=good&state=${state}`)
  assert.match(await page.text(), /You’re signed in/)

  const r = await done
  assert.deepEqual([r.state, r.reason, r.email], ['blocked', 'not_activated', 'ana@studio.in'])
  const doc = docs.get('ana@studio_in')
  assert.deepEqual([doc.email, doc.name, doc.activated], [field('ana@studio.in'), field('Ana Rao'), field(false)])
  assert.equal(JSON.parse(fs.readFileSync(process.env.CH_SESSION_FILE, 'utf8')).refreshToken, 'fb-refresh')
  assert.equal(account.permits('album.open'), false)
})

test('activated by Creative Hubb: retry opens the app, binds this Mac, saves the licence', async () => {
  const doc = docs.get('ana@studio_in'), expiresOn = new Date(Date.now() + 30 * day).toISOString()
  Object.assign(doc, { activated: field(true), expiresOn: { timestampValue: expiresOn }, ...signedFields(expiresOn) })
  const r = await account.retry()
  assert.equal(r.state, 'allowed')
  assert.ok(r.daysLeft >= 29 && r.daysLeft <= 30)
  assert.equal(r.offline, false)
  assert.deepEqual(doc.machineId, field('machine-A'))
  const saved = JSON.parse(fs.readFileSync(process.env.CH_LICENSE_FILE, 'utf8'))
  assert.deepEqual([saved.email, saved.machineId], ['ana@studio.in', 'machine-A'])
  assert.equal(account.permits('album.open'), true)

  // Signing in again never resets `activated`.
  const again = await startSignIn()
  await fetch(`${again.back}/?code=good&state=${again.state}`)
  assert.equal((await again.done).state, 'allowed')
  assert.deepEqual(doc.activated, field(true))
})

test('offline: the licence saved on this Mac opens the app', async () => {
  account._reset()
  offline = true
  try {
    const r = await account.status()
    assert.deepEqual([r.state, r.email, r.offline], ['allowed', 'ana@studio.in', true])
  } finally {
    offline = false
  }
})

test('bound to another Mac, or expired: blocked, and the saved licence goes', async () => {
  const doc = docs.get('ana@studio_in')
  Object.assign(doc, { machineId: field('machine-B'), machineName: field('Studio iMac') })
  let r = await account.retry()
  assert.deepEqual([r.state, r.reason, r.machineName], ['blocked', 'wrong_machine', 'Studio iMac'])
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)

  Object.assign(doc, { machineId: field('machine-A'), expiresOn: { timestampValue: new Date(Date.now() - day).toISOString() } })
  r = await account.retry()
  assert.deepEqual([r.state, r.reason], ['blocked', 'expired'])
  assert.equal(account.permits('album.open'), false)
})

test('a failed or cancelled sign-in says so and frees the address', async () => {
  let s = await startSignIn()
  const page = await fetch(`${s.back}/?code=bad&state=${s.state}`)
  assert.match(await page.text(), /didn’t finish/)
  await assert.rejects(s.done, /Google didn’t finish the sign-in/)

  s = await startSignIn()
  opened = []
  const same = account.signIn({}, {})
  same.catch(() => {})
  assert.equal(opened.length, 1, 'asked again while waiting: the same page opens again')
  account.cancelSignIn()
  await assert.rejects(s.done, /cancelled/)
  await assert.rejects(same, /cancelled/)
  await assert.rejects(fetch(`${s.back}/?code=good&state=${s.state}`), 'the sign-in address is closed')
})

test('sign out forgets the licence and the session', async () => {
  fs.writeFileSync(process.env.CH_LICENSE_FILE, '{}')
  const r = await account.signOut()
  assert.equal(r.state, 'signedOut')
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
  assert.equal(fs.existsSync(process.env.CH_SESSION_FILE), false)
  assert.equal(account.permits('album.open'), false)
})

test('settings: a key left empty in one file comes from the next', () => {
  const a = path.join(dir, 'a.env')
  const b = path.join(dir, 'b.env')
  fs.writeFileSync(a, '# Album Studio\nFIREBASE_PROJECT_ID=\nGOOGLE_CLIENT_ID="from-a"\n')
  fs.writeFileSync(b, 'FIREBASE_PROJECT_ID=from-b\nGOOGLE_CLIENT_ID=from-b\nOTHER=ignored\n')
  const saved = { p: process.env.FIREBASE_PROJECT_ID, c: process.env.GOOGLE_CLIENT_ID }
  delete process.env.FIREBASE_PROJECT_ID
  delete process.env.GOOGLE_CLIENT_ID
  try {
    account.loadSettings([a, path.join(dir, 'missing.env'), b])
    assert.equal(process.env.FIREBASE_PROJECT_ID, 'from-b')
    assert.equal(process.env.GOOGLE_CLIENT_ID, 'from-a', 'the first file with a value wins, quotes removed')
    assert.equal(process.env.OTHER, undefined, 'only sign-in settings are read')
  } finally {
    process.env.FIREBASE_PROJECT_ID = saved.p
    process.env.GOOGLE_CLIENT_ID = saved.c
  }
})

async function activatedAccount({ machineId = '', expiresOn = new Date(Date.now() + 30 * day).toISOString() } = {}) {
  await account.signOut()
  account._reset()
  offline = false
  readHook = patchHook = tokenHook = null
  account._setDeps({ now: () => Date.now() })
  docs.clear()
  versions.clear()
  fbAuth.setSession(fbAuth.mapSignInResponse({ idToken: 'fb-id', refreshToken: 'fb-refresh', email: 'ana@studio.in' }))
  const doc = { activated: field(true), expiresOn: { timestampValue: expiresOn }, name: field('Ana Rao'), machineId: field(machineId), ...signedFields(expiresOn) }
  docs.set('ana@studio_in', doc)
  return doc
}

function saveExistingLicense(expiresOn = new Date(Date.now() + 30 * day).toISOString()) {
  const signed = signedFields(expiresOn)
  licence.saveLicense({ email: 'ana@studio.in', name: 'Ana Rao', machineId: 'machine-A', expiresOn, activatedOn: signed.licActivatedOn.stringValue, sig: signed.sig.stringValue })
}

test('an unsigned activation opens the app online only, and a forged licence never opens it offline', async () => {
  const doc = await activatedAccount({ machineId: 'machine-A' })
  saveExistingLicense()
  for (const key of ['sig', 'licExpiresOn', 'licActivatedOn']) delete doc[key]
  const online = await account.verify('ana@studio.in')
  assert.deepEqual([online.state, online.offline], ['allowed', false])
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false, 'the earlier signed licence goes with the signature')

  const data = { email: 'ana@studio.in', name: 'Ana Rao', machineId: 'machine-A', expiresOn: new Date(Date.now() + 3650 * day).toISOString(), activatedOn: new Date().toISOString(), savedAt: new Date().toISOString() }
  const checksum = require('crypto').createHmac('sha256', 'CH-TOOLKIT-PRO-2025-SECRET').update(JSON.stringify(data)).digest('hex')
  fs.writeFileSync(process.env.CH_LICENSE_FILE, JSON.stringify({ ...data, checksum }))
  account._reset()
  offline = true
  try {
    assert.notEqual((await account.status()).state, 'allowed')
    assert.notEqual((await account.verify('ana@studio.in')).state, 'allowed')
    assert.equal(account.permits('album.open'), false)
  } finally {
    offline = false
  }
})

test('renaming the Google account after activation keeps the saved licence, at launch and offline', async () => {
  const doc = await activatedAccount({ machineId: 'machine-A' })
  doc.licName = field('Ana Rao') // the name Creative Hubb's admin panel signed
  googleName = 'Ana Mehta'
  try {
    const { done, back, state } = await startSignIn()
    await fetch(`${back}/?code=good&state=${state}`)
    assert.equal((await done).state, 'allowed')
    assert.deepEqual(doc.name, field('Ana Mehta'), 'each sign-in records the Google name')

    account._reset()
    assert.equal((await account.status()).state, 'allowed', 'the next launch still finds the saved licence')
    account._reset()
    offline = true
    const r = await account.status()
    assert.deepEqual([r.state, r.offline], ['allowed', true])
  } finally {
    googleName = 'Ana Rao'
    offline = false
  }
})

test('rejected or unconfirmed device binding cannot grant access or save a licence', async (t) => {
  for (const [label, respond] of [
    ['permission denied', ({ reply }) => reply({ error: { code: 403, status: 'PERMISSION_DENIED' } }, 403)],
    ['a non-success response carrying fields', ({ reply, document }) => reply({ ...document(), fields: { ...document().fields, machineId: field('machine-A') } }, 403)],
    ['unconfirmed successful response', ({ reply, document }) => reply(document())],
    ['connection lost', () => { throw new TypeError('fetch failed') }],
  ]) {
    await t.test(label, async () => {
      await activatedAccount()
      patchHook = respond
      const result = await account.verify('ana@studio.in')
      assert.deepEqual([result.state, result.reason], ['blocked', 'machine_binding_failed'])
      assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
      assert.equal(account.permits('album.open'), false)
      patchHook = null
    })
  }
})

test('binding uses the document version and cannot overwrite a concurrent machine claim', async () => {
  const doc = await activatedAccount()
  let attemptedPrecondition
  patchHook = ({ url, init }) => {
    attemptedPrecondition = url.searchParams.get('currentDocument.updateTime')
    assert.deepEqual(Object.keys(JSON.parse(init.body).fields).sort(), ['machineId', 'machineName'])
    Object.assign(doc, { machineId: field('machine-B'), machineName: field('Studio iMac') })
    versions.set('ana@studio_in', 1)
  }
  const result = await account.verify('ana@studio.in')
  patchHook = null
  assert.ok(attemptedPrecondition, 'the bind must compare the version read before writing')
  assert.deepEqual([result.state, result.reason, result.machineName], ['blocked', 'wrong_machine', 'Studio iMac'])
  assert.deepEqual(doc.machineId, field('machine-B'))
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
})

test('binding confirmation rereads the authoritative identity before saving', async () => {
  const doc = await activatedAccount()
  patchHook = ({ reply, document }) => {
    const response = { ...document(), fields: { ...document().fields, machineId: field('machine-A') } }
    doc.machineId = field('machine-B')
    return reply(response)
  }
  const result = await account.verify('ana@studio.in')
  patchHook = null
  assert.deepEqual([result.state, result.reason], ['blocked', 'wrong_machine'])
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
})

test('rejected binding does not fall back to a previously saved offline licence', async () => {
  await activatedAccount()
  saveExistingLicense()
  patchHook = ({ reply }) => reply({ error: { code: 403 } }, 403)
  const result = await account.verify('ana@studio.in')
  patchHook = null
  assert.equal(result.state, 'blocked')
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
})

test('an unbound record without a document version is not safe to claim', async () => {
  const doc = await activatedAccount()
  readHook = ({ reply }) => reply({ fields: doc })
  const result = await account.verify('ana@studio.in')
  readHook = null
  assert.deepEqual([result.state, result.reason], ['blocked', 'machine_binding_failed'])
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
})

test('invalid online expiry cannot create an allowed account or licence', async () => {
  await activatedAccount({ machineId: 'machine-A', expiresOn: 'not a timestamp' })
  const result = await account.verify('ana@studio.in')
  assert.deepEqual([result.state, result.reason], ['blocked', 'expired'])
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
})

test('cached permission and status expire at the verified licence deadline', async () => {
  let now = Date.now()
  const expiresOn = new Date(now + 5_000).toISOString()
  await activatedAccount({ machineId: 'machine-A', expiresOn })
  saveExistingLicense(expiresOn)
  account._setDeps({ now: () => now })
  assert.equal((await account.status()).state, 'allowed')
  now += 5_001
  assert.equal(account.permits('album.open'), false, 'a long-running app must enforce expiry without manual refresh')
  assert.deepEqual([(await account.status()).state, (await account.status()).reason], ['blocked', 'expired'])
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
  account._setDeps({ now: () => Date.now() })
})

test('signing out while status is checking cannot restore access or the licence', async () => {
  await activatedAccount({ machineId: 'machine-A' })
  saveExistingLicense()
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  let entered
  const seen = new Promise((resolve) => { entered = resolve })
  readHook = async () => { entered(); await waiting }
  const pending = account.status()
  await seen
  await account.signOut()
  release()
  const result = await pending
  readHook = null
  assert.equal(result.state, 'signedOut')
  assert.equal((await account.status()).state, 'signedOut')
  assert.equal(account.permits('album.open'), false)
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
  assert.equal(fs.existsSync(process.env.CH_SESSION_FILE), false)
})

test('signing out during a Google callback cannot save a late Firebase session', async () => {
  await activatedAccount({ machineId: 'machine-A' })
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  let entered
  const seen = new Promise((resolve) => { entered = resolve })
  tokenHook = async () => { entered(); await waiting }
  const signIn = await startSignIn()
  const callback = fetch(`${signIn.back}/?code=good&state=${signIn.state}`)
  await seen
  await account.signOut()
  release()
  await assert.rejects(signIn.done, /cancelled/)
  await callback
  tokenHook = null
  assert.equal((await account.status()).state, 'signedOut')
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
  assert.equal(fs.existsSync(process.env.CH_SESSION_FILE), false)
})

test('HTTP errors carrying record fields cannot authorize an online account', async () => {
  await activatedAccount({ machineId: 'machine-A' })
  readHook = ({ reply, document }) => reply(document(), 403)
  const result = await account.verify('ana@studio.in')
  readHook = null
  assert.deepEqual([result.state, result.reason], ['blocked', 'not_activated'])
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
})

test('binding confirmation requires a successful authoritative read', async () => {
  await activatedAccount()
  let reads = 0
  readHook = ({ reply, document }) => ++reads > 1 ? reply(document(), 403) : null
  const result = await account.verify('ana@studio.in')
  readHook = null
  assert.deepEqual([result.state, result.reason], ['blocked', 'machine_binding_failed'])
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
})

test('offline licence with a malformed expiry does not grant unbounded access', async () => {
  await activatedAccount({ machineId: 'machine-A' })
  saveExistingLicense('invalid expiry')
  offline = true
  const result = await account.status()
  offline = false
  assert.deepEqual([result.state, result.reason], ['blocked', 'expired'])
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
})

test('cached offline permission preserves the existing whole-day expiry policy', async () => {
  let now = Date.now()
  const expiresOn = new Date(now + 2 * day + 1_000).toISOString()
  await activatedAccount({ machineId: 'machine-A' })
  saveExistingLicense(expiresOn)
  account._setDeps({ now: () => now })
  offline = true
  assert.equal((await account.status()).state, 'allowed')
  now += day + 1_001
  assert.equal(account.permits('album.open'), false)
  assert.equal((await account.status()).reason, 'expired')
  offline = false
  account._setDeps({ now: () => Date.now() })
})

test('signing out during sign-in server startup cancels before opening a browser', async () => {
  await activatedAccount({ machineId: 'machine-A' })
  opened = []
  const pending = account.signIn({}, {})
  pending.catch(() => {})
  await account.signOut()
  let timeout
  try {
    await assert.rejects(Promise.race([pending, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Startup cancellation did not finish.')), 500) })]), /Sign-in cancelled/)
  } finally {
    clearTimeout(timeout)
    account.cancelSignIn()
  }
  assert.equal(opened.length, 0)
  assert.equal((await account.status()).state, 'signedOut')
})

test('retry and a status refresh share one in-flight account check', async () => {
  await activatedAccount({ machineId: 'machine-A' })
  saveExistingLicense()
  assert.equal((await account.status()).state, 'allowed')
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  let entered
  const seen = new Promise((resolve) => { entered = resolve })
  let reads = 0
  readHook = async ({ reply, document }) => {
    reads += 1
    if (reads > 1) return reply({ ...document(), fields: { ...document().fields, activated: field(false) } })
    entered()
    await waiting
  }
  const refresh = account.status({ refresh: true })
  await seen
  const retried = account.retry()
  await new Promise((resolve) => setImmediate(resolve))
  release()
  const results = await Promise.all([refresh, retried])
  readHook = null
  assert.equal(reads, 1, 'overlapping checks must not race conflicting state or saved licences')
  assert.deepEqual(results[0], results[1])
})

test('signing out while retry is checking cannot restore access or the licence', async () => {
  await activatedAccount({ machineId: 'machine-A' })
  saveExistingLicense()
  assert.equal((await account.status()).state, 'allowed')
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  let entered
  const seen = new Promise((resolve) => { entered = resolve })
  readHook = async () => { entered(); await waiting }
  const pending = account.retry()
  await seen
  await account.signOut()
  release()
  const result = await pending
  readHook = null
  assert.equal(result.state, 'signedOut')
  assert.equal(account.permits('album.open'), false)
  assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
})

test('automatic sign-in timeout prevents an in-flight callback from saving late access', async () => {
  await activatedAccount({ machineId: 'machine-A' })
  fbAuth.clearSession()
  account._setDeps({ signInTimeoutMs: 60 })
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  let entered
  const seen = new Promise((resolve) => { entered = resolve })
  tokenHook = async () => { entered(); await waiting }
  const signIn = await startSignIn()
  const callback = fetch(`${signIn.back}/?code=good&state=${signIn.state}`)
  try {
    await seen
    await assert.rejects(signIn.done, /Sign-in timed out/)
    release()
    await callback
    assert.equal(account.permits('album.open'), false, 'the timed-out flow cannot grant permission later')
    assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), false)
    assert.equal(fs.existsSync(process.env.CH_SESSION_FILE), false)
  } finally {
    release()
    tokenHook = null
    account._setDeps({ signInTimeoutMs: 3 * 60 * 1000 })
    await account.signOut()
  }
})

test('duplicate OAuth callbacks cannot exchange a second code or overwrite the winning flow', async () => {
  await activatedAccount({ machineId: 'machine-A' })
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  let entered
  const seen = new Promise((resolve) => { entered = resolve })
  let exchanges = 0
  tokenHook = async () => { exchanges++; if (exchanges === 1) { entered(); await waiting } }
  const signIn = await startSignIn()
  const callback = fetch(`${signIn.back}/?code=good&state=${signIn.state}`)
  try {
    await seen
    const duplicate = await fetch(`${signIn.back}/?code=good&state=${signIn.state}`)
    assert.equal(duplicate.status, 409)
    assert.equal(exchanges, 1)
    release()
    await callback
    assert.equal((await signIn.done).state, 'allowed')
    assert.equal(account.permits('album.open'), true)
  } finally {
    release()
    tokenHook = null
    await callback.catch(() => {})
    await account.signOut()
  }
})

test('a duplicate OAuth error cannot cancel a valid callback already being processed', async () => {
  await activatedAccount({ machineId: 'machine-A' })
  let release
  const waiting = new Promise((resolve) => { release = resolve })
  let entered
  const seen = new Promise((resolve) => { entered = resolve })
  tokenHook = async () => { entered(); await waiting }
  const signIn = await startSignIn()
  const callback = fetch(`${signIn.back}/?code=good&state=${signIn.state}`)
  try {
    await seen
    const duplicate = await fetch(`${signIn.back}/?error=access_denied&state=${signIn.state}`)
    assert.equal(duplicate.status, 409)
    release()
    await callback
    const result = await signIn.done
    assert.equal(result.state, 'allowed')
    assert.equal(account.permits('album.open'), true)
    assert.equal(fs.existsSync(process.env.CH_LICENSE_FILE), true)
  } finally {
    release()
    tokenHook = null
    await callback.catch(() => {})
    await account.signOut()
  }
})
