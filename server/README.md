# License-signing server

Stateless Ed25519 signer for Creative Hubb Album Toolkit Pro licenses.
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

## Still to do (needs the owner's Firebase project)

- Point the activation flow at this signer and store `sig` in user docs.
- Real Firebase Auth sign-in in the app, then tighten `firestore.rules`
  off `read: if true`.
