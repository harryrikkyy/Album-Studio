'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { makeProject } = require('./fixtures')
const { updateAlbum } = require('../lib/project')

function fixture(t) {
  const f = makeProject()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  return { ...f, file: path.join(f.proj, 'project.json') }
}

test('a pre-existing predictable project temp symlink never changes its unrelated target', async (t) => {
  const { root, file, proj } = fixture(t),
    target = path.join(root, 'unrelated.txt'),
    manual = Buffer.from('unrelated customer data')
  const oldTemporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(target, manual)
  fs.symlinkSync(target, oldTemporary)
  try {
    await updateAlbum({ album: proj, ops: [{ op: 'clearSpread', n: 1 }] })
  } catch (_) {
    /* A preserved conflict is acceptable. */
  }
  assert.deepEqual(fs.readFileSync(target), manual)
  assert.equal(fs.readlinkSync(oldTemporary), target, 'the pre-existing temporary entry is preserved')
  assert.equal(fs.lstatSync(file).isFile(), true, 'the project must never become that unrelated symlink')
})

test('a pre-existing project backup symlink never changes its unrelated target', async (t) => {
  const { root, file, proj } = fixture(t),
    target = path.join(root, 'unrelated-backup.txt'),
    manual = Buffer.from('manually retained recovery data')
  fs.writeFileSync(target, manual)
  fs.symlinkSync(target, `${file}.bak`)
  try {
    await updateAlbum({ album: proj, ops: [{ op: 'clearSpread', n: 1 }] })
  } catch (_) {
    /* A preserved conflict is acceptable. */
  }
  assert.deepEqual(fs.readFileSync(target), manual)
  assert.equal(fs.readlinkSync(`${file}.bak`), target)
})

test('a project changed after reading is preserved and rejects the obsolete edit', async (t) => {
  const { file, proj, shoot } = fixture(t),
    original = fs.readFileSync(file, 'utf8'),
    data = JSON.parse(original)
  data.customerNote = 'external editor saved while this operation was preparing'
  const manual = Buffer.from(JSON.stringify(data, null, 2)),
    open = fs.promises.open
  let injected = false
  t.mock.method(fs.promises, 'open', async (name, ...args) => {
    const handle = await open.call(fs.promises, name, ...args),
      close = handle.close.bind(handle)
    // Source preparation follows the authoritative leased project read. The new
    // pure pre-lease validation read must not accidentally move this fault earlier.
    if (name === path.join(shoot, '_Thumbnails', 'A1.jpg') && !injected)
      handle.close = async () => {
        await close()
        if (!injected) {
          injected = true
          fs.writeFileSync(file, manual)
        }
      }
    return handle
  })
  await assert.rejects(
    updateAlbum({ album: proj, ops: [{ op: 'clearSpread', n: 1 }] }),
    /changed|revision|conflict|preserv/i,
  )
  assert.equal(injected, true)
  assert.deepEqual(fs.readFileSync(file), manual)
})

test('a change during preliminary validation is read as the current revision without losing external fields', async (t) => {
  const { file, proj } = fixture(t),
    data = JSON.parse(fs.readFileSync(file)),
    open = fs.promises.open
  data.customerNote = 'saved before the leased edit read'
  let injected = false
  t.mock.method(fs.promises, 'open', async (name, ...args) => {
    const handle = await open.call(fs.promises, name, ...args),
      close = handle.close.bind(handle)
    if (name === file && !injected)
      handle.close = async () => {
        await close()
        if (!injected) {
          injected = true
          fs.writeFileSync(file, JSON.stringify(data))
        }
      }
    return handle
  })
  await updateAlbum({ album: proj, ops: [{ op: 'clearSpread', n: 1 }] })
  const saved = JSON.parse(fs.readFileSync(file))
  assert.equal(injected, true)
  assert.equal(saved.customerNote, data.customerNote)
  assert.deepEqual(saved.albumPages[1].photos, [])
})

test('an oversized sparse project fails before a whole-file allocation or mutation', async (t) => {
  const { file, proj } = fixture(t),
    size = 3 * 1024 ** 3
  fs.truncateSync(file, size)
  await assert.rejects(updateAlbum({ album: proj, ops: [{ op: 'clearSpread', n: 1 }] }), /regular|larger|budget|bytes/i)
  assert.equal(fs.statSync(file).size, size)
  assert.equal(fs.existsSync(`${file}.bak`), false)
})
