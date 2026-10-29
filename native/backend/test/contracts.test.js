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
const { methods: vectors, events } = require('../../contracts/examples.json')
const album = vectors['album.open'][1],
  collections = vectors['library.collections'][1]
test('every registered method has authored valid request/result/reply examples', async (t) => {
  assert.equal(Object.keys(vectors).length, 53)
  assert.deepEqual(Object.keys(vectors).sort(), Object.keys(c.manifest.methods).sort())
  for (const [method, [params, result]] of Object.entries(vectors))
    await t.test(method, () => {
      assert.equal(c.validateRequest({ id: 1, method, params }).params, params)
      assert.equal(c.validateResult(method, result), result)
      assert.equal(c.validateReply(method, { id: 1, ok: true, result }).result, result)
    })
})
test('all registered events have authored valid examples including committed finishing warnings', async (t) => {
  assert.equal(Object.keys(events).length, 17)
  assert.deepEqual(Object.keys(events).sort(), Object.keys(c.manifest.events).sort())
  for (const [event, data] of Object.entries(events))
    await t.test(event, () => assert.equal(c.validateEvent({ event, data }).data, data))
  c.validateEvent({ event: 'backend.exited' })
})
test('strict envelopes, closed DTOs, finite numbers and absolute paths reject malformed messages', () => {
  for (const id of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])
    assert.throws(() => c.validateRequest({ id, method: 'system.ping' }), c.ContractError)
  for (const value of [
    null,
    [],
    1,
    { id: 1, method: 'system.ping', extra: true },
    { id: 1, method: 'system.ping', params: null },
  ])
    assert.throws(() => c.validateRequest(value), c.ContractError)
  assert.throws(() => c.validateParams('nope', {}), { code: 'METHOD_UNKNOWN' })
  assert.throws(() => c.validateEvent({ event: 'unknown', data: {} }), { code: 'EVENT_UNKNOWN' })
  assert.throws(() => c.validateParams('album.open', { path: '../album' }), c.ContractError)
  assert.throws(() => c.validateParams('render.start', { album: '/album', ppi: NaN }), c.ContractError)
  assert.throws(() => c.validateParams('render.start', { album: '/album', spreads: [1, 1] }), c.ContractError)
  assert.throws(
    () => c.validateParams('album.update', { album: '/album', ops: [{ op: 'addPhoto', n: 1 }] }),
    c.ContractError,
  )
  assert.throws(() => c.validateResult('album.open', { ...album, unexpected: true }), c.ContractError)
  assert.throws(
    () =>
      c.validateResult('library.collections', {
        ...collections,
        collections: [{ ...collections.collections[0], isDefault: undefined }],
      }),
    c.ContractError,
  )
  const plan = structuredClone(vectors['export.plan'][1])
  delete plan.settings.highQuality
  assert.throws(() => c.validateResult('export.plan', plan), c.ContractError)
  assert.throws(
    () => c.validateReply('system.ping', { id: 1, ok: false, error: 'Error', secret: true }),
    c.ContractError,
  )
})
test('optional object undefined matches JSON omission; non-JSON data and executable accessors are rejected', () => {
  c.validateParams('render.start', { album: '/album', force: undefined })
  const cyclic = {}
  cyclic.n = cyclic
  for (const n of [
    NaN,
    Infinity,
    1n,
    () => {},
    Symbol('x'),
    cyclic,
    new Date(),
    [undefined],
    Array(1),
    { constructor: 1 },
  ])
    assert.throws(() => c.validateParams('system.ping', { n }), c.ContractError)
  let reads = 0
  const accessor = Object.defineProperty({}, 'n', {
    enumerable: true,
    get() {
      reads++
      throw Error('must not execute')
    },
  })
  assert.throws(() => c.validateParams('system.ping', accessor), c.ContractError)
  assert.equal(reads, 0)
  const namedArray = []
  namedArray.extra = 1
  assert.throws(() => c.validateParams('system.ping', { n: namedArray }), c.ContractError)
  assert.throws(() => c.validateParams('system.ping', { n: JSON.parse('{"__proto__":1}') }), c.ContractError)
})
test('Unicode scalar text agrees with the native decoder without changing valid emoji or non-Latin text', () => {
  for (const invalid of ['\ud800', '\udfff', 'a\ud800x', '\udfff\ud800']) {
    assert.throws(
      () => c.validateParams('system.ping', { n: invalid }),
      (error) => error.issues[0].keyword === 'unicode',
    )
    assert.throws(() => c.validateParams('system.ping', { n: { [invalid]: 1 } }), c.ContractError)
  }
  for (const valid of ['Album 😀', 'தமிழ்', 'हिन्दी', 'a\ud800\udc00z'])
    assert.equal(c.validateParams('system.ping', { n: valid }).n, valid)
})
test('global traversal bounds fail closed before schema work and cap diagnostic counts', () => {
  let deep = 1
  for (let i = 0; i <= c.limits.maxDepth; i++) deep = [deep]
  assert.throws(
    () => c.validateParams('system.ping', { n: deep }),
    (error) => error.issues.some((i) => i.keyword === 'maxDepth'),
  )
  assert.throws(() => c.validateParams('system.ping', { n: 'x'.repeat(c.limits.maxStringLength + 1) }), c.ContractError)
  assert.throws(() => c.validateParams('system.ping', { n: Array(250001).fill(0) }), c.ContractError)
  const entries = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => ['k' + i, 0]))
  assert.equal(Object.keys(c.validateParams('system.ping', { n: entries(250000) }).n).length, 250000)
  assert.throws(() => c.validateParams('system.ping', { n: entries(250001) }), {
    message: 'Invalid system.ping parameters: The object exceeds the bounded JSON entry limit. (/n).',
    issues: [{ path: '/n', message: 'The object exceeds the bounded JSON entry limit.', keyword: 'maxProperties' }],
  })
  assert.throws(() => c.validateParams('system.ping', { n: Array(65).fill('x'.repeat(1048576)) }), c.ContractError)
  const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ['bad' + i, true]))
  assert.throws(
    () => c.validateParams('render.start', { album: '/album', ...many }),
    (error) => error.issues.length <= 32,
  )
})
test('saved project input accepts supported legacy metadata without stripping or mutation', () => {
  const old = {
    version: '01',
    totalActivePages: '00',
    workspace: {
      imageTokens: ['/shoot'],
      templateTokens: null,
      imageAdjustments: { one: { exposure: 200, bw: true, custom: 1 } },
      customWorkspace: { enabled: true },
    },
    albumPages: { 1: { photos: null, template: { id: 'tpl-one', h: '01', v: null, extension: 'keep' }, extra: [1] } },
    customTop: 'keep',
  }
  const before = JSON.stringify(old)
  assert.equal(c.validateProject(old), old)
  assert.equal(JSON.stringify(old), before)
  assert.throws(() => c.validateProject({ ...old, version: 2 }), c.ContractError)
  assert.throws(() => c.validateProject({ ...old, totalActivePages: '1e2' }), c.ContractError)
  assert.throws(() => c.validateProject({ albumPages: { nope: { photos: [] } } }), c.ContractError)
  const domain = require('../lib/project_domain')
  for (const id of [undefined, null, '', 'spread_one']) {
    const value = { albumPages: { 1: { id, photos: [] } } }
    assert.equal(c.validateProject(value), value)
    assert.equal(domain.validateProject(value), value)
  }
  for (const id of [false, 0, {}, [], 'bad-id']) {
    const value = { albumPages: { 1: { id, photos: [] } } }
    assert.throws(() => c.validateProject(value), c.ContractError)
    assert.throws(() => domain.validateProject(value))
  }
  c.validateParams('album.create', { name: 'A', parent: '/albums', photoFolders: ['/shoot'], autoFill: false })
})
test('error serialization retains only bounded recovery data and never invokes metadata accessors', () => {
  const cause = Object.assign(Error('cause'), {
    recoveryRequired: true,
    recoveryStage: '/out/stage',
    recoveryJournal: '/out/journal',
    recoveryLock: '/out/lock',
    snapshotPath: '/source/snapshot',
    retainedPath: '/history/stage',
    renderCommitted: true,
  })
  const error = Object.assign(Error('saved but close failed', { cause }), {
    code: 'RELEASE_FAILED',
    sourceCode: 'EIO',
    closeErrors: [Error('close one'), 'close two'],
    retainedPaths: ['/one', 'relative'],
    credential: 'never serialize',
    renderRestored: false,
    issues: [{ path: '/album', message: 'Invalid input', keyword: 'type' }],
  })
  const value = c.serializeError(error)
  assert.equal(value.renderCommitted, true)
  assert.equal(value.renderRestored, false)
  assert.equal(value.recoveryRequired, true)
  for (const key of ['recoveryStage', 'recoveryJournal', 'recoveryLock', 'snapshotPath', 'retainedPath'])
    assert.equal(value[key], cause[key])
  assert.deepEqual(value.closeErrors, ['close one', 'close two'])
  assert.deepEqual(value.retainedPaths, ['/one'])
  assert.equal(value.credential, undefined)
  assert.equal(value.stack, undefined)
  c.validateReply('render.start', { id: 1, ok: false, ...value })
  let reads = 0
  const trap = []
  Object.defineProperty(trap, '0', {
    get() {
      reads++
      throw Error('never read')
    },
  })
  trap.length = 1
  const trapped = Object.assign(Error('safe'), { closeErrors: trap, retainedPaths: trap, issues: trap })
  assert.equal(c.serializeError(trapped).error, 'safe')
  assert.equal(reads, 0)
  assert.equal(c.serializeError(Object.assign(Error('empty source code'), { sourceCode: '' })).sourceCode, undefined)
})
test('runtime loads in a browser-like VM with only its two JSON imports and no Node globals', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../contracts/runtime.js'), 'utf8')
  const exports = {},
    imports = []
  const context = vm.createContext({
    exports,
    require(name) {
      imports.push(name)
      if (!['./album-studio.schema.json', './contract-manifest.json'].includes(name)) throw Error('Node dependency')
      return JSON.parse(fs.readFileSync(path.join(__dirname, '../../contracts', name), 'utf8'))
    },
  })
  vm.runInContext(source, context)
  assert.deepEqual(imports.sort(), ['./album-studio.schema.json', './contract-manifest.json'])
  assert.equal(vm.runInNewContext('typeof process'), 'undefined')
  // Construct values in the same realm, as browser callers do.
  assert.equal(typeof exports.validateRequest, 'function')
  assert.equal(Object.isFrozen(exports.manifest), true)
  assert.equal(
    vm.runInContext("exports.validateRequest({id:1,method:'system.ping',params:{n:3}}).params.n", context),
    3,
  )
  assert.equal(
    vm.runInContext(
      "exports.validateResult('render.start',{jobId:'one',total:1,outputFolder:'/out',album:'/album'}).album",
      context,
    ),
    '/album',
  )
})
test('unsupported schema policies fail at load, and scaled traversal budgets stop aggregate and union work', () => {
  const original = fs.readFileSync(path.join(__dirname, '../../contracts/runtime.js'), 'utf8')
  function context(changeSchema, source = original) {
    const exports = {},
      ctx = vm.createContext({
        exports,
        require(name) {
          const value = JSON.parse(fs.readFileSync(path.join(__dirname, '../../contracts', name), 'utf8'))
          if (name.includes('schema') && changeSchema) changeSchema(value)
          return value
        },
      })
    vm.runInContext(source, ctx)
    return ctx
  }
  for (const shape of [
    true,
    { type: 'string', format: 'unchecked' },
    { $ref: '#/$defs/Path', maxLength: 3 },
    { anyOf: [{ type: 'null' }], type: 'number' },
    { type: 'array', uniqueItems: true, items: { type: 'object', additionalProperties: false } },
  ])
    assert.throws(
      () =>
        context((s) => {
          s.$defs.Empty = shape
        }),
      { code: 'CONTRACT_SCHEMA_INVALID' },
    )
  // Scale only the public policy constants in an isolated copy of the same implementation;
  // exercising millions of nodes is unnecessary to verify shared traversal termination.
  // Errors from the copy belong to another realm, so compare their plain JSON form.
  const failure = (ctx, code) => {
    try {
      vm.runInContext(code, ctx)
    } catch (error) {
      return JSON.parse(JSON.stringify({ message: error.message, issues: error.issues }))
    }
    assert.fail(`${code} was accepted`)
  }
  const nodeLimit = (path) => ({ path, message: 'The JSON value exceeds the bounded node limit.', keyword: 'maxNodes' })
  const nodes = context(null, original.replace('MAX_NODES = 2000000', 'MAX_NODES = 50'))
  assert.deepEqual(failure(nodes, "exports.validateParams('system.ping',{n:Array.from({length:12},()=>[1,2,3,4])})"), {
    message: 'Invalid system.ping parameters: The JSON value exceeds the bounded node limit. (/n/9/2).',
    issues: ['/n/9/2', '/n/9/3', '/n/10', '/n/11'].map(nodeLimit),
  })
  // Fifty nodes fit exactly: the parameters object, the array and its 48 entries.
  assert.equal(vm.runInContext("exports.validateParams('system.ping',{n:Array(48).fill(0)}).n.length", nodes), 48)
  assert.deepEqual(failure(nodes, "exports.validateParams('system.ping',{n:Array(49).fill(0)})").issues, [
    nodeLimit('/n/48'),
  ])
  const workLimit = (path) => ({ path, message: 'The schema traversal exceeded its work limit.', keyword: 'maxSteps' })
  const steps = context(null, original.replace('MAX_STEPS = 16000000', 'MAX_STEPS = 50'))
  assert.deepEqual(failure(steps, "exports.validateParams('system.ping',{n:Array.from({length:20},()=>({key:1}))})"), {
    message: 'The contract validation exceeds the bounded work limit.',
    issues: [workLimit('/n/3')],
  })
  // Each schema visited is one step, including every union candidate and $ref hop: the
  // probe array takes 9 steps and the probe object 5, so one step fewer fails on the last.
  const probe = (limit) =>
    context(
      (s) => {
        s.$defs.StepProbe = { type: 'array', items: { anyOf: [{ type: 'string' }, { $ref: '#/$defs/StepLeaf' }] } }
        s.$defs.StepLeaf = { oneOf: [{ type: 'integer' }, { type: 'number' }] }
        s.$defs.StepObject = {
          type: 'object',
          required: ['a'],
          properties: { a: { type: 'integer' } },
          propertyNames: { type: 'string' },
          additionalProperties: { type: 'boolean' },
        }
      },
      original.replace('MAX_STEPS = 16000000', `MAX_STEPS = ${limit}`),
    )
  assert.equal(vm.runInContext("exports.validateDefinition('StepProbe',[1.5,'a']).length", probe(9)), 2)
  assert.deepEqual(failure(probe(8), "exports.validateDefinition('StepProbe',[1.5,'a'])").issues, [workLimit('/1')])
  assert.equal(vm.runInContext("exports.validateDefinition('StepObject',{a:1,b:true}).b", probe(5)), true)
  assert.deepEqual(failure(probe(4), "exports.validateDefinition('StepObject',{a:1,b:true})").issues, [workLimit('/b')])
})
test('actual disposable backend producers satisfy their canonical response contracts', async (t) => {
  const f = makeProject()
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }))
  const { openAlbum } = require('../lib/album'),
    { inspectFolders, inspectCollections, suggestAlbum } = require('../lib/newalbum')
  const { listTemplates } = require('../lib/templates'),
    { rememberAlbum, listRecent } = require('../lib/recent')
  const lib = require('../lib/library'),
    { storageUsage, clearStorage } = require('../lib/storage')
  const actual = await openAlbum({ path: f.proj })
  c.validateResult('album.open', actual)
  await rememberAlbum(actual)
  c.validateResult('album.recent', await listRecent())
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
