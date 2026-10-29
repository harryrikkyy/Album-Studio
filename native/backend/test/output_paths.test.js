'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { tmpdir } = require('./fixtures')

function bounded(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
function fixture(t) {
  const root = tmpdir(),
    projects = [],
    outputs = [],
    closes = []
  for (const name of ['A', 'B']) {
    const project = path.join(root, name),
      output = path.join(root, `sheets-${name}`)
    fs.mkdirSync(project)
    fs.mkdirSync(output)
    fs.writeFileSync(
      path.join(project, 'project.json'),
      JSON.stringify({
        version: 1,
        workspace: { outputToken: output, imageTokens: [], templateTokens: [] },
        albumPages: { 1: { photos: [], template: null } },
        totalActivePages: 1,
      }),
    )
    projects.push(project)
    outputs.push(output)
  }
  t.after(async () => {
    try {
      for (const close of closes.reverse()) await close()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  return { root, projects, outputs, closes }
}
async function held(f) {
  const source = `const jobs=require(${JSON.stringify(require.resolve('../lib/jobs'))});let lease;const timer=setTimeout(()=>process.exit(91),15000);process.on('message',async m=>{if(m==='release'){try{await jobs.releaseJob(lease);clearTimeout(timer);process.disconnect()}catch(e){console.error(e.stack);process.exit(92)}}});jobs.reserveJob('render',${JSON.stringify(f.projects[0])}).then(l=>{lease=l;process.send({held:true})},e=>{console.error(e.stack);process.exit(93)})`
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = '',
    stopped
  child.stderr.on('data', (bytes) => {
    stderr = (stderr + bytes).slice(-8192)
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const stop = () =>
    (stopped ||= (async () => {
      if (child.connected) child.send('release')
      let result
      try {
        result = await bounded(exited, 4000, 'output-path fixture did not release')
      } catch (error) {
        child.kill('SIGKILL')
        await bounded(exited, 2000, 'output-path fixture did not stop')
        throw error
      }
      assert.equal(result.code, 0, `${JSON.stringify(result)} ${stderr}`)
    })())
  f.closes.push(stop)
  await bounded(
    new Promise((resolve, reject) => {
      child.once('message', resolve)
      child.once('error', reject)
      child.once('exit', () => reject(Error(stderr || 'fixture exited before holding')))
    }),
    6000,
    'output-path fixture did not hold its lease',
  )
  return stop
}

test('a real child-held job cannot lose cache bytes through another output metadata alias', async (t) => {
  const f = fixture(t),
    shared = path.join(f.root, 'shared-metadata'),
    raw = path.join(shared, 'raw'),
    customer = path.join(raw, 'manualCustomer.jpg'),
    bytes = Buffer.from('A active derivative and manual customer bytes')
  fs.mkdirSync(raw, { recursive: true })
  fs.writeFileSync(customer, bytes)
  fs.symlinkSync(shared, path.join(f.outputs[1], '.album-studio'), 'dir')
  // The held owner has a real metadata directory. Only the offending caller is aliased.
  fs.mkdirSync(path.join(f.outputs[0], '.album-studio'))
  const stopped = await held(f)
  // Redirect the alias to the first owner's real service metadata after it is reserved.
  fs.renameSync(raw, path.join(f.outputs[0], '.album-studio', 'raw'))
  fs.unlinkSync(path.join(f.outputs[1], '.album-studio'))
  fs.symlinkSync(path.join(f.outputs[0], '.album-studio'), path.join(f.outputs[1], '.album-studio'), 'dir')
  const actual = path.join(f.outputs[0], '.album-studio', 'raw', 'manualCustomer.jpg')
  let failure
  try {
    await require('../lib/storage').clearStorage({ album: f.projects[1], ids: ['raw'] })
  } catch (error) {
    failure = error
  }
  t.diagnostic(
    JSON.stringify({ rejected: !!failure, retainedBytes: fs.existsSync(actual), error: failure && failure.message }),
  )
  assert.equal(
    fs.existsSync(actual),
    true,
    'an unrelated caller deleted another live job cache through an intermediate symlink',
  )
  assert.deepEqual(fs.readFileSync(actual), bytes)
  assert.match((failure && failure.message) || 'clearance fulfilled', /symlink|path|directory|ownership|preserv/i)
  await stopped()
})

test('a real child-held job keeps its shared-page preview and manifest from another project', async (t) => {
  const f = fixture(t),
    shared = path.join(f.root, 'shared-proof-pages'),
    bytes = Buffer.from('A customer preview bytes')
  fs.mkdirSync(shared)
  for (const project of f.projects) {
    fs.mkdirSync(path.join(project, 'proofs'))
    fs.symlinkSync(shared, path.join(project, 'proofs', 'pages'), 'dir')
  }
  const proof = path.join(shared, 'live_page_001.jpg'),
    manifest = path.join(shared, '.album-studio-proofs.json')
  fs.writeFileSync(proof, bytes)
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      spreads: {
        1: {
          id: 'spread_A_owner',
          hash: 'inputs-sha256-1:' + 'a'.repeat(64),
          digest: crypto.createHash('sha256').update(bytes).digest('hex'),
          source: 'live',
        },
      },
    }),
  )
  const before = fs.readFileSync(manifest),
    stopped = await held(f),
    events = []
  const proofs = require('../lib/proofs')
  proofs.refreshProofs(f.projects[1], (event, data) => events.push({ event, ...data }))
  await bounded(proofs.proofsSettled(f.projects[1]), 6000, 'proof alias refresh did not settle')
  t.diagnostic(
    JSON.stringify({
      otherPreviewRetained: fs.existsSync(proof),
      manifestUnchanged: fs.readFileSync(manifest).equals(before),
      idle: events.find((e) => e.event === 'proofs.idle'),
    }),
  )
  assert.equal(fs.existsSync(proof), true, 'another project removed a held-owner preview via pages symlink')
  assert.deepEqual(fs.readFileSync(proof), bytes)
  assert.deepEqual(fs.readFileSync(manifest), before)
  assert.match(events.find((e) => e.event === 'proofs.idle').error, /symlink|path|directory|ownership|preserv/i)
  await stopped()
})

test('output validation accepts root aliases and rejects metadata/nested recovery aliases without changing bytes', async (t) => {
  const { validateOutputPaths } = require('../lib/output_paths')
  for (const entry of [
    '.album-studio',
    '.album-studio/raw',
    '.album-studio/adjusted',
    '.album-studio/sheets',
    '.album-studio/previews',
    '.album-studio/render-history',
    '.album-studio/delivery-history',
    '.album-studio/render-01234567-89ab-cdef-0123-456789abcdef',
  ])
    await t.test(entry, async (tt) => {
      const f = fixture(tt),
        outside = path.join(f.root, 'customer'),
        alias = path.join(f.root, 'root-alias'),
        target = path.join(f.outputs[0], entry)
      fs.mkdirSync(outside)
      fs.writeFileSync(path.join(outside, 'customer.txt'), 'unchanged customer data')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.symlinkSync(outside, target, 'dir')
      fs.symlinkSync(f.outputs[0], alias, 'dir')
      await assert.rejects(validateOutputPaths(alias), /symlink|path|directory|preserv/i)
      assert.equal(fs.readFileSync(path.join(outside, 'customer.txt'), 'utf8'), 'unchanged customer data')
      assert.equal(fs.readlinkSync(target), outside)
    })
  const f = fixture(t),
    alias = path.join(f.root, 'allowed-alias')
  fs.symlinkSync(f.outputs[0], alias, 'dir')
  const result = await validateOutputPaths(alias, { create: true })
  assert.equal(result.root, fs.realpathSync(f.outputs[0]))
  assert.equal(result.metadata, path.join(result.root, '.album-studio'))
})

test('managed cache entries must be directories and nested links cannot be pruned as unknown cache data', async (t) => {
  const { validateOutputPaths } = require('../lib/output_paths')
  for (const kind of ['file', 'nested-link'])
    await t.test(kind, async (tt) => {
      const f = fixture(tt),
        raw = path.join(f.outputs[0], '.album-studio', 'raw'),
        outside = path.join(f.root, 'manualCustomer')
      fs.mkdirSync(path.dirname(raw))
      fs.mkdirSync(outside)
      fs.writeFileSync(path.join(outside, 'original'), 'keep original')
      if (kind === 'file') fs.writeFileSync(raw, 'unexpected manual cache-name file')
      else {
        fs.mkdirSync(raw)
        fs.symlinkSync(outside, path.join(raw, 'foreign'), 'dir')
      }
      await assert.rejects(validateOutputPaths(f.outputs[0]), /symlink|path|directory|preserv/i)
      await assert.rejects(
        require('../lib/storage').clearStorage({ album: f.projects[0], ids: ['raw'] }),
        /symlink|path|directory|preserv/i,
      )
      if (kind === 'file') assert.equal(fs.readFileSync(raw, 'utf8'), 'unexpected manual cache-name file')
      else assert.equal(fs.readlinkSync(path.join(raw, 'foreign')), outside)
      assert.equal(fs.readFileSync(path.join(outside, 'original'), 'utf8'), 'keep original')
    })
})

test('a directory substituted while enumerating managed cache descendants fails closed', async (t) => {
  const { validateOutputPaths } = require('../lib/output_paths'),
    f = fixture(t),
    raw = path.join(f.outputs[0], '.album-studio', 'raw'),
    outside = path.join(f.root, 'manualCustomer'),
    retired = path.join(f.root, 'old-raw')
  fs.mkdirSync(raw, { recursive: true })
  fs.writeFileSync(path.join(raw, 'derivative.jpg'), 'retained derivative')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'original'), 'keep original')
  const readdir = fs.promises.readdir.bind(fs.promises)
  let changed = false
  t.mock.method(fs.promises, 'readdir', async (folder, ...args) => {
    const entries = await readdir(folder, ...args)
    if (!changed && folder === raw) {
      changed = true
      fs.renameSync(raw, retired)
      fs.symlinkSync(outside, raw, 'dir')
    }
    return entries
  })
  await assert.rejects(validateOutputPaths(f.outputs[0]), /symlink|path|directory|changed|preserv/i)
  assert.equal(changed, true)
  assert.equal(fs.readFileSync(path.join(outside, 'original'), 'utf8'), 'keep original')
  assert.equal(fs.readFileSync(path.join(retired, 'derivative.jpg'), 'utf8'), 'retained derivative')
})

test('proof validation accepts canonical root aliases and rejects each intermediate proof alias', async (t) => {
  const { validateProofPaths } = require('../lib/output_paths')
  for (const entry of ['proofs', 'proofs/pages', 'proofs/.album-studio-history'])
    await t.test(entry, async (tt) => {
      const f = fixture(tt),
        outside = path.join(f.root, 'manualCustomer'),
        target = path.join(f.projects[0], entry)
      fs.mkdirSync(outside)
      fs.writeFileSync(path.join(outside, 'preview.jpg'), 'keep preview')
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.symlinkSync(outside, target, 'dir')
      await assert.rejects(validateProofPaths(f.projects[0]), /symlink|path|directory|preserv/i)
      assert.equal(fs.readFileSync(path.join(outside, 'preview.jpg'), 'utf8'), 'keep preview')
    })
  const f = fixture(t),
    alias = path.join(f.root, 'album-alias')
  fs.symlinkSync(f.projects[0], alias, 'dir')
  const result = await validateProofPaths(alias, { create: true })
  assert.equal(result.root, fs.realpathSync(f.projects[0]))
  assert.equal(result.pages, path.join(result.root, 'proofs', 'pages'))
})

test('cache clearing preserves retained directories and loose files without ownership evidence', async (t) => {
  const f = fixture(t),
    raw = path.join(f.outputs[0], '.album-studio', 'raw'),
    stage = path.join(raw, '.album-studio-derived-retained'),
    manual = path.join(stage, 'captured-customer.jpg')
  fs.mkdirSync(stage, { recursive: true })
  fs.writeFileSync(manual, 'keep recovery bytes')
  await assert.rejects(
    require('../lib/storage').clearStorage({ album: f.projects[0], ids: ['raw'] }),
    /retained recovery|unknown directories|histories/i,
  )
  assert.equal(fs.readFileSync(manual, 'utf8'), 'keep recovery bytes')
  const adjusted = path.join(f.outputs[0], '.album-studio', 'adjusted')
  fs.mkdirSync(adjusted)
  fs.writeFileSync(path.join(adjusted, 'ordinary.jpg'), 'regenerable cache')
  await assert.rejects(
    require('../lib/storage').clearStorage({ album: f.projects[0], ids: ['adjusted'] }),
    (error) => error.code === 'CACHE_CLEAR_PRESERVED',
  )
  assert.equal(fs.readFileSync(path.join(adjusted, 'ordinary.jpg'), 'utf8'), 'regenerable cache')
  assert.equal(fs.readFileSync(manual, 'utf8'), 'keep recovery bytes')
  const emptyFixture = fixture(t),
    empty = path.join(emptyFixture.outputs[0], '.album-studio', 'raw')
  fs.mkdirSync(empty, { recursive: true })
  await require('../lib/storage').clearStorage({ album: emptyFixture.projects[0], ids: ['raw'] })
  assert.equal(fs.existsSync(empty), true)
  assert.deepEqual(fs.readdirSync(empty), [])
})
