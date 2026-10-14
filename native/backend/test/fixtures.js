'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

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
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'as-backend-')))
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
    renderHashes: { 1: 'abc' },
  }))
  return { root, shoot, tpls, proj }
}

module.exports = { fakeJpeg, tmpdir, makeProject }
