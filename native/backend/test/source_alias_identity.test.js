'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const { makeProject, fakeJpeg } = require('./fixtures')
const { openAlbum } = require('../lib/album')
const { migrateAlbum, updateAlbum } = require('../lib/project')
function fixture(t) {
  const f = makeProject(),
    alias = path.join(f.root, 'ShootAlias'),
    file = path.join(f.proj, 'project.json'),
    templateAlias = path.join(f.root, 'TemplateAlias')
  fs.symlinkSync(f.shoot, alias)
  fs.symlinkSync(f.tpls, templateAlias)
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  return {
    ...f,
    alias,
    file,
    templateAlias,
    read: () => JSON.parse(fs.readFileSync(file)),
    save: (d) => fs.writeFileSync(file, JSON.stringify(d)),
  }
}
function oldAliases(f) {
  const d = f.read(),
    primary = 'img_saved_primary',
    alias = 'img_saved_alias',
    root = 'root_primary',
    aliasRoot = 'root_alias'
  d.workspace.imageTokens = [f.shoot, f.alias]
  d.workspace.identity = {
    version: 1,
    roots: { [root]: { kind: 'photo', path: f.shoot }, [aliasRoot]: { kind: 'photo', path: f.alias } },
    assets: {
      [primary]: { kind: 'photo', rootId: root, relativePath: '_Thumbnails/A1.jpg', legacyId: 'img_My_Shoot_A1_jpg' },
      [alias]: {
        kind: 'photo',
        rootId: aliasRoot,
        relativePath: '_Thumbnails/A1.jpg',
        legacyId: 'img_ShootAlias_A1_jpg',
      },
    },
  }
  d.workspace.imageAdjustments = { [primary]: { warmth: 25 }, [alias]: { warmth: -25 } }
  d.albumPages[1].photos = [
    { id: primary, url: pathToFileURL(path.join(f.shoot, '_Thumbnails/A1.jpg')).href, orient: 'h' },
  ]
  d.albumPages[2].photos = [
    { id: alias, url: pathToFileURL(path.join(f.alias, '_Thumbnails/A1.jpg')).href, orient: 'h' },
  ]
  f.save(d)
  return { d, primary, alias, root, aliasRoot }
}

test('new registry canonicalizes two logical source aliases into one photo pool and preserves exact legacy references', async (t) => {
  const f = fixture(t),
    d = f.read()
  d.workspace.imageTokens.push(f.alias)
  d.albumPages[2].photos = [
    { id: 'img_ShootAlias_A1_jpg', orient: 'h', url: pathToFileURL(path.join(f.alias, '_Thumbnails/A1.jpg')).href },
  ]
  f.save(d)
  const a = await migrateAlbum({ album: f.proj }),
    saved = f.read()
  assert.equal(a.stats.photos, 3)
  assert.equal(new Set(a.pool.map((id) => fs.realpathSync(a.photos[id].thumb))).size, 3)
  assert.equal(a.spreads[0].photoIds[0], a.spreads[1].photoIds[0])
  assert.equal(a.spreads[1].missingPhotos, 0)
  assert.equal(Object.values(saved.workspace.identity.roots).filter((r) => r.kind === 'photo').length, 1)
  const root = Object.values(saved.workspace.identity.roots).find((r) => r.kind === 'photo')
  assert.equal(root.path, fs.realpathSync(f.shoot))
  assert.ok(root.aliases.includes(f.alias))
  assert.equal(saved.albumPages[2].photos[0].url, d.albumPages[2].photos[0].url)
})

test('adding/reordering/removing a new alias keeps persisted IDs and existing per-photo edits', async (t) => {
  const f = fixture(t),
    first = await migrateAlbum({ album: f.proj }),
    ids = first.pool
  await updateAlbum({ album: f.proj, ops: [{ op: 'adjustPhoto', id: ids[0], adjust: { warmth: 33 } }] })
  for (const folders of [[f.alias, f.shoot], [f.alias], [f.shoot]]) {
    const result = (await updateAlbum({ album: f.proj, ops: [{ op: 'setPhotoFolders', folders }] })).album
    assert.deepEqual(result.pool, ids)
    assert.equal(result.photos[ids[0]].adjust.warmth, 33)
    assert.equal(result.spreads[0].missingPhotos, 0)
  }
})

test('separately persisted physical aliases retain both IDs/edits and make auto-fill fail visibly', async (t) => {
  const f = fixture(t),
    old = oldAliases(f),
    a = await migrateAlbum({ album: f.proj })
  assert.equal(a.spreads[0].photoIds[0], old.primary)
  assert.equal(a.spreads[1].photoIds[0], old.alias)
  assert.equal(a.photos[old.primary].adjust.warmth, 25)
  assert.equal(a.photos[old.alias].adjust.warmth, -25)
  assert.ok(a.identityConflicts.some((c) => c.reason === 'physical-source-alias'))
  const before = fs.readFileSync(f.file)
  await assert.rejects(
    updateAlbum({ album: f.proj, ops: [{ op: 'autoFill', mode: 'desired', desiredSheets: 2 }] }),
    /alias|same physical|same source/i,
  )
  assert.deepEqual(fs.readFileSync(f.file), before)
})

