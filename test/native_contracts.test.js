'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const repo = path.resolve(__dirname, '..'), generator = path.join(repo, 'native/scripts/generate-native-contracts.mjs')
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-native-contracts-')), source = path.join(root, 'native/contracts'), engine = path.join(root, 'engine')
  fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(path.join(engine, 'apps/album-studio'), { recursive: true })
  fs.writeFileSync(path.join(engine, 'apps/album-studio/Cargo.toml'), '[package]\nname="album-studio"\n')
  for (const name of ['album-studio.schema.json', 'contract-manifest.json', 'examples.json', 'native-runtime.rs']) fs.copyFileSync(path.join(repo, 'native/contracts', name), path.join(source, name))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, source, engine, target: path.join(engine, 'apps/album-studio/src/contracts') }
}
function run(f, check = false) { return spawnSync(process.execPath, [generator, '--root', f.root, '--engine', f.engine, ...(check ? ['--check'] : [])], { encoding: 'utf8', timeout: 15000 }) }
test('native embedded contracts detect every canonical input and generated-file drift without rewriting', t => {
  const f = fixture(t)
  assert.equal(run(f).status, 0)
  assert.equal(run(f, true).status, 0)
  for (const name of ['album-studio.schema.json', 'contract-manifest.json', 'examples.json', 'native-runtime.rs']) {
    const file = path.join(f.source, name), before = fs.readFileSync(file)
    fs.appendFileSync(file, '\n')
    assert.equal(run(f, true).status, 1, name)
    fs.writeFileSync(file, before)
  }
  const generated = path.join(f.target, 'generated.rs'), before = fs.readFileSync(generated)
  fs.appendFileSync(generated, '\n// local drift\n')
  assert.equal(run(f, true).status, 1)
  assert.match(fs.readFileSync(generated, 'utf8'), /local drift/)
  assert.equal(run(f).status, 0)
  assert.deepEqual(fs.readFileSync(generated), before)
})
test('native generation refuses unsupported validation rules, missing refs and ambiguous method variants', t => {
  const f = fixture(t), schemaFile = path.join(f.source, 'album-studio.schema.json'), original = JSON.parse(fs.readFileSync(schemaFile))
  for (const shape of [{ type: 'string', format: 'email' }, { $ref: '#/$defs/Missing' }, { type: 'array', uniqueItems: true, items: { type: 'object' } }, { type: ['string', 'null'] }, { const: { nested: true } }, { enum: [[]] }]) {
    const schema = structuredClone(original); schema.$defs.Empty = shape; fs.writeFileSync(schemaFile, JSON.stringify(schema))
    assert.equal(run(f).status, 1)
    assert.equal(fs.existsSync(f.target), false)
  }
  fs.writeFileSync(schemaFile, JSON.stringify(original))
  const manifestFile = path.join(f.source, 'contract-manifest.json'), manifest = JSON.parse(fs.readFileSync(manifestFile))
  manifest.methods['shell-ping'] = manifest.methods['shell.ping']; fs.writeFileSync(manifestFile, JSON.stringify(manifest))
  assert.equal(run(f).status, 1)
  assert.equal(fs.existsSync(f.target), false)
})
