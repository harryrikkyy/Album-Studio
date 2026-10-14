'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { tmpdir } = require('./fixtures')
const jobs = require('../lib/jobs')
const { clearStorage } = require('../lib/storage')
const { exportPlan } = require('../lib/deliver')
const { refreshProofs, proofsSettled } = require('../lib/proofs')
const cleanups = new WeakMap()

function fixture(t, siblings = false) {
  const root = tmpdir(), projects = [], outputs = []
  for (const name of ['A', 'B']) {
    const folder = path.join(root, name), output = path.join(root, 'shared', siblings ? name : 'sheets')
    fs.mkdirSync(folder); fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(folder, 'project.json'), JSON.stringify({ version: 1, workspace: { outputToken: output, imageTokens: [], templateTokens: [] }, albumPages: {}, totalActivePages: 1 }))
    projects.push(folder); outputs.push(output)
  }
  cleanups.set(t, [])
  t.after(async () => {
    try { for (const close of cleanups.get(t).reverse()) await close() }
    finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  return { root, projects, outputs }
}
function bounded(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), ms) })]).finally(() => clearTimeout(timer))
}
async function held(t, album, kind = 'render') {
  const source = `const jobs=require(${JSON.stringify(require.resolve('../lib/jobs'))});let lease;const timer=setTimeout(()=>process.exit(91),15000);process.on('message',async m=>{if(m==='release'){try{await jobs.releaseJob(lease);clearTimeout(timer);process.disconnect()}catch(e){console.error(e.stack);process.exit(92)}}});jobs.reserveJob(${JSON.stringify(kind)},${JSON.stringify(album)}).then(l=>{lease=l;process.send({held:true})},e=>{console.error(e.stack);process.exit(93)});`
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = '', killed = false
  child.stderr.on('data', b => { stderr += b })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  cleanups.get(t).push(async () => {
    if (child.connected) child.send('release')
    let result
    try { result = await bounded(exited, 3000, 'output holder did not release') }
    catch (error) { child.kill('SIGKILL'); await exited; throw error }
    assert.equal(killed ? result.signal : result.code, killed ? 'SIGKILL' : 0, stderr)
  })
  await bounded(new Promise((resolve, reject) => {
    child.once('message', resolve); child.once('error', reject)
    child.once('exit', () => reject(Error(stderr || 'output holder exited before ready')))
  }), 6000, 'output holder did not become ready')
  return { async kill() { killed = true; child.kill('SIGKILL'); await exited } }
}
async function reserve(album, kind) {
  let lease
  try { lease = await jobs.reserveJob(kind, album) } finally { if (lease) await jobs.releaseJob(lease) }
}

test('different live projects sharing a sheet root cannot reserve overlapping jobs', async t => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.projects[1], 'project.json'))
  await held(t, f.projects[0])
  await assert.rejects(reserve(f.projects[1], 'export'), /busy|progress|locked|lease/i)
  assert.deepEqual(fs.readFileSync(path.join(f.projects[1], 'project.json')), before)
  const third = path.join(f.root, 'C'), output = path.join(f.root, 'shared', 'third')
  fs.mkdirSync(third); fs.mkdirSync(output)
  fs.writeFileSync(path.join(third, 'project.json'), JSON.stringify({ version: 1, workspace: { outputToken: output }, albumPages: {}, totalActivePages: 1 }))
  await reserve(third, 'export') // The failed shared-sheet acquisition must release its parent.
})
test('sibling sheet roots serialize their shared delivery parent', async t => {
  const f = fixture(t, true)
  await held(t, f.projects[0], 'export')
  await assert.rejects(reserve(f.projects[1], 'export'), /busy|progress|locked|lease/i)
  await reserve(f.projects[1], 'render')
})
test('physical sheet-folder aliases share ownership even when their logical parents differ', async t => {
  const f = fixture(t), alias = path.join(f.projects[1], 'aliased-sheets')
  fs.symlinkSync(f.outputs[0], alias, 'dir')
  const file = path.join(f.projects[1], 'project.json'), data = JSON.parse(fs.readFileSync(file))
  data.workspace.outputToken = alias; fs.writeFileSync(file, JSON.stringify(data))
  await held(t, f.projects[0])
  await assert.rejects(reserve(f.projects[1], 'render'), /busy|progress|locked|lease/i)
})
test('album cache clearing, export planning and proof refresh cannot mutate a different project-held output root', async t => {
  const f = fixture(t), raw = path.join(f.outputs[0], '.album-studio', 'raw'), image = path.join(raw, 'customer.jpg')
  fs.mkdirSync(raw, { recursive: true }); fs.writeFileSync(image, 'retained derivative bytes')
  await held(t, f.projects[0])
  await assert.rejects(clearStorage({ album: f.projects[1], ids: ['raw'] }), /busy|progress|locked|lease/i)
  assert.equal(fs.readFileSync(image, 'utf8'), 'retained derivative bytes')
  await assert.rejects(exportPlan({ album: f.projects[1] }), /busy|progress|locked|lease/i)
  const events = []
  refreshProofs(f.projects[1], (event, data) => events.push({ event, ...data }))
  await proofsSettled(f.projects[1])
  assert.match(events.find(e => e.event === 'proofs.idle').error, /busy|progress|locked|lease/i)
})
test('a killed project releases stale output reservations through verified owner recovery', async t => {
  const f = fixture(t), owner = await held(t, f.projects[0], 'export')
  await owner.kill()
  await reserve(f.projects[1], 'export')
})

