// server/index.js — stateless license-signing endpoint.
//
// POST /sign  { email, name, machineId, expiresOn, activatedOn }
//   → 200 { ...payload, sig }        (Ed25519 over the canonical fields)
//   → 401 without the admin token, 400 on malformed payloads.
//
// Deploy anywhere Node runs (Cloud Function, small VPS). The process needs:
//   LICENSE_SIGNING_KEY_PATH — path to license_signing_key.pem (from keygen.js)
//   LICENSE_ADMIN_TOKEN      — shared secret the owner's activation tool sends
//                              as the x-admin-token header
// It keeps no state: the private key signs whatever the authenticated owner
// submits, and the app verifies offline with the bundled public key.

const http = require('http')
const fs = require('fs')
const { signLicense, SIGNED_FIELDS } = require('../src/license_signing')

// 8787 is a common default and collides with other local dev tools, so default
// to 8791. Override with PORT if needed; the admin panel must point at the same.
const PORT = Number(process.env.PORT || 8791)
const keyPath = process.env.LICENSE_SIGNING_KEY_PATH || `${__dirname}/license_signing_key.pem`
const adminToken = process.env.LICENSE_ADMIN_TOKEN

if (!adminToken) {
  console.error('LICENSE_ADMIN_TOKEN is required')
  process.exit(1)
}
const privateKey = fs.readFileSync(keyPath, 'utf8')

function readBody(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  // The local admin panel is a browser page (http://localhost:PORT), so calls
  // to this signer are cross-origin and carry a custom x-admin-token header —
  // that triggers a CORS preflight we must answer. The server binds to the
  // loopback interface only (see listen below), so it is never exposed to the
  // network regardless of these permissive headers.
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-admin-token')
  res.setHeader('Access-Control-Max-Age', '600')

  const json = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'POST' || req.url !== '/sign') return json(404, { error: 'not found' })
  // timingSafeEqual over hashes so token comparison doesn't leak length.
  const crypto = require('crypto')
  const given = crypto.createHash('sha256').update(String(req.headers['x-admin-token'] || '')).digest()
  const want = crypto.createHash('sha256').update(adminToken).digest()
  if (!crypto.timingSafeEqual(given, want)) return json(401, { error: 'unauthorized' })

  let payload
  try { payload = JSON.parse(await readBody(req)) } catch (_) { return json(400, { error: 'invalid JSON' }) }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return json(400, { error: 'payload must be an object' })
  }
  for (const f of ['email', 'expiresOn']) {
    if (typeof payload[f] !== 'string' || !payload[f]) return json(400, { error: `${f} is required` })
  }
  // Sign only the canonical fields — anything extra is dropped, not signed.
  const license = {}
  for (const f of SIGNED_FIELDS) license[f] = payload[f] === undefined ? null : payload[f]
  return json(200, { ...license, sig: signLicense(license, privateKey) })
})

// Loopback only — reachable from this Mac (the local admin panel), never the network.
server.listen(PORT, '127.0.0.1', () => console.log(`license signer listening on http://127.0.0.1:${PORT} (local only)`))
