'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { tmpdir } = require('./fixtures')

process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()

const sharp = require('sharp')
const agpsd = require('ag-psd')
const { listSheets, renameSheets, psdThumbnail } = require('../lib/labnaming')

async function makeOrder() {
  const dir = path.join(tmpdir(), '256')
  fs.mkdirSync(dir)
  for (const [name, w] of [['Page_002.jpg', 900], ['Page_010.jpg', 900], ['Page_001.jpg', 900], ['cover.png', 600]]) {
    await sharp({ create: { width: w, height: 300, channels: 3, background: '#888' } })[name.endsWith('png') ? 'png' : 'jpeg']().toFile(path.join(dir, name))
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
  return dir
}

test('an order folder lists its sheets in natural order, with thumbnails and sizes', async () => {
  const dir = await makeOrder()
  const r = await listSheets({ folder: dir })
  assert.equal(r.name, '256')
  assert.deepEqual(r.sheets.map((s) => s.fileName), ['cover.png', 'Page_001.jpg', 'Page_002.jpg', 'Page_010.jpg'])
  assert.deepEqual([r.sheets[1].width, r.sheets[1].height], [900, 300])
  assert.ok(fs.existsSync(r.sheets[1].thumb))
  await assert.rejects(listSheets({ folder: path.join(dir, 'nope') }), /isn’t there/)
})

test('renames swap safely, keep extensions, refuse clashes, and undo', async () => {
  const dir = await makeOrder()
  const p = (n) => path.join(dir, n)
  // Page_001 ↔ Page_002 swap names, the cover becomes the pad.
  const r = await renameSheets({ folder: dir, ops: [
    { fromPath: p('Page_001.jpg'), toBaseName: 'Page_002' },
    { fromPath: p('Page_002.jpg'), toBaseName: 'Page_001' },
    { fromPath: p('cover.png'), toBaseName: 'ZZZ--256--Matte--12x36--3+1' },
  ] })
  assert.equal(r.renamed, 3)
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Page_001.jpg', 'Page_002.jpg', 'Page_010.jpg', 'ZZZ--256--Matte--12x36--3+1.png', 'notes.txt'])
  await renameSheets({ folder: dir, ops: r.undo })
  assert.deepEqual(fs.readdirSync(dir).sort(), ['Page_001.jpg', 'Page_002.jpg', 'Page_010.jpg', 'cover.png', 'notes.txt'], 'undone')

  await assert.rejects(renameSheets({ folder: dir, ops: [{ fromPath: p('Page_001.jpg'), toBaseName: 'Page_010' }] }), /already exists/)
  await assert.rejects(renameSheets({ folder: dir, ops: [{ fromPath: p('Page_001.jpg'), toBaseName: 'x' }, { fromPath: p('Page_002.jpg'), toBaseName: 'x' }] }), /both be called/)
  await assert.rejects(renameSheets({ folder: dir, ops: [{ fromPath: p('Page_001.jpg'), toBaseName: '../x' }] }), /can’t be a file name/)
  await assert.rejects(renameSheets({ folder: dir, ops: [{ fromPath: '/etc/hosts', toBaseName: 'x' }] }), /isn’t in/)
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.as-rename')), [], 'no temporary files left')
})

test('a PSD’s stored JPEG preview is found', async () => {
  const jpeg = await sharp({ create: { width: 60, height: 20, channels: 3, background: '#c00' } }).jpeg().toBuffer()
  // Image resource 1036: a 28-byte header, then the JPEG.
  const res = Buffer.concat([Buffer.alloc(28), jpeg])
  const block = Buffer.concat([Buffer.from('8BIM'), Buffer.from([0x04, 0x0c, 0, 0]), Buffer.alloc(4), res, Buffer.alloc(res.length % 2)])
  block.writeUInt32BE(res.length, 8)
  const head = Buffer.alloc(26)
  head.write('8BPS', 0, 'latin1')
  const colour = Buffer.alloc(4)
  const resLen = Buffer.alloc(4)
  resLen.writeUInt32BE(block.length)
  const buf = Buffer.concat([head, colour, resLen, block])
  assert.deepEqual(psdThumbnail(buf), jpeg)
  assert.equal(psdThumbnail(agpsd.writePsdBuffer({ width: 4, height: 4, children: [] })), null, 'none stored: none found')
})
