'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { fakeJpeg, makeProject, tmpdir } = require('./fixtures')

process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()
const { updateAlbum, undo, redo } = require('../lib/project')

const A = 'img_My_Shoot_A1_jpg'
const B = 'img_My_Shoot_B2_jpg'
const C = 'img_My_Shoot_C3_jpg'
const GONE = 'img_My_Shoot_GONE_jpg'
const TPL = 'tpl_Templates_2026_1h1v_0001_psd'

const fileOf = (proj) => path.join(proj, 'project.json')
const read = (proj) => JSON.parse(fs.readFileSync(fileOf(proj), 'utf8'))
const ids = (d, n) => d.albumPages[n].photos.map((p) => p.id)
const edit = (proj, ...ops) => updateAlbum({ album: proj, ops })

test('an edit saves in the Electron format and keeps the previous version', async () => {
  const { proj, shoot } = makeProject()
  const before = fs.readFileSync(fileOf(proj))
  const r = await edit(proj, { op: 'addPhoto', n: 2, id: C })

  const d = read(proj)
  assert.deepEqual(Object.keys(d.albumPages), ['1', '2'])
  assert.equal(d.totalActivePages, 2)
  assert.deepEqual(ids(d, 2), [GONE, C], 'a photo no longer on disk stays where it was')
  assert.deepEqual(d.albumPages[2].photos[1], { id: C, url: 'file://' + path.join(shoot, '_Thumbnails', 'C3.jpg'), orient: 'v' })
  assert.equal(d.version, 1, 'fields this app does not edit are kept')
  assert.deepEqual(d.renderHashes, { 1: 'abc' })
  assert.deepEqual(d.workspace.imageRotations, { [C]: 90 })
  assert.notEqual(d.savedAt, '2026-10-01T00:00:00.000Z')
  assert.deepEqual(fs.readFileSync(fileOf(proj) + '.bak'), before, 'the replaced version is kept as project.json.bak')
  assert.deepEqual(fs.readdirSync(proj).filter((f) => f.includes('.tmp-')), [], 'no temporary file is left behind')

  assert.deepEqual(r.album.spreads[1].photoIds, [GONE, C], 'the reply carries the updated album')
  assert.deepEqual([r.canUndo, r.canRedo], [true, false])
})

test('adding moves a photo off its old spread; replacing swaps across spreads', async () => {
  const { proj } = makeProject()
  await edit(proj, { op: 'addPhoto', n: 2, id: A, index: 0 })
  let d = read(proj)
  assert.deepEqual([ids(d, 1), ids(d, 2)], [[B], [A, GONE]])

  await edit(proj, { op: 'replacePhoto', n: 1, oldId: B, newId: A })
  d = read(proj)
  assert.deepEqual([ids(d, 1), ids(d, 2)], [[A], [B, GONE]], 'a photo from another spread trades places')

  await edit(proj, { op: 'replacePhoto', n: 1, oldId: A, newId: C })
  d = read(proj)
  assert.deepEqual([ids(d, 1), ids(d, 2)], [[C], [B, GONE]], 'an unused photo takes the slot; the old one goes back to the pool')

  await edit(proj, { op: 'removePhoto', n: 1, id: C }, { op: 'setPhotos', n: 2, photoIds: [A, B] })
  d = read(proj)
  assert.deepEqual([ids(d, 1), ids(d, 2)], [[], [A, B]])
})

