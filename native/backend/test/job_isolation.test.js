'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn, execFile } = require('child_process')
const { promisify } = require('util')
const { makeProject } = require('./fixtures')
const jobs = require('../lib/jobs')
const { updateAlbum, undo, redo, migrateAlbum } = require('../lib/project')
const { renderPlan, startRender } = require('../lib/render')
const { exportPlan, startExport } = require('../lib/deliver')
const runFile = promisify(execFile)
const BUSY = /already|busy|in progress|rendering|exporting|starting|lease|locked|in use/i

function fixture(t) {
  const f = makeProject(),
    cleanup = []
  const alias = path.join(f.root, 'Album alias'),
    fileAlias = path.join(f.root, 'project-link.json')
  fs.symlinkSync(f.proj, alias, 'dir')
  fs.symlinkSync(path.join(f.proj, 'project.json'), fileAlias)
  f.file = path.join(f.proj, 'project.json')
  f.psd = path.join(f.root, 'out', 'Page_001.psd')
  f.aliases = [f.proj, f.file, alias, path.join(alias, 'project.json'), fileAlias]
  f.cleanup = cleanup
  t.after(async () => {
    try {
      for (const close of [...cleanup].reverse()) await close()
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true })
    }
  })
  return f
}

function bounded(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

async function heldLease(f, album = f.proj) {
  const script = `
const jobs=require(${JSON.stringify(require.resolve('../lib/jobs'))})
let lease, closing=false
const deadline=setTimeout(()=>process.exit(91),10000)
process.on('message',async message=>{
 if(message!=='release'||closing)return
 closing=true
 try {await jobs.releaseJob(lease);clearTimeout(deadline);process.send({type:'released'});process.disconnect()}
 catch(error){console.error(error.message);process.exit(92)}
})
;(async()=>{lease=await jobs.reserveJob('render',${JSON.stringify(album)});process.send({type:'held'})})().catch(error=>{console.error(error.message);process.exit(93)})
`
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = '',
    closed
  child.stdout.resume()
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192)
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const stop = () =>
    (closed ||= (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.send('release')
        } catch (_) {
          child.kill('SIGKILL')
        }
      }
      let result
      try {
        result = await bounded(exited, 1500, 'lease child did not release')
      } catch (_) {
        child.kill('SIGKILL')
        result = await bounded(exited, 1500, 'lease child did not terminate after SIGKILL')
      }
      assert.equal(result.code, 0, `lease child terminal state ${JSON.stringify(result)}: ${stderr}`)
    })())
  f.cleanup.push(stop)
  const ready = new Promise((resolve, reject) => {
    child.on('message', (message) => {
      if (message.type === 'held') resolve()
    })
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      reject(new Error(`lease child exited before holding: ${code}/${signal}: ${stderr}`)),
    )
  })
  await bounded(ready, 4000, 'lease child did not confirm ownership')
  return { stop }
}

function bytes(f) {
  return [fs.readFileSync(f.file), fs.readFileSync(f.psd)]
}
function unchanged(f, before) {
  assert.deepEqual(fs.readFileSync(f.file), before[0], 'blocked operation changed project bytes')
  assert.deepEqual(fs.readFileSync(f.psd), before[1], 'blocked operation changed a customer PSD')
}

test(
  'a real child-held lease blocks every album mutation and plan through canonical and symlink aliases',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t)
    await heldLease(f)
    const actions = {
      reserve: async (album) => {
        let lease
        try {
          lease = await jobs.reserveJob('export', album)
        } finally {
          if (lease) await jobs.releaseJob(lease)
        }
      },
      update: (album) => updateAlbum({ album, ops: [{ op: 'clearSpread', n: 1 }] }),
      undo: (album) => undo({ album }),
      redo: (album) => redo({ album }),
      migrate: (album) => migrateAlbum({ album }),
      renderPlan: (album) => renderPlan({ album, size: 'original' }),
      exportPlan: (album) => exportPlan({ album, size: 'original' }),
    }
    for (const [index, album] of f.aliases.entries())
      for (const [name, action] of Object.entries(actions))
        await t.test(`alias ${index + 1}: ${name}`, async () => {
          const before = bytes(f)
          let failure
          try {
            await action(album)
          } catch (error) {
            failure = error
          }
          unchanged(f, before)
          assert.match(
            failure ? failure.message : 'operation unexpectedly fulfilled',
            BUSY,
            'an external heavy job must own the whole album',
          )
        })
  },
)

