# License-signing server

Stateless Ed25519 signer for Album Studio licenses (shared with the earlier Album Toolkit Pro app).
The private key lives only here; the app bundles the public key
(`src/license_public_key.pem`) and verifies licenses fully offline —
unlike the legacy HMAC checksum, nothing shipped with the app can forge
a license.

## One-time setup

```sh
node server/keygen.js        # writes server/license_signing_key.pem (private, gitignored)
                             # and src/license_public_key.pem (bundled)
```

Commit `src/license_public_key.pem`. Back up the private key somewhere safe;
losing it means re-issuing every license against a new keypair.

## Run

```sh
LICENSE_ADMIN_TOKEN=<long random secret> node server/index.js
# optional: LICENSE_SIGNING_KEY_PATH, PORT (default 8787)
```

## Issue a license (owner's activation tool)

```sh
curl -s -X POST http://localhost:8787/sign \
  -H 'x-admin-token: <token>' \
  -H 'content-type: application/json' \
  -d '{"email":"customer@example.com","name":"Customer","machineId":"abc123",
       "expiresOn":"2027-01-01T00:00:00.000Z","activatedOn":"2026-07-11T00:00:00.000Z"}'
```

The response (`{ …fields, sig }`) is what gets stored in the customer's
Firestore user doc / handed to the app; `src/license.js` verifies `sig`
against the bundled public key on every load.

## How it fits together

The owner's admin panel (outside this repository) calls `/sign` when it activates or extends a
licence, and stores the response's `sig`, `licExpiresOn` and `licActivatedOn` in the customer's
Firestore user record. The app signs in to Firebase with Google, reads its own record, and keeps
offline access only for a licence whose `sig` verifies against the bundled public key; an unsigned
record opens the app online only. Firestore rules let only the owner write those fields.

Known limit: the signature covers the customer's `name`, which the app refreshes from Google at
every sign-in, so a Google profile-name change breaks offline verification until the licence is
signed again (Extend in the admin panel does that).
