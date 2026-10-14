'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { tmpdir, fakeJpeg, makeProject } = require('./fixtures')
const { openAlbum } = require('../lib/album')
const { listTemplates } = require('../lib/templates')
const { updateAlbum, undo, redo, migrateAlbum } = require('../lib/project')

function collisionProject(withUrls = false) {
  const root = tmpdir()
  const folders = ['one', 'two'].map((name) => path.join(root, name, 'DCIM'))
  for (const folder of folders) {
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'IMG_0001.jpg'), fakeJpeg(400, 200))
  }
  const proj = path.join(root, 'Album')
  fs.mkdirSync(proj)
  const entries = folders.map((folder) => ({ id: 'img_DCIM_IMG_0001_jpg', orient: 'h', ...(withUrls ? { url: pathToFileURL(path.join(folder, 'IMG_0001.jpg')).href } : {}) }))
  const data = { workspace: { imageTokens: folders, templateTokens: [], imageRotations: { img_DCIM_IMG_0001_jpg: 90 } }, albumPages: { 1: { photos: entries, template: null } }, totalActivePages: 1 }
  const file = path.join(proj, 'project.json')
  fs.writeFileSync(file, JSON.stringify(data))
  return { root, folders, proj, file, data }
}

test('duplicate photo basenames stay distinct; ambiguous legacy references fail visibly', async () => {
  const { proj } = collisionProject()
  const album = await openAlbum({ path: proj })
  assert.equal(album.stats.photos, 2)
  assert.equal(new Set(album.pool).size, 2)
  assert.equal(album.spreads[0].missingPhotos, 2)
  assert.ok(album.identityConflicts.some((c) => c.kind === 'photo' && c.reason === 'ambiguous-reference'))
  assert.ok(album.identityConflicts.some((c) => c.reason === 'ambiguous-adjustment'))
  assert.ok(Object.values(album.photos).every((p) => p.rotation === 0), 'an ambiguous rotation cannot be applied to both photographs')
})

test('exact saved photo URLs resolve collisions and migrated IDs survive folder removal and undo', async () => {
  const { proj, folders, file } = collisionProject(true)
  let album = await openAlbum({ path: proj })
  assert.equal(album.spreads[0].missingPhotos, 0)
  assert.deepEqual(album.spreads[0].photoIds.map((id) => album.photos[id].folder), folders)
  const ids = album.spreads[0].photoIds
  await updateAlbum({ album: proj, ops: [{ op: 'setPhotoFolders', folders: [folders[0]] }] })
  const saved = JSON.parse(fs.readFileSync(file))
  assert.ok(saved.workspace.identity.assets[ids[1]], 'missing asset identity is preserved')
  album = await openAlbum({ path: proj })
  assert.equal(album.pool[0], ids[0])
  assert.equal(album.spreads[0].photoIds[1], ids[1])
  assert.equal(album.spreads[0].missingPhotos, 1)
  album = (await undo({ album: proj })).album
  assert.deepEqual(album.spreads[0].photoIds, ids)
  assert.equal(album.spreads[0].missingPhotos, 0)
})

test('sanitization and recursive template basename collisions receive unique IDs', async () => {
  const root = tmpdir(), photos = path.join(root, 'Shoot'), templates = path.join(root, 'Templates'), proj = path.join(root, 'Album')
  fs.mkdirSync(photos)
  for (const name of ['A-B.jpg', 'A_B.jpg']) fs.writeFileSync(path.join(photos, name), fakeJpeg(400, 200))
  for (const sub of ['one', 'two']) {
    fs.mkdirSync(path.join(templates, sub), { recursive: true })
    fs.writeFileSync(path.join(templates, sub, '1h0v_001.psd'), 'x')
  }
  fs.mkdirSync(proj)
  fs.writeFileSync(path.join(proj, 'project.json'), JSON.stringify({ workspace: { imageTokens: [photos], templateTokens: [templates] }, albumPages: { 1: { photos: [], template: { id: 'tpl_Templates_1h0v_001_psd', name: '1h0v_001.psd' } } }, totalActivePages: 1 }))
  const album = await openAlbum({ path: proj })
  assert.equal(new Set(album.pool).size, 2)
  const list = await listTemplates([templates])
  assert.equal(new Set(list.map((t) => t.id)).size, 2)
  assert.equal(album.spreads[0].template.file, null)
  assert.ok(album.identityConflicts.some((c) => c.kind === 'template'))
})