test('direct migration cannot persist identity while this helper holds a heavy lease', async (t) => {
  const f = fixture(t),
    before = bytes(f),
    lease = await jobs.reserveJob('render', f.proj)
  try {
    let failure
    try {
      await migrateAlbum({ album: f.aliases[3] })
    } catch (error) {
      failure = error
    }
    unchanged(f, before)
    assert.match(failure ? failure.message : 'operation unexpectedly fulfilled', BUSY)
  } finally {
    await jobs.releaseJob(lease)
  }
})

test('same-helper concurrent render and export plans serialize their project access across aliases', async (t) => {
  const f = fixture(t),
    read = fs.promises.readFile.bind(fs.promises)
  const names = new Set([f.file, fs.realpathSync(f.file), path.join(f.aliases[2], 'project.json'), f.aliases[4]])
  let active = 0,
    peak = 0
  t.mock.method(fs.promises, 'readFile', async (file, ...args) => {
    if (!names.has(file)) return read(file, ...args)
    active++
    peak = Math.max(peak, active)
    try {
      await new Promise((resolve) => setTimeout(resolve, 15))
      return await read(file, ...args)
    } finally {
      active--
    }
  })
  await Promise.all([
    renderPlan({ album: f.proj, size: 'original' }),
    exportPlan({ album: f.aliases[3], size: 'original' }),
  ])
  assert.equal(peak, 1, 'whole plan access, including migration, must share one canonical queue')
})

test('folder, project-file and symlink aliases share one undo and redo history', async (t) => {
  const f = fixture(t)
  await updateAlbum({ album: f.proj, ops: [{ op: 'clearSpread', n: 1 }] })
  const restored = await undo({ album: f.aliases[3] })
  assert.equal(restored.changed, true)
  assert.equal(restored.album.spreads[0].photoIds.length, 2)
  const repeated = await redo({ album: f.aliases[4] })
  assert.equal(repeated.changed, true)
  assert.equal(repeated.album.spreads[0].photoIds.length, 0)
})

test('an external project edit invalidates in-memory undo and redo without replacing the child revision', async (t) => {
  const f = fixture(t)
  await updateAlbum({ album: f.proj, ops: [{ op: 'clearSpread', n: 1 }] })
  const script = `require(${JSON.stringify(require.resolve('../lib/project'))}).updateAlbum(${JSON.stringify({ album: f.aliases[3], ops: [{ op: 'insertSpread' }] })}).then(()=>process.exit(0),error=>{console.error(error.message);process.exit(2)})`
  await runFile(process.execPath, ['-e', script], { timeout: 5000 })
  const childRevision = fs.readFileSync(f.file)
  const undone = await undo({ album: f.proj })
  assert.equal(undone.changed, false)
  assert.equal(undone.canUndo, false)
  assert.equal(undone.canRedo, false)
  assert.deepEqual(fs.readFileSync(f.file), childRevision)
  const redone = await redo({ album: f.aliases[3] })
  assert.equal(redone.changed, false)
  assert.deepEqual(fs.readFileSync(f.file), childRevision)
})

test('failed render/export starts release the whole-album lease for another process', async (t) => {
  const f = fixture(t),
    context = { emit() {} }
  await assert.rejects(startExport({ album: f.proj, jpegs: false, pdf: false }, context), /Choose at least/)
  await (await heldLease(f, f.aliases[3])).stop()
  await assert.rejects(
    startRender({ album: f.proj, spreads: [], size: 'original' }, context),
    /Select existing spreads/,
  )
  await (await heldLease(f, f.aliases[4])).stop()
})

test('render completion releases its lease before a new helper can reserve the album', async (t) => {
  const f = fixture(t),
    data = JSON.parse(fs.readFileSync(f.file))
  data.albumPages = { 1: { photos: [], template: null } }
  data.totalActivePages = 1
  fs.writeFileSync(f.file, JSON.stringify(data))
  const beforePsd = fs.readFileSync(f.psd)
  let finish
  const finished = new Promise((resolve) => {
    finish = resolve
  })
  await startRender(
    { album: f.proj, size: 'original' },
    {
      emit: (event, value) => {
        if (event === 'render.finished') finish(value)
      },
    },
  )
  await bounded(finished, 5000, 'empty synthetic render did not finish')
  await (await heldLease(f, f.aliases[3])).stop()
  assert.deepEqual(fs.readFileSync(f.psd), beforePsd)
})
