'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const checker = import(pathToFileURL(path.resolve(__dirname, '../native/scripts/check-architecture.mjs')).href)

async function fixture(t) {
  const { checkArchitecture, defaultPolicy } = await checker, root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-architecture-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text) }
  const policy = JSON.parse(JSON.stringify(defaultPolicy))
  delete policy.reachability // the miniature fixture has deliberately unimported files; one test opts in
  const manifest = {
    methods: { alpha: { owner: 'backend', params: '#/$defs/Params', result: '#/$defs/Result' }, 'shell.fixture': { owner: 'shell', params: '#/$defs/Params', result: '#/$defs/Result' } },
    events: { 'alpha.done': { data: '#/$defs/Result' }, 'shell.fixtureEvent': { data: '#/$defs/Result' } },
    dto: { Result: '#/$defs/Result' }, errors: { Error: '#/$defs/Error' }, persistedProject: { v1: '#/$defs/Project' }, schemaVersions: { project: [1] },
  }
  const schema = { $defs: { Params: { type: 'object' }, Result: { type: 'object' }, Error: { type: 'object' }, Project: { type: 'object' } } }
  write('native/backend/server.js', "const {methods}=require('./methods');const {validateRequest}=require('../contracts/runtime');validateRequest({});module.exports=methods\n")
  write('native/backend/methods.js', "const methods={alpha:async()=>({})};module.exports={methods}\n")
  write('native/backend/domain.js', "function send(emit){emit('alpha.done',{})};module.exports={send}\n")
  write('native/contracts/runtime.js', 'exports.validateRequest=x=>x;exports.validateReply=x=>x\n')
  write('native/contracts/types.ts', 'export type Result = Record<string, unknown>\n')
  write('native/contracts/contract-manifest.json', JSON.stringify(manifest))
  write('native/contracts/album-studio.schema.json', JSON.stringify(schema))
  write('native/ui/src/bridge.ts', "import {validateReply} from '../../contracts/runtime.js';export function call(method:string){return validateReply({method})};export function onEvent(name:string,fn:Function){}\n")
  write('native/ui/src/main.ts', "import {call as rpc,onEvent} from './bridge';rpc('alpha');onEvent('alpha.done',()=>{})\n")
  write('native/photocraft/apps/album-studio/src/shell.rs', 'fn handle(method:&str){ match method {\n "shell.fixture" =>{},\n _=>{}\n}}\nfn event(){json!({"event":"shell.fixtureEvent"});}\n')
  write('native/photocraft/apps/album-studio/src/backend.rs', '// no backend exit event in this miniature fixture\n')
  write('native/scripts/generate-contract-types.mjs', "import fs from 'node:fs';if(fs.readFileSync('native/contracts/types.ts','utf8')!=='export type Result = Record<string, unknown>\\n')process.exit(1)\n")
  write('src/license_public_key.pem', 'fixture public key, not a credential\n')
  const packagedClosure = { files: ['native/backend/server.js', 'native/backend/methods.js', 'native/contracts/runtime.js', 'native/contracts/contract-manifest.json', 'native/contracts/album-studio.schema.json', 'src/license_public_key.pem'], packages: [] }
  const check = () => checkArchitecture(root, { policy, packagedClosure })
  const saveManifest = () => write('native/contracts/contract-manifest.json', JSON.stringify(manifest))
  return { root, policy, manifest, schema, write, check, packagedClosure, saveManifest }
}
const codes = result => result.violations.map(item => item.code)

test('the architecture graph inventories lazy runtime dependencies, protocol aliases, native handlers and actual closure', async t => {
  const f = await fixture(t), result = f.check()
  assert.equal(result.ok, true, JSON.stringify(result.violations))
  assert.ok(result.edges.some(edge => edge.from === 'native/backend/server.js' && edge.target === 'native/contracts/runtime.js'))
  assert.deepEqual(result.contracts.uiCalls, ['alpha']); assert.deepEqual(result.contracts.shellMethods, ['shell.fixture'])
  assert.deepEqual(result.contracts.events, ['alpha.done', 'shell.fixtureEvent']); assert.equal(result.runtime.comparedWithCollector, true)
})

test('real forbidden imports fail while commented and stringified fake imports do not become graph edges', async t => {
  const f = await fixture(t)
  f.write('native/ui/src/main.ts', "import fs from 'node:fs';import backend from '../../backend/methods.js';// require('../../../server/private')\nconst example=\"require('electron')\"\n")
  const result = f.check()
  assert.ok(codes(result).includes('FORBIDDEN_PACKAGE')); assert.ok(codes(result).includes('FORBIDDEN_LAYER'))
  assert.equal(result.edges.some(edge => edge.spec === 'electron'), false)
  assert.equal(result.edges.some(edge => edge.spec.includes('server/private')), false)
})