test('persistent spread IDs follow move, insert, clear, delete, undo and redo', async () => {
  const { proj } = makeProject()
  const moved = await updateAlbum({ album: proj, ops: [{ op: 'moveSpread', from: 1, to: 2 }] })
  const ids = moved.album.spreads.map((s) => s.id)
  assert.ok(ids.every((id) => typeof id === 'string' && id.startsWith('spread_')))
  assert.notEqual(ids[0], ids[1])
  assert.deepEqual((await undo({ album: proj })).album.spreads.map((s) => s.id), [...ids].reverse())
  assert.deepEqual((await redo({ album: proj })).album.spreads.map((s) => s.id), ids)
  const inserted = await updateAlbum({ album: proj, ops: [{ op: 'insertSpread', at: 1 }, { op: 'clearSpread', n: 2 }] })
  assert.deepEqual(inserted.album.spreads.slice(1).map((s) => s.id), ids)
  assert.ok(!ids.includes(inserted.album.spreads[0].id))
  const removed = await updateAlbum({ album: proj, ops: [{ op: 'removeSpread', n: 2 }] })
  assert.equal(removed.album.spreads[1].id, ids[1])
  assert.deepEqual((await undo({ album: proj })).album.spreads.map((s) => s.id), inserted.album.spreads.map((s) => s.id))
})

test('a failed initial edit leaves project migration and undo history untouched', async () => {
  const { proj } = makeProject()
  const file = path.join(proj, 'project.json'), before = fs.readFileSync(file)
  await assert.rejects(updateAlbum({ album: proj, ops: [{ op: 'moveSpread', from: 1, to: 2 }, { op: 'noSuchOp' }] }), /unknown album operation/)
  assert.deepEqual(fs.readFileSync(file), before)
  assert.equal((await undo({ album: proj })).changed, false)
})

test('explicit source relink preserves IDs and colour edits, and undo restores the original root', async () => {
  const { proj, folders, file, root } = collisionProject(true)
  const initial = await migrateAlbum({ album: proj })
  const [id] = initial.spreads[0].photoIds
  await updateAlbum({ album: proj, ops: [{ op: 'adjustPhoto', id, adjust: { warmth: 25 } }] })
  const moved = path.join(root, 'moved', 'DCIM')
  fs.mkdirSync(path.dirname(moved))
  fs.renameSync(folders[0], moved)
  const relinked = (await updateAlbum({ album: proj, ops: [{ op: 'relinkFolder', kind: 'photo', from: folders[0], to: moved }] })).album
  assert.equal(relinked.photos[id].folder, moved)
  assert.deepEqual(relinked.photos[id].adjust, { warmth: 25 })
  assert.equal(relinked.spreads[0].photoIds[0], id)
  await undo({ album: proj })
  const saved = JSON.parse(fs.readFileSync(file))
  assert.ok(saved.workspace.imageTokens.includes(folders[0]))
  assert.ok(Object.values(saved.workspace.identity.roots).some((r) => r.path === folders[0]))
})

test('auto-fill replaces page edits and undo restores their original spread identities', async () => {
  const { proj } = makeProject(), file = path.join(proj, 'project.json')
  const before = await migrateAlbum({ album: proj })
  const data = JSON.parse(fs.readFileSync(file))
  data.workspace.pageLayerEdits = { 1: { opacity: 0.5 } }
  data.workspace.pageBackgrounds = { 2: 'a background' }
  fs.writeFileSync(file, JSON.stringify(data))
  await updateAlbum({ album: proj, ops: [{ op: 'autoFill', mode: 'desired', desiredSheets: 2 }] })
  const after = JSON.parse(fs.readFileSync(file))
  for (const field of ['pageOverlays', 'pageLayerEdits', 'pageBackgrounds']) assert.deepEqual(after.workspace[field], {})
  assert.ok(Object.values(after.albumPages).every((p) => !before.spreads.some((s) => s.id === p.id)))
  const restored = (await undo({ album: proj })).album
  assert.deepEqual(restored.spreads.map((s) => s.id), before.spreads.map((s) => s.id))
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).workspace.pageLayerEdits, data.workspace.pageLayerEdits)
})

test('failed atomic writes do not add, remove or move undo history', async () => {
  const { proj } = makeProject(), file = path.join(proj, 'project.json')
  await updateAlbum({ album: proj, ops: [{ op: 'clearSpread', n: 1 }] })
  const before = fs.readFileSync(file)
  const exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive
  exclusive.renameExclusive = async (from, to) => {
    if (to === file && path.basename(from) === 'install-project.json') throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' })
    return rename(from, to)
  }
  try {
    await assert.rejects(updateAlbum({ album: proj, ops: [{ op: 'insertSpread', at: 1 }] }), /simulated disk failure/)
    await assert.rejects(undo({ album: proj }), /simulated disk failure/)
    assert.deepEqual(fs.readFileSync(file), before)
    assert.equal(fs.existsSync(`${file}.tmp-${process.pid}`), false)
  } finally { exclusive.renameExclusive = rename }
  const restored = await undo({ album: proj })
  assert.equal(restored.changed, true)
  assert.equal(restored.album.spreads[0].photoIds.length, 2)
  assert.equal(restored.canUndo, false, 'the failed edit did not enter undo history')
})

