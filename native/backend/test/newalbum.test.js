'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { tmpdir } = require('./fixtures')

process.env.ALBUM_STUDIO_DATA_DIR = tmpdir()
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()

const sharp = require('sharp')
const { surveyFolder, ensureThumbnails, makeThumb } = require('../lib/thumbs')
const { createAlbum, inspectCollections, inspectFolders, knownCollections, setAlbumFolders, suggestAlbum } = require('../lib/newalbum')
const { undo } = require('../lib/project')

const noise = (w, h) => sharp({ create: { width: w, height: h, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } })

/** A TIFF-shaped "RAW" carrying a JPEG preview and an orientation tag, like an ARW. */
function fakeRaw(jpeg, orientation) {
  const ifd = Buffer.alloc(2 + 3 * 12 + 4)
  ifd.writeUInt16LE(3, 0)
  const entry = (i, tag, type, value) => { const o = 2 + i * 12; ifd.writeUInt16LE(tag, o); ifd.writeUInt16LE(type, o + 2); ifd.writeUInt32LE(1, o + 4); ifd.writeUInt32LE(value, o + 8) }
  entry(0, 0x0112, 3, orientation)
  entry(1, 0x0201, 4, 8 + ifd.length)
  entry(2, 0x0202, 4, jpeg.length)
  return Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]), ifd, jpeg])
}

/** A shoot: two JPEGs (one stored sideways with an EXIF turn), a RAW, and a RAW+JPEG pair. */
async function makeShoot(root, name = 'wedding') {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  await noise(1200, 800).jpeg().toFile(path.join(dir, 'A.jpg'))
  await noise(1200, 800).jpeg().withMetadata({ orientation: 6 }).toFile(path.join(dir, 'B.JPG'))
  fs.writeFileSync(path.join(dir, 'C.ARW'), fakeRaw(await noise(1600, 1066).jpeg().toBuffer(), 8))
  fs.writeFileSync(path.join(dir, 'D.ARW'), fakeRaw(await noise(1600, 1066).jpeg().toBuffer(), 1))
  await noise(900, 600).jpeg().toFile(path.join(dir, 'D.jpg'))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a photo')
  return dir
}

const size = async (f) => { const m = await sharp(f).metadata(); return [m.width, m.height] }

test('a folder survey counts each photo once and lists the thumbnails still to make', async () => {
  const root = tmpdir()
  const dir = await makeShoot(root)
  fs.mkdirSync(path.join(dir, '_Thumbnails'))
  await makeThumb(path.join(dir, 'A.jpg'), path.join(dir, '_Thumbnails', 'A.jpg'))
  const s = await surveyFolder(dir)
  assert.equal(s.exists, true)
  assert.equal(s.photos, 4, 'A, B, C, and D (its RAW and JPEG are one photo)')
  assert.equal(s.raws, 1, 'D counts as its JPEG')
  assert.equal(s.thumbs, 1)
  assert.deepEqual(s.missing, ['B.JPG', 'C.ARW', 'D.jpg'])
  assert.equal((await surveyFolder(path.join(root, 'nope'))).exists, false)
})

test('thumbnails are made upright at 400 px, RAWs from their embedded preview, and only once', async () => {
  const dir = await makeShoot(tmpdir())
  const progress = []
  const r = await ensureThumbnails(dir, (p) => progress.push(p))
  assert.deepEqual([r.made, r.failed], [4, []])
  const t = (n) => path.join(dir, '_Thumbnails', n)
  assert.deepEqual(await size(t('A.jpg')), [400, 267])
  assert.deepEqual(await size(t('B.jpg')), [267, 400], 'the EXIF turn is applied')
  assert.deepEqual(await size(t('C.jpg')), [267, 400], 'the RAW’s orientation 8 turns its preview upright')
  assert.deepEqual(await size(t('D.jpg')), [400, 267])
  assert.deepEqual(progress.at(-1), { done: 4, total: 4, current: progress.at(-1).current })
  assert.deepEqual(fs.readdirSync(path.join(dir, '_Thumbnails')).filter((n) => !n.startsWith('.')).sort(), ['A.jpg', 'B.jpg', 'C.jpg', 'D.jpg'], 'only photo proxies appear in the catalogue')
  assert.ok(fs.statSync(path.join(dir, '_Thumbnails', '.album-studio-thumbs')).isDirectory(), 'provenance is hidden from photo enumeration')

  const again = await ensureThumbnails(dir)
  assert.equal(again.made, 0, 'nothing to do the second time')
})

