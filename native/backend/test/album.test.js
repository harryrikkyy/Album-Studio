'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { jpegSizeFromBuffer } = require('../lib/jpeg_size')
const { openAlbum } = require('../lib/album')
const { listRecent, rememberAlbum } = require('../lib/recent')
const { dispatch } = require('../server')

/** A minimal valid JPEG header: SOI, APP0, SOF0 with the given size. */
function fakeJpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])
  const sof = Buffer.alloc(19)
  sof.writeUInt16BE(0xffc0, 0)
  sof.writeUInt16BE(17, 2)
  sof[4] = 8
  sof.writeUInt16BE(height, 5)
  sof.writeUInt16BE(width, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'as-backend-'))
}

/** A project with one photo folder (thumbnails + originals) and two spreads. */
function makeProject() {
  const root = tmpdir()
  const shoot = path.join(root, 'My Shoot')
  fs.mkdirSync(path.join(shoot, '_Thumbnails'), { recursive: true })
  fs.writeFileSync(path.join(shoot, '_Thumbnails', 'A1.jpg'), fakeJpeg(400, 266))
  fs.writeFileSync(path.join(shoot, '_Thumbnails', 'B2.jpg'), fakeJpeg(266, 400))
  fs.writeFileSync(path.join(shoot, '_Thumbnails', 'C3.jpg'), fakeJpeg(400, 266))
  fs.writeFileSync(path.join(shoot, 'A1.JPG'), 'x')
  fs.writeFileSync(path.join(shoot, 'B2.jpg'), 'x')
  fs.writeFileSync(path.join(shoot, 'B2.ARW'), 'x') // RAW wins over the same-named JPEG
  const tpls = path.join(root, 'Templates 2026')
  fs.mkdirSync(path.join(tpls, 'Thumbnails'), { recursive: true })
  fs.writeFileSync(path.join(tpls, '1h1v_0001.psd'), 'x')
  fs.writeFileSync(path.join(tpls, 'Thumbnails', '1h1v_0001.jpg'), fakeJpeg(300, 100))
  fs.mkdirSync(path.join(root, 'out'), { recursive: true })
  fs.writeFileSync(path.join(root, 'out', 'Page_001.psd'), 'x')
  const proj = path.join(root, 'Album')
  fs.mkdirSync(path.join(proj, 'proofs', 'pages'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'proofs', 'pages', 'live_page_001.jpg'), fakeJpeg(300, 100))
  fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({
    version: 1,
    savedAt: '2026-10-01T00:00:00.000Z',
    workspace: { imageTokens: [shoot], templateTokens: [tpls], outputToken: path.join(root, 'out'), imageRotations: { img_My_Shoot_C3_jpg: 90 }, pageOverlays: { 2: [{ kind: 'text' }] } },
    albumPages: {
      1: { photos: [{ id: 'img_My_Shoot_A1_jpg', orient: 'h' }, { id: 'img_My_Shoot_B2_jpg', orient: 'v' }], template: { id: 'tpl_Templates_2026_1h1v_0001_psd', name: '1h1v_0001.psd', h: 1, v: 1 } },
      2: { photos: [{ id: 'img_My_Shoot_GONE_jpg', orient: 'h' }], template: null },
    },
    totalActivePages: 2,
  }))
  return { root, shoot, tpls, proj }
}

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
  process.stdout.write = (s) => { out.push(String(s)); return true }
  try {
    await dispatch(JSON.stringify({ id: 9, method: 'nope' }))
    await dispatch(JSON.stringify({ id: 10, method: 'system.ping', params: { n: 3 } }))
    await dispatch('{not json')
  } finally {
    process.stdout.write = orig
  }
  const replies = out.map((l) => JSON.parse(l))
  assert.deepEqual(replies[0], { id: 9, ok: false, error: 'unknown method `nope`' })
  assert.equal(replies[1].result.pong, 3)
  assert.equal(replies.length, 2, 'a line that is not JSON gets no reply')
})
