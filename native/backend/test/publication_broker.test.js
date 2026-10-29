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
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
function frame(value) {
  const b = Buffer.from(JSON.stringify(value)),
    h = Buffer.alloc(4)
  h.writeUInt32BE(b.length)
  return Buffer.concat([h, b])
}
function fixture(t) {
  const root = tmpdir(),
    output = path.join(root, 'Sheets'),
    target = path.join(output, 'manual.psd'),
    old = Buffer.from('customer bytes'),
    next = Buffer.from('saved document bytes')
  fs.mkdirSync(output)
  fs.writeFileSync(target, old)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, output, target, old, next }
}
function worker(t, request) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../server.js'), '--native-publication'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = readline.createInterface({ input: child.stdout }),
    queued = [],
    waiting = []
  let stderr = '',
    exited = false
  child.stdin.on('error', () => {}) // Failed admission may close input before the sender observes the reply.
  lines.on('line', (line) => {
    const value = JSON.parse(line)
    if (waiting.length) waiting.shift()(value)
    else queued.push(value)
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => {
      exited = true
      resolve(code)
    })
  })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
  t.after(async () => {
    clearTimeout(timeout)
    if (!exited) child.kill('SIGKILL')
    await exit
    lines.close()
  })
  child.stdin.write(frame(request))
  return {
    child,
    async next() {
      if (queued.length) return queued.shift()
      return Promise.race([
        new Promise((resolve) => waiting.push(resolve)),
        exit.then(() => {
          if (queued.length) return queued.shift()
          throw new Error(`Broker exited before its reply: ${stderr}`)
        }),
      ])
    },
    exit,
  }
}
const request = (f, expected = { mode: 'overwrite' }) => ({ version: 1, target: f.target, expected })
function payload(w, f) {
  w.child.stdin.write(frame({ length: f.next.length, digest: sha(f.next) }))
  w.child.stdin.write(f.next)
}

test('the actual private worker streams bytes, waits for commit and returns exact publication receipt', async (t) => {
  const f = fixture(t),
    w = worker(t, request(f))
  assert.equal((await w.next()).state, 'ready')
  payload(w, f)
  assert.equal((await w.next()).state, 'prepared')
  assert.deepEqual(fs.readFileSync(f.target), f.old)
  w.child.stdin.end(frame({ commit: true }))
  const r = await w.next()
  assert.equal(r.state, 'committed')
  assert.equal(r.result.records[0].digest, sha(f.next))
  assert.equal(await w.exit, 0)
  assert.deepEqual(fs.readFileSync(f.target), f.next)
})
test('worker admission respects a managed output lease before accepting any encoded bytes', async (t) => {
  const f = fixture(t),
    outputs = await acquireOutputLease(f.output)
  try {
    const w = worker(t, request(f)),
      r = await w.next()
    assert.equal(r.state, 'failed')
    assert.equal(r.error.code, 'PROJECT_BUSY')
    assert.equal(await w.exit, 1)
    assert.deepEqual(fs.readFileSync(f.target), f.old)
  } finally {
    await outputs.release()
  }
})
test('earlier decoder source and exact inode records are checked instead of rebasing onto current bytes', async (t) => {
  for (const mode of ['source', 'exact', 'new']) {
    const f = fixture(t),
      record = await fingerprintFile(f.target)
    const expected =
      mode === 'source'
        ? { mode, digest: record.digest, size: record.size }
        : mode === 'exact'
          ? { mode, record }
          : { mode }
    if (mode === 'source') fs.writeFileSync(f.target, 'a later manual edit')
    if (mode === 'exact') {
      fs.renameSync(f.target, path.join(f.root, 'earlier'))
      fs.copyFileSync(path.join(f.root, 'earlier'), f.target)
    }
    const before = fs.readFileSync(f.target),
      w = worker(t, request(f, expected)),
      r = await w.next()
    assert.equal(r.state, 'failed')
    assert.equal(r.error.code, 'PUBLICATION_CONFLICT')
    assert.equal(await w.exit, 1)
    assert.deepEqual(fs.readFileSync(f.target), before)
  }
})
for (const at of ['ready', 'partial', 'prepared'])
  test(`parent disconnect at ${at} cannot publish`, async (t) => {
    const f = fixture(t),
      w = worker(t, request(f))
    assert.equal((await w.next()).state, 'ready')
    if (at === 'partial') {
      w.child.stdin.write(frame({ length: f.next.length + 1, digest: sha(f.next) }))
      w.child.stdin.write(f.next)
    }
    if (at === 'prepared') {
      payload(w, f)
      assert.equal((await w.next()).state, 'prepared')
    }
    w.child.stdin.end()
    const r = await w.next()
    assert.equal(r.state, 'failed')
    assert.equal(r.error.code, 'PUBLICATION_PROTOCOL')
    assert.equal(await w.exit, 1)
    assert.deepEqual(fs.readFileSync(f.target), f.old)
  })
