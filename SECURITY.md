# Security & Licensing Notes

This document explains how Album Studio handles sign-in, licensing, and
Firestore access — and how to deploy the database rules that protect it.
Licences are shared with the earlier Album Toolkit Pro app. Keep it in sync with `firestore.rules` and `src/license.js`.

## Authentication model

The desktop app **signs in to Firebase with Google**. The flow is:

1. Google OAuth (local loopback redirect on `127.0.0.1:9842`, with PKCE) reads
   the user's email + profile and returns a Google ID token.
2. The app exchanges that token for a Firebase session (Identity Toolkit
   `accounts:signInWithIdp`) and sends the Firebase ID token with every
   **Firestore REST API** call on the user's `/users/{userKey}` document.

So every request the app makes carries `request.auth`, with the user's
Google-verified email. The security rules scope each read and write to the
signed-in user's own record, and gate creates/updates on **data shape** as
well — see `firestore.rules`.

The **owner's activation tool** is the only thing that may flip `activated` or
set `expiresOn`. It must either:

- authenticate to Firebase Auth as `creativehubb2@gmail.com`, with a verified
  email (Google sign-in reports Gmail addresses as verified), or
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

The rules close three attacks that the naive ruleset left open:

1. **Self-activation bypass** — `create` now requires `activated:false` and no
   `expiresOn`, so nobody can craft a pre-activated doc and skip payment.
2. **License theft** — `update` may only set `machineId` when it is empty; an
   attacker can't repoint another user's license at their own machine. The
   owner can still move a machine via the owner-write rule.
3. **Email impersonation** — every rule that trusts the signed-in email,
   including the owner's, requires `email_verified`. A password account
   registered with someone else's address cannot read their record, claim
   their machine binding or act as the owner.

## Read access

A signed-in user can read only their own record, and only the owner can list
the collection. Earlier rules allowed `read: if true`, which exposed every user
doc (email, machine name, photo URL) to anyone holding the public API key; the
app's Firebase sign-in closed that, so do not reopen it.

## Local license (offline)

When offline, the app falls back to a local license file at
`~/.ch_toolkit_license`, validated by `validateOfflineLicense()` in
`src/license.js`. Only a license signed by the license server (`server/`,
Ed25519 over the canonical fields) is accepted. The app verifies it with the
bundled public key `src/license_public_key.pem`; the private key never ships.

A Firestore record without a signature opens the app online only. Licenses
saved by older builds carry an HMAC checksum whose secret shipped inside the
app, so they are no longer accepted. Those customers need one online check,
and offline access again needs a signed record: re-issue it with `server/`.

## Environment variables

See `.env.example`. The security-relevant ones:

- `FIREBASE_API_KEY` — public Firestore REST key.
- `FIREBASE_PROJECT_ID` — Firestore project (defaults to `creative-hubb-toolkit`).
- Google OAuth client id/secret — from the Google Cloud Console. The redirect
  URI `http://127.0.0.1:9842` must be registered there.
