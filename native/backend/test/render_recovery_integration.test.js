'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const crypto = require('crypto')
const ag = require('ag-psd')
const sharp = require('sharp')
const { tmpdir } = require('./fixtures')
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()
process.env.ALBUM_STUDIO_DATA_DIR = tmpdir()
const { startRender, renderPlan } = require('../lib/render')
const { openAlbum } = require('../lib/album')
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

async function fixture(t) {
  const root = tmpdir(),
    album = path.join(root, 'Album'),
    shoot = path.join(root, 'Shoot'),
    templates = path.join(root, 'Templates'),
    output = path.join(album, 'exports')
  for (const dir of [output, shoot, templates]) fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const photo = path.join(shoot, 'photo.jpg'),
    template = path.join(templates, '1h0v.psd')
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#ce3a24' } })
    .jpeg()
    .toFile(photo)
  const pixels = new Uint8ClampedArray(200 * 100 * 4).fill(255)
  fs.writeFileSync(
    template,
    ag.writePsdBuffer({
      width: 200,
      height: 100,
      imageData: { width: 200, height: 100, data: pixels },
      children: [
        {
          name: 'ToolkitHFrame_001',
          left: 0,
          top: 0,
          right: 200,
          bottom: 100,
          imageData: { width: 200, height: 100, data: pixels },
        },
      ],
    }),
  )
  fs.writeFileSync(
    path.join(album, 'project.json'),
    JSON.stringify({
      version: 1,
      workspace: { imageTokens: [shoot], templateTokens: [templates], outputToken: output },
      totalActivePages: 1,
      albumPages: {
        1: {
          photos: [{ id: 'img_Shoot_photo_jpg', orient: 'h' }],
          template: { id: 'tpl_Templates_1h0v_psd', name: '1h0v.psd', h: 1, v: 0 },
        },
      },
    }),
  )
  const initial = await render({ album })
  assert.equal(initial.failed, 0, JSON.stringify(initial))
  assert.equal(initial.done, 1)
  const model = await openAlbum({ path: album }),
    sheet = model.spreads[0].sheet,
    cache = path.join(output, '.album-studio', 'render-cache.json')
  const oldSheet = fs.readFileSync(sheet),
    oldCache = fs.readFileSync(cache)
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#36b472' } })
    .jpeg()
    .toFile(photo)
  return { root, album, output, sheet, cache, oldSheet, oldCache }
}
async function render(p) {
  let finish
  const done = new Promise((resolve) => {
    finish = resolve
  })
  await startRender(p, {
    emit: (event, data) => {
      if (event === 'render.finished') finish(data)
    },
  })
  return done
}
const worker = `
const fs=require('fs'),path=require('path');const f=JSON.parse(process.argv[1]),at=process.argv[2],backend=process.argv[3];
process.env.ALBUM_STUDIO_CACHE_DIR=path.join(f.root,'worker-cache');
const exclusive=require(path.join(backend,'lib/exclusive_rename')),rename=exclusive.renameExclusive;
exclusive.renameExclusive=async(from,to)=>{await rename(from,to);
const b=path.basename(to);const hit=at==='sheet-captured'&&from===f.sheet||at==='sheet-installed'&&to===f.sheet||at==='cache-captured'&&b==='captured-cache'||at==='cache-installed'&&to===f.cache||at==='commit'&&b==='commit.json';
if(hit){process.send({checkpoint:at},()=>process.kill(process.pid,'SIGKILL'));await new Promise(()=>{})}};
require(path.join(backend,'lib/render')).startRender({album:f.album,force:true},{emit:(event,data)=>{if(event==='render.finished'){process.send({unexpectedFinish:data});process.exit(3)}}}).catch(e=>{process.send({error:e.stack});process.exit(4)});
`
async function crash(f, at) {
  const child = spawn(process.execPath, ['-e', worker, JSON.stringify(f), at, path.resolve(__dirname, '..')], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: process.env,
  })
  let message,
    stderr = ''
  child.on('message', (m) => {
    message = m
  })
  child.stderr.on('data', (b) => {
    stderr += b
  })
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Render boundary ${at} not reached: ${JSON.stringify(message)} ${stderr}`))
    }, 20000)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  assert.equal(exit.signal, 'SIGKILL', JSON.stringify(message) + stderr)
  assert.equal(message.checkpoint, at)
}
for (const at of ['sheet-captured', 'sheet-installed', 'cache-captured', 'cache-installed', 'commit']) {
  test(`the ordinary render plan recovers an engine render killed at ${at}`, async (t) => {
    const f = await fixture(t)
    await crash(f, at)
    const plan = await renderPlan({ album: f.album })
    if (at === 'commit') {
      assert.notEqual(sha(fs.readFileSync(f.sheet)), sha(f.oldSheet))
      assert.equal(
        JSON.parse(fs.readFileSync(f.cache)).spreads[Object.keys(JSON.parse(f.oldCache).spreads)[0]].sheetDigest,
        sha(fs.readFileSync(f.sheet)),
      )
      assert.equal(plan.spreads[0].state, 'current', 'the committed render stays current')
    } else {
      assert.equal(
        sha(fs.readFileSync(f.sheet)),
        sha(f.oldSheet),
        'the pending render must restore the exact previous sheet',
      )
      assert.equal(
        sha(fs.readFileSync(f.cache)),
        sha(f.oldCache),
        'the pending render must restore the exact ownership record',
      )
      assert.equal(plan.spreads[0].state, 'stale', 'the restored sheet still needs the changed photo rendered')
    }
    assert.equal(
      (await renderPlan({ album: f.album })).spreads[0].state,
      plan.spreads[0].state,
      'recovery is idempotent',
    )
  })
}

test('ordinary album reopening restores a missing cache before reading sheet ownership', async (t) => {
  const f = await fixture(t)
  await crash(f, 'cache-captured')
  assert.equal(fs.existsSync(f.cache), false)
  const album = await require('../methods').methods['album.open']({ path: f.album }, { emit: () => {} })
  await require('../lib/proofs').proofsSettled(f.album)
  assert.equal(album.spreads[0].sheet, f.sheet)
  assert.equal(sha(fs.readFileSync(f.sheet)), sha(f.oldSheet))
  assert.equal(sha(fs.readFileSync(f.cache)), sha(f.oldCache))
})

test('a preview metadata failure reports the committed render and refresh can regenerate it', async (t) => {
  const f = await fixture(t),
    write = fs.promises.writeFile.bind(fs.promises)
  let injected = false
  t.mock.method(fs.promises, 'writeFile', async (file, ...args) => {
    if (String(file).includes('.album-studio-proofs.json.tmp-')) {
      injected = true
      throw Object.assign(new Error('ENOSPC preview metadata'), { code: 'ENOSPC' })
    }
    return write(file, ...args)
  })
  const result = await render({ album: f.album, force: true })
  assert.equal(injected, true)
  assert.equal(result.done, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.results[0].committed, true)
  assert.match(result.results[0].warnings.join(' '), /sheet is saved.*preview.*ENOSPC/i)
  const sheetDigest = sha(fs.readFileSync(f.sheet)),
    cache = JSON.parse(fs.readFileSync(f.cache))
  assert.notEqual(sheetDigest, sha(f.oldSheet))
  assert.equal(Object.values(cache.spreads)[0].sheetDigest, sheetDigest)
  t.mock.restoreAll()
  const events = [],
    proofs = require('../lib/proofs')
  proofs.refreshProofs(f.album, (event, data) => events.push({ event, ...data }))
  await proofs.proofsSettled(f.album)
  assert.equal(events.find((e) => e.event === 'proofs.idle').failed, 0, JSON.stringify(events))
  const manifest = JSON.parse(fs.readFileSync(path.join(f.album, 'proofs', 'pages', '.album-studio-proofs.json')))
  assert.equal(manifest.spreads[1].source, 'sheet')
  assert.equal(manifest.spreads[1].sheetDigest, sheetDigest)
})

test('cancellation during publication restores the pair and reports stopped without a failed sheet', async (t) => {
  const f = await fixture(t),
    exclusive = require('../lib/exclusive_rename'),
    rename = exclusive.renameExclusive
  let stopped = false
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    await rename(from, to)
    if (!stopped && to === f.cache && path.basename(from) === 'install-cache.json') {
      stopped = true
      assert.equal(require('../lib/render').cancelRender().cancelled, true)
    }
  })
  const result = await render({ album: f.album, force: true })
  assert.equal(stopped, true)
  assert.equal(result.cancelled, true)
  assert.equal(result.failed, 0)
  assert.equal(result.done, 0)
  assert.equal(result.results[0].state, 'cancelled')
  assert.equal(sha(fs.readFileSync(f.sheet)), sha(f.oldSheet))
  assert.equal(sha(fs.readFileSync(f.cache)), sha(f.oldCache))
})