test('creating an album: thumbnails, the project in the Electron format, a first plan', async () => {
  const root = tmpdir()
  const dir = await makeShoot(root)
  const tpls = path.join(root, 'Templates')
  fs.mkdirSync(tpls)
  for (const n of ['2h0v_0001', '1h1v_0001', '2h1v_0001', '1h2v_0001', '3h1v_0001', '0h1v_0001', '1h0v_0001']) fs.writeFileSync(path.join(tpls, `${n}.psd`), 'x')

  assert.deepEqual(suggestAlbum({ photoFolders: [dir] }), { name: 'Wedding Album', parent: root })
  const [info] = await inspectFolders({ paths: [dir] })
  assert.deepEqual([info.photos, info.missing], [4, 4])

  const events = []
  const r = await createAlbum(
    { name: 'Wedding Album', parent: root, photoFolders: [dir], templateCollections: [tpls], autoFill: { desiredSheets: 2 } },
    { emit: (e, d) => events.push([e, d.stage]) },
  )
  const folder = path.join(root, 'Wedding Album')
  const d = JSON.parse(fs.readFileSync(path.join(folder, 'project.json'), 'utf8'))
  assert.equal(d.version, 1)
  assert.deepEqual(d.workspace.imageTokens, [dir])
  assert.deepEqual(d.workspace.templateTokens, [tpls])
  assert.equal(d.workspace.outputToken, path.join(folder, 'exports'))
  assert.ok(fs.existsSync(path.join(folder, 'exports')) && fs.existsSync(path.join(folder, 'proofs')))
  assert.equal(d.totalActivePages, 2)
  assert.equal(Object.values(d.albumPages).flatMap((p) => p.photos).length, 4, 'every photo placed')
  assert.ok(Object.values(d.albumPages).every((p) => p.template), 'each spread got a fitting template')
  assert.equal(r.album.name, 'Wedding Album')
  assert.deepEqual([...new Set(events.map((e) => e[1]))], ['thumbs', 'project', 'plan'])

  await assert.rejects(createAlbum({ name: 'Wedding Album', parent: root, photoFolders: [dir], templateCollections: [] }, { emit() {} }), /already an album called/)
  await assert.rejects(createAlbum({ name: 'a/b', parent: root, photoFolders: [dir] }, { emit() {} }), /can’t contain/)
  await assert.rejects(createAlbum({ name: 'X', parent: root, photoFolders: [path.join(root, 'gone')] }, { emit() {} }), /isn’t there/)
  await assert.rejects(createAlbum({ name: 'Y', parent: root, photoFolders: [dir], templateCollections: [], autoFill: { desiredSheets: 2 } }, { emit() {} }), /needs at least one template collection/)

  // The new album's collection is suggested for the next one.
  const known = await knownCollections()
  assert.deepEqual(known.map((k) => [k.name, k.templates, k.albums]), [['Templates', 7, ['Wedding Album']]])
  const [c, gone] = await inspectCollections({ paths: [tpls, path.join(root, 'nope')] })
  assert.deepEqual([c.templates, c.exists, gone.exists, gone.templates], [7, true, false, 0])
})

test('an album’s folders change later: new photo folders get thumbnails, and it undoes', async () => {
  const root = tmpdir()
  const one = await makeShoot(root, 'haldi')
  const two = await makeShoot(root, 'wedding')
  const tpls = path.join(root, 'Templates')
  fs.mkdirSync(tpls)
  fs.writeFileSync(path.join(tpls, '1h1v_0001.psd'), 'x')
  await createAlbum({ name: 'Album', parent: root, photoFolders: [one], templateCollections: [] }, { emit() {} })
  const proj = path.join(root, 'Album')
  const events = []
  const r = await setAlbumFolders({ album: proj, photoFolders: [one, two], templateCollections: [tpls] }, { emit: (e, d) => events.push([e, d.stage]) })
  assert.equal(r.album.stats.photos, 8, 'both shoots’ photos')
  assert.deepEqual(r.album.templateCollections.map((c) => c.name), ['Templates'])
  assert.ok(fs.existsSync(path.join(two, '_Thumbnails', 'A.jpg')), 'thumbnails made for the new folder')
  assert.ok(events.every(([e]) => e === 'album.folders'))
  const back = await undo({ album: proj })
  assert.deepEqual([back.album.stats.photos, back.album.templateCollections.length], [4, 0], 'one undo puts both back')
  await assert.rejects(setAlbumFolders({ album: proj, photoFolders: [] }, { emit() {} }), /at least one photo folder/)
})
