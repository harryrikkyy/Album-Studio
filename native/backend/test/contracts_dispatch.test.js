'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')
const ag = require('ag-psd')
const { tmpdir } = require('./fixtures')
const contract = require('../../contracts/runtime')
const isolated = tmpdir()
process.env.ALBUM_STUDIO_DATA_DIR = path.join(isolated, 'app-data')
process.env.ALBUM_STUDIO_CACHE_DIR = path.join(isolated, 'app-cache')
test.after(() => fs.rmSync(isolated, { recursive: true, force: true }))
const account = require('../lib/account')
const { methods } = require('../methods')
const { createDispatcher } = require('../server')
const { proofsSettled } = require('../lib/proofs')
function bounded(promise, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 20000) })]).finally(() => clearTimeout(timer))
}

test('all 39 backend method handlers cross the actual validating dispatcher with disposable data', { timeout: 90000 }, async t => {
  const shoot = path.join(isolated, 'Shoot'), templates = path.join(isolated, 'Templates'), parent = path.join(isolated, 'Albums')
  for (const folder of [shoot, templates, parent]) fs.mkdirSync(folder, { recursive: true })
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#cd4a22' } }).jpeg().toFile(path.join(shoot, 'one.jpg'))
  const imageData = { width: 200, height: 100, data: new Uint8ClampedArray(200 * 100 * 4).fill(255) }
  const templateFile = path.join(templates, '1h0v.psd')
  fs.writeFileSync(templateFile, ag.writePsdBuffer({ width: 200, height: 100, imageData, children: [{ name: 'ToolkitHFrame_001', left: 0, top: 0, right: 200, bottom: 100, imageData }] }))
  // The credential/browser service is explicitly substituted. No real account, browser,
  // remote endpoint or user's stored activation is touched by this shape-integration test.
  const signedOut = { state: 'signedOut', configured: false, reason: 'not_activated' }
  for (const name of ['status', 'retry', 'signOut']) t.mock.method(account, name, async () => signedOut)
  t.mock.method(account, 'signIn', async (_p, ctx) => { ctx.emit('account.signIn', { stage: 'browser' }); return signedOut })
  t.mock.method(account, 'cancelSignIn', () => null)
  const observedMethods = new Set(), observedEvents = new Set(), invalidEvents = [], replies = new Map(), completed = new Map(), listeners = new Map()
  let nextId = 1
  const event = (name, data) => {
    try { contract.validateEvent({ event: name, data }) } catch (error) { invalidEvents.push(error); throw error }
    observedEvents.add(name)
    if (name.endsWith('.finished')) { completed.set(name, data); const listener = listeners.get(name); if (listener) listener(data) }
  }
  const dispatch = createDispatcher({ registry: methods, allowed: () => true, reply: reply => replies.set(reply.id, reply), event })
  const rpc = async (method, params = {}) => {
    const id = nextId++, request = { id, method, params }
    contract.validateRequest(request)
    await dispatch(JSON.stringify(request))
    const reply = replies.get(id)
    assert.ok(reply, `${method} must answer its id`); contract.validateReply(method, reply)
    assert.equal(reply.ok, true, `${method}: ${JSON.stringify(reply)}`)
    observedMethods.add(method)
    const album = params.album || reply.result?.album?.path || (method === 'album.open' && reply.result.path)
    if (album) await bounded(proofsSettled(album), `${method} proof refresh did not settle`)
    return reply.result
  }
  const finish = name => completed.has(name) ? Promise.resolve(completed.get(name)) : bounded(new Promise(resolve => listeners.set(name, resolve)), `${name} did not settle`)
  await rpc('system.ping', { n: { protocol: 1 } })
  await rpc('account.status'); await rpc('account.signIn'); await rpc('account.cancelSignIn'); await rpc('account.retry'); await rpc('account.signOut')
  await rpc('folders.inspect', { paths: [shoot] }); await rpc('templates.inspect', { paths: [templates] }); await rpc('templates.collections'); await rpc('album.suggest', { photoFolders: [shoot] })
  await rpc('library.add', { paths: [templates] }); await rpc('library.collections'); await rpc('library.setDefaults', { paths: [templates] }); await rpc('library.templates', { path: templates }); await rpc('library.remove', { path: templates })
  const created = await rpc('album.create', { name: 'Contract Album', parent, photoFolders: [shoot], templateCollections: [templates], autoFill: { desiredSheets: 1 } })
  const album = created.album.path
  await rpc('album.open', { path: album }); await rpc('album.recent')
  const extraShoot = path.join(isolated, 'Second Shoot'); fs.mkdirSync(extraShoot)
  await sharp({ create: { width: 200, height: 400, channels: 3, background: '#22a4cd' } }).jpeg().toFile(path.join(extraShoot, 'two.jpg'))
  await rpc('album.setFolders', { album, photoFolders: [shoot, extraShoot], templateCollections: [templates] })
  const photoId = Object.keys(created.album.photos)[0]
  await rpc('album.update', { album, ops: [{ op: 'rotatePhotos', ids: [photoId], by: 180 }] })
  await rpc('album.undo', { album }); await rpc('album.redo', { album })
  await rpc('templates.list', { album }); await rpc('spread.layout', { album, n: 1 }); await rpc('proofs.refresh', { album })
  await rpc('render.plan', { album, size: 'original' })
  const started = await rpc('render.start', { album, size: 'original' })
  assert.equal(started.album, album)
  await rpc('render.status')
  const rendered = await finish('render.finished'); assert.equal(rendered.done, 1, JSON.stringify(rendered)); assert.equal(rendered.failed, 0)
  await rpc('render.cancel', { jobId: started.jobId })
  await rpc('export.plan', { album, size: 'original' })
  await rpc('export.start', { album, size: 'original', jpegs: true, pdf: true })
  await rpc('export.status')
  const exported = await finish('export.finished'); assert.equal(exported.done, 1, JSON.stringify(exported)); assert.equal(exported.failed, 0); assert.equal(exported.pdf.pages, 1)
  await rpc('export.cancel')
  const labFolder = path.join(isolated, 'Lab Order'); fs.mkdirSync(labFolder)
  fs.copyFileSync(rendered.results[0].path, path.join(labFolder, '001.psd'))
  const listed = await rpc('lab.list', { folder: labFolder })
  assert.equal(listed.sheets.length, 1)
  await rpc('lab.rename', { folder: labFolder, ops: [{ fromPath: listed.sheets[0].path, toBaseName: 'Delivered_001' }] })
  const picks = await rpc('picks.analyze', { folders: [shoot] }); assert.equal(picks.photos.length, 1)
  await rpc('picks.copy', { picks: [{ folder: shoot, base: 'one' }] })
  await rpc('storage.usage', { album }); await rpc('storage.clear', { album, ids: ['raw-previews'] })
  // Exercise a real failed proof decode after the successful pipeline, using this test's
  // own template bytes. This is expected to report failure rather than corrupt the protocol.
  fs.writeFileSync(templateFile, 'invalid disposable template')
  await rpc('proofs.refresh', { album })
  assert.deepEqual(invalidEvents, [])
  assert.deepEqual([...observedMethods].sort(), Object.keys(contract.manifest.methods).filter(name => contract.manifest.methods[name].owner === 'backend').sort())
  assert.equal(observedMethods.size, 39)
  for (const name of ['account.signIn', 'album.creating', 'album.folders', 'picks.progress', 'render.started', 'render.progress', 'render.finished', 'export.started', 'export.progress', 'export.finished', 'proofs.updated', 'proofs.failed', 'proofs.idle']) assert.ok(observedEvents.has(name), `missing real producer event ${name}`)
})
