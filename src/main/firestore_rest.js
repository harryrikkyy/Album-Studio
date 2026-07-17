// firestore_rest.js — shared helpers for talking to Firestore over REST.
//
// Extracted from app.js (Phase: app.js split). The env values are read
// lazily inside each call — NOT at module load — so require-order relative
// to the .env loader can never silently produce an empty API key.

const fbAuth = require('../firebase_auth')

function projectId() { return process.env.FIREBASE_PROJECT_ID || 'creative-hubb-toolkit' }
function apiKey() { return process.env.FIREBASE_API_KEY || '' }

// Build a Firestore REST path. `mask` is the list of `updateMask.fieldPaths`
// values. Centralizing this kills the previously hardcoded API key duplication.
function firestorePath(suffix, mask = []) {
  const base = `/v1/projects/${projectId()}/databases/(default)/documents`
  const m = mask.length ? '&' + mask.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&') : ''
  return `${base}${suffix}?key=${apiKey()}${m}`
}

// Firebase Auth session — turns the Google sign-in into an authenticated
// Firestore session so the security rules can scope each read to its own user.
// Returns {} when there is no valid session (e.g. offline), letting callers
// degrade to the offline license path instead of firing an unauthed request.
async function firestoreAuthHeaders() {
  try {
    const token = await fbAuth.getValidIdToken(apiKey())
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch (_) { return {} }
}

// R3: derive the Firestore document id from an email in ONE place. Previously
// the `email.replace(/\./g, '_')` transform was copy-pasted in three spots,
// so any future change risked them drifting apart and looking up different
// docs for the same user. NOTE: this transform must stay byte-for-byte in sync
// with the owner's external activation tool — do not change it without also
// migrating existing Firestore docs (e.g. a@b.c and a_b_c would collide, but
// changing the scheme would orphan every already-activated account).
function emailToUserKey(email) {
  return String(email || '').replace(/\./g, '_')
}

// ⚡ Task 5.1: safe JSON parse for HTTPS response bodies. An unguarded
// JSON.parse inside a response.on('end') callback throws synchronously inside
// the event emitter — a non-JSON 500 page or a truncated body would crash the
// MAIN process (taking the whole app down). This returns a fallback instead.
function safeJsonParse(str, fallback = null) {
  try { return JSON.parse(str) } catch (_) { return fallback }
}

module.exports = {
  apiKey,
  firestorePath,
  firestoreAuthHeaders,
  emailToUserKey,
  safeJsonParse,
}