test('spreads insert, move and delete, and their page edits move with them', async () => {
  const { proj } = makeProject()
  await edit(proj, { op: 'insertSpread', at: 1 })
  let d = read(proj)
  assert.equal(d.totalActivePages, 3)
  assert.deepEqual([ids(d, 1), ids(d, 2), ids(d, 3)], [[], [A, B], [GONE]])
  assert.deepEqual(Object.keys(d.workspace.pageOverlays), ['3'], 'the overlay follows its spread')

  await edit(proj, { op: 'moveSpread', from: 3, to: 1 })
  d = read(proj)
  assert.deepEqual([ids(d, 1), ids(d, 2), ids(d, 3)], [[GONE], [], [A, B]])
  assert.deepEqual(Object.keys(d.workspace.pageOverlays), ['1'])

  await edit(proj, { op: 'removeSpread', n: 1 })
  d = read(proj)
  assert.equal(d.totalActivePages, 2)
  assert.deepEqual(d.workspace.pageOverlays, {}, 'a deleted spread takes its overlays with it')

  await edit(proj, { op: 'removeSpread', n: 1 }, { op: 'removeSpread', n: 1 })
  d = read(proj)
  assert.equal(d.totalActivePages, 1, 'an album always keeps one spread')
  assert.deepEqual(d.albumPages[1], { photos: [], template: null })

  await assert.rejects(edit(proj, { op: 'clearSpread', n: 5 }), /There is no spread 5/)
})

test('templates are set by id; a failed edit saves nothing', async () => {
  const { proj, tpls } = makeProject()
  await edit(proj, { op: 'setTemplate', n: 2, templateId: TPL })
  const d = read(proj)
  assert.deepEqual(d.albumPages[2].template, { id: TPL, name: '1h1v_0001.psd', h: 1, v: 1, url: 'file://' + path.join(tpls, 'Thumbnails', '1h1v_0001.jpg') })

  const saved = fs.readFileSync(fileOf(proj))
  // The first op is fine; the second fails, so neither is saved.
  await assert.rejects(edit(proj, { op: 'clearSpread', n: 1 }, { op: 'setTemplate', n: 1, templateId: 'tpl_nope' }), /isn’t in this album’s collections/)
  await assert.rejects(edit(proj, { op: 'explode' }), /unknown album operation `explode`/)
  await assert.rejects(edit(proj, { op: 'addPhoto', n: 1, id: 'img_who' }), /isn't in this album's folders/)
  assert.deepEqual(fs.readFileSync(fileOf(proj)), saved)
})

test('undo and redo walk the history; a new edit clears redo; no-op edits are not steps', async () => {
  const { proj } = makeProject()
  await edit(proj, { op: 'clearSpread', n: 1 })
  await edit(proj, { op: 'insertSpread' })
  assert.equal(read(proj).totalActivePages, 3)

  let r = await undo({ album: proj })
  assert.equal(read(proj).totalActivePages, 2)
  assert.deepEqual([r.changed, r.canUndo, r.canRedo], [true, true, true])
  r = await undo({ album: proj })
  assert.deepEqual(ids(read(proj), 1), [A, B])
  assert.deepEqual([r.canUndo, r.canRedo], [false, true])
  r = await undo({ album: proj })
  assert.equal(r.changed, false, 'nothing left to undo')

  r = await redo({ album: proj })
  assert.deepEqual(ids(read(proj), 1), [])
  r = await edit(proj, { op: 'moveSpread', from: 1, to: 1 })
  assert.deepEqual([r.canUndo, r.canRedo], [true, true], 'an edit that changes nothing is not a step')
  r = await edit(proj, { op: 'addPhoto', n: 1, id: C })
  assert.deepEqual([r.canUndo, r.canRedo], [true, false], 'a new edit clears redo')
})

test('auto-fill re-plans the album from every photo, as one undoable step', async () => {
  const { proj, tpls } = makeProject()
  fs.writeFileSync(path.join(tpls, '1h0v_0002.psd'), 'x')
  fs.writeFileSync(path.join(tpls, '0h1v_0003.psd'), 'x')
  // rng 0: counts [1, 2] → [A] (1 H) and [B, C] (2 V, no such template).
  const r = await updateAlbum({ album: proj, ops: [{ op: 'autoFill', mode: 'desired', desiredSheets: 2, chronological: false }] }, { rng: () => 0 })
  const d = read(proj)
  assert.equal(d.totalActivePages, 2)
  assert.deepEqual([ids(d, 1), ids(d, 2)], [[A], [B, C]])
  assert.equal(d.albumPages[1].template.name, '1h0v_0002.psd')
  assert.equal(d.albumPages[2].template, null)
  assert.deepEqual(r.report.autoFill, { spreads: 2, withoutTemplate: 1, cappedTo: null })

  await assert.rejects(edit(proj, { op: 'autoFill', mode: 'range', min: 3, max: 2 }), /Invalid Min\/Max/)
  await undo({ album: proj })
  assert.deepEqual(ids(read(proj), 1), [A, B], 'one undo brings the whole previous album back')
})

