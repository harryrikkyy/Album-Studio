'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { tmpdir, makeProject } = require('./fixtures')
const c = require('../../contracts/runtime')
const root = tmpdir()
process.env.ALBUM_STUDIO_DATA_DIR = path.join(root, 'data')
process.env.ALBUM_STUDIO_CACHE_DIR = path.join(root, 'cache')
test.after(() => fs.rmSync(root, { recursive: true, force: true }))

// Deliberately authored protocol examples, not samples generated from the schema.
// Native examples verify the declared contract only; they do not execute the native shell.
const album = { path: '/album', file: '/album/project.json', name: 'Album', savedAt: null, outputFolder: '/out', photoFolders: [], templateCollections: [], spreads: [], photos: {}, pool: [], stats: { spreads: 0, photos: 0, used: 0, planned: 0 } }
const updated = { album, canUndo: true, canRedo: false, changed: true, report: { noTemplate: [] } }
const account = { state: 'signedOut', configured: false, reason: 'not_activated' }
const collections = { collections: [{ path: '/templates', name: 'Templates', exists: true, templates: 1, albums: ['Album'], isDefault: true }], defaultsChosen: true }
const template = { id: 'tpl-one', name: '1h0v.psd', file: '/templates/1h0v.psd', preview: null, collection: 'Templates', sourceRoot: '/templates', h: 1, v: 0, width: 200, height: 100 }
const paths = { sheets: '/out', high: '/out/JPEG-High-Res', low: '/out/JPEG-Low-Res', pdf: '/out/Album.pdf', cache: '/out/.album-studio/export-cache.json' }
const renderStarted = { jobId: 'render-1', total: 1, outputFolder: '/out', album: '/album' }
const exportStarted = { jobId: 'export-1', total: 1, paths, missingSheets: [] }
const storage = { root: '/cache', caches: [{ id: 'raw', label: 'RAW', scope: 'album', bytes: 1, files: 1 }], retention: { historyPath: '/cache/.history', bytes: 1, stages: 1, limits: { maxHistoryBytes: 8589934592, maxHistoryStages: 256, minFreeBytes: 268435456 }, automaticPruning: false } }
const vectors = {
  'system.ping': [{ n: 7 }, { pong: 7, node: 'v22.22.3' }],
  'account.status': [{ refresh: false }, account], 'account.signIn': [{}, account], 'account.cancelSignIn': [{}, null], 'account.retry': [{}, account], 'account.signOut': [{}, account],
  'album.open': [{ path: '/album' }, album], 'album.recent': [{}, [{ path: '/album', name: 'Album', openedAt: '2026-10-15', spreads: 1, photos: 1, cover: null, available: true }]],
  'folders.inspect': [{ paths: ['/shoot'] }, [{ path: '/shoot', name: 'Shoot', exists: true, photos: 1, raws: 0, thumbs: 1, missing: 0, samples: ['one.jpg'] }]],
  'templates.collections': [{}, collections.collections], 'templates.inspect': [{ paths: ['/templates'] }, collections.collections],
  'album.suggest': [{ photoFolders: ['/shoot'] }, { name: 'Shoot', parent: '/' }],
  'album.create': [{ name: 'Album', parent: '/albums', photoFolders: ['/shoot'], autoFill: { desiredSheets: 1 } }, { album, report: null, thumbFailures: [], thumbFailed: 0 }],
  'album.setFolders': [{ album: '/album', photoFolders: ['/shoot'], templateCollections: ['/templates'] }, updated],
  'album.update': [{ album: '/album', ops: [{ op: 'addPhoto', n: 1, ids: ['photo-one'] }] }, updated],
  'album.undo': [{ album: '/album' }, updated], 'album.redo': [{ album: '/album' }, updated],
  'templates.list': [{ album: '/album' }, [template]],
  'spread.layout': [{ album: '/album', n: 1 }, { n: 1, template: 'tpl-one', width: 200, height: 100, backdrop: null, frames: [{ name: 'Frame', orient: 'h', x: 0, y: 0, w: 200, h: 100, z: 0, photoId: 'photo-one' }], unplaced: [] }],
  'library.collections': [{}, collections], 'library.add': [{ paths: ['/templates'] }, collections], 'library.remove': [{ path: '/templates' }, collections], 'library.setDefaults': [{ paths: ['/templates'] }, collections], 'library.templates': [{ path: '/templates' }, [template]],
  'storage.usage': [{ album: '/album' }, storage], 'storage.clear': [{ album: '/album', ids: ['raw'] }, storage],
  'lab.list': [{ folder: '/out' }, { folder: '/out', name: 'out', sheets: [{ path: '/out/001.psd', fileName: '001.psd', baseName: '001', ext: '.psd', thumb: null, width: 200, height: 100 }] }],
  'lab.rename': [{ folder: '/out', ops: [{ fromPath: '/out/001.psd', toBaseName: '002' }] }, { renamed: 1, undo: [{ fromPath: '/out/002.psd', toBaseName: '001' }] }],
  'picks.analyze': [{ folders: ['/shoot'] }, { photos: [{ thumb: '/shoot/_Thumbnails/one.jpg', base: 'one', folder: '/shoot', orient: 'h', sharpness: 10, exposure: 0.5, blackPct: 0, whitePct: 0, hash: 'abcd' }] }],
  'picks.copy': [{ picks: [{ folder: '/shoot', base: 'one' }] }, { folders: [{ folder: '/shoot', dest: '/shoot/Selected', copied: 1, skipped: 0 }], copied: 1, skipped: 0 }],
  'proofs.refresh': [{ album: '/album' }, { queued: true }],
  'render.start': [{ album: '/album', spreads: [1] }, renderStarted], 'render.cancel': [{ jobId: 'render-1' }, { cancelled: true }], 'render.status': [{}, { running: false }],
  'render.plan': [{ album: '/album' }, { outputFolder: '/out', spreads: [{ n: 1, id: 'spread-one', state: 'current' }], running: { running: false } }],
  'export.plan': [{ album: '/album', pdf: true }, { paths, settings: { size: 'print', heightInches: 12, ppi: 300, highQuality: 95, lowQuality: 75 }, spreads: [{ n: 1, id: 'spread-one', psd: '/out/001.psd', stamp: '123', state: 'todo' }], preflight: { errors: [], warnings: [], info: [] }, pdf: null, running: { running: false } }],
  'export.start': [{ album: '/album', jpegs: true }, exportStarted], 'export.cancel': [{}, { cancelled: false }], 'export.status': [{}, { running: true, jobId: 'export-1', total: 1, done: 0, skipped: 0, failed: 0 }],
  'shell.ping': [{ n: 3 }, { pong: 3 }], 'shell.info': [{}, { photocraft: '/cli', mode: 'native' }],
  'editor.open': [{ path: '/album/project.json' }, null], 'editor.inspect': [{}, { open: true, geometry: [1, 2] }],
  'dialog.pickFolder': [{ title: 'Folder', multiple: true }, ['/shoot']], 'shell.reveal': [{ path: '/out' }, null],
  'shell.showAlbum': [{}, null], 'shell.dragWindow': [{}, null], 'shell.zoomWindow': [{}, null], 'shell.activate': [{}, null],
  'shell.log': [{ level: 'warn', message: 'A warning' }, null], 'shell.selftestReturnAfter': [{ ms: 10 }, null],
  'debug.queuePicks': [{ answers: ['/shoot', ['/one', '/two'], null] }, null], 'debug.result': [{ key: 1, result: { passed: true } }, null],
}
const finished = { jobId: 'render-1', total: 1, done: 1, skipped: 0, failed: 0, cancelled: false, ms: 100, finishingError: 'Engine close warning', warnings: ['Engine close warning'] }
const events = {
  'backend.ready': { pid: 123, node: 'v22.22.3' }, 'backend.exited': {}, 'account.signIn': { stage: 'browser' },
  'album.creating': { stage: 'project', spreads: 1 }, 'album.folders': { stage: 'thumbs', current: 'one.jpg', done: 1, total: 1 },
  'picks.progress': { stage: 'score', folder: '/shoot', done: 1, total: 1 },
  'render.started': renderStarted, 'render.progress': { jobId: 'render-1', total: 1, n: 1, state: 'done', index: 0, ms: 100 },
  'render.finished': { ...finished, outputFolder: '/out', results: [{ n: 1, state: 'done', committed: true, path: '/out/001.psd' }] },
  'export.started': exportStarted, 'export.progress': { jobId: 'export-1', total: 1, state: 'pdf', pages: 1 },
  'export.finished': { ...finished, jobId: 'export-1', paths, results: [{ n: 1, state: 'done', width: 200, height: 100 }], pdf: { path: '/out/Album.pdf', pages: 1, bytes: 100 }, missingSheets: [] },
  'proofs.updated': { album: '/album', n: 1, proof: '/album/proofs/pages/one.jpg', source: 'sheet' }, 'proofs.failed': { album: '/album', n: 1, error: 'Source unavailable' }, 'proofs.idle': { album: '/album', rendered: 1, failed: 0 },
  'shell.albumShown': {}, menu: { command: 'save' },
}
test('every registered method has authored valid request/result/reply examples', async t => {
  assert.equal(Object.keys(vectors).length, 53)
  assert.deepEqual(Object.keys(vectors).sort(), Object.keys(c.manifest.methods).sort())
  for (const [method, [params, result]] of Object.entries(vectors)) await t.test(method, () => {
    assert.equal(c.validateRequest({ id: 1, method, params }).params, params)
    assert.equal(c.validateResult(method, result), result)
    assert.equal(c.validateReply(method, { id: 1, ok: true, result }).result, result)
  })
})
test('all registered events have authored valid examples including committed finishing warnings', async t => {
  assert.equal(Object.keys(events).length, 17)
  assert.deepEqual(Object.keys(events).sort(), Object.keys(c.manifest.events).sort())
  for (const [event, data] of Object.entries(events)) await t.test(event, () => assert.equal(c.validateEvent({ event, data }).data, data))
  c.validateEvent({ event: 'backend.exited' })
})
test('strict envelopes, closed DTOs, finite numbers and absolute paths reject malformed messages', () => {
  for (const id of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) assert.throws(() => c.validateRequest({ id, method: 'system.ping' }), c.ContractError)
  for (const value of [null, [], 1, { id: 1, method: 'system.ping', extra: true }, { id: 1, method: 'system.ping', params: null }]) assert.throws(() => c.validateRequest(value), c.ContractError)
  assert.throws(() => c.validateParams('nope', {}), { code: 'METHOD_UNKNOWN' })
  assert.throws(() => c.validateEvent({ event: 'unknown', data: {} }), { code: 'EVENT_UNKNOWN' })
  assert.throws(() => c.validateParams('album.open', { path: '../album' }), c.ContractError)
  assert.throws(() => c.validateParams('render.start', { album: '/album', ppi: NaN }), c.ContractError)
  assert.throws(() => c.validateParams('render.start', { album: '/album', spreads: [1, 1] }), c.ContractError)
  assert.throws(() => c.validateParams('album.update', { album: '/album', ops: [{ op: 'addPhoto', n: 1 }] }), c.ContractError)
  assert.throws(() => c.validateResult('album.open', { ...album, unexpected: true }), c.ContractError)
  assert.throws(() => c.validateResult('library.collections', { ...collections, collections: [{ ...collections.collections[0], isDefault: undefined }] }), c.ContractError)
  const plan = structuredClone(vectors['export.plan'][1]); delete plan.settings.highQuality
  assert.throws(() => c.validateResult('export.plan', plan), c.ContractError)
  assert.throws(() => c.validateReply('system.ping', { id: 1, ok: false, error: 'Error', secret: true }), c.ContractError)
})
test('optional object undefined matches JSON omission; non-JSON data and executable accessors are rejected', () => {
  c.validateParams('render.start', { album: '/album', force: undefined })
  const cyclic = {}; cyclic.n = cyclic
  for (const n of [NaN, Infinity, 1n, () => {}, Symbol('x'), cyclic, new Date(), [undefined], Array(1), { constructor: 1 }]) assert.throws(() => c.validateParams('system.ping', { n }), c.ContractError)
  let reads = 0
  const accessor = Object.defineProperty({}, 'n', { enumerable: true, get() { reads++; throw Error('must not execute') } })
  assert.throws(() => c.validateParams('system.ping', accessor), c.ContractError); assert.equal(reads, 0)
  const namedArray = []; namedArray.extra = 1
  assert.throws(() => c.validateParams('system.ping', { n: namedArray }), c.ContractError)
  assert.throws(() => c.validateParams('system.ping', { n: JSON.parse('{"__proto__":1}') }), c.ContractError)
})
test('global traversal bounds fail closed before schema work and cap diagnostic counts', () => {
  let deep = 1; for (let i = 0; i <= c.limits.maxDepth; i++) deep = [deep]
  assert.throws(() => c.validateParams('system.ping', { n: deep }), error => error.issues.some(i => i.keyword === 'maxDepth'))
  assert.throws(() => c.validateParams('system.ping', { n: 'x'.repeat(c.limits.maxStringLength + 1) }), c.ContractError)
  assert.throws(() => c.validateParams('system.ping', { n: Array(250001).fill(0) }), c.ContractError)
  assert.throws(() => c.validateParams('system.ping', { n: Array(65).fill('x'.repeat(1048576)) }), c.ContractError)
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['bad' + i, true]))
  assert.throws(() => c.validateParams('render.start', { album: '/album', ...many }), error => error.issues.length <= 32)
})
test('saved project input accepts supported legacy metadata without stripping or mutation', () => {
  const old = { version: '01', totalActivePages: '00', workspace: { imageTokens: ['/shoot'], templateTokens: null, imageAdjustments: { one: { exposure: 200, bw: true, custom: 1 } }, customWorkspace: { enabled: true } }, albumPages: { 1: { photos: null, template: { id: 'tpl-one', h: '01', v: null, extension: 'keep' }, extra: [1] } }, customTop: 'keep' }
  const before = JSON.stringify(old)
  assert.equal(c.validateProject(old), old); assert.equal(JSON.stringify(old), before)
  assert.throws(() => c.validateProject({ ...old, version: 2 }), c.ContractError)
  assert.throws(() => c.validateProject({ ...old, totalActivePages: '1e2' }), c.ContractError)
  assert.throws(() => c.validateProject({ albumPages: { nope: { photos: [] } } }), c.ContractError)
  const domain = require('../lib/project_domain')
  for (const id of [undefined, null, '', 'spread_one']) {
    const value = { albumPages: { 1: { id, photos: [] } } }
    assert.equal(c.validateProject(value), value); assert.equal(domain.validateProject(value), value)
  }
  for (const id of [false, 0, {}, [], 'bad-id']) {
    const value = { albumPages: { 1: { id, photos: [] } } }
    assert.throws(() => c.validateProject(value), c.ContractError); assert.throws(() => domain.validateProject(value))
  }
  c.validateParams('album.create', { name: 'A', parent: '/albums', photoFolders: ['/shoot'], autoFill: false })
})
test('error serialization retains only bounded recovery data and never invokes metadata accessors', () => {
  const cause = Object.assign(Error('cause'), { recoveryRequired: true, recoveryStage: '/out/stage', recoveryJournal: '/out/journal', recoveryLock: '/out/lock', snapshotPath: '/source/snapshot', retainedPath: '/history/stage', renderCommitted: true })
  const error = Object.assign(Error('saved but close failed', { cause }), { code: 'RELEASE_FAILED', sourceCode: 'EIO', closeErrors: [Error('close one'), 'close two'], retainedPaths: ['/one', 'relative'], credential: 'never serialize', renderRestored: false, issues: [{ path: '/album', message: 'Invalid input', keyword: 'type' }] })
  const value = c.serializeError(error)
  assert.equal(value.renderCommitted, true); assert.equal(value.renderRestored, false); assert.equal(value.recoveryRequired, true)
  for (const key of ['recoveryStage', 'recoveryJournal', 'recoveryLock', 'snapshotPath', 'retainedPath']) assert.equal(value[key], cause[key])
  assert.deepEqual(value.closeErrors, ['close one', 'close two']); assert.deepEqual(value.retainedPaths, ['/one']); assert.equal(value.credential, undefined); assert.equal(value.stack, undefined)
  c.validateReply('render.start', { id: 1, ok: false, ...value })
  let reads = 0
  const trap = []; Object.defineProperty(trap, '0', { get() { reads++; throw Error('never read') } }); trap.length = 1
  const trapped = Object.assign(Error('safe'), { closeErrors: trap, retainedPaths: trap, issues: trap })
  assert.equal(c.serializeError(trapped).error, 'safe'); assert.equal(reads, 0)
  assert.equal(c.serializeError(Object.assign(Error('empty source code'), { sourceCode: '' })).sourceCode, undefined)
})
test('runtime loads in a browser-like VM with only its two JSON imports and no Node globals', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../contracts/runtime.js'), 'utf8')
  const exports = {}, imports = []
  const context = vm.createContext({ exports, require(name) { imports.push(name); if (!['./album-studio.schema.json', './contract-manifest.json'].includes(name)) throw Error('Node dependency'); return JSON.parse(fs.readFileSync(path.join(__dirname, '../../contracts', name), 'utf8')) } })
  vm.runInContext(source, context)
  assert.deepEqual(imports.sort(), ['./album-studio.schema.json', './contract-manifest.json'])
  assert.equal(vm.runInNewContext('typeof process'), 'undefined')
  // Construct values in the same realm, as browser callers do.
  assert.equal(typeof exports.validateRequest, 'function'); assert.equal(Object.isFrozen(exports.manifest), true)
  assert.equal(vm.runInContext("exports.validateRequest({id:1,method:'system.ping',params:{n:3}}).params.n", context), 3)
  assert.equal(vm.runInContext("exports.validateResult('render.start',{jobId:'one',total:1,outputFolder:'/out',album:'/album'}).album", context), '/album')
})
test('unsupported schema policies fail at load, and scaled traversal budgets stop aggregate and union work', () => {
  const original = fs.readFileSync(path.join(__dirname, '../../contracts/runtime.js'), 'utf8')
  function context(changeSchema, source = original) {
    const exports = {}, ctx = vm.createContext({ exports, require(name) {
      const value = JSON.parse(fs.readFileSync(path.join(__dirname, '../../contracts', name), 'utf8'))
      if (name.includes('schema') && changeSchema) changeSchema(value)
      return value
    } })
    vm.runInContext(source, ctx); return ctx
  }
  for (const shape of [true, { type: 'string', format: 'unchecked' }, { $ref: '#/$defs/Path', maxLength: 3 }, { anyOf: [{ type: 'null' }], type: 'number' }, { type: 'array', uniqueItems: true, items: { type: 'object', additionalProperties: false } }]) assert.throws(() => context(s => { s.$defs.Empty = shape }), { code: 'CONTRACT_SCHEMA_INVALID' })
  // Scale only the public policy constants in an isolated copy of the same implementation;
  // exercising millions of nodes is unnecessary to verify shared traversal termination.
  const nodes = context(null, original.replace('MAX_NODES = 2000000', 'MAX_NODES = 50'))
  assert.throws(() => vm.runInContext("exports.validateParams('system.ping',{n:Array.from({length:12},()=>[1,2,3,4])})", nodes), error => error.issues.some(i => i.keyword === 'maxNodes'))
  const steps = context(null, original.replace('MAX_STEPS = 16000000', 'MAX_STEPS = 50'))
  assert.throws(() => vm.runInContext("exports.validateParams('system.ping',{n:Array.from({length:20},()=>({key:1}))})", steps), error => error.issues.some(i => i.keyword === 'maxSteps'))
})
test('actual disposable backend producers satisfy their canonical response contracts', async t => {
  const f = makeProject(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const { openAlbum } = require('../lib/album'), { inspectFolders, inspectCollections, suggestAlbum } = require('../lib/newalbum')
  const { listTemplates } = require('../lib/templates'), { rememberAlbum, listRecent } = require('../lib/recent')
  const lib = require('../lib/library'), { storageUsage, clearStorage } = require('../lib/storage')
  const actual = await openAlbum({ path: f.proj }); c.validateResult('album.open', actual)
  await rememberAlbum(actual); c.validateResult('album.recent', await listRecent())
  c.validateResult('folders.inspect', await inspectFolders({ paths: [f.shoot] }))
  c.validateResult('templates.inspect', await inspectCollections({ paths: [f.tpls] }))
  c.validateResult('templates.list', await listTemplates([f.tpls]))
  c.validateResult('album.suggest', await suggestAlbum({ photoFolders: [f.shoot] }))
  c.validateResult('library.add', await lib.addCollections({ paths: [f.tpls] }))
  c.validateResult('library.collections', await lib.libraryCollections())
  c.validateResult('library.setDefaults', await lib.setDefaults({ paths: [f.tpls] }))
  c.validateResult('library.templates', await lib.collectionTemplates({ path: f.tpls }))
  c.validateResult('library.remove', await lib.removeCollection({ path: f.tpls }))
  c.validateResult('storage.usage', await storageUsage({ album: f.proj }))
  c.validateResult('storage.clear', await clearStorage({ ids: ['lab-thumbs'] }))
  const { listSheets, renameSheets } = require('../lib/labnaming')
  c.validateResult('lab.list', await listSheets({ folder: path.join(f.root, 'out') }))
  c.validateResult('lab.rename', await renameSheets({ folder: path.join(f.root, 'out'), ops: [] }))
})
