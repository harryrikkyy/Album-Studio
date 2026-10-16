'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createVerifiedFileReader } = require('../lib/verified_file')
const read = createVerifiedFileReader({ label: 'Native document', changed: what => Object.assign(new Error(`${what} changed`), { code: 'SOURCE_CHANGED' }) })
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-verified-publication-')), file = path.join(root, 'source.psd')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(file, 'original source bytes')
  return file
}
test('buffered metadata cannot allocate a document-sized buffer and preserves the sparse source', async t => {
  const file = fixture(t), size = 64 * 1024 * 1024 + 1
  fs.truncateSync(file, size)
  await assert.rejects(read(file, Number.MAX_SAFE_INTEGER, true), /Buffered publication metadata exceeds the 64 MiB limit/)
  assert.equal(fs.statSync(file).size, size)
})
test('a failed descriptor close preserves the primary revision failure and reports the secondary error', async t => {
  const file = fixture(t), original = fs.promises.open
  fs.promises.open = async function (name, ...args) {
    const handle = await original.call(this, name, ...args)
    if (name === file) {
      const close = handle.close.bind(handle)
      handle.read = async () => ({ bytesRead: 0 })
      handle.close = async () => { await close(); throw Object.assign(new Error('injected close failure'), { code: 'EIO' }) }
    }
    return handle
  }
  try {
    await assert.rejects(read(file), error => error.code === 'SOURCE_CHANGED' && /length changed/.test(error.message) && error.closeErrors[0] === 'injected close failure')
    assert.equal(fs.readFileSync(file, 'utf8'), 'original source bytes')
  } finally { fs.promises.open = original }
})
