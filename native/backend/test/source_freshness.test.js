'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { tmpdir } = require('./fixtures')
const { fileStamp, fileDigest, contentFileKey } = require('../lib/cache')
const { inputsHash } = require('../lib/inputs')

function replacePreservingStamp(file, bytes) {
  const st = fs.statSync(file)
  assert.equal(bytes.length, st.size)
  fs.writeFileSync(file, bytes); fs.utimesSync(file, st.atime, st.mtime)
}

test('spread input evidence changes when source and template bytes change with the same size and timestamps', async (t) => {
  const dir = tmpdir(), photo = path.join(dir, 'photo.bin'), tpl = path.join(dir, 'template.bin')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(photo, 'original'); fs.writeFileSync(tpl, 'template')
  const spread = { n: 1, photoIds: ['a'], template: { file: tpl } }, album = { photos: { a: { original: photo, orient: 'h' } } }
  const before = await inputsHash(['recipe'], spread, album, {})
  const stamp = await fileStamp(photo)
  replacePreservingStamp(photo, Buffer.from('modified'))
  assert.equal(await fileStamp(photo), stamp)
  const after = await inputsHash(['recipe'], spread, album, {})
  assert.notEqual(after, before, 'content, rather than stamp-only evidence, identifies source revisions')
  const templateStamp = await fileStamp(tpl)
  replacePreservingStamp(tpl, Buffer.from('changed!'))
  assert.equal(await fileStamp(tpl), templateStamp)
  assert.notEqual(await inputsHash(['recipe'], spread, album, {}), after)
})

test('content evidence streams bounded buffers and does not reuse a global stamp-only digest', async (t) => {
  const dir = tmpdir(), file = path.join(dir, 'large.bin'), bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 41)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, bytes)
  const opened = fs.promises.open, reads = []
  fs.promises.open = async (...args) => {
    const h = await opened.apply(fs.promises, args), read = h.read.bind(h)
    h.read = (...values) => { reads.push(values[2]); return read(...values) }
    return h
  }
  let key
  try {
    assert.equal(await fileDigest(file), crypto.createHash('sha256').update(bytes).digest('hex'))
    key = await contentFileKey(file)
  } finally { fs.promises.open = opened }
  assert.ok(reads.length > 6)
  assert.ok(reads.every((n) => n <= 1024 * 1024))
  assert.match(key, /^[a-f0-9]{64}$/)
  replacePreservingStamp(file, Buffer.alloc(bytes.length, 42))
  assert.notEqual(await contentFileKey(file), key)
})

test('content evidence rejects a source mutated during streaming and settles missing/symlink inputs', async (t) => {
  const dir = tmpdir(), file = path.join(dir, 'source.bin'), linked = path.join(dir, 'link.bin')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 1))
  const opened = fs.promises.open
  fs.promises.open = async (...args) => {
    const h = await opened.apply(fs.promises, args), read = h.read.bind(h)
    let changed = false
    h.read = async (...values) => {
      const result = await read(...values)
      if (!changed) { changed = true; replacePreservingStamp(file, Buffer.alloc(2 * 1024 * 1024, 2)) }
      return result
    }
    return h
  }
  try { await assert.rejects(fileDigest(file), /changed/i) }
  finally { fs.promises.open = opened }
  await assert.rejects(fileDigest(path.join(dir, 'missing')), { code: 'ENOENT' })
  fs.symlinkSync(file, linked)
  await assert.rejects(fileDigest(linked), /regular|symlink/i)
})

test('many requested source digests keep concurrent file handles bounded', async (t) => {
  const dir = tmpdir(), file = path.join(dir, 'source.bin')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(file, Buffer.alloc(1024 * 1024, 3))
  const opened = fs.promises.open
  let active = 0, peak = 0
  fs.promises.open = async (...args) => {
    const h = await opened.apply(fs.promises, args), close = h.close.bind(h), read = h.read.bind(h)
    active++; peak = Math.max(peak, active)
    h.read = async (...values) => { await new Promise((resolve) => setTimeout(resolve, 2)); return read(...values) }
    h.close = async () => { try { return await close() } finally { active-- } }
    return h
  }
  try {
    const values = await Promise.all(Array.from({ length: 24 }, () => fileDigest(file)))
    assert.equal(new Set(values).size, 1)
    assert.ok(peak <= 4, `bounded digest pool opened ${peak} source handles`)
    assert.equal(active, 0)
  } finally { fs.promises.open = opened }
})