test('a shared module importing backend or issuer logic is rejected even when the import is lazy', async t => {
  const f = await fixture(t)
  f.write('server/secret.js', 'module.exports={}\n')
  f.write('src/domain.js', "exports.later=()=>require('../native/backend/methods');exports.issuer=()=>require('../server/secret')\n")
  assert.equal(f.check().violations.filter(item => item.code === 'FORBIDDEN_LAYER').length, 2)
})

test('a packaging collector cannot silently omit a lazy runtime module, source data or external package', async t => {
  const f = await fixture(t)
  f.write('native/backend/server.js', "const {methods}=require('./methods');const {validateRequest}=require('../contracts/runtime');validateRequest({});exports.lazy=()=>require('./late');exports.codec=()=>require('missing-package')\n")
  f.write('native/backend/late.js', 'module.exports={}\n')
  f.packagedClosure.files = f.packagedClosure.files.filter(file => !file.endsWith('album-studio.schema.json'))
  const result = f.check()
  assert.ok(result.violations.some(item => item.code === 'RUNTIME_NOT_PACKAGED' && item.file.endsWith('late.js')))
  assert.ok(result.violations.some(item => item.code === 'RUNTIME_NOT_PACKAGED' && item.file.endsWith('album-studio.schema.json')))
  assert.ok(codes(result).includes('PACKAGE_NOT_PACKAGED'))
})

test('dynamic dependencies fail closed and packaged issuer files cannot be smuggled into the helper', async t => {
  const f = await fixture(t)
  f.write('native/backend/domain.js', 'module.exports=name=>require(name)\n')
  f.packagedClosure.files.push('server/private-key.pem')
  const result = f.check()
  assert.ok(codes(result).includes('DYNAMIC_DEPENDENCY')); assert.ok(codes(result).includes('RUNTIME_FORBIDDEN_FILE'))
})

test('adding a backend/native handler or an emitted event requires a canonical schema contract', async t => {
  const f = await fixture(t)
  f.write('native/backend/methods.js', "const methods={alpha:async()=>({}),danger:async()=>({})};module.exports={methods}\n")
  f.write('native/backend/domain.js', "exports.emit=emit=>emit('new.event',{})\n")
  f.write('native/photocraft/apps/album-studio/src/shell.rs', 'fn handle(method:&str){match method{\n"shell.fixture"=>{},\n"shell.extra"=>{},\n_=>{}\n}}\n')
  const result = f.check()
  assert.ok(result.violations.some(item => item.code === 'METHOD_CONTRACT_MISSING' && item.method === 'danger'))
  assert.ok(result.violations.some(item => item.code === 'METHOD_CONTRACT_MISSING' && item.method === 'shell.extra'))
  assert.ok(result.violations.some(item => item.code === 'EVENT_CONTRACT_MISSING' && item.event === 'new.event'))
})

test('namespace and renamed UI bridge imports still require declared methods and event contracts', async t => {
  const f = await fixture(t)
  f.write('native/ui/src/main.ts', "import * as bridge from './bridge';import {onEvent as listen,call as invoke} from './bridge';bridge.call('undeclared');invoke('also.missing');listen('new.event',()=>{})\n")
  const result = f.check()
  assert.equal(result.violations.filter(item => item.code === 'UI_METHOD_UNDECLARED').length, 2)
  assert.ok(result.violations.some(item => item.code === 'EVENT_CONTRACT_MISSING' && item.event === 'new.event'))
})

test('bounded literal-union UI methods are inventoried and unconstrained dynamic calls fail closed', async t => {
  const f = await fixture(t)
  f.write('native/ui/src/main.ts', "import {call as rpc} from './bridge';function route(method:'alpha'|'shell.fixture'){return rpc(method)}\n")
  assert.equal(f.check().ok, true)
  f.write('native/ui/src/main.ts', "import {call as rpc} from './bridge';function route(method:string){return rpc(method)}\n")
  assert.ok(codes(f.check()).includes('DYNAMIC_PROTOCOL_METHOD'))
})

