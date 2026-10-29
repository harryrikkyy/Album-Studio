'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const scripts = () => import('../native/scripts/engine.mjs')
const publish = () => import('../native/scripts/publish-new-directory.mjs')
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-engine-pin-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const engine = path.join(root, 'source')
  fs.mkdirSync(engine)
  const git = (...args) => execFileSync('git', ['-C', engine, ...args], { encoding: 'utf8' }).trim()
  git('init', '--quiet')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  fs.mkdirSync(path.join(engine, 'apps/album-studio'), { recursive: true })
  fs.writeFileSync(path.join(engine, 'apps/album-studio/Cargo.toml'), '[package]\nname="album-studio"\n')
  fs.writeFileSync(path.join(engine, 'Cargo.lock'), '# fixture lock\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'base')
  const baseCommit = git('rev-parse', 'HEAD')
  git('checkout', '--quiet', '-b', 'album-studio')
  fs.writeFileSync(path.join(engine, 'apps/album-studio/shell.rs'), '// fixture shell\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'shell')
  const commit = git('rev-parse', 'HEAD')
  const bundle = path.join(root, 'fork.bundle')
  git('bundle', 'create', bundle, 'album-studio', `^${baseCommit}`)
  const pin = {
    schema: 1,
    upstreamRepository: 'https://example.invalid/public-engine.git',
    commit,
    baseCommit,
    bundle: 'fork.bundle',
    bundleSha256: hash(bundle),
    cargoLockSha256: hash(path.join(engine, 'Cargo.lock')),
    rustToolchain: '1.99.0',
    sourceDate: '2026-10-12',
    features: ['heif'],
  }
  const manifest = path.join(root, 'pin.json')
  fs.writeFileSync(manifest, JSON.stringify(pin))
  return { root, engine, git, pin, manifest, bundle }
}

test('an exact pristine engine passes while unrelated untracked files are preserved', async (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.engine, '.DS_Store'), 'user metadata')
  const { validateEngine } = await scripts()
  assert.equal(validateEngine(f).commit, f.pin.commit)
  assert.equal(fs.readFileSync(path.join(f.engine, '.DS_Store'), 'utf8'), 'user metadata')
})

test('engine drift and tracked edits fail without resetting source or changing HEAD', async (t) => {
  const f = fixture(t)
  const { validateEngine, setupEngine } = await scripts()
  fs.writeFileSync(path.join(f.engine, 'Cargo.lock'), 'a user edit')
  assert.throws(() => validateEngine(f), /tracked changes/)
  assert.throws(() => setupEngine(f), /tracked changes/)
  assert.equal(fs.readFileSync(path.join(f.engine, 'Cargo.lock'), 'utf8'), 'a user edit')
  f.git('add', 'Cargo.lock')
  f.git('commit', '--quiet', '-m', 'new work')
  const head = f.git('rev-parse', 'HEAD')
  assert.throws(() => validateEngine(f), /revision drift/)
  assert.equal(f.git('rev-parse', 'HEAD'), head)
})

test('a fresh checkout reconstructs the exact fork from its prerequisite and checked bundle', async (t) => {
  const f = fixture(t)
  const { setupEngine } = await scripts()
  const target = path.join(f.root, 'fresh')
  const result = setupEngine({ manifest: f.manifest, engine: target, baseRepository: f.engine })
  assert.equal(result.commit, f.pin.commit)
  assert.equal(fs.readFileSync(path.join(target, 'apps/album-studio/shell.rs'), 'utf8'), '// fixture shell\n')
  assert.equal(hash(path.join(target, 'Cargo.lock')), f.pin.cargoLockSha256)
  assert.equal(execFileSync('git', ['-C', target, 'status', '--porcelain=v1'], { encoding: 'utf8' }).trim(), '')
})

test('bundle tampering and wrong lock pins fail before changing existing work', async (t) => {
  const f = fixture(t)
  const { readPin, validateEngine } = await scripts()
  fs.writeFileSync(f.manifest, JSON.stringify({ ...f.pin, cargoLockSha256: 'a'.repeat(64) }))
  assert.throws(() => validateEngine(f), /Cargo.lock/)
  fs.writeFileSync(f.bundle, 'tampered')
  assert.throws(() => readPin(f.manifest), /checksum/)
  assert.equal(fs.existsSync(path.join(f.engine, 'apps/album-studio/shell.rs')), true)
})

test('setup refuses non-repository and dangling-link destinations instead of replacing them', async (t) => {
  const f = fixture(t)
  const { setupEngine } = await scripts()
  const target = path.join(f.root, 'other')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'customer.txt'), 'preserve')
  assert.throws(() => setupEngine({ manifest: f.manifest, engine: target }), /Git|git/)
  assert.equal(fs.readFileSync(path.join(target, 'customer.txt'), 'utf8'), 'preserve')
  const link = path.join(f.root, 'dangling')
  fs.symlinkSync(path.join(f.root, 'missing'), link)
  assert.throws(() => setupEngine({ manifest: f.manifest, engine: link }), /missing/)
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
})

