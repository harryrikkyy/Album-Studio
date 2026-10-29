'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const modulePath = path.resolve(__dirname, '../lib/project_transaction')
const revision = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const context = { assertOwned: async () => {} } // Save/recovery mechanics; lease integration tested separately.
function fixture(t) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'as-project-transaction-')))
  const file = path.join(folder, 'project.json'),
    old = Buffer.from('{"albumPages":{},"marker":"old customer project"}\n')
  fs.writeFileSync(file, old)
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  return { folder, file, old, data: { albumPages: {}, marker: 'new project' } }
}
function allFiles(folder) {
  const result = []
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name)
    if (entry.isDirectory()) result.push(...allFiles(file))
    else result.push(file)
  }
  return result
}

test('a durable project save keeps exact previous bytes in .bak and detached permanent history', async (t) => {
  const { saveProject, recoverProject } = require(modulePath),
    f = fixture(t)
  const result = await saveProject(f.file, f.data, revision(f.old), context)
  assert.equal(result.committed, true)
  assert.equal(JSON.parse(fs.readFileSync(f.file)).marker, 'new project')
  assert.equal(result.revision, revision(fs.readFileSync(f.file)))
  assert.deepEqual(fs.readFileSync(`${f.file}.bak`), f.old)
  const snapshots = allFiles(result.historyPath).filter((file) => fs.lstatSync(file).isFile())
  assert.ok(snapshots.some((file) => fs.readFileSync(file).equals(f.old)))
  fs.writeFileSync(`${f.file}.bak`, 'a later public backup edit')
  assert.ok(
    snapshots.some((file) => fs.readFileSync(file).equals(f.old)),
    'public .bak does not hard-link to retained old bytes',
  )
  assert.deepEqual((await recoverProject(f.file, context)).recovered, [])
})

test('unknown regular and symlink backups are retained without changing their referents', async (t) => {
  const { saveProject } = require(modulePath)
  for (const kind of ['regular', 'symlink']) {
    const f = fixture(t),
      manual = Buffer.from('unrelated customer backup'),
      outside = path.join(f.folder, 'customer.txt')
    fs.writeFileSync(outside, manual)
    if (kind === 'regular') fs.writeFileSync(`${f.file}.bak`, manual)
    else fs.symlinkSync(outside, `${f.file}.bak`)
    if (kind === 'symlink') {
      await assert.rejects(saveProject(f.file, f.data, revision(f.old), context), /regular|preserv/i)
      assert.deepEqual(fs.readFileSync(f.file), f.old)
      assert.equal(fs.readlinkSync(`${f.file}.bak`), outside)
      assert.deepEqual(fs.readFileSync(outside), manual)
      continue
    }
    const result = await saveProject(f.file, f.data, revision(f.old), context)
    assert.deepEqual(fs.readFileSync(`${f.file}.bak`), f.old)
    assert.deepEqual(fs.readFileSync(outside), manual)
    const retained = allFiles(result.historyPath)
    assert.ok(
      retained.some((file) =>
        kind === 'symlink'
          ? fs.lstatSync(file).isSymbolicLink() && fs.readlinkSync(file) === outside
          : fs.lstatSync(file).isFile() && fs.readFileSync(file).equals(manual),
      ),
    )
  }
})

test('a stale expected revision cannot replace the current project or its backup', async (t) => {
  const { saveProject } = require(modulePath),
    f = fixture(t),
    manual = Buffer.from('{"external":"current project"}')
  fs.writeFileSync(f.file, manual)
  fs.writeFileSync(`${f.file}.bak`, 'customer backup')
  await assert.rejects(saveProject(f.file, f.data, revision(f.old), context), /changed|revision/i)
  assert.deepEqual(fs.readFileSync(f.file), manual)
  assert.equal(fs.readFileSync(`${f.file}.bak`, 'utf8'), 'customer backup')
})

