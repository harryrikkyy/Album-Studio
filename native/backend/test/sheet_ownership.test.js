'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { makeProject, tmpdir } = require('./fixtures')
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()
const { openAlbum } = require('../lib/album')
const { updateAlbum, undo, redo, migrateAlbum } = require('../lib/project')
const { spreadHash, renderPlan, startRender } = require('../lib/render')
const { fileStamp } = require('../lib/cache')

async function fixture() {
  const { root, proj } = makeProject()
  const file = path.join(proj, 'project.json'), d = JSON.parse(fs.readFileSync(file, 'utf8'))
  d.albumPages[2] = { photos: [{ id: 'img_My_Shoot_C3_jpg', orient: 'v' }], template: { ...d.albumPages[1].template } }
  fs.writeFileSync(file, JSON.stringify(d))
  const output = d.workspace.outputToken
  const one = path.join(output, 'Page_001.psd'), two = path.join(output, 'Page_002.psd')
  fs.writeFileSync(one, 'A rendered document'); fs.writeFileSync(two, 'B rendered document')
  const a = await openAlbum({ path: proj }), cache = {}
  for (const s of a.spreads) cache[s.n] = { hash: await spreadHash(s, a, d.workspace), sheet: await fileStamp(s.n === 1 ? one : two) }
  fs.mkdirSync(path.join(output, '.album-studio'), { recursive: true })
  fs.writeFileSync(path.join(output, '.album-studio', 'render-cache.json'), JSON.stringify(cache))
  fs.appendFileSync(one, ' + hand edits')
  return { root, proj, one, two, output }
}

test('reorder, delete, undo and redo retain exact owned PSD paths and hand-edited bytes', async () => {
  const { proj, one, two } = await fixture()
  const before = await migrateAlbum({ album: proj })
  const ids = before.spreads.map((s) => s.id)
  let r = await updateAlbum({ album: proj, ops: [{ op: 'moveSpread', from: 1, to: 2 }] })
  assert.deepEqual(r.album.spreads.map((s) => s.id), ids.toReversed())
  assert.deepEqual(r.album.spreads.map((s) => s.sheet), [two, one])
  const plan = await renderPlan({ album: proj })
  assert.deepEqual(plan.spreads.map((s) => [s.state, !!s.edited]), [['current', false], ['current', true]])
  assert.equal(fs.readFileSync(r.album.spreads[1].sheet, 'utf8'), 'A rendered document + hand edits')
  r = await updateAlbum({ album: proj, ops: [{ op: 'removeSpread', n: 1 }] })
  assert.equal(r.album.spreads[0].sheet, one)
  r = await undo({ album: proj }); assert.deepEqual(r.album.spreads.map((s) => s.sheet), [two, one])
  r = await redo({ album: proj }); assert.equal(r.album.spreads[0].sheet, one)
  assert.equal(fs.readFileSync(two, 'utf8'), 'B rendered document', 'deleted spread documents remain recoverable')
})

test('inserting a spread never adopts another spread numbered PSD', async () => {
  const { proj, one, two } = await fixture()
  await migrateAlbum({ album: proj })
  const r = await updateAlbum({ album: proj, ops: [{ op: 'insertSpread', at: 1 }] })
  assert.deepEqual(r.album.spreads.map((s) => s.sheet), [null, one, two])
})

test('overlapping render starts cannot acquire two running jobs', async () => {
  const { proj } = await fixture()
  const finished = []
  const ctx = { emit: (event, data) => { if (event === 'render.finished') finished.push(data) } }
  const requests = await Promise.allSettled([startRender({ album: proj }, ctx), startRender({ album: proj }, ctx)])
  assert.equal(requests.filter((r) => r.status === 'fulfilled').length, 1)
  assert.match(requests.find((r) => r.status === 'rejected').reason.message, /already|running|starting/i)
  for (let i = 0; i < 100 && !finished.length; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(finished.length, 1)
  assert.equal(finished[0].failed, 0)
})