test('a complete TAP gate rejects any skipped tests and absent suite summaries', async () => {
  const { assertNoSkippedTap } = await scripts()
  assert.doesNotThrow(() => assertNoSkippedTap('# skipped 0\n# skipped 0\n# skipped 0\n', { expectedSuites: 3 }))
  assert.throws(() => assertNoSkippedTap('# skipped 1\n'), /skipped tests/)
  assert.throws(() => assertNoSkippedTap('partial output'), /complete test summaries/)
  assert.throws(() => assertNoSkippedTap('# skipped 0\n', { expectedSuites: 3 }), /complete test summaries/)
})

test('atomic publisher keeps previous bundles, directories and dangling links intact', async (t) => {
  const f = fixture(t)
  const { publishNewDirectory } = await publish()
  const stage = path.join(f.root, 'stage.app')
  const dest = path.join(f.root, 'Album Studio.app')
  fs.mkdirSync(stage)
  fs.writeFileSync(path.join(stage, 'new'), 'new build')
  fs.mkdirSync(dest)
  fs.writeFileSync(path.join(dest, 'old'), 'old build')
  assert.throws(() => publishNewDirectory(stage, dest), /already exists/)
  assert.equal(fs.readFileSync(path.join(dest, 'old'), 'utf8'), 'old build')
  assert.equal(fs.readFileSync(path.join(stage, 'new'), 'utf8'), 'new build')
  const link = path.join(f.root, 'link.app')
  fs.symlinkSync(path.join(f.root, 'absent'), link)
  assert.throws(() => publishNewDirectory(stage, link), /already exists/)
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
})

test('completed staging directory publishes to a new path in one no-replace rename', async (t) => {
  const f = fixture(t)
  const { publishNewDirectory } = await publish()
  const stage = path.join(f.root, 'stage.app')
  const dest = path.join(f.root, 'new.app')
  fs.mkdirSync(stage)
  fs.writeFileSync(path.join(stage, 'binary'), 'compiled')
  assert.equal(publishNewDirectory(stage, dest), dest)
  assert.equal(fs.existsSync(stage), false)
  assert.equal(fs.readFileSync(path.join(dest, 'binary'), 'utf8'), 'compiled')
  assert.equal(
    fs.readdirSync(f.root).some((name) => name.endsWith('.lock')),
    false,
  )
})

test('the native publication primitive refuses even an empty existing destination', (t) => {
  const f = fixture(t)
  const source = path.join(__dirname, '../native/scripts/rename-exclusive.c')
  const binary = path.join(f.root, 'rename-exclusive')
  execFileSync('cc', ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', binary])
  const stage = path.join(f.root, 'stage')
  const target = path.join(f.root, 'empty-target')
  fs.mkdirSync(stage)
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(stage, 'new'), 'unpublished')
  const inode = fs.statSync(target).ino
  assert.throws(() => execFileSync(binary, [stage, target], { stdio: 'pipe' }), /failed/)
  assert.equal(fs.statSync(target).ino, inode)
  assert.deepEqual(fs.readdirSync(target), [])
  assert.equal(fs.readFileSync(path.join(stage, 'new'), 'utf8'), 'unpublished')
})

test('pin schema refuses credentials, moving refs and escaping bundle paths', async (t) => {
  const f = fixture(t)
  const { readPin } = await scripts()
  for (const change of [
    { commit: 'main' },
    { upstreamRepository: 'https://user:secret@example.invalid/source' },
    { bundle: '../fork.bundle' },
    { rustToolchain: 'stable' },
    { bundleRef: 'HEAD' },
    { bundleRef: 'refs/heads/../main' },
    { bundleRef: '--upload-pack=bad' },
    { contractsVersion: 2 },
  ]) {
    fs.writeFileSync(f.manifest, JSON.stringify({ ...f.pin, ...change }))
    assert.throws(() => readPin(f.manifest))
  }
})

test('packaging refuses dependency drift and never removes a pre-existing app bundle', () => {
  const script = fs.readFileSync(path.join(__dirname, '../native/scripts/package-mac.sh'), 'utf8')
  assert.match(script, /engine\.mjs.*build/)
  assert.match(script, /publish-new-directory\.mjs/)
  assert.doesNotMatch(script, /rm\s+-rf\s+"\$APP"/)
})

test('a named architecture branch reconstructs the exact commit without relying on the legacy bundle branch', async (t) => {
  const f = fixture(t),
    ref = 'refs/heads/codex/native-contracts'
  f.git('branch', 'codex/native-contracts')
  f.git('bundle', 'create', f.bundle, ref, `^${f.pin.baseCommit}`)
  fs.writeFileSync(f.manifest, JSON.stringify({ ...f.pin, bundleRef: ref, bundleSha256: hash(f.bundle) }))
  const { setupEngine } = await scripts(),
    engine = path.join(f.root, 'named-branch')
  assert.equal(setupEngine({ manifest: f.manifest, engine, baseRepository: f.engine }).commit, f.pin.commit)
})