test('several photos are added at once, copied on request, and reordered', async () => {
  const { proj } = makeProject()
  await edit(proj, { op: 'addPhoto', n: 2, ids: [C, A], index: 0 })
  let d = read(proj)
  assert.deepEqual([ids(d, 1), ids(d, 2)], [[B], [C, A, GONE]], 'moved off spread 1, in the order given')

  await edit(proj, { op: 'addPhoto', n: 1, id: A, copy: true })
  d = read(proj)
  assert.deepEqual([ids(d, 1), ids(d, 2)], [[B, A], [C, A, GONE]], 'a copy leaves the photo where it was too')

  await edit(proj, { op: 'movePhoto', n: 2, id: GONE, index: 0 })
  assert.deepEqual(ids(read(proj), 2), [GONE, C, A])
  await edit(proj, { op: 'swapPhotos', n: 2, a: A, b: GONE })
  assert.deepEqual(ids(read(proj), 2), [A, C, GONE])
  await assert.rejects(edit(proj, { op: 'movePhoto', n: 1, id: C, index: 0 }), /no longer on this spread/)
})

test('fitTemplate picks a template whose frames fit the photos, from the same collection first', async () => {
  const { proj, root, tpls, shoot } = makeProject()
  fs.writeFileSync(path.join(shoot, '_Thumbnails', 'D4.jpg'), fakeJpeg(400, 266))
  const D = 'img_My_Shoot_D4_jpg'
  fs.writeFileSync(path.join(tpls, '2h0v_0001.psd'), 'x')
  fs.writeFileSync(path.join(tpls, '2h0v_0002.psd'), 'x')
  const other = path.join(root, 'Other')
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(other, '2h0v_0009.psd'), 'x')
  fs.writeFileSync(path.join(other, '1h0v_0001.psd'), 'x')
  const d0 = read(proj)
  d0.workspace.templateTokens.push(other)
  fs.writeFileSync(fileOf(proj), JSON.stringify(d0))

  // Spread 1 is A (H) + B (V) on a 1H 1V template: it fits, so nothing changes.
  let r = await edit(proj, { op: 'fitTemplate', n: 1 })
  assert.equal(r.canUndo, false, 'a fitting template is left alone')

  // Two landscape photos no longer fit 1H 1V.
  r = await updateAlbum({ album: proj, ops: [{ op: 'setPhotos', n: 1, photoIds: [A, D] }, { op: 'fitTemplate', n: 1 }] }, { rng: () => 0.99 })
  let d = read(proj)
  assert.equal(d.albumPages[1].template.name, '2h0v_0002.psd', 'the same collection is preferred')
  assert.deepEqual(r.report.templates, [{ n: 1, name: '2h0v_0002.psd', auto: true }])

  await updateAlbum({ album: proj, ops: [{ op: 'fitTemplate', n: 1, another: true }] }, { rng: () => 0 })
  d = read(proj)
  assert.equal(d.albumPages[1].template.name, '2h0v_0001.psd', 'another: never the current one')

  r = await edit(proj, { op: 'setPhotos', n: 1, photoIds: [A, B, C] }, { op: 'fitTemplate', n: 1 })
  assert.deepEqual(r.report.noTemplate, [{ n: 1, h: 1, v: 2 }], 'no 1H 2V template: said so, template kept')
  assert.equal(read(proj).albumPages[1].template.name, '2h0v_0001.psd')
})

test('the print-sheet folder changes like any edit, and undoes', async () => {
  const { proj, root } = makeProject()
  const before = read(proj).workspace.outputToken
  await edit(proj, { op: 'setOutputFolder', folder: path.join(root, 'Prints') })
  assert.equal(read(proj).workspace.outputToken, path.join(root, 'Prints'))
  await undo({ album: proj })
  assert.equal(read(proj).workspace.outputToken, before)
  await assert.rejects(edit(proj, { op: 'setOutputFolder', folder: 'relative/path' }), /Choose a folder/)
})

