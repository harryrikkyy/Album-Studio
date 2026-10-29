'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const ts = require('typescript')
const repo = path.resolve(__dirname, '..'),
  generator = path.join(repo, 'native/scripts/generate-contract-types.mjs')
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-contract-types-')),
    target = path.join(root, 'native/contracts')
  fs.mkdirSync(target, { recursive: true })
  for (const name of ['contract-manifest.json', 'album-studio.schema.json', 'runtime.d.ts', 'types.ts'])
    fs.copyFileSync(path.join(repo, 'native/contracts', name), path.join(target, name))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, target }
}
function run(root, check = false) {
  return spawnSync(process.execPath, [generator, '--root', root, ...(check ? ['--check'] : [])], {
    encoding: 'utf8',
    timeout: 15000,
  })
}
test('committed declarations are deterministic and --check detects schema or manifest drift without writing', (t) => {
  const { root, target } = fixture(t),
    file = path.join(target, 'types.ts'),
    original = fs.readFileSync(file, 'utf8')
  assert.equal(run(repo, true).status, 0)
  assert.equal(run(root).status, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
  for (const name of ['album-studio.schema.json', 'contract-manifest.json']) {
    const source = path.join(target, name),
      before = fs.readFileSync(source, 'utf8')
    fs.writeFileSync(source, before + ' ')
    const changed = run(root, true)
    assert.equal(changed.status, 1)
    assert.match(changed.stderr, /differs/)
    assert.equal(fs.readFileSync(file, 'utf8'), original)
    fs.writeFileSync(source, before)
  }
  fs.writeFileSync(file, original + '// drift\n')
  assert.equal(run(root, true).status, 1)
  assert.equal(run(root).status, 0)
  assert.equal(fs.readFileSync(file, 'utf8'), original)
})
test('generation rejects unresolved references and unchecked extensions rather than inventing types', (t) => {
  const { root, target } = fixture(t),
    source = path.join(target, 'album-studio.schema.json'),
    initial = JSON.parse(fs.readFileSync(source))
  for (const changed of [{ $ref: '#/$defs/Missing' }, { type: 'object', additionalProperties: true }, true]) {
    const schema = structuredClone(initial)
    schema.$defs.Empty = changed
    fs.writeFileSync(source, JSON.stringify(schema))
    assert.equal(run(root).status, 1)
  }
})
test('generated method/event maps and runtime declaration infer domain types and reject wrong shapes', (t) => {
  const { root, target } = fixture(t),
    sample = path.join(root, 'consumer.ts')
  fs.writeFileSync(
    sample,
    `import { validateResult, validateEvent, validateParams } from './native/contracts/runtime'
import type { MethodParams, MethodResult, EventData, MethodName, EventName } from './native/contracts/types'
const p: MethodParams<'album.open'> = { path: '/album' }
const result: MethodResult<'render.start'> = { jobId: 'one', total: 1, outputFolder: '/out', album: '/album' }
const e: EventData<'render.started'> = result
const actual = validateResult('render.start', result)
const album: string = actual.album
const names: [MethodName, EventName] = ['render.start', 'render.started']
validateEvent({event:'render.started',data:e}); validateParams('album.open', p)
// @ts-expect-error absolute paths are strings, not numbers
const bad: MethodParams<'album.open'> = { path: 1 }
// @ts-expect-error required job album identity must not disappear
const noIdentity: MethodResult<'render.start'> = { jobId:'one', total:1, outputFolder:'/out' }
// @ts-expect-error unknown methods cannot be used in generated contracts
const unknownMethod: MethodName = 'nope'
// @ts-expect-error invalid event discriminator
const unknownEvent: EventName = 'nope'
// @ts-expect-error library results guarantee isDefault
const missingDefault: MethodResult<'library.collections'> = { collections:[{path:'/t',name:'T',exists:true,templates:1,albums:[]}],defaultsChosen:false }
// @ts-expect-error exported print settings guarantee both qualities
const missingQuality: MethodResult<'export.plan'>['settings'] = {size:'print',heightInches:12,ppi:300}
void [album,names,bad,noIdentity,unknownMethod,unknownEvent,missingDefault,missingQuality]
`,
  )
  const program = ts.createProgram([sample, path.join(target, 'types.ts'), path.join(target, 'runtime.d.ts')], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    skipLibCheck: false,
    types: [],
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.deepEqual(
    diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')),
    [],
  )
})
