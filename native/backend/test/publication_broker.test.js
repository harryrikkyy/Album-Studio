'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const readline = require('node:readline')
const { spawn } = require('node:child_process')
const { tmpdir } = require('./fixtures')
const { acquireOutputLease } = require('../lib/output_lock')
const { fingerprintFile } = require('../lib/file_publication')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function frame(value) { const b = Buffer.from(JSON.stringify(value)), h = Buffer.alloc(4); h.writeUInt32BE(b.length); return Buffer.concat([h, b]) }
function fixture(t) {
  const root = tmpdir(), output = path.join(root, 'Sheets'), target = path.join(output, 'manual.psd'), old = Buffer.from('customer bytes'), next = Buffer.from('saved document bytes')
  fs.mkdirSync(output); fs.writeFileSync(target, old)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, output, target, old, next }
}
function worker(t, request) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server.js'), '--native-publication'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = readline.createInterface({ input: child.stdout }), queued = [], waiting = []
  let stderr = '', exited = false
  child.stdin.on('error', () => {}) // Failed admission may close input before the sender observes the reply.
  lines.on('line', line => { const value = JSON.parse(line); if (waiting.length) waiting.shift()(value); else queued.push(value) })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  const exit = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => { exited = true; resolve(code) }) })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
  t.after(async () => { clearTimeout(timeout); if (!exited) child.kill('SIGKILL'); await exit; lines.close() })
  child.stdin.write(frame(request))
  return { child, async next() {
    if (queued.length) return queued.shift()
    return Promise.race([new Promise(resolve => waiting.push(resolve)), exit.then(() => { if (queued.length) return queued.shift(); throw new Error(`Broker exited before its reply: ${stderr}`) })])
  }, exit }
}
const request = (f, expected = { mode: 'overwrite' }) => ({ version: 1, target: f.target, expected })
function payload(w, f) { w.child.stdin.write(frame({ length: f.next.length, digest: sha(f.next) })); w.child.stdin.write(f.next) }

