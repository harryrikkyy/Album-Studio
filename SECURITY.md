# Security & Licensing Notes

This document explains how Creative Hubb Album Toolkit Pro handles sign-in,
licensing, and Firestore access — and how to deploy the database rules that
protect it. Keep it in sync with `firestore.rules` and `src/license.js`.

## Authentication model

The desktop app **does not sign in to Firebase**. The flow is:

1. Google OAuth (local loopback redirect on `127.0.0.1:9842`) is used **only**
   to read the user's email + profile.
2. The app then calls the **Firestore REST API** with the public `FIREBASE_API_KEY`
   to read/write the user's `/users/{userKey}` document.

Because there is no Firebase Auth session, every request the app makes has
`request.auth == null`. The security rules are therefore written to gate
reads/creates/updates on **data shape**, not on auth — see `firestore.rules`.

The **owner's activation tool** is the only thing that may flip `activated` or
set `expiresOn`. It must either:

- authenticate to Firebase Auth as `creativehubb2@gmail.com`, or
- use the Firebase **Admin SDK** (which bypasses security rules entirely).

## What the app writes

The app performs exactly three Firestore writes, all verified to pass the rules:

| Operation              | Fields written                                       |
|------------------------|------------------------------------------------------|
| New-user first login   | email, name, photoURL, lastLogin, `activated:false`  |
| Returning-user login   | email, name, photoURL, lastLogin                     |
| Machine lock           | machineId, machineName (only when currently unbound) |

The document id (`userKey`) is the email with `.` replaced by `_`
(see `emailToUserKey()` in `app.js`). **This transform must stay byte-for-byte
in sync with the activation tool.** Changing it would orphan every existing
activated account.

## Deploying the rules

The rules live in version control at [`firestore.rules`](./firestore.rules).

- Firebase Console → Firestore Database → **Rules** tab → paste → **Publish**, or
- `firebase deploy --only firestore:rules` (Firebase CLI).

The rules close two attacks that the naive ruleset left open:

1. **Self-activation bypass** — `create` now requires `activated:false` and no
   `expiresOn`, so nobody can craft a pre-activated doc and skip payment.
2. **License theft** — `update` may only set `machineId` when it is empty; an
   attacker can't repoint another user's license at their own machine. The
   owner can still move a machine via the owner-write rule.

## Known, accepted tradeoff

`allow read: if true` exposes user docs (email, machine name, photo URL) to
anyone holding the API key. This is inherent to the app not using Firebase
Auth. Closing it requires real per-user authentication, which is a much larger
change than this distribution warrants. It is a conscious decision, recorded
here so it is not mistaken for an oversight.

## Local license (offline)

When offline, the app falls back to a signed local license file at
`~/.ch_toolkit_license`, validated by `validateOfflineLicense()` in
`src/license.js` (HMAC-SHA256 over the payload). The signing secret comes from
`LICENSE_SECRET_KEY`.

> **Before distributing a build, set a real `LICENSE_SECRET_KEY` in `.env`.**
> The in-source fallback secret is forgeable; the app logs a warning at startup
> when it is used.

## Environment variables

See `.env.example`. The security-relevant ones:

- `FIREBASE_API_KEY` — public Firestore REST key.
- `FIREBASE_PROJECT_ID` — Firestore project (defaults to `creative-hubb-toolkit`).
- `LICENSE_SECRET_KEY` — **must** be set to a strong secret before distribution.
- Google OAuth client id/secret — from the Google Cloud Console. The redirect
  URI `http://127.0.0.1:9842` must be registered there.
