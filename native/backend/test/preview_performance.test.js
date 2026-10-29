'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const sharp = require('../../../src/sharp_config').getSharp()
const ag = require('ag-psd')
const { tmpdir } = require('./fixtures')
const { refreshProofs, proofsSettled } = require('../lib/proofs')
const { updateAlbum } = require('../lib/project')

async function fixture(t) {
  const root = tmpdir(),
    cache = path.join(root, 'cache'),
    shoot = path.join(root, 'Shoot'),
    templates = path.join(root, 'Templates'),
    album = path.join(root, 'Album')
  const previous = process.env.ALBUM_STUDIO_CACHE_DIR
  process.env.ALBUM_STUDIO_CACHE_DIR = cache
  t.after(() => {
    if (previous === undefined) delete process.env.ALBUM_STUDIO_CACHE_DIR
    else process.env.ALBUM_STUDIO_CACHE_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (const p of [cache, shoot, templates, album]) fs.mkdirSync(p)
  await sharp({ create: { width: 120, height: 60, channels: 3, background: '#e04020' } })
    .jpeg()
    .toFile(path.join(shoot, 'A.jpg'))
  const data = new Uint8ClampedArray(120 * 60 * 4).fill(255)
  fs.writeFileSync(
    path.join(templates, '1h0v.psd'),
    ag.writePsdBuffer({
      width: 120,
      height: 60,
      imageData: { width: 120, height: 60, data },
      children: [
        {
          name: 'toolkithframe1',
          left: 0,
          top: 0,
          right: 120,
          bottom: 60,
          imageData: { width: 120, height: 60, data },
        },
      ],
    }),
  )
  fs.writeFileSync(
    path.join(album, 'project.json'),
    JSON.stringify({
      version: 1,
      totalActivePages: 2,
      workspace: { imageTokens: [shoot], templateTokens: [templates], outputToken: path.join(root, 'out') },
      albumPages: Object.fromEntries(
        [1, 2].map((n) => [
          n,
          {
            photos: [{ id: 'img_Shoot_A_jpg', orient: 'h' }],
            template: { id: 'tpl_Templates_1h0v_psd', name: '1h0v.psd', h: 1, v: 0 },
          },
        ]),
      ),
    }),
  )
  return { root, cache, album, id: 'img_Shoot_A_jpg' }
}
async function refresh(f) {
  const events = []
  refreshProofs(f.album, (event, data) => events.push({ event, ...data }))
  await proofsSettled(f.album)
  return events
}
test('ordinary previews work with a full retained history without deleting or relocating it', async (t) => {
  const f = await fixture(t),
    history = path.join(f.cache, '.album-studio-stage-history', 'preserved-work')
  fs.mkdirSync(history, { recursive: true })
  const preserved = path.join(history, 'customer.bin'),
    fd = fs.openSync(preserved, 'wx')
  try {
    fs.ftruncateSync(fd, 8 * 1024 ** 3)
  } finally {
    fs.closeSync(fd)
  }
  const before = fs.statSync(preserved),
    events = await refresh(f)
  assert.equal(events.filter((e) => e.event === 'proofs.failed').length, 0, JSON.stringify(events))
  assert.equal(events.filter((e) => e.event === 'proofs.updated').length, 2)
  assert.equal(fs.statSync(preserved).ino, before.ino)
  assert.equal(fs.statSync(preserved).size, before.size)
  assert.deepEqual(fs.readdirSync(path.dirname(history)), ['preserved-work'])
})
test('repeated photo edits do not accumulate full-source snapshots in the preview cache', async (t) => {
  const f = await fixture(t)
  await refresh(f)
  for (let i = 0; i < 3; i++) {
    await updateAlbum({ album: f.album, ops: [{ op: 'rotatePhotos', ids: [f.id], by: 90 }] })
    await refresh(f)
  }
  const history = path.join(f.cache, '.album-studio-stage-history')
  assert.equal(fs.existsSync(history) ? fs.readdirSync(history).length : 0, 0)
})
test('a photo edit can finish while a background preview decoder is waiting', async (t) => {
  const f = await fixture(t)
  await refresh(f)
  const proof = path.join(f.album, 'proofs/pages/live_page_001.jpg'),
    initial = fs.readFileSync(proof)
  await updateAlbum({ album: f.album, ops: [{ op: 'rotatePhotos', ids: [f.id], by: 180 }] })
  const renderer = require('../../../src/proof_renderer'),
    original = renderer.buildPhotoLayer
  let enter,
    release,
    once = true
  const entered = new Promise((resolve) => {
      enter = resolve
    }),
    held = new Promise((resolve) => {
      release = resolve
    })
  t.mock.method(renderer, 'buildPhotoLayer', async (...args) => {
    if (once) {
      once = false
      enter()
      await held
    }
    return original(...args)
  })
  refreshProofs(f.album, () => {})
  let enterTimer
  await Promise.race([
    entered,
    new Promise((_, reject) => {
      enterTimer = setTimeout(() => reject(Error('preview never reached its decoder')), 5000)
    }),
  ]).finally(() => clearTimeout(enterTimer))
  const edit = updateAlbum({ album: f.album, ops: [{ op: 'rotatePhotos', ids: [f.id], by: 180 }] })
  let timer
  const responsive = await Promise.race([
    edit.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 2000)
    }),
  ])
  clearTimeout(timer)
  release()
  await edit
  await proofsSettled(f.album)
  assert.equal(responsive, true, 'background decoding held the project edit lease')
  assert.deepEqual(fs.readFileSync(proof), initial, 'a stale rotated preview replaced the newer restored project')
})

