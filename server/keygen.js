#!/usr/bin/env node
// keygen.js — generate the Ed25519 license-signing keypair.
//
//   node server/keygen.js
//
// Writes license_signing_key.pem (PRIVATE — stays on the signing server /
// owner machine, gitignored) into server/, and license_public_key.pem
// (bundled with the app) into src/. Run once; re-running refuses to
// overwrite an existing private key.

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const privPath = path.join(__dirname, 'license_signing_key.pem')
const pubPath = path.join(__dirname, '..', 'src', 'license_public_key.pem')

if (fs.existsSync(privPath)) {
  console.error(`Refusing to overwrite existing private key: ${privPath}`)
  process.exit(1)
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }))

console.log(`private key → ${privPath}  (keep this OFF the repo and OFF user machines)`)
console.log(`public key  → ${pubPath}  (bundled with the app)`)