test('unexpected namespace records fail closed without replacing their bytes', async t => {
  const f = fixture(t), file = path.join(f.outputs[0], '.album-studio-namespace-sheets.json')
  fs.writeFileSync(file, 'customer metadata', { mode: 0o400 })
  await assert.rejects(reserve(f.projects[0], 'render'), /unexpected|changed|preserved/i)
  assert.equal(fs.readFileSync(file, 'utf8'), 'customer metadata')
})
test('a namespace symlink cannot edit its referent or acquire an output reservation', async t => {
  const f = fixture(t), target = path.join(f.root, 'customer.json'), file = path.join(f.outputs[0], '.album-studio-namespace-sheets.json')
  fs.writeFileSync(target, JSON.stringify({ version: 1, scope: 'sheets' }), { mode: 0o400 }); fs.symlinkSync(target, file)
  const bytes = fs.readFileSync(target)
  await assert.rejects(reserve(f.projects[0], 'render'), /unexpected|changed|preserved/i)
  assert.deepEqual(fs.readFileSync(target), bytes); assert.equal(fs.readlinkSync(file), target)
})
test('a changed private namespace record invalidates a held job and preserves the edit', async t => {
  const f = fixture(t), file = path.join(f.outputs[0], '.album-studio-namespace-sheets.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, scope: 'sheets' }), { mode: 0o400 })
  const lease = await jobs.reserveJob('render', f.projects[0])
  try {
    fs.chmodSync(file, 0o600); fs.writeFileSync(file, 'manual namespace change')
    await assert.rejects(lease.project.assertOwned(), /unexpected|changed|preserved/i)
  } finally { await jobs.releaseJob(lease) }
  assert.equal(fs.readFileSync(file, 'utf8'), 'manual namespace change')
})
test('render records reject another project and malformed history without changing either project or cache', async t => {
  const f = fixture(t), folder = path.join(f.outputs[0], '.album-studio'), file = path.join(folder, 'render-cache.json')
  fs.mkdirSync(folder)
  const owner = path.join(f.projects[0], 'project.json'), foreign = path.join(f.projects[1], 'project.json'), projectBytes = fs.readFileSync(foreign)
  fs.writeFileSync(file, JSON.stringify({ version: 2, albumFile: owner, spreads: {} }))
  const cacheBytes = fs.readFileSync(file)
  await assert.rejects(reserve(f.projects[1], 'render'), /another project|separate.*folder/i)
  assert.deepEqual(fs.readFileSync(foreign), projectBytes); assert.deepEqual(fs.readFileSync(file), cacheBytes)
  await reserve(f.projects[0], 'render')
  fs.writeFileSync(file, '{"damaged history":')
  await assert.rejects(reserve(f.projects[0], 'render'), /could not be verified|preserved/i)
  assert.equal(fs.readFileSync(file, 'utf8'), '{"damaged history":')
})
test('export preparation refuses a changed output before inspecting another folder\'s recovery history', async t => {
  const f = fixture(t), file = path.join(f.projects[0], 'project.json'), other = path.join(f.root, 'other-sheets')
  fs.mkdirSync(path.join(other, '.album-studio'), { recursive: true })
  const retained = path.join(other, '.album-studio', 'customer-recovery.txt')
  fs.writeFileSync(retained, 'preserve unrelated recovery bytes')
  const read = fs.promises.readFile.bind(fs.promises), readdir = fs.promises.readdir.bind(fs.promises)
  let changed = false, outsideReads = 0
  t.mock.method(fs.promises, 'readFile', async (name, ...args) => {
    if (!changed && name === file) {
      changed = true
      const data = JSON.parse(fs.readFileSync(file)); data.workspace.outputToken = other; fs.writeFileSync(file, JSON.stringify(data))
    }
    return read(name, ...args)
  })
  t.mock.method(fs.promises, 'readdir', async (name, ...args) => {
    if (name === path.join(other, '.album-studio')) outsideReads++
    return readdir(name, ...args)
  })
  await assert.rejects(exportPlan({ album: f.projects[0] }), /output namespace|lease|ownership/i)
  assert.equal(changed, true); assert.equal(outsideReads, 0)
  assert.equal(fs.readFileSync(retained, 'utf8'), 'preserve unrelated recovery bytes')
})