test('a manual project change at capture is restored exclusively and all baseline bytes remain', async (t) => {
  const { saveProject, recoverProject } = require(modulePath),
    f = fixture(t),
    exclusive = require('../lib/exclusive_rename'),
    rename = exclusive.renameExclusive
  const manual = Buffer.from('{"manual":"edited at capture"}')
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    if (from === f.file) fs.writeFileSync(from, manual)
    return rename(from, to)
  })
  await assert.rejects(saveProject(f.file, f.data, revision(f.old), context), /changed|revision|preserv/i)
  assert.deepEqual(fs.readFileSync(f.file), manual)
  assert.ok(allFiles(f.folder).some((file) => fs.lstatSync(file).isFile() && fs.readFileSync(file).equals(f.old)))
  t.mock.restoreAll()
  await recoverProject(f.file, context)
  assert.deepEqual(fs.readFileSync(f.file), manual)
})

test('a new project appearing during exclusive installation is preserved', async (t) => {
  const { saveProject, recoverProject } = require(modulePath),
    f = fixture(t),
    exclusive = require('../lib/exclusive_rename'),
    rename = exclusive.renameExclusive
  const manual = Buffer.from('{"manual":"new customer project in vacant name"}')
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    if (to === f.file && path.basename(from) === 'install-project.json') fs.writeFileSync(to, manual, { flag: 'wx' })
    return rename(from, to)
  })
  await assert.rejects(saveProject(f.file, f.data, revision(f.old), context), /exists|preserv|EEXIST/i)
  assert.deepEqual(fs.readFileSync(f.file), manual)
  t.mock.restoreAll()
  await recoverProject(f.file, context)
  assert.deepEqual(fs.readFileSync(f.file), manual)
})

const crash = `
const path=require('path'),exclusive=require(path.join(path.dirname(process.argv[1]),'exclusive_rename')),rename=exclusive.renameExclusive;
exclusive.renameExclusive=async(from,to)=>{await rename(from,to);const at=process.argv[4];
 if(at==='journal'&&path.basename(to).startsWith('save-')||at==='backup-captured'&&path.basename(to)==='captured-backup'||at==='backup-installed'&&to===process.argv[2]+'.bak'||at==='project-captured'&&path.basename(to)==='captured-project'||at==='project-installed'&&to===process.argv[2]||at==='commit'&&path.basename(to)==='commit.json'){
  process.send({checkpoint:at},()=>process.kill(process.pid,'SIGKILL'));await new Promise(()=>{});
 }
};
require(process.argv[1]).saveProject(process.argv[2],{albumPages:{},marker:'new project'},process.argv[3],{assertOwned:async()=>{}}).then(()=>process.exit(0),e=>{console.error(e.stack);process.exit(2)});
`
for (const boundary of [
  'journal',
  'backup-captured',
  'backup-installed',
  'project-captured',
  'project-installed',
  'commit',
]) {
  test(`SIGKILL after ${boundary} recovers a complete revision and retains all old backup bytes`, async (t) => {
    const { recoverProject, recoveryLocation } = require(modulePath),
      f = fixture(t),
      backup = Buffer.from('previous unknown customer backup')
    fs.writeFileSync(`${f.file}.bak`, backup)
    const proc = spawn(process.execPath, ['-e', crash, modulePath, f.file, revision(f.old), boundary], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    proc.stderr.on('data', (bytes) => {
      stderr += bytes
    })
    const done = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })))
    t.after(async () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
      await done
    })
    const event = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Crash boundary not reached: ${stderr}`)), 10000)
      proc.once('message', (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      done.then((value) => {
        clearTimeout(timer)
        if (value.signal !== 'SIGKILL') reject(new Error(`Crash helper failed: ${JSON.stringify(value)} ${stderr}`))
      })
    })
    assert.equal(event.checkpoint, boundary)
    assert.equal((await done).signal, 'SIGKILL')
    if (boundary === 'project-captured')
      assert.deepEqual(await recoveryLocation(f.folder), {
        file: fs.realpathSync(f.folder) + path.sep + 'project.json',
        folder: fs.realpathSync(f.folder),
      })
    const result = await recoverProject(f.file, context)
    assert.equal(result.recovered.length, 1)
    if (boundary === 'commit') {
      assert.equal(JSON.parse(fs.readFileSync(f.file)).marker, 'new project')
      assert.deepEqual(fs.readFileSync(`${f.file}.bak`), f.old)
    } else {
      assert.deepEqual(fs.readFileSync(f.file), f.old)
      assert.deepEqual(fs.readFileSync(`${f.file}.bak`), backup)
    }
    assert.ok(
      allFiles(result.recovered[0]).some((file) => fs.lstatSync(file).isFile() && fs.readFileSync(file).equals(backup)),
    )
  })
}

for (const spelling of ['folder', 'file', 'symlink'])
  test(`normal album open recovers a killed real lease through its ${spelling} name`, async (t) => {
    const f = fixture(t),
      oldData = process.env.ALBUM_STUDIO_DATA_DIR
    process.env.ALBUM_STUDIO_DATA_DIR = path.join(f.folder, 'test-app-data')
    t.after(() => {
      if (oldData === undefined) delete process.env.ALBUM_STUDIO_DATA_DIR
      else process.env.ALBUM_STUDIO_DATA_DIR = oldData
    })
    const source = `
