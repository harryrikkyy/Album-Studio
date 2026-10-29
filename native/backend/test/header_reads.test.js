'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { tmpdir, fakeJpeg } = require('./fixtures')
const { readFileHeader } = require('../lib/cache')
const { canvasOf } = require('../lib/templates')
const { jpegSize } = require('../lib/jpeg_size')
const { captureTime } = require('../lib/autofill')

function file(t, bytes, size = bytes.length) {
  const root = tmpdir(),
    source = path.join(root, 'source.psd')
  const fd = fs.openSync(source, 'wx')
  try {
    fs.writeSync(fd, bytes)
    fs.ftruncateSync(fd, size)
  } finally {
    fs.closeSync(fd)
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return source
}
function budget(t, source, maximum) {
  const open = fs.promises.open.bind(fs.promises)
  let requested = 0
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args),
      read = handle.read.bind(handle)
    if (args[0] === source)
      handle.read = async (buffer, offset, length, position) => {
        requested += length
        assert.ok(requested <= maximum, `Metadata requested ${requested} bytes; budget is ${maximum}`)
        return read(buffer, offset, length, position)
      }
    return handle
  })
  return () => requested
}
test('a large PSD catalogue entry reads only its canvas header', async (t) => {
  const bytes = Buffer.alloc(26)
  bytes.write('8BPS')
  bytes.writeUInt16BE(1, 4)
  bytes.writeUInt32BE(2400, 14)
  bytes.writeUInt32BE(7200, 18)
  const source = file(t, bytes, 64 * 1024 * 1024),
    reads = budget(t, source, 52)
  assert.deepEqual(await canvasOf(source), { width: 7200, height: 2400 })
  assert.equal(reads(), 52)
})
test('large JPEG dimensions do not read the pixel payload', async (t) => {
  const source = file(t, fakeJpeg(4000, 3000), 64 * 1024 * 1024),
    reads = budget(t, source, 2 * 128 * 1024)
  assert.deepEqual(await jpegSize(source), { width: 4000, height: 3000 })
  assert.equal(reads(), 2 * 128 * 1024)
})
test('capture metadata reads its bounded prefix rather than hashing all pixels', async (t) => {
  const source = file(t, fakeJpeg(4000, 3000), 64 * 1024 * 1024),
    reads = budget(t, source, 2 * 256 * 1024)
  assert.equal(await captureTime(source), null)
  assert.equal(reads(), 2 * 256 * 1024)
})
test('headers reject a transient prefix that disagrees with the second read', async (t) => {
  const source = file(t, Buffer.from('original')),
    open = fs.promises.open.bind(fs.promises)
  let injected = false
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args),
      read = handle.read.bind(handle)
    if (args[0] === source)
      handle.read = async (...input) => {
        const result = await read(...input)
        if (!injected && result.bytesRead) {
          injected = true
          input[0][input[1]] ^= 0xff
        }
        return result
      }
    return handle
  })
  await assert.rejects(readFileHeader(source, 8), { code: 'SOURCE_CHANGED' })
  assert.equal(injected, true)
})
test('headers refuse symbolic sources and invalid budgets before consumption', async (t) => {
  const source = file(t, Buffer.from('private')),
    alias = `${source}.alias`
  fs.symlinkSync(source, alias)
  await assert.rejects(readFileHeader(alias, 4), /regular file/)
  for (const limit of [0, -1, 1.1, Infinity, 1024 * 1024 + 1])
    await assert.rejects(readFileHeader(source, limit), /header budget/)
})
test('short and empty metadata files retain exact lengths', async (t) => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('tiny')])
    assert.deepEqual(await readFileHeader(file(t, bytes), 26), bytes)
})
test('a replaced header path is refused rather than borrowed from an old descriptor', async (t) => {
  const source = file(t, Buffer.from('original')),
    open = fs.promises.open.bind(fs.promises)
  let replaced = false
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args),
      read = handle.read.bind(handle)
    if (args[0] === source)
      handle.read = async (...input) => {
        const result = await read(...input)
        if (!replaced) {
          replaced = true
          fs.renameSync(source, `${source}.old`)
          fs.writeFileSync(source, 'original')
        }
        return result
      }
    return handle
  })
  await assert.rejects(readFileHeader(source, 8), { code: 'SOURCE_CHANGED' })
})
