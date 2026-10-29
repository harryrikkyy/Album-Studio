'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { makeProject, tmpdir } = require('./fixtures')

process.env.ALBUM_STUDIO_DATA_DIR = tmpdir()
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()

async function holdJob(t, album) {
  const jobs = path.resolve(__dirname, '../lib/jobs.js')
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    (async()=>{const j=require(process.argv[1]);const lease=await j.reserveJob('render',process.argv[2]);
      process.send({ready:true});process.on('message',async()=>{await j.releaseJob(lease);process.exit(0)})
    })().catch(e=>{console.error(e);process.exit(2)})`,
      jobs,
      album,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  )
  let stderr = ''
  child.stderr.on('data', (bytes) => {
    stderr += bytes
  })
  const done = new Promise((resolve) => child.once('exit', resolve))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await done
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Holder timed out: ${stderr}`)), 10000)
    child.once('message', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('exit', () => {
      clearTimeout(timer)
      reject(new Error(`Holder exited: ${stderr}`))
    })
  })
}

test('a project appearing during creation is preserved instead of overwritten', async (t) => {
  const root = tmpdir(),
    shoot = path.join(root, 'Shoot'),
    folder = path.join(root, 'New album')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(shoot)
  await require('sharp')({ create: { width: 20, height: 10, channels: 3, background: '#f08020' } })
    .jpeg()
    .toFile(path.join(shoot, 'Photo.jpg'))
  const manual = Buffer.from('{"manual":"customer project appeared during thumbnail generation"}\n')
  await assert.rejects(
    require('../lib/newalbum').createAlbum(
      { name: 'New album', parent: root, photoFolders: [shoot] },
      {
        emit(event, value) {
          if (event === 'album.creating' && value.stage === 'project') {
            fs.mkdirSync(folder, { recursive: true })
            fs.writeFileSync(path.join(folder, 'project.json'), manual, { flag: 'wx' })
          }
        },
      },
    ),
    /already|exists|conflict/i,
  )
  assert.deepEqual(fs.readFileSync(path.join(folder, 'project.json')), manual)
})

test('background proof refresh cannot publish while another helper owns the album', async (t) => {
  const { root, proj } = makeProject()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(proj, 'project.json'),
    proof = path.join(proj, 'proofs', 'pages', 'live_page_001.jpg')
  const before = fs.readFileSync(file),
    image = fs.readFileSync(proof),
    events = []
  await holdJob(t, proj)
  const { refreshProofs, proofsSettled } = require('../lib/proofs')
  refreshProofs(proj, (name, value) => events.push({ name, value }))
  await proofsSettled(proj)
  assert.ok(
    events.some(
      (event) => event.name === 'proofs.idle' && /busy|locked|running|lease|reserved/i.test(event.value.error || ''),
    ),
    JSON.stringify(events),
  )
  assert.deepEqual(fs.readFileSync(file), before)
  assert.deepEqual(fs.readFileSync(proof), image)
  assert.equal(fs.existsSync(path.join(proj, 'proofs', 'pages', '.album-studio-proofs.json')), false)
})

test('album cache clearing cannot remove active render inputs owned by another helper', async (t) => {
  const { root, proj } = makeProject()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'out', '.album-studio', 'raw'),
    file = path.join(dir, 'Photo.jpg'),
    bytes = Buffer.from('active verified input')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, bytes)
  await holdJob(t, path.join(proj, 'project.json'))
  await assert.rejects(
    require('../lib/storage').clearStorage({ ids: ['raw'], album: proj }),
    /busy|locked|running|lease|reserved/i,
  )
  assert.deepEqual(fs.readFileSync(file), bytes)
})

test('a project-file symlink outside the album keeps models and output paths in the actual album', async (t) => {
  const { root, proj } = makeProject(),
    file = path.join(proj, 'project.json'),
    alias = path.join(root, 'external-project.json')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const data = JSON.parse(fs.readFileSync(file))
  delete data.workspace.outputToken
  fs.writeFileSync(file, JSON.stringify(data))
  fs.symlinkSync(file, alias)
  const album = await require('../lib/album').openAlbum({ path: alias })
  assert.equal(album.file, file)
  assert.equal(album.path, proj)
  const plan = await require('../lib/render').renderPlan({ album: alias, size: 'original' })
  assert.equal(plan.outputFolder, path.join(proj, 'exports'))
  const exported = await require('../lib/deliver').exportPlan({ album: alias, size: 'original' })
  assert.equal(exported.paths.sheets, path.join(proj, 'exports'))
  const { refreshProofs, proofsSettled } = require('../lib/proofs')
  refreshProofs(alias, () => {})
  await proofsSettled(alias)
  assert.equal(fs.existsSync(path.join(root, 'proofs')), false)
  assert.equal(fs.existsSync(path.join(root, 'exports')), false)
})
