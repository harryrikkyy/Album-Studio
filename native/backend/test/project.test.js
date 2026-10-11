'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { updateAlbum, undo, redo } = require('../lib/project')
const { fakeJpeg, makeProject } = require('./fixtures')

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
