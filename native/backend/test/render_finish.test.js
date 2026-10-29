'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const sharp = require('sharp')
const ag = require('ag-psd')
const { tmpdir } = require('./fixtures')
const appCache = tmpdir(),
  dataRoot = tmpdir()
process.env.ALBUM_STUDIO_CACHE_DIR = appCache
process.env.ALBUM_STUDIO_DATA_DIR = dataRoot
test.after(() => {
  fs.rmSync(appCache, { recursive: true, force: true })
  fs.rmSync(dataRoot, { recursive: true, force: true })
})
const jobs = require('../lib/jobs')
const { PhotoCraftSession } = require('../lib/photocraft')
const { startRender, cancelRender, renderStatus, renderPlan } = require('../lib/render')
const { openAlbum } = require('../lib/album')
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

async function fixture(t, { spreads = 1, brokenSecond = false } = {}) {
  const root = tmpdir(),
    album = path.join(root, 'Album'),
    shoot = path.join(root, 'Shoot'),
    templates = path.join(root, 'Templates'),
    output = path.join(album, 'exports')
  for (const dir of [output, shoot, templates]) fs.mkdirSync(dir, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#cd4a22' } })
    .jpeg()
    .toFile(path.join(shoot, 'photo.jpg'))
  const data = new Uint8ClampedArray(200 * 100 * 4).fill(255),
    imageData = { width: 200, height: 100, data }
  fs.writeFileSync(
    path.join(templates, '1h0v.psd'),
    ag.writePsdBuffer({
      width: 200,
      height: 100,
      imageData,
      children: [{ name: 'ToolkitHFrame_001', left: 0, top: 0, right: 200, bottom: 100, imageData }],
    }),
  )
  const albumPages = {}
  for (let n = 1; n <= spreads; n++)
    albumPages[n] = {
      photos: [{ id: 'img_Shoot_photo_jpg', orient: 'h' }],
      template: brokenSecond && n === 2 ? null : { id: 'tpl_Templates_1h0v_psd', name: '1h0v.psd', h: 1, v: 0 },
    }
  fs.writeFileSync(
    path.join(album, 'project.json'),
    JSON.stringify({
      version: 1,
      workspace: { imageTokens: [shoot], templateTokens: [templates], outputToken: output },
      totalActivePages: spreads,
      albumPages,
    }),
  )
  return { root, album, output }
}
function bounded(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(label)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
async function render(f, observe = () => {}) {
  let finish
  const events = [],
    done = new Promise((resolve) => {
      finish = resolve
    })
  await startRender(
    { album: f.album },
    {
      emit: (event, data) => {
        events.push({ event, ...data })
        observe(event, data)
        if (event === 'render.finished') finish(data)
      },
    },
  )
  return { result: await bounded(done, 10000, 'render finishing regression did not settle'), events }
}
async function assertSaved(f, result) {
  const album = await openAlbum({ path: f.album }),
    record = result.results.find((r) => r.n === 1)
  assert.equal(record.state, 'done')
  assert.equal(record.committed, true)
  assert.equal(record.path, album.spreads[0].sheet)
  const cache = JSON.parse(fs.readFileSync(path.join(f.output, '.album-studio', 'render-cache.json')))
  assert.equal(cache.spreads[album.spreads[0].id].sheetDigest, sha(fs.readFileSync(record.path)))
  assert.equal((await renderPlan({ album: f.album })).spreads[0].state, 'current')
}
async function assertReleased(f) {
  assert.equal(renderStatus().running, false)
  assert.equal(jobs.activeJob(), null)
  const next = await jobs.reserveJob('render', f.album)
  await jobs.releaseJob(next)
}
function failedClose(t) {
  const close = PhotoCraftSession.prototype.close
  let calls = 0,
    session
  t.mock.method(PhotoCraftSession.prototype, 'close', async function () {
    calls++
    session = this
    await close.call(this)
    throw new Error('engine close evidence unavailable after terminal exit')
  })
  return () => {
    assert.equal(calls, 1)
    assert.ok(
      session.proc.exitCode !== null || session.proc.signalCode !== null,
      'the real engine must reach terminal state before the injected close report error',
    )
  }
}
function failingRelease(t, which, attempts) {
  const lease = jobs.activeJob()
  for (const key of ['outputs', 'project']) {
    const original = lease[key].release.bind(lease[key])
    t.mock.method(lease[key], 'release', async () => {
      attempts.push(key)
      await original()
      if (which.includes(key)) throw new Error(`${key} release evidence unavailable after retirement`)
    })
  }
}

test('engine close errors retain committed results and exact per-sheet counts after success, partial failure and cancellation', async (t) => {
  for (const scenario of ['saved', 'partial-failure', 'cancelled-after-save'])
    await t.test(scenario, async (tt) => {
      const f = await fixture(tt, {
          spreads: scenario === 'saved' ? 1 : 2,
          brokenSecond: scenario === 'partial-failure',
        }),
        closed = failedClose(tt)
      const { result } = await render(f, (event, value) => {
        if (
          scenario === 'cancelled-after-save' &&
          event === 'render.progress' &&
          value.n === 1 &&
          value.state === 'done'
        )
          assert.equal(cancelRender().cancelled, true)
      })
      assert.equal(result.done, 1)
      assert.equal(result.failed, scenario === 'partial-failure' ? 1 : 0)
      assert.equal(result.cancelled, scenario === 'cancelled-after-save')
      assert.equal(result.results.length, scenario === 'partial-failure' ? 2 : 1)
      assert.match(result.finishingError, /engine close evidence unavailable/)
      assert.match(result.error, /engine close evidence unavailable/)
      assert.match(result.warnings.join(' '), /engine close evidence unavailable/)
      if (scenario === 'partial-failure') assert.match(result.results[1].error, /no template/)
      closed()
      await assertSaved(f, result)
      await assertReleased(f)
    })
})

test('lease release errors retain saved-sheet results without inventing a failed sheet and attempt every release', async (t) => {
  for (const which of [['outputs'], ['project'], ['outputs', 'project']])
    await t.test(which.join('+'), async (tt) => {
      const f = await fixture(tt),
        attempts = []
      const { result } = await render(f, (event) => {
        if (event === 'render.started') failingRelease(tt, which, attempts)
      })
      assert.equal(result.done, 1)
      assert.equal(result.failed, 0)
      assert.equal(result.results.length, 1)
      for (const name of which) assert.match(result.finishingError, new RegExp(`${name} release evidence unavailable`))
      assert.deepEqual(attempts, ['outputs', 'project'])
      assert.equal(result.cancelled, false)
      await assertSaved(f, result)
      await assertReleased(f)
    })
})

test('engine and release finishing errors combine while a committed sheet stays successful', async (t) => {
  const f = await fixture(t),
    attempts = [],
    closed = failedClose(t)
  const { result } = await render(f, (event) => {
    if (event === 'render.started') failingRelease(t, ['outputs'], attempts)
  })
  assert.equal(result.done, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.results.length, 1)
  assert.match(result.finishingError, /engine close evidence unavailable.*outputs release evidence unavailable/)
  assert.equal(result.warnings.length, 2, JSON.stringify(result.warnings))
  closed()
  await assertSaved(f, result)
  await assertReleased(f)
})

test('a release error after stopping before work preserves cancellation without reporting a failed sheet', async (t) => {
  const f = await fixture(t, { spreads: 2 }),
    attempts = []
  const { result } = await render(f, (event) => {
    if (event === 'render.started') {
      failingRelease(t, ['project'], attempts)
      assert.equal(cancelRender().cancelled, true)
    }
  })
  assert.equal(result.done, 0)
  assert.equal(result.failed, 0)
  assert.equal(result.skipped, 0)
  assert.equal(result.cancelled, true)
  assert.deepEqual(result.results, [])
  assert.match(result.finishingError, /project release evidence unavailable/)
  assert.deepEqual(attempts, ['outputs', 'project'])
  await assertReleased(f)
})