test('missing schemas, unresolved internal references and absent domain contracts cannot count as coverage', async t => {
  const f = await fixture(t)
  f.manifest.methods.alpha.params = '#/$defs/Missing'; delete f.manifest.persistedProject; f.saveManifest()
  f.schema.$defs.Result = { $ref: '#/$defs/UnknownNested' }; f.write('native/contracts/album-studio.schema.json', JSON.stringify(f.schema))
  const result = f.check()
  assert.ok(codes(result).includes('METHOD_SCHEMA_UNRESOLVED')); assert.ok(codes(result).includes('SCHEMA_REFERENCE_UNRESOLVED')); assert.ok(codes(result).includes('DOMAIN_CONTRACT_MISSING'))
})

test('importing but never calling a canonical validator is not a checked process boundary', async t => {
  const f = await fixture(t)
  f.write('native/ui/src/bridge.ts', "import {validateReply} from '../../contracts/runtime.js';export function call(method:string){return method};export function onEvent(name:string,fn:Function){}\n")
  assert.ok(f.check().violations.some(item => item.code === 'RUNTIME_VALIDATION_MISSING' && item.file === 'native/ui/src/bridge.ts'))
})

test('generated type drift fails the real configured deterministic generator check', async t => {
  const f = await fixture(t)
  f.write('native/contracts/types.ts', 'export type Result = any\n')
  assert.ok(codes(f.check()).includes('GENERATED_TYPES_DRIFT'))
})

test('canonical orphan/duplicate method entries and circular dependency groups remain visible', async t => {
  const f = await fixture(t)
  f.manifest.methods.orphan = { params: '#/$defs/Params', result: '#/$defs/Result' }; f.saveManifest()
  f.write('native/backend/a.js', "module.exports=require('./b')\n"); f.write('native/backend/b.js', "module.exports=require('./a')\n")
  let result = f.check()
  assert.ok(result.violations.some(item => item.code === 'METHOD_HANDLER_MISSING' && item.method === 'orphan'))
  assert.deepEqual(result.cycles, [['native/backend/a.js', 'native/backend/b.js']])
  assert.ok(codes(result).includes('DEPENDENCY_CYCLE'))
  f.write('native/backend/methods.js', 'const methods={alpha:()=>1,alpha:()=>2};module.exports={methods}\n')
  result = f.check(); assert.ok(result.violations.some(item => item.code === 'CONTRACT_CONFIGURATION' && /duplicate/i.test(item.message)))
})

test('native helper exit events are inventoried and canonical orphan events fail closed', async t => {
  const f = await fixture(t)
  f.write('native/photocraft/apps/album-studio/src/backend.rs', 'fn exit(){let data=r#"{"event":"backend.exited"}"#;}\n')
  assert.ok(f.check().violations.some(item => item.code === 'EVENT_CONTRACT_MISSING' && item.event === 'backend.exited'))
  f.manifest.events['backend.exited'] = { data: '#/$defs/Result' }
  f.manifest.events['orphan.event'] = { data: '#/$defs/Result' }; f.saveManifest()
  assert.ok(f.check().violations.some(item => item.code === 'EVENT_SOURCE_MISSING' && item.event === 'orphan.event'))
})

test('changing canonical method ownership cannot redirect an existing executor across the native boundary', async t => {
  const f = await fixture(t)
  f.manifest.methods.alpha.owner = 'shell'
  f.manifest.methods['shell.fixture'].owner = 'backend'
  f.saveManifest()
  const bad = f.check().violations.filter(item => item.code === 'METHOD_OWNER_MISMATCH')
  assert.deepEqual(bad.map(item => [item.method, item.expectedOwner]), [['alpha', 'backend'], ['shell.fixture', 'shell']])
})

test('a module no application entry point reaches is reported; type declarations and issuer-only imports are not', async t => {
  const f = await fixture(t)
  f.policy.reachability = { entries: ['native/backend/server.js', 'native/ui/src/main.ts', 'server/index.js'] }
  f.write('src/orphan.js', 'module.exports = {}\n')
  f.write('src/types.d.ts', 'export type Unused = string\n')
  f.write('src/signing.js', 'module.exports = {}\n')
  f.write('server/index.js', "require('../src/signing')\n")
  const unreachable = f.check().violations.filter(v => v.code === 'UNREACHABLE_MODULE').map(v => v.file)
  assert.ok(unreachable.includes('src/orphan.js'), JSON.stringify(unreachable))
  for (const live of ['src/types.d.ts', 'src/signing.js', 'native/ui/src/bridge.ts', 'native/backend/methods.js']) {
    assert.equal(unreachable.includes(live), false, live)
  }
})