test('a scoped spread refresh does not hash unrelated original photos', async (t) => {
  const f = await fixture(t),
    b = path.join(f.root, 'Shoot/B.jpg'),
    project = path.join(f.album, 'project.json')
  await sharp({ create: { width: 120, height: 60, channels: 3, background: '#208040' } })
    .jpeg()
    .toFile(b)
  const data = JSON.parse(fs.readFileSync(project))
  data.albumPages[2].photos[0].id = 'img_Shoot_B_jpg'
  fs.writeFileSync(project, JSON.stringify(data))
  await refresh(f)
  await updateAlbum({ album: f.album, ops: [{ op: 'rotatePhotos', ids: [f.id], by: 180 }] })
  const open = fs.promises.open.bind(fs.promises)
  let fullReads = 0
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args),
      read = handle.read.bind(handle)
    if (args[0] === b)
      handle.read = async (...input) => {
        if (input[0].length === 1024 * 1024) fullReads++
        return read(...input)
      }
    return handle
  })
  const events = []
  refreshProofs(f.album, (event, d) => events.push({ event, ...d }), { spreads: [1] })
  await proofsSettled(f.album)
  assert.equal(fullReads, 0, 'an unrelated spread triggered full-source hashing')
  assert.deepEqual(
    events.filter((e) => e.event === 'proofs.updated').map((e) => e.n),
    [1],
  )
})

test('dirty-spread selection includes every use of a transformed photo and structural edits fall back to all', () => {
  const { proofScope } = require('../lib/proof_scope'),
    album = {
      spreads: [
        { n: 1, photoIds: ['a'] },
        { n: 2, photoIds: ['b'] },
        { n: 3, photoIds: ['a', 'b'] },
      ],
    }
  assert.deepEqual(proofScope([{ op: 'setTemplate', n: 2 }], album), [2])
  assert.deepEqual(proofScope([{ op: 'rotatePhotos', ids: ['a'] }], album), [1, 3])
  assert.deepEqual(proofScope([{ op: 'adjustPhoto', id: 'b' }], album), [2, 3])
  assert.equal(proofScope([{ op: 'addPhoto', n: 2, id: 'a' }], album), null)
  // Replacing an assigned photo swaps its previous spread too.
  assert.equal(proofScope([{ op: 'replacePhoto', n: 2, oldId: 'b', newId: 'a' }], album), null)
  assert.equal(proofScope([{ op: 'moveSpread', from: 1, to: 2 }], album), null)
})
