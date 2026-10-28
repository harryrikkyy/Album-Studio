'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('./fixtures')
const { acquirePublicationDirectories } = require('../lib/namespace_lock')
function fixture(t) {
  const root = tmpdir(), a = path.join(root, 'A'), b = path.join(root, 'B'), alias = path.join(root, 'Alias')
  fs.mkdirSync(a); fs.mkdirSync(b); fs.symlinkSync(a, alias, 'dir')
  const file = path.join(a, 'manual.psd'), bytes = Buffer.from('customer sheet bytes')
  fs.writeFileSync(file, bytes)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, a, b, alias, file, bytes }
}
test('publication parents deduplicate aliases and exclude another writer without adopting files', async t => {
  const f = fixture(t)
  const lease = await acquirePublicationDirectories([f.file, path.join(f.alias, 'another.psd')])
  try {
    await lease.assertTarget(path.join(f.alias, 'manual.psd'))
    await assert.rejects(acquirePublicationDirectories([path.join(f.a, 'new.psd')]), { code: 'PROJECT_BUSY' })
    await assert.rejects(lease.assertTarget(path.join(f.b, 'unreserved.psd')), { code: 'OUTPUT_LOCK_UNCERTAIN' })
    assert.deepEqual(fs.readFileSync(f.file), f.bytes)
    assert.equal(fs.existsSync(path.join(f.b, '.album-studio-namespace-files.json')), false)
  } finally { await lease.release() }
  const next = await acquirePublicationDirectories([f.file])
  await next.release()
})
test('retargeting an alias invalidates the capability while release preserves the new location', async t => {
  const f = fixture(t), lease = await acquirePublicationDirectories([path.join(f.alias, 'manual.psd')])
  try {
    fs.unlinkSync(f.alias); fs.symlinkSync(f.b, f.alias, 'dir')
    await assert.rejects(lease.assertOwned(), { code: 'OUTPUT_LOCK_UNCERTAIN' })
    await assert.rejects(lease.assertTarget(path.join(f.alias, 'manual.psd')), { code: 'OUTPUT_LOCK_UNCERTAIN' })
  } finally { await lease.release() }
  assert.deepEqual(fs.readFileSync(f.file), f.bytes)
  assert.deepEqual(fs.readdirSync(f.b), [])
})
test('a hardlinked namespace marker is refused without removing its evidence or customer bytes', async t => {
  const f = fixture(t), lease = await acquirePublicationDirectories([f.file])
  await lease.release()
  const marker = path.join(f.a, '.album-studio-namespace-files.json'), other = path.join(f.a, 'marker-link')
  fs.linkSync(marker, other)
  await assert.rejects(acquirePublicationDirectories([f.file]), { code: 'OUTPUT_LOCK_UNCERTAIN' })
  assert.equal(fs.statSync(marker).ino, fs.statSync(other).ino)
  assert.deepEqual(fs.readFileSync(f.file), f.bytes)
})
test('standalone publication shares an enclosing managed sheets reservation', async t => {
  const f = fixture(t), { acquireOutputLease } = require('../lib/output_lock')
  const nested = path.join(f.a, '.album-studio', 'sheets')
  fs.mkdirSync(nested, { recursive: true })
  const outputs = await acquireOutputLease(f.a)
  try {
    await assert.rejects(acquirePublicationDirectories([path.join(nested, 'spread_manual.psd')]), { code: 'PROJECT_BUSY' })
  } finally { await outputs.release() }
  const files = await acquirePublicationDirectories([path.join(nested, 'spread_manual.psd')])
  try { await assert.rejects(acquireOutputLease(f.a), { code: 'PROJECT_BUSY' }) }
  finally { await files.release() }
  assert.deepEqual(fs.readFileSync(f.file), f.bytes)
})
test('a newly appearing managed scope invalidates an existing standalone capability', async t => {
  const f = fixture(t), files = await acquirePublicationDirectories([f.file])
  try {
    const { acquireOutputLease } = require('../lib/output_lock'), outputs = await acquireOutputLease(f.a)
    try { await assert.rejects(files.assertOwned(), { code: 'OUTPUT_LOCK_UNCERTAIN' }) }
    finally { await outputs.release() }
  } finally { await files.release() }
  assert.deepEqual(fs.readFileSync(f.file), f.bytes)
})
test('an owned output capability can cover its enclosing scope while adding a file reservation', async t => {
  const f = fixture(t), { acquireOutputLease } = require('../lib/output_lock'), outputs = await acquireOutputLease(f.a)
  let files
  try {
    files = await acquirePublicationDirectories([f.file], { enclosing: outputs })
    await files.assertOwned()
    await assert.rejects(acquirePublicationDirectories([f.file]), { code: 'PROJECT_BUSY' })
    await outputs.release()
    await assert.rejects(files.assertOwned(), { code: 'PROJECT_LOCK_LOST' })
  } finally { if (files) await files.release(); await outputs.release() }
  assert.deepEqual(fs.readFileSync(f.file), f.bytes)
})