test('edits sent together apply in order, none lost', async () => {
  const { proj } = makeProject()
  await Promise.all([
    edit(proj, { op: 'addPhoto', n: 1, id: C }),
    edit(proj, { op: 'removePhoto', n: 1, id: A }),
    edit(proj, { op: 'insertSpread' }),
  ])
  const d = read(proj)
  assert.deepEqual(ids(d, 1), [B, C])
  assert.equal(d.totalActivePages, 3)
})

test('a very old project with a bare workspace stays bare', async () => {
  const { proj } = makeProject()
  const d0 = read(proj)
  const { workspace, ...rest } = d0
  fs.writeFileSync(fileOf(proj), JSON.stringify({ ...workspace, ...rest }))
  await edit(proj, { op: 'insertSpread', at: 1 })
  const d = read(proj)
  assert.equal(d.workspace, undefined)
  assert.deepEqual(Object.keys(d.pageOverlays), ['3'])
  assert.equal(d.totalActivePages, 3)
})

test('photos turn in quarter turns, everywhere they appear, and the turn undoes', async () => {
  const { proj } = makeProject()
  let r = await edit(proj, { op: 'rotatePhotos', ids: [A], by: 90 })
  let d = read(proj)
  assert.deepEqual(d.workspace.imageRotations, { [C]: 90, [A]: 90 }, 'kept as the Electron app does')
  assert.equal(d.albumPages[1].photos[0].orient, 'v', 'a quarter turn makes a landscape photo portrait on its spread')
  assert.deepEqual([r.album.photos[A].rotation, r.album.photos[A].orient], [90, 'v'])

  r = await edit(proj, { op: 'rotatePhotos', ids: [A, C], by: -90 })
  d = read(proj)
  assert.deepEqual(d.workspace.imageRotations, {}, 'turned back upright: no entry left')
  assert.deepEqual([r.album.photos[C].rotation, r.album.photos[C].orient], [0, 'h'], 'a photo on no spread follows its thumbnail and turn')
  assert.equal(d.albumPages[1].photos[0].orient, 'h')

  r = await edit(proj, { op: 'rotatePhotos', ids: [B], by: 180 })
  assert.deepEqual([r.album.photos[B].rotation, r.album.photos[B].orient], [180, 'v'], 'a half turn keeps the orientation')

  await undo({ album: proj })
  r = await undo({ album: proj })
  d = read(proj)
  assert.deepEqual(d.workspace.imageRotations, { [C]: 90, [A]: 90 })
  assert.equal(d.albumPages[1].photos[0].orient, 'v')
  assert.equal(r.album.photos[A].rotation, 90)
  await assert.rejects(edit(proj, { op: 'rotatePhotos', ids: [A], by: 45 }), /quarter turns/)
  await assert.rejects(edit(proj, { op: 'rotatePhotos', ids: ['img_nope'], by: 90 }), /isn't in this album/)
})

/** A minimal PSD: a canvas and one photo frame layer at `left` (ag-psd writes it). */
function framePsd(file, { width, height, name, left, top, w, h }) {
  const ag = require('ag-psd')
  const px = (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4).fill(255) })
  ag.initializeCanvas((a, b) => ({ width: a, height: b, getContext: () => ({ createImageData: px, getImageData: () => px(a, b), putImageData: () => {} }) }))
  const psd = { width, height, imageData: px(width, height), children: [{ name, left, top, right: left + w, bottom: top + h, imageData: px(w, h) }] }
  fs.writeFileSync(file, Buffer.from(ag.writePsd(psd, { generateThumbnail: false })))
}