const path=require('path'),exclusive=require(path.join(path.dirname(process.argv[1]),'exclusive_rename')),rename=exclusive.renameExclusive;
exclusive.renameExclusive=async(from,to)=>{await rename(from,to);if(path.basename(to)==='captured-project'){process.send({captured:true},()=>process.kill(process.pid,'SIGKILL'));await new Promise(()=>{})}};
;(async()=>{const jobs=require(path.join(path.dirname(process.argv[1]),'jobs'));const lease=await jobs.reserveJob('render',process.argv[2]);await require(process.argv[1]).saveProject(process.argv[2],{albumPages:{},marker:'new project'},process.argv[3],{assertOwned:()=>lease.project.assertOwned()});})().catch(e=>{console.error(e.stack);process.exit(2)});
`
    const child = spawn(process.execPath, ['-e', source, modulePath, f.file, revision(f.old)], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    child.stderr.on('data', (bytes) => {
      stderr += bytes
    })
    const done = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await done
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Project capture did not occur: ${stderr}`)), 10000)
      child.once('message', () => {
        clearTimeout(timer)
        resolve()
      })
      done.then((state) => {
        clearTimeout(timer)
        if (state.signal !== 'SIGKILL') reject(new Error(`Capture failed: ${JSON.stringify(state)} ${stderr}`))
      })
    })
    assert.equal((await done).signal, 'SIGKILL')
    assert.equal(fs.existsSync(f.file), false)
    let input = spelling === 'folder' ? f.folder : f.file
    if (spelling === 'symlink') {
      input = path.join(f.folder, 'project-alias.json')
      fs.symlinkSync(f.file, input)
    }
    const opened = await require('../methods').methods['album.open']({ path: input }, { emit() {} })
    await require('../lib/proofs').proofsSettled(opened.path)
    assert.equal(opened.file, f.file)
    assert.equal(opened.path, f.folder)
    assert.deepEqual(fs.readFileSync(f.file), f.old)
  })

test('a completed save whose history retirement fails is reported as committed with the exact retained path', async (t) => {
  const { saveProject } = require(modulePath),
    f = fixture(t),
    exclusive = require('../lib/exclusive_rename'),
    rename = exclusive.renameExclusive
  let retained
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    if (path.basename(path.dirname(to)) === 'history') {
      retained = from
      throw Object.assign(new Error('Simulated history disk failure'), { code: 'ENOSPC' })
    }
    return rename(from, to)
  })
  const failure = await saveProject(f.file, f.data, revision(f.old), context).then(
    () => null,
    (error) => error,
  )
  assert.ok(failure)
  assert.equal(failure.projectCommitted, true)
  assert.equal(failure.recoveryStage, retained)
  assert.match(failure.message, /project was saved/i)
  assert.equal(JSON.parse(fs.readFileSync(f.file)).marker, 'new project')
  assert.deepEqual(fs.readFileSync(`${f.file}.bak`), f.old)
})