test('conflicting unregistered legacy alias adjustments and page references are never silently merged', async (t) => {
  const f = fixture(t),
    d = f.read(),
    primary = 'img_My_Shoot_A1_jpg',
    alias = 'img_ShootAlias_A1_jpg'
  d.workspace.imageTokens.push(f.alias)
  d.workspace.imageAdjustments = { [primary]: { warmth: 25 }, [alias]: { warmth: -25 } }
  d.albumPages[2].photos = [
    { id: alias, orient: 'h', url: pathToFileURL(path.join(f.alias, '_Thumbnails/A1.jpg')).href },
  ]
  f.save(d)
  const a = await migrateAlbum({ album: f.proj }),
    saved = f.read()
  assert.deepEqual(saved.workspace.imageAdjustments, d.workspace.imageAdjustments)
  assert.equal(saved.albumPages[2].photos[0].id, alias)
  assert.equal(a.spreads[1].photoIds[0], alias)
  assert.ok(a.identityConflicts.some((c) => c.reason === 'conflicting-alias-adjustment'))
})

test('a newly selected alias with multiple historical owners stays unresolved until an original root is chosen', async (t) => {
  const f = fixture(t),
    old = oldAliases(f),
    third = path.join(f.root, 'ThirdAlias')
  fs.symlinkSync(f.shoot, third)
  const d = f.read()
  d.workspace.imageTokens = [third]
  f.save(d)
  const a = await openAlbum({ path: f.proj })
  assert.equal(a.stats.photos, 0)
  assert.ok(a.identityConflicts.some((c) => c.reason === 'physical-source-alias'))
  assert.equal(a.spreads[0].photoIds[0], old.primary)
  assert.equal(a.spreads[1].photoIds[0], old.alias)
  const resolved = (await updateAlbum({ album: f.proj, ops: [{ op: 'setPhotoFolders', folders: [f.shoot] }] })).album
  assert.ok(resolved.photos[old.primary])
  assert.equal(resolved.photos[old.alias], undefined)
  assert.equal(resolved.identityConflicts.filter((c) => c.reason === 'physical-source-alias').length, 0)
  assert.equal(f.read().workspace.imageAdjustments[old.alias].warmth, -25)
})

test('template root aliases deduplicate only when they have a single attributable identity', async (t) => {
  const f = fixture(t),
    { listTemplates } = require('../lib/templates')
  assert.equal((await listTemplates([f.tpls, f.templateAlias])).length, 1)
  const d = f.read()
  d.workspace.templateTokens = [f.tpls, f.templateAlias]
  d.workspace.identity = {
    version: 1,
    roots: { root_first: { kind: 'template', path: f.tpls }, root_second: { kind: 'template', path: f.templateAlias } },
    assets: {
      tpl_first: {
        kind: 'template',
        rootId: 'root_first',
        relativePath: '1h1v_0001.psd',
        legacyId: 'tpl_Templates_2026_1h1v_0001_psd',
      },
      tpl_second: {
        kind: 'template',
        rootId: 'root_second',
        relativePath: '1h1v_0001.psd',
        legacyId: 'tpl_TemplateAlias_1h1v_0001_psd',
      },
    },
  }
  d.albumPages[1].template.id = 'tpl_first'
  d.albumPages[2].template = { id: 'tpl_second', name: '1h1v_0001.psd' }
  f.save(d)
  const a = await openAlbum({ path: f.proj })
  assert.deepEqual(
    a.spreads.map((s) => s.template.id),
    ['tpl_first', 'tpl_second'],
  )
  assert.ok(a.identityConflicts.some((c) => c.kind === 'template' && c.reason === 'physical-source-alias'))
})

test('same-display physical aliases preserve a uniquely attributable legacy ID', async (t) => {
  const f = fixture(t),
    alias = path.join(f.root, 'other', 'My Shoot')
  fs.mkdirSync(path.dirname(alias))
  fs.symlinkSync(f.shoot, alias)
  const d = f.read()
  d.workspace.imageTokens = [f.shoot, alias]
  f.save(d)
  const a = await migrateAlbum({ album: f.proj })
  assert.equal(a.stats.photos, 3)
  assert.ok(a.pool.includes('img_My_Shoot_A1_jpg'))
  assert.equal(a.spreads[0].photoIds[0], 'img_My_Shoot_A1_jpg')
})

test('removing collided roots never frees their legacy alias for an unrelated third photo or its edits', async (t) => {
  const f = fixture(t),
    folders = ['one', 'two', 'third'].map((name) => path.join(f.root, name, 'DCIM')),
    legacy = 'img_DCIM_A_jpg'
  for (const folder of folders) {
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, 'A.jpg'), fakeJpeg(400, 200))
  }
  const d = f.read()
  d.workspace.imageTokens = folders.slice(0, 2)
  d.workspace.imageAdjustments = { [legacy]: { warmth: 80 } }
  d.albumPages = { 1: { photos: [{ id: legacy }], template: null } }
  d.totalActivePages = 1
  f.save(d)
  const before = await migrateAlbum({ album: f.proj })
  assert.equal(before.spreads[0].missingPhotos, 1)
  const after = (await updateAlbum({ album: f.proj, ops: [{ op: 'setPhotoFolders', folders: [folders[2]] }] })).album
  assert.equal(
    after.spreads[0].missingPhotos,
    1,
    'an old ambiguous reference must not acquire the newly selected unrelated original',
  )
  assert.equal(after.photos[legacy], undefined)
  assert.notEqual(after.pool[0], legacy)
  assert.equal(after.photos[after.pool[0]].adjust, null)
  assert.equal(f.read().workspace.imageAdjustments[legacy].warmth, 80)
})