test('templates picked for the photos skip ones with a frame parked off the page', async () => {
  const { framesOffPage, offPageFrames } = require('../lib/template_check')
  assert.deepEqual(framesOffPage(300, 100, [
    { name: 'in', x: 10, y: 10, w: 100, h: 80 },
    { name: 'half', x: 250, y: 10, w: 100, h: 80 },
    { name: 'parked', x: 298, y: 0, w: 80, h: 100 },
    { name: 'hidden', x: 400, y: 0, w: 10, h: 10, hidden: true },
  ]), ['parked'], 'half on the page still shows; hidden frames show nothing anyway')

  const { proj, tpls } = makeProject()
  framePsd(path.join(tpls, '1h0v_0001.psd'), { width: 300, height: 100, name: 'ToolkitHFrame_001', left: 296, top: 10, w: 100, h: 60 })
  framePsd(path.join(tpls, '1h0v_0002.psd'), { width: 300, height: 100, name: 'ToolkitHFrame_001', left: 20, top: 10, w: 100, h: 60 })
  assert.deepEqual(await offPageFrames(path.join(tpls, '1h0v_0001.psd')), ['ToolkitHFrame_001'])
  // rng 0 tries 1h0v_0001 first: its frame is off the page, so 1h0v_0002 is chosen.
  await updateAlbum({ album: proj, ops: [{ op: 'clearSpread', n: 2 }, { op: 'addPhoto', n: 2, id: A }, { op: 'fitTemplate', n: 2 }] }, { rng: () => 0 })
  assert.equal(read(proj).albumPages[2].template.name, '1h0v_0002.psd')
})

test('templates picked for the photos keep to the album’s page shape', async () => {
  const { shapeOf, commonShape } = require('../lib/templates')
  assert.equal(shapeOf({ width: 7200, height: 2400 }), shapeOf({ width: 10800, height: 3600 }), 'same shape at another resolution')
  assert.equal(commonShape([{ width: 7200, height: 2400 }, { width: 7200, height: 4500 }, { width: 10800, height: 3600 }]), 3)

  const { proj, tpls } = makeProject()
  const frame = { name: 'ToolkitHFrame_001', left: 10, top: 10, w: 50, h: 30 }
  // The album's spread 1 template becomes a 3:1 page; 1h0v_0001 is 16:10, 1h0v_0002 is 3:1.
  framePsd(path.join(tpls, '1h1v_0001.psd'), { width: 300, height: 100, ...frame })
  framePsd(path.join(tpls, '1h0v_0001.psd'), { width: 160, height: 100, ...frame })
  framePsd(path.join(tpls, '1h0v_0002.psd'), { width: 600, height: 200, ...frame })
  await updateAlbum({ album: proj, ops: [{ op: 'clearSpread', n: 2 }, { op: 'addPhoto', n: 2, id: C }, { op: 'rotatePhotos', ids: [C], by: 90 }, { op: 'fitTemplate', n: 2 }] }, { rng: () => 0 })
  assert.equal(read(proj).albumPages[2].template.name, '1h0v_0002.psd', 'rng 0 would take the 16:10 page; the 3:1 one is chosen')
})

test('a photo is zoomed and panned in its frame, clamped, and fits again; undo covers it', async () => {
  const { proj } = makeProject()
  let r = await edit(proj, { op: 'placePhoto', id: A, scale: 1.8, ox: -0.4, oy: 2 })
  assert.deepEqual(read(proj).workspace.imagePlacements, { [A]: { scale: 1.8, ox: -0.4, oy: 1 } }, 'kept as the Electron app does; pan clamped to the edge')
  assert.deepEqual(r.album.photos[A].placement, { scale: 1.8, ox: -0.4, oy: 1 })
  r = await edit(proj, { op: 'placePhoto', id: A })
  assert.deepEqual(read(proj).workspace.imagePlacements, {}, 'no values: fitted again, nothing kept')
  assert.equal(r.album.photos[A].placement, null)
  await undo({ album: proj })
  assert.deepEqual(read(proj).workspace.imagePlacements, { [A]: { scale: 1.8, ox: -0.4, oy: 1 } })
  await assert.rejects(edit(proj, { op: 'placePhoto', id: 'img_nope', scale: 2 }), /isn't in this album/)
})
