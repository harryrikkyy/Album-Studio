'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { tmpdir, makeProject } = require('./fixtures')

process.env.ALBUM_STUDIO_DATA_DIR = tmpdir()
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()

const { openAlbum } = require('../lib/album')
const { rememberAlbum } = require('../lib/recent')
const { addCollections, collectionTemplates, libraryCollections, removeCollection, setDefaults } = require('../lib/library')

test('the library: collections albums use and ones added, defaults for new albums, removal leaves files', async () => {
  const { proj, tpls, root } = makeProject()
  await rememberAlbum(await openAlbum({ path: proj }))
  let lib = await libraryCollections()
  assert.deepEqual(lib.collections.map((c) => [c.name, c.templates, c.albums, c.isDefault]), [['Templates 2026', 1, ['Album'], true]])
  assert.equal(lib.defaultsChosen, false)

  const extra = path.join(root, 'Market PSDs')
  fs.mkdirSync(extra)
  fs.writeFileSync(path.join(extra, '2h1v_0001.psd'), 'x')
  lib = await addCollections({ paths: [extra] })
  assert.deepEqual(lib.collections.map((c) => c.name), ['Templates 2026', 'Market PSDs'], 'used ones first')

  lib = await setDefaults({ paths: [extra] })
  assert.deepEqual(lib.collections.map((c) => [c.name, c.isDefault]), [['Templates 2026', false], ['Market PSDs', true]])

  lib = await removeCollection({ path: tpls })
  assert.deepEqual(lib.collections.map((c) => c.name), ['Market PSDs'])
  assert.ok(fs.existsSync(path.join(tpls, '1h1v_0001.psd')), 'the folder is untouched')
  lib = await addCollections({ paths: [tpls] })
  assert.equal(lib.collections.length, 2, 'adding it again brings it back')

  const t = await collectionTemplates({ path: extra })
  assert.deepEqual(t.map((x) => [x.name, x.h, x.v]), [['2h1v_0001.psd', 2, 1]])
})

test('storage: cache sizes, and clearing only what was asked', async () => {
  const { storageUsage, clearStorage } = require('../lib/storage')
  const { cacheRoot } = require('../lib/cache')
  fs.mkdirSync(path.join(cacheRoot(), 'raw-previews'), { recursive: true })
  fs.writeFileSync(path.join(cacheRoot(), 'raw-previews', 'a.jpg'), Buffer.alloc(1000))
  fs.mkdirSync(path.join(cacheRoot(), 'picks'), { recursive: true })
  fs.writeFileSync(path.join(cacheRoot(), 'picks', 'x.json'), '{}')
  const { proj, root } = makeProject()
  fs.mkdirSync(path.join(root, 'out', '.album-studio', 'raw'), { recursive: true })
  fs.writeFileSync(path.join(root, 'out', '.album-studio', 'raw', 'B2.jpg'), Buffer.alloc(500))
  fs.writeFileSync(path.join(root, 'out', '.album-studio', 'render-cache.json'), '{}')
  let u = await storageUsage({ album: proj })
  const get = (id) => u.caches.find((c) => c.id === id)
  assert.deepEqual([get('raw-previews').bytes, get('raw').bytes, get('raw').scope], [1000, 500, 'album'])
  u = await clearStorage({ ids: ['raw-previews', 'raw'], album: proj })
  assert.deepEqual([get('raw-previews').bytes, get('raw').bytes, get('picks').files], [0, 0, 1])
  assert.ok(fs.existsSync(path.join(root, 'out', '.album-studio', 'render-cache.json')), 'the render record stays')
  await assert.rejects(clearStorage({ ids: ['../../etc'] }), /Unknown cache/)
})