test('a contract-bearing engine pin rejects copied runtime drift even at a clean exact revision', async (t) => {
  const f = fixture(t),
    { nativeContracts } = await import('../native/scripts/generate-native-contracts.mjs')
  const target = path.join(f.engine, 'apps/album-studio/src/contracts')
  fs.mkdirSync(target, { recursive: true })
  for (const [name, bytes] of nativeContracts()) fs.writeFileSync(path.join(target, name), bytes)
  f.git('add', 'apps/album-studio/src/contracts')
  f.git('commit', '--quiet', '-m', 'native contracts')
  const commit = f.git('rev-parse', 'HEAD')
  f.git('bundle', 'create', f.bundle, 'album-studio', `^${f.pin.baseCommit}`)
  const pin = { ...f.pin, contractsVersion: 1, commit, bundleSha256: hash(f.bundle) }
  fs.writeFileSync(f.manifest, JSON.stringify(pin))
  const { validateEngine } = await scripts()
  assert.equal(validateEngine(f).commit, commit)
  fs.appendFileSync(path.join(target, 'mod.rs'), '\n// changed runtime\n')
  f.git('add', 'apps/album-studio/src/contracts/mod.rs')
  f.git('commit', '--quiet', '-m', 'diverge runtime')
  f.git('bundle', 'create', f.bundle, 'album-studio', `^${f.pin.baseCommit}`)
  fs.writeFileSync(
    f.manifest,
    JSON.stringify({ ...pin, commit: f.git('rev-parse', 'HEAD'), bundleSha256: hash(f.bundle) }),
  )
  assert.throws(() => validateEngine(f), /canonical contract drift/)
  assert.match(fs.readFileSync(path.join(target, 'mod.rs'), 'utf8'), /changed runtime/)
})

test('a relative local base mirror resolves against the caller before reconstruction enters staging', async (t) => {
  const f = fixture(t),
    { setupEngine } = await scripts(),
    engine = path.join(f.root, 'relative-mirror')
  const result = setupEngine({ manifest: f.manifest, engine, baseRepository: path.relative(process.cwd(), f.engine) })
  assert.equal(result.commit, f.pin.commit)
})

test('a source edit made during compilation cannot receive a successful provenance result', async (t) => {
  const f = fixture(t),
    { buildEngine } = await scripts(),
    bin = path.join(f.root, 'bin')
  fs.mkdirSync(bin)
  const cargo = path.join(bin, 'cargo'),
    rustc = path.join(bin, 'rustc')
  fs.writeFileSync(
    cargo,
    `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('cargo 1.99.0 (fixture)');else require('node:fs').writeFileSync(${JSON.stringify(path.join(f.engine, 'Cargo.lock'))},'concurrent source edit\\n');\n`,
    { mode: 0o700 },
  )
  fs.writeFileSync(rustc, `#!${process.execPath}\nconsole.log('rustc 1.99.0 (fixture)');\n`, { mode: 0o700 })
  const previous = process.env.PATH
  process.env.PATH = bin + path.delimiter + previous
  try {
    assert.throws(
      () => buildEngine({ engine: f.engine, manifest: f.manifest, targetDir: path.join(f.root, 'output') }),
      /tracked changes/,
    )
    assert.equal(fs.readFileSync(path.join(f.engine, 'Cargo.lock'), 'utf8'), 'concurrent source edit\n')
  } finally {
    process.env.PATH = previous
  }
})

test('a build pin changed during compilation cannot be certified even if its source commit stays the same', async (t) => {
  const f = fixture(t),
    { buildEngine } = await scripts(),
    bin = path.join(f.root, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, 'cargo'),
    `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('cargo 1.99.0 (fixture)');else {const fs=require('node:fs'),p=${JSON.stringify(f.manifest)},m=JSON.parse(fs.readFileSync(p));m.features=[];fs.writeFileSync(p,JSON.stringify(m));}\n`,
    { mode: 0o700 },
  )
  fs.writeFileSync(path.join(bin, 'rustc'), `#!${process.execPath}\nconsole.log('rustc 1.99.0 (fixture)');\n`, {
    mode: 0o700,
  })
  const previous = process.env.PATH
  process.env.PATH = bin + path.delimiter + previous
  try {
    assert.throws(
      () => buildEngine({ engine: f.engine, manifest: f.manifest, targetDir: path.join(f.root, 'output') }),
      /pin changed during compilation/,
    )
    assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest)).features, [])
    assert.equal(f.git('rev-parse', 'HEAD'), f.pin.commit)
  } finally {
    process.env.PATH = previous
  }
})
