'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { tmpdir, makeProject, fakeJpeg } = require('./fixtures')
const modulePath = path.resolve(__dirname, '../lib/project_domain')
function valid() {
  return {
    version: 1,
    workspace: { imageTokens: [], templateTokens: [] },
    albumPages: { 1: { photos: [], template: null } },
    totalActivePages: 1,
  }
}
function fixture(t, data) {
  const root = tmpdir(),
    file = path.join(root, 'project.json')
  fs.writeFileSync(file, JSON.stringify(data))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, file }
}
const childScript = `const {openAlbum}=require(process.argv[1]);openAlbum({path:process.argv[2]}).then(a=>{process.send({accepted:true,spreads:a.spreads.length});process.exit(0)},e=>{process.send({rejected:true,message:e.message,code:e.code});process.exit(0)});`
for (const count of ['Infinity', '1e309', '9007199254740991', 2.5])
  test(`ordinary album open rejects unsafe count ${count} within a bounded subprocess`, async (t) => {
    const d = valid()
    d.totalActivePages = count
    const f = fixture(t, d),
      original = fs.readFileSync(f.file)
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=64', '-e', childScript, path.resolve(__dirname, '../lib/album'), f.file],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    )
    let message,
      stderr = ''
    child.on('message', (m) => {
      message = m
    })
    child.stderr.on('data', (b) => {
      stderr = (stderr + b).slice(-2048)
    })
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 700)
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        resolve({ code, signal })
      })
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })
    assert.equal(result.signal, null, `loader did not reject before its bounded process limit: ${stderr}`)
    assert.equal(message && message.rejected, true, JSON.stringify(message))
    assert.match(message.message, /page|spread|count|integer|finite|limit|invalid/i)
    assert.deepEqual(fs.readFileSync(f.file), original)
    assert.deepEqual(fs.readdirSync(f.root), ['project.json'])
  })

test('pure validation rejects unsafe project counts, malformed arrays and future versions without mutation', () => {
  const { validateProject, LIMITS } = require(modulePath)
  for (const count of [Infinity, NaN, -1, 1.5, null, true, 'Infinity', '1e4', ' 2', '2.0', LIMITS.SPREADS + 1]) {
    const d = valid()
    d.totalActivePages = count
    assert.throws(() => validateProject(d), /page|spread|integer|count|finite|limit|invalid/i)
  }
  for (const change of [
    (d) => {
      d.albumPages = []
    },
    (d) => {
      d.workspace = []
    },
    (d) => {
      d.albumPages[1].photos = 'photo'
    },
    (d) => {
      d.albumPages[1].photos = [null]
    },
    (d) => {
      d.workspace.imageTokens = '/a-folder'
    },
    (d) => {
      d.workspace.templateTokens = [null]
    },
    (d) => {
      d.version = 2
    },
    (d) => {
      d.version = '99'
    },
  ]) {
    const d = valid()
    change(d)
    const before = JSON.stringify(d)
    assert.throws(() => validateProject(d))
    assert.equal(JSON.stringify(d), before)
  }
})

test('legacy migration is explicit, idempotent, in-place and preserves unknown extension fields', () => {
  const { migrateProject, validateProject } = require(modulePath)
  const extension = { vendor: { marker: 'keep byte-semantic JSON data' } },
    d = {
      version: '0',
      imageTokens: [],
      templateTokens: [],
      totalActivePages: '2',
      albumPages: { 1: { photos: null, template: null, custom: extension }, 2: { photos: [], template: null } },
      extension,
    }
  const result = migrateProject(d)
  assert.equal(result, d)
  assert.equal(d.version, 1)
  assert.equal(d.totalActivePages, 2)
  assert.deepEqual(d.albumPages[1].photos, [])
  assert.equal(d.extension, extension)
  assert.equal(d.albumPages[1].custom, extension)
  assert.equal(d.workspace, undefined, 'the flat legacy workspace remains flat')
  const once = JSON.stringify(d)
  assert.equal(migrateProject(d), d)
  validateProject(d)
  assert.equal(JSON.stringify(d), once)
})

test('rejected migration leaves even supported pending normalizations untouched', () => {
  const { migrateProject } = require(modulePath),
    d = valid()
  d.version = '1'
  d.totalActivePages = '1'
  d.albumPages[1].photos = 'wrong'
  const before = JSON.stringify(d)
  assert.throws(() => migrateProject(d))
  assert.equal(JSON.stringify(d), before)
})

test('missing count preserves sparse page positions and bounded inactive data is never silently discarded', () => {
  const { migrateProject, validateProject } = require(modulePath),
    d = valid()
  delete d.totalActivePages
  d.albumPages[5] = { photos: [{ id: 'missing-photo', extension: 'preserve' }], template: null }
  migrateProject(d)
  assert.equal(d.totalActivePages, 5)
  assert.equal(d.albumPages[5].photos[0].extension, 'preserve')
  d.totalActivePages = 1
  assert.throws(() => validateProject(d), /count|page|spread|outside|active/i)
})