test('legacy URL evidence still identifies the second photo when the first already owns the old ID', async () => {
  const { proj, folders, file, data } = collisionProject(true)
  data.workspace.imageTokens = [folders[0]]
  data.albumPages[1].photos = [data.albumPages[1].photos[0]]
  fs.writeFileSync(file, JSON.stringify(data))
  await migrateAlbum({ album: proj })
  const saved = JSON.parse(fs.readFileSync(file))
  saved.workspace.imageTokens.push(folders[1])
  saved.albumPages[1].photos.push({ id: 'img_DCIM_IMG_0001_jpg', url: pathToFileURL(path.join(folders[1], 'IMG_0001.jpg')).href, orient: 'h' })
  fs.writeFileSync(file, JSON.stringify(saved))
  const album = await openAlbum({ path: proj })
  assert.deepEqual(album.spreads[0].photoIds.map((id) => album.photos[id].folder), folders)
})

test('legacy URL evidence for an absent collided asset cannot resolve to a different present photo', async () => {
  const { proj, folders, file } = collisionProject(true)
  const initial = await migrateAlbum({ album: proj })
  const absentId = initial.spreads[0].photoIds[1]
  const saved = JSON.parse(fs.readFileSync(file))
  saved.workspace.imageTokens = [folders[0]]
  saved.albumPages[1].photos[1].id = 'img_DCIM_IMG_0001_jpg' // old application wrote its display-name ID again
  fs.writeFileSync(file, JSON.stringify(saved))
  const album = await openAlbum({ path: proj })
  assert.equal(album.spreads[0].photoIds[1], absentId)
  assert.equal(album.spreads[0].missingPhotos, 1)
})

test('duplicate persisted spread IDs and conflicting asset registry records fail before saving', async () => {
  const { proj } = makeProject(), file = path.join(proj, 'project.json')
  await migrateAlbum({ album: proj })
  const data = JSON.parse(fs.readFileSync(file))
  data.albumPages[2].id = data.albumPages[1].id
  fs.writeFileSync(file, JSON.stringify(data))
  const before = fs.readFileSync(file)
  await assert.rejects(updateAlbum({ album: proj, ops: [{ op: 'insertSpread', at: 1 }] }), /duplicate spread identity/)
  assert.deepEqual(fs.readFileSync(file), before)
  data.albumPages[2].id = 'spread_another'
  const [asset] = Object.values(data.workspace.identity.assets)
  data.workspace.identity.assets.img_conflicting = { ...asset }
  fs.writeFileSync(file, JSON.stringify(data))
  await assert.rejects(openAlbum({ path: proj }), /identity registry is invalid/)
})

test('project edits and undo cannot change a plan while its files are being produced', async () => {
  const { proj } = makeProject(), file = path.join(proj, 'project.json')
  await updateAlbum({ album: proj, ops: [{ op: 'clearSpread', n: 1 }] })
  const before = fs.readFileSync(file), jobs = require('../lib/jobs'), other = makeProject()
  for (const kind of ['render', 'export']) {
    const lease = await jobs.reserveJob(kind, proj)
    try {
      const match = kind === 'render' ? /album is rendering/ : /album is exporting/
      await assert.rejects(updateAlbum({ album: proj, ops: [{ op: 'insertSpread', at: 1 }] }), match)
      await assert.rejects(undo({ album: proj }), match)
      await assert.rejects(redo({ album: proj }), match)
      assert.equal((await migrateAlbum({ album: proj }, { lease: lease.project })).path, proj, 'only the job holding the capability can migrate during preparation')
      await updateAlbum({ album: other.proj, ops: [{ op: 'insertSpread', at: 1 }] })
      assert.deepEqual(fs.readFileSync(file), before)
    } finally { await jobs.releaseJob(lease) }
  }
  assert.equal((await undo({ album: proj })).changed, true)
})

test('clearing a spread removes its page edits and undo restores them with the same identity', async () => {
  const { proj } = makeProject()
  const before = await migrateAlbum({ album: proj })
  const cleared = (await updateAlbum({ album: proj, ops: [{ op: 'clearSpread', n: 2 }] })).album
  assert.equal(cleared.spreads[1].id, before.spreads[1].id)
  assert.equal(cleared.spreads[1].edited, false)
  const restored = (await undo({ album: proj })).album
  assert.equal(restored.spreads[1].id, before.spreads[1].id)
  assert.equal(restored.spreads[1].edited, true)
})