test('the actual private worker streams bytes, waits for commit and returns exact publication receipt', async t => {
  const f = fixture(t), w = worker(t, request(f))
  assert.equal((await w.next()).state, 'ready')
  payload(w, f)
  assert.equal((await w.next()).state, 'prepared')
  assert.deepEqual(fs.readFileSync(f.target), f.old)
  w.child.stdin.end(frame({ commit: true }))
  const r = await w.next()
  assert.equal(r.state, 'committed'); assert.equal(r.result.records[0].digest, sha(f.next))
  assert.equal(await w.exit, 0); assert.deepEqual(fs.readFileSync(f.target), f.next)
})
test('worker admission respects a managed output lease before accepting any encoded bytes', async t => {
  const f = fixture(t), outputs = await acquireOutputLease(f.output)
  try {
    const w = worker(t, request(f)), r = await w.next()
    assert.equal(r.state, 'failed'); assert.equal(r.error.code, 'PROJECT_BUSY')
    assert.equal(await w.exit, 1); assert.deepEqual(fs.readFileSync(f.target), f.old)
  } finally { await outputs.release() }
})
test('earlier decoder source and exact inode records are checked instead of rebasing onto current bytes', async t => {
  for (const mode of ['source', 'exact', 'new']) {
    const f = fixture(t), record = await fingerprintFile(f.target)
    const expected = mode === 'source' ? { mode, digest: record.digest, size: record.size } : mode === 'exact' ? { mode, record } : { mode }
    if (mode === 'source') fs.writeFileSync(f.target, 'a later manual edit')
    if (mode === 'exact') { fs.renameSync(f.target, path.join(f.root, 'earlier')); fs.copyFileSync(path.join(f.root, 'earlier'), f.target) }
    const before = fs.readFileSync(f.target), w = worker(t, request(f, expected)), r = await w.next()
    assert.equal(r.state, 'failed'); assert.equal(r.error.code, 'PUBLICATION_CONFLICT')
    assert.equal(await w.exit, 1); assert.deepEqual(fs.readFileSync(f.target), before)
  }
})
for (const at of ['ready', 'partial', 'prepared']) test(`parent disconnect at ${at} cannot publish`, async t => {
  const f = fixture(t), w = worker(t, request(f))
  assert.equal((await w.next()).state, 'ready')
  if (at === 'partial') { w.child.stdin.write(frame({ length: f.next.length + 1, digest: sha(f.next) })); w.child.stdin.write(f.next) }
  if (at === 'prepared') { payload(w, f); assert.equal((await w.next()).state, 'prepared') }
  w.child.stdin.end()
  const r = await w.next()
  assert.equal(r.state, 'failed'); assert.equal(r.error.code, 'PUBLICATION_PROTOCOL')
  assert.equal(await w.exit, 1); assert.deepEqual(fs.readFileSync(f.target), f.old)
})
test('a manual edit after preparation is preserved with typed recovery metadata', async t => {
  const f = fixture(t), w = worker(t, request(f))
  await w.next(); payload(w, f); await w.next()
  fs.writeFileSync(f.target, 'manual edit during save preparation')
  w.child.stdin.end(frame({ commit: true }))
  const r = await w.next()
  assert.equal(r.state, 'failed'); assert.equal(r.error.code, 'PUBLICATION_CONFLICT')
  assert.equal(await w.exit, 1); assert.equal(fs.readFileSync(f.target, 'utf8'), 'manual edit during save preparation')
})
test('bad payload hashes and trailing commands fail without publishing', async t => {
  for (const kind of ['hash', 'trailing']) {
    const f = fixture(t), w = worker(t, request(f))
    await w.next()
    w.child.stdin.write(frame({ length: f.next.length, digest: sha(kind === 'hash' ? 'wrong bytes' : f.next) })); w.child.stdin.write(f.next)
    if (kind === 'trailing') { assert.equal((await w.next()).state, 'prepared'); w.child.stdin.end(Buffer.concat([frame({ commit: true }), Buffer.from('extra command')])) }
    const r = await w.next()
    assert.equal(r.state, 'failed'); assert.equal(r.error.code, 'PUBLICATION_PROTOCOL')
    w.child.stdin.end()
    assert.equal(await w.exit, 1); assert.deepEqual(fs.readFileSync(f.target), f.old)
  }
})
test('the real worker accepts a multi-chunk document larger than the GUI JSON frame limit', async t => {
  const f = fixture(t), w = worker(t, request(f)), { once } = require('node:events')
  assert.equal((await w.next()).state, 'ready')
  const chunk = Buffer.alloc(1024 * 1024, 0x79), suffix = Buffer.from('document end marker'), count = 9
  const hash = crypto.createHash('sha256')
  for (let i = 0; i < count; i++) hash.update(chunk)
  const digest = hash.update(suffix).digest('hex'), length = chunk.length * count + suffix.length
  w.child.stdin.write(frame({ length, digest }))
  for (let i = 0; i < count; i++) if (!w.child.stdin.write(chunk)) await once(w.child.stdin, 'drain')
  w.child.stdin.write(suffix)
  assert.equal((await w.next()).state, 'prepared')
  assert.deepEqual(fs.readFileSync(f.target), f.old)
  w.child.stdin.end(frame({ commit: true }))
  const r = await w.next()
  assert.equal(r.state, 'committed'); assert.equal(r.result.records[0].size, String(length)); assert.equal(r.result.records[0].digest, digest)
  assert.equal(await w.exit, 0); assert.equal((await fingerprintFile(f.target)).digest, digest)
})
test('exact revision checks ignore incidental access time and JSON property order', async t => {
  const f = fixture(t), record = await fingerprintFile(f.target)
  record.atimeMs += 1234
  const reordered = Object.fromEntries(Object.entries(record).reverse()), w = worker(t, request(f, { mode: 'exact', record: reordered }))
  assert.equal((await w.next()).state, 'ready')
  payload(w, f); assert.equal((await w.next()).state, 'prepared')
  w.child.stdin.end(frame({ commit: true }))
  const r = await w.next()
  assert.equal(r.state, 'committed'); assert.equal(await w.exit, 0)
  assert.ok(fs.existsSync(path.join(r.result.inputHistory, 'source')))
  const lease = await require('../lib/namespace_lock').acquirePublicationDirectories([f.target])
  try { assert.deepEqual((await require('../lib/file_publication').recoverFiles(f.output, lease)).orphanStages, []) }
  finally { await lease.release() }
})
test('malformed Unicode target names cannot alias a different replacement-character file', async t => {
  const f = fixture(t), target = path.join(f.output, 'bad-\ufffd.psd')
  fs.writeFileSync(target, f.old)
  const w = worker(t, { ...request(f), target: path.join(f.output, 'bad-\ud800.psd') }), r = await w.next()
  assert.equal(r.state, 'failed'); assert.equal(r.error.code, 'PUBLICATION_PROTOCOL'); assert.equal(await w.exit, 1)
  assert.deepEqual(fs.readFileSync(target), f.old)
})
