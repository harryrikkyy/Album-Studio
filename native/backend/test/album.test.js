'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')

const { jpegSizeFromBuffer } = require('../lib/jpeg_size')
const { openAlbum } = require('../lib/album')
const { listRecent, rememberAlbum } = require('../lib/recent')
const { dispatch } = require('../server')
const { fakeJpeg, tmpdir, makeProject } = require('./fixtures')

test('reads a JPEG size from its header', () => {
  assert.deepEqual(jpegSizeFromBuffer(fakeJpeg(7200, 2400)), { width: 7200, height: 2400 })
  assert.equal(jpegSizeFromBuffer(Buffer.from('not a jpeg')), null)
  assert.equal(jpegSizeFromBuffer(Buffer.from([0xff, 0xd8])), null)
})

test('opens a project: spreads, templates, proofs, photos', async () => {
  const { shoot, tpls, proj } = makeProject()
  const a = await openAlbum({ path: proj })
  assert.equal(a.name, 'Album')
  assert.deepEqual(a.stats, { spreads: 2, photos: 3, used: 2, planned: 2 })

  const [s1, s2] = a.spreads
  assert.equal(s1.template.file, path.join(tpls, '1h1v_0001.psd'))
  assert.equal(s1.template.preview, path.join(tpls, 'Thumbnails', '1h1v_0001.jpg'))
  assert.equal(s1.proof, path.join(proj, 'proofs', 'pages', 'live_page_001.jpg'))
  assert.equal(s1.edited, false)
  assert.ok(s1.sheet.endsWith(path.join('out', 'Page_001.psd')), 'the rendered sheet is found in the output folder')
  assert.equal(s2.template, null)
  assert.equal(s2.sheet, null, 'no rendered sheet yet')
  assert.equal(s2.missingPhotos, 1, 'a photo that is no longer on disk is counted, not dropped')
  assert.equal(s2.edited, true)

  const a1 = a.photos.img_My_Shoot_A1_jpg
  assert.equal(a1.thumb, path.join(shoot, '_Thumbnails', 'A1.jpg'))
  assert.equal(a1.original, path.join(shoot, 'A1.JPG'))
  assert.deepEqual(a1.usedOn, [1])
  assert.equal(a.photos.img_My_Shoot_B2_jpg.original, path.join(shoot, 'B2.ARW'))
  // C3 is landscape on disk but rotated 90°, and no spread records it: portrait.
  assert.equal(a.photos.img_My_Shoot_C3_jpg.orient, 'v')
  assert.deepEqual(a.pool, ['img_My_Shoot_A1_jpg', 'img_My_Shoot_B2_jpg', 'img_My_Shoot_C3_jpg'])
})

test('a missing project explains itself', async () => {
  await assert.rejects(openAlbum({ path: '/definitely/not/here' }), /disconnected, or the project moved/)
  const empty = tmpdir()
  await assert.rejects(openAlbum({ path: empty }), /isn't an Album Studio project/)
})

test('recent albums: newest first, de-duplicated, availability checked', async () => {
  process.env.ALBUM_STUDIO_DATA_DIR = tmpdir()
  const { proj } = makeProject()
  const a = await openAlbum({ path: proj })
  await rememberAlbum(a)
  await rememberAlbum({ ...a, path: '/gone/away', name: 'Gone' })
  await rememberAlbum(a)
  const list = await listRecent()
  assert.deepEqual(list.map((e) => e.name), ['Album', 'Gone'])
  assert.equal(list[0].available, true)
  assert.equal(list[1].available, false)
  assert.ok(list[0].cover.endsWith('live_page_001.jpg'))
})

test('the protocol answers unknown methods with an error, not a crash', async () => {
  const out = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = (s, callback) => { out.push(String(s)); if (callback) queueMicrotask(callback); return true }
  try {
    await dispatch(JSON.stringify({ id: 9, method: 'nope' }))
    await dispatch(JSON.stringify({ id: 10, method: 'system.ping', params: { n: 3 } }))
    await dispatch('{not json')
  } finally {
    process.stdout.write = orig
  }
  const replies = out.map((l) => JSON.parse(l))
  assert.deepEqual(replies[0], { id: 9, ok: false, error: 'unknown method `nope`', code: 'METHOD_UNKNOWN', details: { issues: [{ path: '/method', message: 'Unknown method.', keyword: 'enum' }] } })
  assert.equal(replies[1].result.pong, 3)
  assert.equal(replies.length, 2, 'a line that is not JSON gets no reply')
})

test('a JPEG is measured the way it is seen: EXIF orientations 5–8 swap width and height', async () => {
  const sharp = require('../../../src/sharp_config').getSharp()
  const { jpegSize } = require('../lib/jpeg_size')
  const dir = require('./fixtures').tmpdir()
  const sizes = {}
  for (const o of [1, 3, 6, 8]) {
    const f = path.join(dir, `o${o}.jpg`)
    await sharp({ create: { width: 300, height: 200, channels: 3, background: '#888' } }).jpeg().withMetadata({ orientation: o }).toFile(f)
    sizes[o] = await jpegSize(f)
  }
  assert.deepEqual(sizes[1], { width: 300, height: 200 })
  assert.deepEqual(sizes[3], { width: 300, height: 200 }, 'upside down is still landscape')
  assert.deepEqual(sizes[6], { width: 200, height: 300 }, 'a portrait the camera stored sideways')
  assert.deepEqual(sizes[8], { width: 200, height: 300 })
  assert.deepEqual(jpegSizeFromBuffer(require('fs').readFileSync(path.join(dir, 'o6.jpg')), { stored: true }), { width: 300, height: 200 }, 'a PDF embeds the stored grid')
})