test('ordinary open normalizes the supplied owned data object without cloning it', async (t) => {
  const d = valid(),
    f = fixture(t, d),
    supplied = { ...valid(), version: '1', totalActivePages: '1', extension: { keep: true } }
  const a = await require('../lib/album').openAlbum({ path: f.file }, { data: supplied })
  assert.equal(supplied.version, 1)
  assert.equal(supplied.totalActivePages, 1)
  assert.equal(supplied.albumPages[1].id, a.spreads[0].id)
  assert.ok(supplied.workspace.identity)
})

test('a future version is refused before identity mutation or source-folder scans', async (t) => {
  const f = fixture(t, valid()),
    d = { ...valid(), version: 2 }
  d.workspace.imageTokens = [path.join(f.root, 'untrusted-source')]
  const before = JSON.stringify(d),
    readdir = fs.promises.readdir
  let scans = 0
  t.mock.method(fs.promises, 'readdir', async (...args) => {
    scans++
    return readdir(...args)
  })
  await assert.rejects(require('../lib/album').openAlbum({ path: f.file }, { data: d }), /newer|future|version/i)
  assert.equal(scans, 0)
  assert.equal(JSON.stringify(d), before)
})

test('direct spread identity materialization shares the finite page guard', () => {
  const d = valid()
  d.totalActivePages = 'Infinity'
  const source = `const {ensureSpreadIds}=require(process.argv[1]);try{ensureSpreadIds(JSON.parse(process.argv[2]));process.exit(3)}catch(e){process.stdout.write(e.message);process.exit(0)}`
  const { spawnSync } = require('child_process'),
    r = spawnSync(
      process.execPath,
      ['--max-old-space-size=64', '-e', source, path.resolve(__dirname, '../lib/identity'), JSON.stringify(d)],
      { timeout: 700, maxBuffer: 4096 },
    )
  assert.equal(r.status, 0, 'identity entry point must reject before a loop')
  assert.match(r.stdout.toString(), /page|spread|integer|count|invalid/i)
})

test('operation and creation boundaries reject malformed/unbounded inputs before filesystem work', async (t) => {
  const { validateOperations, validateCreateInput, LIMITS } = require(modulePath)
  for (const ops of [
    null,
    [],
    new Array(LIMITS.OPERATIONS + 1).fill({ op: 'clearSpread', n: 1 }),
    [null],
    [{ op: 'insertSpread', at: Infinity }],
    [{ op: 'setPhotos', n: 1, photoIds: 'not-array' }],
    [{ op: 'autoFill', desiredSheets: 'Infinity' }],
  ])
    assert.throws(() => validateOperations(ops), /operation|ops|spread|integer|array|invalid|limit/i)
  assert.throws(() => validateCreateInput({ photoFolders: 'a-string', templateCollections: [] }), /folder|array/i)
  assert.throws(
    () => validateCreateInput({ photoFolders: [], templateCollections: [], autoFill: { desiredSheets: Infinity } }),
    /spread|integer|finite|limit|invalid/i,
  )
  const f = makeProject()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const file = path.join(f.proj, 'project.json'),
    before = fs.readFileSync(file)
  await assert.rejects(
    require('../lib/project').updateAlbum({ album: f.proj, ops: [{ op: 'insertSpread', at: Infinity }] }),
    /integer|spread|invalid/i,
  )
  assert.deepEqual(fs.readFileSync(file), before)
})

test('finite limits reject oversized folder/photo/page collections with recoverable errors', () => {
  const { validateProject, LIMITS } = require(modulePath)
  const folders = valid()
  folders.workspace.imageTokens = new Array(LIMITS.FOLDERS + 1).fill('/source')
  assert.throws(() => validateProject(folders), /folder|limit/i)
  const photos = valid()
  photos.albumPages[1].photos = new Array(LIMITS.PHOTOS_PER_SPREAD + 1).fill({ id: 'photo' })
  assert.throws(() => validateProject(photos), /photo|limit/i)
  const pages = valid()
  pages.albumPages[LIMITS.SPREADS + 1] = { photos: [] }
  assert.throws(() => validateProject(pages), /page|spread|limit/i)
})

test('ordinary catalogue reopening observes in-place thumbnail dimensions even with preserved file/directory stamps', async (t) => {
  const f = makeProject()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const file = path.join(f.proj, 'project.json'),
    project = JSON.parse(fs.readFileSync(file))
  project.workspace.imageRotations = {}
  fs.writeFileSync(file, JSON.stringify(project))
  const open = require('../lib/album').openAlbum,
    id = 'img_My_Shoot_C3_jpg',
    thumb = path.join(f.shoot, '_Thumbnails', 'C3.jpg'),
    before = fs.statSync(thumb),
    folderBefore = fs.statSync(path.dirname(thumb)).mtimeMs
  assert.equal((await open({ path: f.proj })).photos[id].width, 400)
  fs.writeFileSync(thumb, fakeJpeg(200, 400))
  fs.utimesSync(thumb, before.atime, before.mtime)
  assert.equal(fs.statSync(thumb).size, before.size)
  assert.equal(fs.statSync(path.dirname(thumb)).mtimeMs, folderBefore)
  const photo = (await open({ path: f.proj })).photos[id]
  assert.equal(photo.width, 200)
  assert.equal(photo.height, 400)
  assert.equal(photo.orient, 'v')
})
