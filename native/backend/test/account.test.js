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
  LICENSE_SECRET_KEY: 'test-licence-key',
})
delete process.env.ALBUM_STUDIO_ACCOUNT

const account = require('../lib/account')
const { dispatch } = require('../server')

// Google and Firestore, as far as the sign-in uses them. `docs` holds user records by key.
const docs = new Map()
const calls = []
let offline = false
const day = 24 * 3600 * 1000
const field = (v) => (typeof v === 'boolean' ? { booleanValue: v } : { stringValue: v })

async function fakeFetch(url, init = {}) {
  if (offline) throw new TypeError('fetch failed')
  const u = new URL(url)
  const method = init.method || 'GET'
  calls.push(`${method} ${u.hostname}${u.pathname}`)
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status })
  if (u.hostname === 'oauth2.googleapis.com') {
    const p = new URLSearchParams(init.body)
    assert.equal(p.get('client_secret'), 'test-secret')
    return p.get('code') === 'good' ? reply({ access_token: 'access', id_token: 'google-id' }) : reply({ error: 'invalid_grant' }, 400)
  }
  if (u.pathname === '/oauth2/v2/userinfo') return reply({ email: 'ana@studio.in', name: 'Ana Rao', picture: '' })
  if (u.hostname === 'identitytoolkit.googleapis.com') return reply({ idToken: 'fb-id', refreshToken: 'fb-refresh', email: 'ana@studio.in', expiresIn: '3600' })
  if (u.hostname === 'firestore.googleapis.com') {
    assert.equal(init.headers?.Authorization, 'Bearer fb-id', 'every record read and write is authenticated')
    const key = decodeURIComponent(u.pathname.split('/users/')[1])
    if (method === 'GET') return docs.has(key) ? reply({ fields: docs.get(key) }) : reply({ error: { code: 404 } }, 404)
    const mask = u.searchParams.getAll('updateMask.fieldPaths')
    const sent = JSON.parse(init.body).fields
    const doc = docs.get(key) || {}
    for (const f of mask) doc[f] = sent[f]
    docs.set(key, doc)
    return reply({ fields: doc })
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
  const url = new URL(await seen)
  return { done, back: url.searchParams.get('redirect_uri'), state: url.searchParams.get('state') }
}

test('signed out with nothing saved: only account and system calls are answered', async () => {
  assert.deepEqual(await account.status(), { state: 'signedOut', configured: true })
  assert.equal(account.permits('album.open'), false)
  assert.equal(account.permits('account.signIn'), true)
  assert.equal(account.permits('system.ping'), true)

  const out = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = (s) => { out.push(JSON.parse(String(s))); return true }
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
  const doc = docs.get('ana@studio_in')
  Object.assign(doc, { activated: field(true), expiresOn: { timestampValue: new Date(Date.now() + 30 * day).toISOString() } })
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
