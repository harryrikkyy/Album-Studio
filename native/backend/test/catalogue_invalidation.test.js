'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { tmpdir, fakeJpeg, makeProject } = require('./fixtures')
const { listTemplates } = require('../lib/templates')
const { captureTime, chronological } = require('../lib/autofill')
function root(t) {
  const folder = tmpdir()
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  return folder
}
function header(width, height) {
  const bytes = Buffer.alloc(26)
  bytes.write('8BPS')
  bytes.writeUInt16BE(1, 4)
  bytes.writeUInt32BE(height, 14)
  bytes.writeUInt32BE(width, 18)
  return bytes
}
function datedJpeg(date) {
  const tiff = Buffer.alloc(64)
  tiff.write('II')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(1, 8)
  tiff.writeUInt16LE(0x8769, 10)
  tiff.writeUInt16LE(4, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt32LE(26, 18)
  tiff.writeUInt16LE(1, 26)
  tiff.writeUInt16LE(0x9003, 28)
  tiff.writeUInt16LE(2, 30)
  tiff.writeUInt32LE(20, 32)
  tiff.writeUInt32LE(44, 36)
  tiff.write(date, 44)
  const app = Buffer.alloc(4)
  app.writeUInt16BE(0xffe1)
  app.writeUInt16BE(2 + 6 + tiff.length, 2)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, Buffer.from('Exif\0\0'), tiff, fakeJpeg(400, 200).subarray(2)])
}
test('template canvas changes invalidate the catalogue despite preserved file and directory timestamps', async (t) => {
  const folder = root(t),
    file = path.join(folder, '1h0v.psd')
  fs.writeFileSync(file, header(600, 200))
  fs.utimesSync(file, 1577836800, 1577836800)
  fs.utimesSync(folder, 1577836800, 1577836800)
  const stamp = fs.statSync(file),
    dirStamp = fs.statSync(folder)
  assert.equal((await listTemplates([folder]))[0].width, 600)
  fs.writeFileSync(file, header(900, 300))
  fs.utimesSync(file, stamp.atime, stamp.mtime)
  fs.utimesSync(folder, dirStamp.atime, dirStamp.mtime)
  assert.equal((await listTemplates([folder]))[0].width, 900)
})
test('nested collection additions and removals invalidate without waiting for the top directory timestamp', async (t) => {
  const folder = root(t),
    nested = path.join(folder, 'Nested')
  fs.mkdirSync(nested)
  const a = path.join(nested, '1h0v_a.psd'),
    b = path.join(nested, '1h0v_b.psd')
  fs.writeFileSync(a, header(600, 200))
  fs.utimesSync(folder, 1577836800, 1577836800)
  assert.equal((await listTemplates([folder])).length, 1)
  const stamp = fs.statSync(folder)
  fs.writeFileSync(b, header(600, 200))
  fs.utimesSync(folder, stamp.atime, stamp.mtime)
  assert.equal((await listTemplates([folder])).length, 2)
  fs.unlinkSync(a)
  fs.utimesSync(folder, stamp.atime, stamp.mtime)
  assert.deepEqual(
    (await listTemplates([folder])).map((item) => item.name),
    ['1h0v_b.psd'],
  )
})
test('capture order rereads EXIF content rather than caching a filename forever', async (t) => {
  const folder = root(t),
    a = path.join(folder, 'a.jpg'),
    b = path.join(folder, 'b.jpg')
  fs.writeFileSync(a, datedJpeg('2020:01:01 12:00:00'))
  fs.writeFileSync(b, datedJpeg('2021:01:01 12:00:00'))
  const stamp = fs.statSync(a),
    photos = [
      { id: 'a', original: a },
      { id: 'b', original: b },
    ]
  assert.deepEqual(
    (await chronological(photos)).map((photo) => photo.id),
    ['a', 'b'],
  )
  fs.writeFileSync(a, datedJpeg('2022:01:01 12:00:00'))
  fs.utimesSync(a, stamp.atime, stamp.mtime)
  assert.deepEqual(
    (await chronological(photos)).map((photo) => photo.id),
    ['b', 'a'],
  )
})
test('capture metadata refuses a transient prefix from a different revision', async (t) => {
  const folder = root(t),
    file = path.join(folder, 'a.jpg'),
    original = datedJpeg('2020:01:01 12:00:00'),
    replacement = datedJpeg('2022:01:01 12:00:00')
  fs.writeFileSync(file, original)
  const open = fs.promises.open.bind(fs.promises)
  let injected = false
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args),
      read = handle.read.bind(handle)
    if (args[0] === file)
      handle.read = async (buffer, offset, length, position) => {
        const result = await read(buffer, offset, length, position)
        if (!injected && position === 0 && result.bytesRead) {
          injected = true
          replacement.copy(buffer, offset, 0, result.bytesRead)
        }
        return result
      }
    return handle
  })
  await assert.rejects(captureTime(file), { code: 'SOURCE_CHANGED' })
  assert.equal(injected, true)
  assert.deepEqual(fs.readFileSync(file), original)
})
test('album photo dimensions refresh after in-place thumbnail edits with unchanged directory timestamps', async (t) => {
  const f = makeProject()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const { openAlbum } = require('../lib/album'),
    file = path.join(f.shoot, '_Thumbnails', 'A1.jpg'),
    stamp = fs.statSync(file),
    folder = path.dirname(file),
    dirStamp = fs.statSync(folder)
  assert.equal((await openAlbum({ path: f.proj })).photos.img_My_Shoot_A1_jpg.width, 400)
  fs.writeFileSync(file, fakeJpeg(266, 400))
  fs.utimesSync(file, stamp.atime, stamp.mtime)
  fs.utimesSync(folder, dirStamp.atime, dirStamp.mtime)
  assert.equal((await openAlbum({ path: f.proj })).photos.img_My_Shoot_A1_jpg.width, 266)
})

test('album hydration skips unused canvas reads while still observing nested template additions and removals', async (t) => {
  const f = makeProject()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const { openAlbum } = require('../lib/album'),
    open = fs.promises.open.bind(fs.promises)
  let templateReads = 0
  t.mock.method(fs.promises, 'open', async (...args) => {
    if (String(args[0]).startsWith(f.tpls + path.sep) && /\.psd$/i.test(String(args[0]))) templateReads++
    return open(...args)
  })
  const first = await openAlbum({ path: f.proj })
  assert.equal(first.spreads[0].template.file, path.join(f.tpls, '1h1v_0001.psd'))
  const nested = path.join(f.tpls, 'Nested')
  fs.mkdirSync(nested)
  const added = path.join(nested, '1h1v_0002.psd'),
    project = path.join(f.proj, 'project.json'),
    data = JSON.parse(fs.readFileSync(project))
  fs.writeFileSync(added, header(900, 300))
  data.albumPages[1].template = { id: 'tpl_Templates_2026_1h1v_0002_psd', name: '1h1v_0002.psd', h: 1, v: 1 }
  fs.writeFileSync(project, JSON.stringify(data))
  assert.equal((await openAlbum({ path: f.proj })).spreads[0].template.file, added)
  fs.unlinkSync(added)
  assert.equal((await openAlbum({ path: f.proj })).spreads[0].template.file, null)
  assert.equal(templateReads, 0)
})
