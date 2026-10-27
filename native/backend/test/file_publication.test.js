'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { tmpdir } = require('./fixtures')
const { publishFiles, recoverFiles, fingerprintFile } = require('../lib/file_publication')
const exclusive = require('../lib/exclusive_rename')
const modulePath = require.resolve('../lib/file_publication')
const exclusivePath = require.resolve('../lib/exclusive_rename')
const sha = b => crypto.createHash('sha256').update(b).digest('hex')
// Transaction mechanics tests inject domain capabilities. Namespace/process identity
// acceptance lives in namespace_lock/output_isolation and the native integration tests.
const caps = { assertOwned: async () => {}, assertTarget: async () => {} }
function fixture(t) {
  const root = tmpdir(), folder = path.join(root, 'Output'), source = path.join(root, 'next.psd')
  fs.mkdirSync(folder)
  const file = path.join(folder, 'manual.psd'), old = Buffer.from('customer manual layers'), next = Buffer.from('encoded native revision')
  fs.writeFileSync(file, old); fs.writeFileSync(source, next)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, folder, source, file, old, next }
}
async function input(f) { return { folder: f.folder, entries: [{ name: 'manual.psd', source: f.source, sourceDigest: sha(f.next), before: await fingerprintFile(f.file) }] } }
const stages = f => fs.readdirSync(path.join(f.folder, '.album-studio-publications')).filter(n => /^files-/.test(n)).map(n => path.join(f.folder, '.album-studio-publications', n))
function history(f) { const folder = path.join(f.folder, '.album-studio-publications/history'); return fs.existsSync(folder) ? fs.readdirSync(folder).map(n => path.join(folder, n)) : [] }
function killAt(f, p, point) {
  const code = `
    const fs = require('fs'), path = require('path'), ex = require(${JSON.stringify(exclusivePath)}), move = ex.renameExclusive;
    const p = JSON.parse(process.argv[1]), point = process.argv[2];
    ex.renameExclusive = async (from, to) => {
      const r = await move(from, to);
      const hit = point === 'journal' && path.basename(to).startsWith('files-') && !to.includes('/history/')
        || point === 'captured' && path.basename(to) === 'captured-0'
        || point === 'installed' && path.basename(from) === 'install-0'
        || point === 'installed-second' && path.basename(from) === 'install-1'
        || point === 'commit' && path.basename(to) === 'commit.json'
        || point === 'history' && to.includes('/history/');
      if (hit) process.kill(process.pid, 'SIGKILL');
      return r;
    };
    require(${JSON.stringify(modulePath)}).publishFiles(p, {assertOwned:async()=>{},assertTarget:async()=>{}})
      .then(()=>process.exit(2),e=>{console.error(e);process.exit(3)});
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, JSON.stringify(p), point], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Publication crash fixture timed out.')) }, 15000)
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timeout); try { assert.equal(signal, 'SIGKILL', stderr); resolve() } catch (error) { reject(error) } })
  })
}

test('commits a native document and companion file with exact detached history and receipts', async t => {
  const f = fixture(t), p = await input(f)
  p.entries.push({ name: 'new-proof.txt', source: f.source, sourceDigest: sha(f.next), before: null })
  const r = await publishFiles(p, caps)
  assert.equal(r.committed, true); assert.equal(r.records.length, 2)
  assert.deepEqual(fs.readFileSync(f.file), f.next)
  assert.deepEqual(fs.readFileSync(path.join(f.folder, 'new-proof.txt')), f.next)
  assert.deepEqual(fs.readFileSync(path.join(r.historyPath, 'old-0')), f.old)
  assert.deepEqual(fs.readFileSync(path.join(r.historyPath, 'next-0')), f.next)
  assert.notEqual(fs.statSync(f.file).ino, fs.statSync(path.join(r.historyPath, 'next-0')).ino)
  fs.writeFileSync(f.file, 'subsequent external edit')
  assert.deepEqual((await recoverFiles(f.folder, caps)).recovered, [])
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'subsequent external edit')
})
test('requires exact earlier target identity, staged bytes and authority before publication', async t => {
  for (const kind of ['revision', 'inode', 'source', 'absent', 'capability']) {
    const f = fixture(t), p = await input(f)
    if (kind === 'revision') fs.writeFileSync(f.file, 'new customer contents')
    if (kind === 'inode') { fs.renameSync(f.file, path.join(f.root, 'original')); fs.copyFileSync(path.join(f.root, 'original'), f.file) }
    if (kind === 'source') fs.writeFileSync(f.source, 'different encoder output')
    if (kind === 'absent') p.entries[0].before = null
    const prior = fs.readFileSync(f.file)
    await assert.rejects(publishFiles(p, kind === 'capability' ? {} : caps), /revision|source|capabilit/i)
    assert.deepEqual(fs.readFileSync(f.file), prior)
    assert.equal(history(f).length, 0)
  }
})
test('rejects duplicate, escaping, reserved and unbounded entry identities', async t => {
  const f = fixture(t), p = await input(f)
  for (const name of ['..', '../elsewhere', 'child/file', '.album-studio-publications', 'nul\0name', 'long'.repeat(70)]) {
    await assert.rejects(publishFiles({ ...p, entries: [{ ...p.entries[0], name }] }, caps), /distinct file names/)
  }
  await assert.rejects(publishFiles({ ...p, entries: [p.entries[0], p.entries[0]] }, caps), /distinct file names/)
  assert.deepEqual(fs.readFileSync(f.file), f.old)
})
test('cancellation after installation restores the exact old batch and retains both revisions', async t => {
  const f = fixture(t), p = await input(f), rename = exclusive.renameExclusive
  let stopped = false
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => { const r = await rename(from, to); if (path.basename(from) === 'install-0') stopped = true; return r })
  await assert.rejects(publishFiles(p, { ...caps, isCancelled: () => stopped }), error => error.code === 'PUBLICATION_CANCELLED' && error.publicationRestored && !error.publicationCommitted && fs.existsSync(error.recoveryJournal))
  assert.deepEqual(fs.readFileSync(f.file), f.old)
  assert.equal(history(f).length, 1)
  assert.deepEqual(fs.readFileSync(path.join(history(f)[0], 'next-0')), f.next)
})
for (const point of ['journal', 'captured', 'installed', 'commit', 'history']) test(`SIGKILL at ${point} recovers idempotently and keeps detached history`, async t => {
  const f = fixture(t), p = await input(f)
  await killAt(f, p, point)
  const committed = ['commit', 'history'].includes(point)
  const r = await recoverFiles(f.folder, caps)
  assert.deepEqual(fs.readFileSync(f.file), committed ? f.next : f.old)
  assert.equal(r.recovered.length, point === 'history' ? 0 : 1)
  if (r.recovered.length) assert.equal(r.recovered[0].state, committed ? 'committed' : 'restored')
  assert.deepEqual((await recoverFiles(f.folder, caps)).recovered, [])
  assert.equal(history(f).length, 1)
  assert.deepEqual(fs.readFileSync(path.join(history(f)[0], 'old-0')), f.old)
  assert.deepEqual(fs.readFileSync(path.join(history(f)[0], 'next-0')), f.next)
})
test('recovery refuses a later customer edit and preserves every retained revision', async t => {
  const f = fixture(t), p = await input(f)
  await killAt(f, p, 'installed')
  fs.writeFileSync(f.file, 'manual edit after interrupted native save')
  await assert.rejects(recoverFiles(f.folder, caps), error => error.code === 'PUBLICATION_CONFLICT' && !error.publicationCommitted && fs.existsSync(error.recoveryJournal))
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'manual edit after interrupted native save')
  const stage = stages(f)[0]
  assert.deepEqual(fs.readFileSync(path.join(stage, 'old-0')), f.old)
  assert.deepEqual(fs.readFileSync(path.join(stage, 'next-0')), f.next)
})
test('committed recovery preserves subsequent customer edits', async t => {
  const f = fixture(t), p = await input(f)
  await killAt(f, p, 'commit')
  fs.writeFileSync(f.file, 'later committed document edits')
  const r = await recoverFiles(f.folder, caps)
  assert.equal(r.recovered[0].state, 'committed')
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'later committed document edits')
})
for (const point of ['capture', 'install']) test(`a competing manual edit at ${point} is never overwritten`, async t => {
  const f = fixture(t), p = await input(f), rename = exclusive.renameExclusive
  const manual = Buffer.from(`manual customer ${point} bytes`)
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    if (point === 'capture' && from === f.file) fs.writeFileSync(from, manual)
    if (point === 'install' && to === f.file && path.basename(from) === 'install-0') fs.writeFileSync(to, manual, { flag: 'wx' })
    return rename(from, to)
  })
  await assert.rejects(publishFiles(p, caps), error => !!error.recoveryRequired && !error.publicationCommitted)
  assert.deepEqual(fs.readFileSync(f.file), manual)
  assert.equal(stages(f).length, 1)
  assert.deepEqual(fs.readFileSync(path.join(stages(f)[0], 'old-0')), f.old)
})
test('a substituted identical-byte commit inode cannot certify a pending transaction', async t => {
  const f = fixture(t), p = await input(f), rename = exclusive.renameExclusive
  let substituted = false
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    if (!substituted && path.basename(from) === 'commit.part.json') {
      substituted = true
      const bytes = fs.readFileSync(from)
      fs.renameSync(from, path.join(path.dirname(from), 'reserved-marker-evidence'))
      fs.writeFileSync(from, bytes, { flag: 'wx', mode: 0o400 })
    }
    return rename(from, to)
  })
  await assert.rejects(publishFiles(p, caps), error => !error.publicationCommitted && error.recoveryRequired)
  assert.equal(stages(f).length, 1)
  await assert.rejects(recoverFiles(f.folder, caps), /identity|unexpected/)
})
test('large document publication streams beyond the metadata buffer limit with bounded allocations', async t => {
  const f = fixture(t), length = 65 * 1024 * 1024 + 1
  fs.truncateSync(f.source, length)
  const source = await fingerprintFile(f.source), p = await input(f)
  p.entries[0].sourceDigest = source.digest
  const allocate = Buffer.alloc, allocations = []
  t.mock.method(Buffer, 'alloc', function (size, ...rest) {
    allocations.push(size)
    assert.ok(size <= 2 * 1024 * 1024, `unbounded document allocation: ${size}`)
    return allocate.call(this, size, ...rest)
  })
  const r = await publishFiles(p, caps)
  assert.equal(r.records[0].size, String(length)); assert.equal(r.records[0].digest, source.digest)
  assert.equal((await fingerprintFile(f.file)).digest, source.digest)
  assert.ok(allocations.includes(1024 * 1024)); assert.deepEqual(fs.readFileSync(path.join(r.historyPath, 'old-0')), f.old)
})
test('a killed two-file publication restores both old revisions before accepting another batch', async t => {
  const f = fixture(t), p = await input(f), second = path.join(f.folder, 'companion.txt'), old = Buffer.from('existing companion bytes')
  fs.writeFileSync(second, old)
  p.entries.push({ name: 'companion.txt', source: f.source, sourceDigest: sha(f.next), before: await fingerprintFile(second) })
  await killAt(f, p, 'installed-second')
  assert.deepEqual(fs.readFileSync(second), f.next)
  const r = await recoverFiles(f.folder, caps)
  assert.equal(r.recovered[0].state, 'restored')
  assert.deepEqual(fs.readFileSync(f.file), f.old); assert.deepEqual(fs.readFileSync(second), old)
  assert.deepEqual(fs.readFileSync(path.join(r.recovered[0].historyPath, 'old-1')), old)
})
test('target-specific capabilities receive real publication names without a synthetic sentinel', async t => {
  const f = fixture(t), p = await input(f), checked = []
  const r = await publishFiles(p, { ...caps, assertTarget: async target => { checked.push(target); assert.equal(target, f.file) } })
  assert.equal(r.committed, true); assert.ok(checked.length > 1)
})
test('filesystem-valid Unicode names preserve normal native save behaviour', async t => {
  const f = fixture(t), p = await input(f), name = '图'.repeat(process.platform === 'darwin' ? 100 : 60) + '.psd'
  const target = path.join(f.folder, name)
  fs.writeFileSync(target, 'existing Unicode document')
  p.entries = [{ ...p.entries[0], name, before: await fingerprintFile(target) }]
  const r = await publishFiles(p, caps)
  assert.equal(r.committed, true); assert.deepEqual(fs.readFileSync(target), f.next)
})

async function payloadBytesRead(t, run) {
  const open = fs.promises.open, owners = new WeakMap(), probe = await open(__filename), proto = Object.getPrototypeOf(probe)
  await probe.close()
  const read = proto.read; let bytes = 0
  t.mock.method(fs.promises, 'open', async (file, ...args) => { const handle = await open(file, ...args); owners.set(handle, String(file)); return handle })
  t.mock.method(proto, 'read', async function (...args) { const result = await read.apply(this, args); if (!/\.json$/.test(owners.get(this) || '')) bytes += result.bytesRead; return result })
  try { await run() } finally { t.mock.restoreAll() }
  return bytes
}
test('a batch hashes each retained file once, so its reads per byte do not grow with the batch', async t => {
  const size = 1024 * 1024, root = tmpdir(), folder = path.join(root, 'Output')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(folder)
  // Reads per payload byte, one pass each because every read is checked against a known digest: the
  // source gate, each detached copy's source and copy, and the public batch before commit. A repeated
  // publication adds the previous revision, its detached copy and the captured original.
  for (const count of [1, 3]) {
    const batch = (tag, repeated) => Promise.all(Array.from({ length: count }, async (_, i) => {
      const name = `batch-${count}-${i}.psd`, source = path.join(root, `${tag}-${count}-${i}.bin`), bytes = crypto.randomBytes(size)
      fs.writeFileSync(source, bytes)
      return { name, source, sourceDigest: sha(bytes), before: repeated ? await fingerprintFile(path.join(folder, name)) : null }
    }))
    for (const [tag, repeated, budget] of [['first', false, 6], ['again', true, 10]]) {
      const entries = await batch(tag, repeated)
      const reads = await payloadBytesRead(t, () => publishFiles({ folder, entries }, caps)) / (count * size)
      assert.ok(reads <= budget, `a ${repeated ? 'repeated' : 'first'} ${count}-file publication read each byte ${reads} times; the budget is ${budget}`)
      for (const entry of entries) assert.equal(sha(fs.readFileSync(path.join(folder, entry.name))), entry.sourceDigest)
    }
  }
})
function replaceWith(file, bytes) { const temp = path.join(path.dirname(file), '.replacement'); fs.writeFileSync(temp, bytes); fs.renameSync(temp, file); return fs.statSync(file).ino }
test('a public file replaced after its revision gate stays published instead of being captured', async t => {
  const f = fixture(t), p = await input(f), move = exclusive.renameExclusive
  let node
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    const result = await move(from, to)
    if (/^files-/.test(path.basename(to)) && !node) node = replaceWith(f.file, 'replacement saved by another app')
    return result
  })
  await assert.rejects(publishFiles(p, caps), /public revision of manual\.psd/)
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'replacement saved by another app')
  assert.equal(fs.statSync(f.file).ino, node)
})
test('a public file replaced after its install stops the batch before the next file is captured', async t => {
  const f = fixture(t), p = await input(f), move = exclusive.renameExclusive, second = path.join(f.folder, 'second.psd')
  fs.writeFileSync(second, 'second customer layers')
  p.entries.push({ name: 'second.psd', source: f.source, sourceDigest: sha(f.next), before: await fingerprintFile(second) })
  const secondNode = fs.statSync(second).ino, open = fs.promises.open, folder = fs.realpathSync(f.folder)
  let installed = false, replaced = false
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => { const result = await move(from, to); if (path.basename(from) === 'install-0') installed = true; return result })
  t.mock.method(fs.promises, 'open', async (name, ...args) => {
    // The install's folder sync runs after its rename is verified and before the identity check.
    if (installed && !replaced && name === folder) { replaced = true; replaceWith(f.file, 'replacement saved by another app') }
    return open(name, ...args)
  })
  await assert.rejects(publishFiles(p, caps), /installed revision of manual\.psd/)
  assert.equal(fs.statSync(second).ino, secondNode)
  assert.equal(fs.readFileSync(second, 'utf8'), 'second customer layers')
})
test('each file keeps only its newest committed publication history, and other files keep theirs', async t => {
  const f = fixture(t), other = path.join(f.folder, 'other.psd'), versions = [Buffer.from('second revision'), Buffer.from('third revision')]
  fs.writeFileSync(other, 'other customer layers')
  await publishFiles(await input(f), caps)
  const kept = await publishFiles({ folder: f.folder, entries: [{ name: 'other.psd', source: f.source, sourceDigest: sha(f.next), before: await fingerprintFile(other) }] }, caps)
  const publish = async (bytes, capabilities = caps) => {
    fs.writeFileSync(f.source, bytes)
    return publishFiles({ folder: f.folder, entries: [{ name: 'manual.psd', source: f.source, sourceDigest: sha(bytes), before: await fingerprintFile(f.file) }] }, capabilities)
  }
  let stopped = false
  const stop = { ...caps, validateSnapshot: async () => { if (!stopped && stages(f).length) { stopped = true; throw new Error('injected stop after exposure') } } }
  await assert.rejects(publish(Buffer.from('abandoned revision'), stop), /injected stop after exposure/)
  const restored = history(f).find(h => !fs.existsSync(path.join(h, 'commit.json')))
  assert.ok(restored, 'the stopped publication left a restored history')
  let last
  for (const bytes of versions) last = await publish(bytes)
  assert.deepEqual(history(f).sort(), [kept.historyPath, restored, last.historyPath].sort())
  assert.deepEqual(fs.readFileSync(path.join(last.historyPath, 'captured-0')), versions[0])
})
