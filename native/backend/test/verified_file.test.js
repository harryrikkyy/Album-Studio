'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createVerifiedFileReader } = require('../lib/verified_file')
const read = createVerifiedFileReader({
  label: 'Native document',
  changed: (what) => Object.assign(new Error(`${what} changed`), { code: 'SOURCE_CHANGED' }),
})
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-verified-publication-')),
    file = path.join(root, 'source.psd')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(file, 'original source bytes')
  return file
}
test('buffered metadata cannot allocate a document-sized buffer and preserves the sparse source', async (t) => {
  const file = fixture(t),
    size = 64 * 1024 * 1024 + 1
  fs.truncateSync(file, size)
  await assert.rejects(
    read(file, Number.MAX_SAFE_INTEGER, true),
    /Buffered publication metadata exceeds the 64 MiB limit/,
  )
  assert.equal(fs.statSync(file).size, size)
})
test('a failed descriptor close preserves the primary revision failure and reports the secondary error', async (t) => {
  const file = fixture(t),
    original = fs.promises.open
  fs.promises.open = async function (name, ...args) {
    const handle = await original.call(this, name, ...args)
    if (name === file) {
      const close = handle.close.bind(handle)
      handle.read = async () => ({ bytesRead: 0 })
      handle.close = async () => {
        await close()
        throw Object.assign(new Error('injected close failure'), { code: 'EIO' })
      }
    }
    return handle
  }
  try {
    await assert.rejects(
      read(file),
      (error) =>
        error.code === 'SOURCE_CHANGED' &&
        /length changed/.test(error.message) &&
        error.closeErrors[0] === 'injected close failure',
    )
    assert.equal(fs.readFileSync(file, 'utf8'), 'original source bytes')
  } finally {
    fs.promises.open = original
  }
})
// Reads the file with its close failing, and with every read throwing `thrown` if one is given.
async function closeFails(file, thrown) {
  const original = fs.promises.open
  fs.promises.open = async function (name, ...args) {
    const handle = await original.call(this, name, ...args)
    if (name === file) {
      const close = handle.close.bind(handle)
      if (thrown !== undefined)
        handle.read = async () => {
          throw thrown
        }
      handle.close = async () => {
        await close()
        throw Object.assign(new Error('injected close failure'), { code: 'EIO' })
      }
    }
    return handle
  }
  try {
    return await read(file).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
  } finally {
    fs.promises.open = original
  }
}
test('a read failure that cannot list close errors is replaced, keeping its message, code and cause', async (t) => {
  const file = fixture(t),
    frozen = Object.freeze(Object.assign(new Error('frozen failure'), { code: 'EFROZEN' }))
  const accessor = Object.defineProperty(
    Object.assign(new Error('accessor failure'), { code: 'EACCESS' }),
    'closeErrors',
    {
      get: () => [],
    },
  )
  for (const [thrown, message, code] of [
    [frozen, 'frozen failure', 'EFROZEN'],
    [accessor, 'accessor failure', 'EACCESS'],
    ['plain failure', 'plain failure', undefined],
    [7, 'The publication read failed.', undefined],
  ]) {
    const { error } = await closeFails(file, thrown)
    assert.notEqual(error, thrown)
    assert.equal(error.cause, thrown)
    assert.deepEqual([error.message, error.code, error.closeErrors], [message, code, ['injected close failure']])
  }
})
test("a close failure joins a read failure's close errors, up to 64", async (t) => {
  const earlier = Array.from({ length: 70 }, (_, i) => `earlier ${i}`),
    thrown = Object.assign(new Error('listed failure'), { closeErrors: earlier })
  const { error } = await closeFails(fixture(t), thrown)
  assert.equal(error, thrown)
  assert.deepEqual(error.closeErrors, [...earlier.slice(0, 63), 'injected close failure'])
})
test('a close failure after a complete read is the failure itself', async (t) => {
  const { value, error } = await closeFails(fixture(t))
  assert.equal(value, undefined)
  assert.deepEqual([error.message, error.code], ['injected close failure', 'EIO'])
})
async function bytesRead(t, file, run) {
  const open = fs.promises.open,
    owners = new WeakMap(),
    probe = await open(__filename),
    proto = Object.getPrototypeOf(probe)
  await probe.close()
  const read = proto.read
  let bytes = 0
  t.mock.method(fs.promises, 'open', async (name, ...args) => {
    const handle = await open(name, ...args)
    owners.set(handle, String(name))
    return handle
  })
  t.mock.method(proto, 'read', async function (...args) {
    const result = await read.apply(this, args)
    if (owners.get(this) === file) bytes += result.bytesRead
    return result
  })
  try {
    await run()
  } finally {
    t.mock.restoreAll()
  }
  return bytes
}
test('a read that matches the digest its caller requires makes one pass; any other read makes two', async (t) => {
  const file = fixture(t),
    size = fs.statSync(file).size,
    digest = (await read(file)).digest
  assert.equal(await bytesRead(t, file, () => read(file, undefined, false, { expectedDigest: digest })), size)
  assert.equal(await bytesRead(t, file, () => read(file)), 2 * size)
  let other
  assert.equal(
    await bytesRead(t, file, async () => {
      other = await read(file, undefined, false, { expectedDigest: 'f'.repeat(64) })
    }),
    2 * size,
  )
  assert.equal(other.digest, digest)
})
test('a required digest never admits a same-stamp in-place A/B/A hybrid', async (t) => {
  const file = fixture(t),
    chunk = 1024 * 1024,
    original = Buffer.alloc(3 * chunk, 0x41),
    mutation = Buffer.alloc(chunk, 0x42)
  fs.writeFileSync(file, original)
  const digest = require('node:crypto').createHash('sha256').update(original).digest('hex')
  const baseline = fs.lstatSync(file, { bigint: true }),
    open = fs.promises.open,
    lstat = fs.promises.lstat
  t.mock.method(fs.promises, 'lstat', async (target, ...args) => (target === file ? baseline : lstat(target, ...args)))
  t.mock.method(fs.promises, 'open', async (target, ...args) => {
    const handle = await open(target, ...args)
    if (target !== file) return handle
    const pass = handle.read.bind(handle)
    let first = true
    handle.stat = async () => baseline // Coarse-time oracle: the rewrite leaves every stamp unchanged.
    handle.read = async (buffer, offset, length, position) => {
      if (first && position === chunk) {
        const fd = fs.openSync(file, 'r+')
        fs.writeSync(fd, mutation, 0, chunk, chunk)
        fs.closeSync(fd)
      }
      const result = await pass(buffer, offset, length, position)
      if (first && position === 2 * chunk) {
        const fd = fs.openSync(file, 'r+')
        fs.writeSync(fd, original, chunk, chunk, chunk)
        fs.closeSync(fd)
      }
      if (position === original.length) first = false
      return result
    }
    return handle
  })
  await assert.rejects(read(file, undefined, false, { expectedDigest: digest }), /content or identity changed/)
  t.mock.restoreAll()
  assert.deepEqual(fs.readFileSync(file), original)
})
