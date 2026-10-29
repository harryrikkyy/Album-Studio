'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { tmpdir } = require('./fixtures')
const cache = require('../lib/cache')
const raw = require('../lib/raw')

function fixture(t) {
  const root = tmpdir(),
    source = path.join(root, 'original.jpg')
  fs.writeFileSync(source, 'verified original bytes')
  const previous = process.env.ALBUM_STUDIO_CACHE_DIR
  process.env.ALBUM_STUDIO_CACHE_DIR = path.join(root, 'cache')
  t.after(() => {
    if (previous === undefined) delete process.env.ALBUM_STUDIO_CACHE_DIR
    else process.env.ALBUM_STUDIO_CACHE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, source }
}
test('global clearing preserves retained histories and unknown manual files', async (t) => {
  fixture(t)
  const dir = path.join(cache.cacheRoot(), 'raw-previews'),
    retained = path.join(dir, '.album-studio-snapshot-retained', 'edited.jpg'),
    notes = path.join(dir, 'customer.txt')
  fs.mkdirSync(path.dirname(retained), { recursive: true })
  fs.writeFileSync(retained, 'manual recovery edits')
  fs.writeFileSync(notes, 'unknown customer notes')
  await assert.rejects(require('../lib/storage').clearStorage({ ids: ['raw-previews'] }), /preserv|ownership|retained/i)
  assert.equal(fs.readFileSync(retained, 'utf8'), 'manual recovery edits')
  assert.equal(fs.readFileSync(notes, 'utf8'), 'unknown customer notes')
})
test('global clearing cannot delete an active source snapshot', async (t) => {
  const f = fixture(t),
    key = await cache.contentFileKey(f.source)
  await raw.consumeSnapshot(f.source, key, path.join(cache.cacheRoot(), 'raw-previews'), async (frozen) => {
    await assert.rejects(
      require('../lib/storage').clearStorage({ ids: ['raw-previews'] }),
      /preserv|ownership|retained|busy/i,
    )
    assert.equal(fs.readFileSync(frozen, 'utf8'), 'verified original bytes')
  })
})
test('another real process cannot clear active snapshots through a cache-root alias', async (t) => {
  const f = fixture(t),
    key = await cache.contentFileKey(f.source),
    alias = path.join(f.root, 'cache-alias')
  fs.mkdirSync(cache.cacheRoot(), { recursive: true })
  fs.symlinkSync(cache.cacheRoot(), alias)
  await raw.consumeSnapshot(f.source, key, path.join(cache.cacheRoot(), 'raw-previews'), async (frozen) => {
    const script = `require(${JSON.stringify(require.resolve('../lib/storage'))}).clearStorage({ids:['raw-previews']}).then(()=>process.exit(2),e=>{process.stdout.write(e.code);process.exit(e.code==='CACHE_CLEAR_PRESERVED'?0:3)})`
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, ALBUM_STUDIO_CACHE_DIR: alias },
    })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(child.stdout, 'CACHE_CLEAR_PRESERVED')
    assert.equal(fs.readFileSync(frozen, 'utf8'), 'verified original bytes')
  })
})
test('source cleanup retains a complete stage when an unknown file appears', async (t) => {
  const f = fixture(t),
    key = await cache.contentFileKey(f.source)
  const error = await raw
    .consumeSnapshot(f.source, key, path.join(f.root, 'raw'), async (_frozen, stage) => {
      fs.writeFileSync(path.join(stage, 'customer.json'), 'manual notes')
    })
    .then(
      () => null,
      (e) => e,
    )
  assert.ok(error, 'unknown stage contents must fail closed')
  assert.equal(error.code, 'PRIVATE_STAGE_PRESERVED')
  assert.equal(fs.readFileSync(path.join(error.retainedPath, 'customer.json'), 'utf8'), 'manual notes')
  assert.equal(fs.readFileSync(f.source, 'utf8'), 'verified original bytes')
})
test('derived evidence EEXIST preserves the exact unowned record', async (t) => {
  const f = fixture(t),
    key = await cache.contentFileKey(f.source),
    out = path.join(f.root, 'derived', 'image.jpg')
  const error = await raw
    .deriveCached(f.source, out, key, 'fixture', async (tmp) => {
      fs.writeFileSync(tmp, 'decoder result')
      fs.writeFileSync(path.join(path.dirname(tmp), 'evidence.json'), 'existing manual record')
    })
    .then(
      () => null,
      (e) => e,
    )
  assert.equal(error.code, 'EEXIST')
  assert.ok(error.retainedPath)
  assert.equal(fs.readFileSync(path.join(error.retainedPath, 'evidence.json'), 'utf8'), 'existing manual record')
  assert.equal(fs.existsSync(out), false)
})
test('a decoder failure preserves a substituted temporary image and primary error', async (t) => {
  const f = fixture(t),
    key = await cache.contentFileKey(f.source),
    out = path.join(f.root, 'derived', 'image.jpg')
  const error = await raw
    .deriveCached(f.source, out, key, 'fixture', async (tmp) => {
      fs.writeFileSync(tmp, 'decoder result')
      fs.renameSync(tmp, path.join(f.root, 'displaced.jpg'))
      fs.writeFileSync(tmp, 'manual replacement')
      throw Object.assign(new Error('decoder failed'), { code: 'DECODER_FAILED' })
    })
    .then(
      () => null,
      (e) => e,
    )
  assert.equal(error.code, 'DECODER_FAILED')
  assert.ok(error.retainedPath)
  assert.equal(fs.readFileSync(path.join(error.retainedPath, 'image.jpg'), 'utf8'), 'manual replacement')
})
test('proof cleanup preserves edited snapshots and unknown files after a real PSD draw', async (t) => {
  const f = fixture(t),
    ag = require('ag-psd'),
    templates = require('../lib/psd_template'),
    file = path.join(f.root, 'template.psd'),
    W = 16,
    H = 8,
    data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < data.length; i += 4) data.set([40, 80, 120, 255], i)
  fs.writeFileSync(
    file,
    ag.writePsdBuffer({ width: W, height: H, imageData: { width: W, height: H, data }, children: [] }),
  )
  const original = templates.templateArt
  t.mock.method(templates, 'templateArt', async (...args) => {
    const art = await original(...args),
      stage = path.join(
        cache.cacheRoot(),
        fs.readdirSync(cache.cacheRoot()).find((n) => n.startsWith('proof-sources-')),
      ),
      frozen = path.join(
        stage,
        fs.readdirSync(stage).find((n) => n.endsWith('.psd')),
      )
    fs.chmodSync(frozen, 0o600)
    fs.writeFileSync(frozen, 'manual snapshot edit')
    fs.writeFileSync(path.join(stage, 'customer.txt'), 'manual proof notes')
    return art
  })
  delete require.cache[require.resolve('../lib/proofs')]
  t.after(() => {
    delete require.cache[require.resolve('../lib/proofs')]
  })
  const error = await require('../lib/proofs')
    .drawProof(
      { n: 1, photoIds: [], template: { file } },
      { path: f.root, photos: {} },
      {},
      path.join(f.root, 'proof.jpg'),
    )
    .then(
      () => null,
      (e) => e,
    )
  assert.equal(error?.code, 'PRIVATE_STAGE_PRESERVED')
  assert.ok(error.retainedPath)
  assert.equal(fs.readFileSync(path.join(error.retainedPath, 'customer.txt'), 'utf8'), 'manual proof notes')
  const edited = fs.readdirSync(error.retainedPath).find((n) => n.endsWith('.psd'))
  assert.equal(fs.readFileSync(path.join(error.retainedPath, edited), 'utf8'), 'manual snapshot edit')
})
