'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { tmpdir } = require('./fixtures')
const { fileEvidence, readVerifiedBuffer } = require('../lib/cache')
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
function fixture(t, bytes) {
  const root = tmpdir(),
    file = path.join(root, 'source.bin')
  fs.writeFileSync(file, bytes)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return file
}
test('source evidence captures its prefix from the exact digest pass, including short and empty files', async (t) => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('tiny'), Buffer.alloc(2 * 1024 * 1024 + 7, 0xab)]) {
    const file = fixture(t, bytes),
      evidence = await fileEvidence(file, { prefixBytes: 1024 * 1024 })
    assert.equal(evidence.digest, sha(bytes))
    assert.deepEqual(evidence.prefix, bytes.subarray(0, 1024 * 1024))
  }
})
test('invalid source budgets and revisions fail before opening the source', async (t) => {
  const file = fixture(t, 'bytes')
  t.mock.method(fs.promises, 'open', async () => {
    throw new Error('invalid bounds reached filesystem')
  })
  for (const prefixBytes of [-1, 1.1, Infinity, 1024 * 1024 + 1])
    await assert.rejects(fileEvidence(file, { prefixBytes }), /bounded prefix/)
  for (const maximum of [0, -1, 1.1, Infinity, 512 * 1024 * 1024 + 1])
    await assert.rejects(readVerifiedBuffer(file, sha('bytes'), maximum), /budget/)
  await assert.rejects(fileEvidence(file, { expectedDigest: 'old' }), /valid expected revision/)
  await assert.rejects(readVerifiedBuffer(file, 'old'), /expected revision/)
})
test('metadata evidence and buffered consumption both reject a different expected revision', async (t) => {
  const file = fixture(t, 'actual')
  await assert.rejects(fileEvidence(file, { prefixBytes: 3, expectedDigest: sha('expected') }), {
    code: 'SOURCE_CHANGED',
  })
  await assert.rejects(readVerifiedBuffer(file, sha('expected')), { code: 'SOURCE_CHANGED' })
})
test('verified buffered bytes are detached from later changes and obey the declared budget', async (t) => {
  const original = Buffer.from('customer source'),
    file = fixture(t, original)
  await assert.rejects(readVerifiedBuffer(file, sha(original), original.length - 1), /decoding budget/)
  const bytes = await readVerifiedBuffer(file, sha(original), original.length)
  fs.writeFileSync(file, 'replacement')
  assert.deepEqual(bytes, original)
})
test('a transient consumed-buffer substitution cannot borrow the restored source digest', async (t) => {
  const original = Buffer.from('original'),
    file = fixture(t, original),
    open = fs.promises.open.bind(fs.promises)
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args),
      read = handle.read.bind(handle)
    if (args[0] === file)
      handle.read = async (buffer, offset, length, position) => {
        const result = await read(buffer, offset, length, position)
        if (position === 0 && result.bytesRead) buffer[offset] ^= 0xff
        return result
      }
    return handle
  })
  await assert.rejects(readVerifiedBuffer(file, sha(original)), { code: 'SOURCE_CHANGED' })
  assert.deepEqual(fs.readFileSync(file), original)
})
test('two-pass evidence rejects a transient prefix even when later bytes and file metadata agree', async (t) => {
  const file = fixture(t, 'original'),
    open = fs.promises.open.bind(fs.promises)
  let injected = false
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args),
      read = handle.read.bind(handle)
    if (args[0] === file)
      handle.read = async (buffer, offset, length, position) => {
        const result = await read(buffer, offset, length, position)
        if (!injected && position === 0 && result.bytesRead) {
          injected = true
          buffer[offset] ^= 0xff
        }
        return result
      }
    return handle
  })
  await assert.rejects(fileEvidence(file, { prefixBytes: 8 }), { code: 'SOURCE_CHANGED' })
  assert.equal(injected, true)
})
test('a continually growing source is refused after the declared length rather than read forever', async (t) => {
  const file = fixture(t, 'original'),
    open = fs.promises.open.bind(fs.promises)
  let reads = 0
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args),
      read = handle.read.bind(handle)
    if (args[0] === file)
      handle.read = async (...input) => {
        reads++
        fs.appendFileSync(file, 'growth')
        return read(...input)
      }
    return handle
  })
  await assert.rejects(fileEvidence(file), { code: 'SOURCE_CHANGED' })
  assert.ok(reads <= 2)
})
test('symbolic sources are rejected without consuming the target', async (t) => {
  const file = fixture(t, 'private'),
    alias = `${file}.alias`
  fs.symlinkSync(file, alias)
  await assert.rejects(fileEvidence(alias), /regular file/)
  await assert.rejects(readVerifiedBuffer(alias, sha('private')), /regular file/)
})