test('a manual edit after preparation is preserved with typed recovery metadata', async (t) => {
  const f = fixture(t),
    w = worker(t, request(f))
  await w.next()
  payload(w, f)
  await w.next()
  fs.writeFileSync(f.target, 'manual edit during save preparation')
  w.child.stdin.end(frame({ commit: true }))
  const r = await w.next()
  assert.equal(r.state, 'failed')
  assert.equal(r.error.code, 'PUBLICATION_CONFLICT')
  assert.equal(await w.exit, 1)
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'manual edit during save preparation')
})
test('bad payload hashes and trailing commands fail without publishing', async (t) => {
  for (const kind of ['hash', 'trailing']) {
    const f = fixture(t),
      w = worker(t, request(f))
    await w.next()
    w.child.stdin.write(frame({ length: f.next.length, digest: sha(kind === 'hash' ? 'wrong bytes' : f.next) }))
    w.child.stdin.write(f.next)
    if (kind === 'trailing') {
      assert.equal((await w.next()).state, 'prepared')
      w.child.stdin.end(Buffer.concat([frame({ commit: true }), Buffer.from('extra command')]))
    }
    const r = await w.next()
    assert.equal(r.state, 'failed')
    assert.equal(r.error.code, 'PUBLICATION_PROTOCOL')
    w.child.stdin.end()
    assert.equal(await w.exit, 1)
    assert.deepEqual(fs.readFileSync(f.target), f.old)
  }
})
test('the real worker accepts a multi-chunk document larger than the GUI JSON frame limit', async (t) => {
  const f = fixture(t),
    w = worker(t, request(f)),
    { once } = require('node:events')
  assert.equal((await w.next()).state, 'ready')
  const chunk = Buffer.alloc(1024 * 1024, 0x79),
    suffix = Buffer.from('document end marker'),
    count = 9
  const hash = crypto.createHash('sha256')
  for (let i = 0; i < count; i++) hash.update(chunk)
  const digest = hash.update(suffix).digest('hex'),
    length = chunk.length * count + suffix.length
  w.child.stdin.write(frame({ length, digest }))
  for (let i = 0; i < count; i++) if (!w.child.stdin.write(chunk)) await once(w.child.stdin, 'drain')
  w.child.stdin.write(suffix)
  assert.equal((await w.next()).state, 'prepared')
  assert.deepEqual(fs.readFileSync(f.target), f.old)
  w.child.stdin.end(frame({ commit: true }))
  const r = await w.next()
  assert.equal(r.state, 'committed')
  assert.equal(r.result.records[0].size, String(length))
  assert.equal(r.result.records[0].digest, digest)
  assert.equal(await w.exit, 0)
  assert.equal((await fingerprintFile(f.target)).digest, digest)
})
test('exact revision checks ignore incidental access time and JSON property order', async (t) => {
  const f = fixture(t),
    record = await fingerprintFile(f.target)
  record.atimeMs += 1234
  const reordered = Object.fromEntries(Object.entries(record).reverse()),
    w = worker(t, request(f, { mode: 'exact', record: reordered }))
  assert.equal((await w.next()).state, 'ready')
  payload(w, f)
  assert.equal((await w.next()).state, 'prepared')
  w.child.stdin.end(frame({ commit: true }))
  const r = await w.next()
  assert.equal(r.state, 'committed')
  assert.equal(await w.exit, 0)
  assert.ok(fs.existsSync(path.join(r.result.inputHistory, 'source')))
  const lease = await require('../lib/namespace_lock').acquirePublicationDirectories([f.target])
  try {
    assert.deepEqual((await require('../lib/file_publication').recoverFiles(f.output, lease)).orphanStages, [])
  } finally {
    await lease.release()
  }
})
test('malformed Unicode target names cannot alias a different replacement-character file', async (t) => {
  const f = fixture(t),
    target = path.join(f.output, 'bad-\ufffd.psd')
  fs.writeFileSync(target, f.old)
  const w = worker(t, { ...request(f), target: path.join(f.output, 'bad-\ud800.psd') }),
    r = await w.next()
  assert.equal(r.state, 'failed')
  assert.equal(r.error.code, 'PUBLICATION_PROTOCOL')
  assert.equal(await w.exit, 1)
  assert.deepEqual(fs.readFileSync(target), f.old)
})
const documentExpectation = (f, record) => ({
  mode: 'document',
  currentPath: f.target,
  sourcePath: f.target,
  digest: record.digest,
  size: record.size,
  publication: null,
})
async function finishDocument(w, f) {
  assert.equal((await w.next()).state, 'ready')
  payload(w, f)
  assert.equal((await w.next()).state, 'prepared')
  w.child.stdin.end(frame({ commit: true }))
  const r = await w.next()
  assert.equal(r.state, 'committed')
  assert.equal(await w.exit, 0)
  return r.result.fileReceipt
}
test('document source proof and subsequent receipts guard the actual current file across saves', async (t) => {
  const f = fixture(t),
    record = await fingerprintFile(f.target),
    e = documentExpectation(f, record)
  const first = await finishDocument(worker(t, request(f, e)), f)
  assert.equal(first.replacesSource, true)
  assert.equal(first.revision.digest, sha(f.next))
  const second = await finishDocument(worker(t, request(f, { ...e, publication: first })), f)
  assert.equal(second.replacesSource, true)
  fs.writeFileSync(f.target, 'newer external document revision')
  const w = worker(t, request(f, { ...e, publication: second })),
    r = await w.next()
  assert.equal(r.state, 'failed')
  assert.equal(r.error.code, 'PUBLICATION_CONFLICT')
  assert.equal(await w.exit, 1)
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'newer external document revision')
})
test('document paths resolve aliases while a different Save Copy preserves the source receipt', async (t) => {
  const f = fixture(t),
    record = await fingerprintFile(f.target),
    e = documentExpectation(f, record),
    alias = path.join(f.root, 'Alias')
  fs.symlinkSync(f.output, alias, 'dir')
  const first = await finishDocument(worker(t, { ...request(f, e), target: path.join(alias, 'manual.psd') }), f)
  assert.equal(first.replacesSource, true)
  const copy = { ...f, target: path.join(f.output, 'copy.psd') },
    receipt = await finishDocument(worker(t, request(copy, { ...e, publication: first })), copy)
  assert.equal(receipt.replacesSource, false)
  const r = await finishDocument(worker(t, request(f, { ...e, publication: first })), f)
  assert.equal(r.replacesSource, true)
  assert.equal(fs.readFileSync(copy.target, 'utf8'), f.next.toString())
})
test('a current file without earlier source or receipt cannot be silently adopted', async (t) => {
  const f = fixture(t),
    expected = {
      mode: 'document',
      currentPath: f.target,
      sourcePath: null,
      digest: null,
      size: null,
      publication: null,
    }
  const w = worker(t, request(f, expected)),
    r = await w.next()
  assert.equal(r.state, 'failed')
  assert.equal(r.error.code, 'PUBLICATION_CONFLICT')
  assert.equal(await w.exit, 1)
  assert.deepEqual(fs.readFileSync(f.target), f.old)
  const copy = { ...f, target: path.join(f.output, 'recovered-copy.psd') }
  const receipt = await finishDocument(worker(t, request(copy, expected)), copy)
  assert.equal(receipt.replacesSource, false)
  assert.deepEqual(fs.readFileSync(f.target), f.old)
})
test('Save Copy to a former source after Save As keeps the current file receipt', async (t) => {
  const f = fixture(t),
    record = await fingerprintFile(f.target),
    origin = documentExpectation(f, record)
  const first = await finishDocument(worker(t, request(f, origin)), f)
  const renamed = { ...f, target: path.join(f.output, 'renamed.psd') },
    current = await finishDocument(worker(t, request(renamed, { ...origin, publication: first })), renamed)
  const e = { ...origin, currentPath: renamed.target, publication: current }
  const copy = await finishDocument(worker(t, request(f, e)), f)
  assert.equal(copy.replacesSource, false)
  const saved = await finishDocument(worker(t, request(renamed, e)), renamed)
  assert.equal(saved.replacesSource, true)
})
test('private revision expectations preserve string wire types instead of coercing arrays or numbers', async (t) => {
  const f = fixture(t),
    record = await fingerprintFile(f.target),
    { requestOf } = require('../lib/publication_broker')
  for (const patch of [{ size: [record.size] }, { node: { ...record.node, dev: Number(record.node.dev) } }]) {
    assert.throws(() => requestOf(request(f, { mode: 'exact', record: { ...record, ...patch } })), {
      code: 'PUBLICATION_PROTOCOL',
    })
  }
  assert.throws(() => requestOf(request(f, { mode: 'source', digest: record.digest, size: [record.size] })), {
    code: 'PUBLICATION_PROTOCOL',
  })
  assert.deepEqual(fs.readFileSync(f.target), f.old)
})
test('ordinary native publication cannot change private recovery history or add metadata inside it', async (t) => {
  const f = fixture(t)
  await finishDocument(worker(t, request(f)), f)
  const history = path.join(f.output, '.album-studio-publications/history'),
    stage = path.join(history, fs.readdirSync(history)[0])
  const target = path.join(stage, 'old-0'),
    before = fs.readFileSync(target),
    names = fs.readdirSync(stage).sort()
  const w = worker(t, request({ ...f, target })),
    r = await w.next()
  assert.equal(r.state, 'failed')
  assert.equal(r.error.code, 'PUBLICATION_PRIVATE_PATH')
  assert.equal(await w.exit, 1)
  assert.deepEqual(fs.readFileSync(target), before)
  assert.deepEqual(fs.readdirSync(stage).sort(), names)
})
test('the actual managed sheets directory remains a valid native document destination', async (t) => {
  const f = fixture(t),
    folder = path.join(f.output, '.album-studio/sheets'),
    target = path.join(folder, 'spread_fixture.psd')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(target, f.old)
  const record = await fingerprintFile(target),
    sheet = { ...f, target }
  const receipt = await finishDocument(worker(t, request(sheet, documentExpectation(sheet, record))), sheet)
  assert.equal(receipt.replacesSource, true)
  assert.deepEqual(fs.readFileSync(target), f.next)
})
test('a publication request with fields its mode does not define is refused before anything is written', async (t) => {
  const f = fixture(t),
    record = await fingerprintFile(f.target),
    { requestOf } = require('../lib/publication_broker')
  for (const expected of [
    { mode: 'overwrite', extra: true },
    { mode: 'source', digest: record.digest, size: record.size, record },
    { mode: 'exact', record, digest: record.digest },
  ])
    assert.throws(() => requestOf(request(f, expected)), { code: 'PUBLICATION_PROTOCOL' })
  assert.deepEqual(fs.readFileSync(f.target), f.old)
})
test('a document save whose deciding paths are relative is refused before anything is written', async (t) => {
  const f = fixture(t),
    record = await fingerprintFile(f.target),
    { requestOf } = require('../lib/publication_broker')
  const e = documentExpectation(f, record),
    relative = path.relative(process.cwd(), f.target)
  for (const patch of [{ currentPath: relative }, { sourcePath: relative }]) {
    assert.throws(
      () => requestOf(request(f, { ...e, ...patch })),
      { code: 'PUBLICATION_PROTOCOL' },
      JSON.stringify(patch),
    )
  }
  assert.deepEqual(fs.readFileSync(f.target), f.old)
})
for (const variant of ['.Album-Studio-Namespace-Files.json', '.album-ſtudio-namespace-files.json']) {
  test(`a save to the look-alike private name ${variant} is refused and the real marker is untouched`, async (t) => {
    const f = fixture(t)
    await finishDocument(worker(t, request(f)), f)
    const marker = path.join(f.output, '.album-studio-namespace-files.json'),
      before = fs.readFileSync(marker)
    const w = worker(t, request({ ...f, target: path.join(f.output, variant) })),
      r = await w.next()
    assert.equal(r.state, 'failed')
    assert.equal(r.error.code, 'PUBLICATION_PROTOCOL')
    assert.equal(await w.exit, 1)
    assert.deepEqual(fs.readFileSync(marker), before)
  })
}
