'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const modulePath = path.resolve(__dirname, '../lib/project_lock')

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'as-project-lease-'))
  const file = path.join(folder, 'project.json')
  fs.writeFileSync(file, JSON.stringify({ albumPages: {}, totalActivePages: 1 }))
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  return { folder, file }
}
function child(code, args = [], environment = {}) {
  const proc = spawn(process.execPath, ['-e', code, modulePath, ...args], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ...environment },
  })
  let stderr = ''
  proc.stderr.on('data', (bytes) => {
    stderr += bytes
  })
  const done = new Promise((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal, stderr }))
  })
  const messages = [],
    waiters = []
  proc.on('message', (value) => {
    const waiting = waiters.shift()
    if (waiting) waiting.resolve(value)
    else messages.push(value)
  })
  done.then((result) => {
    for (const waiting of waiters.splice(0))
      waiting.reject(new Error(`Lease fixture exited: ${JSON.stringify(result)}`))
  })
  const message = () =>
    new Promise((resolve, reject) => {
      if (messages.length) {
        resolve(messages.shift())
        return
      }
      const timer = setTimeout(() => reject(new Error(`Lease fixture timed out: ${stderr}`)), 10000)
      waiters.push({
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  return { proc, done, message }
}
const holder = `
const {acquireProjectLease}=require(process.argv[1]);
acquireProjectLease(process.argv[2],{kind:'fixture-holder'}).then(async lease=>{
 process.send({ready:true,file:lease.file,folder:lease.folder,lockPath:lease.lockPath,token:lease.token});
 process.on('message',async message=>{try{if(message==='release'){await lease.release();process.exit(0)}else if(message==='check'){await lease.assertOwned();process.send({owned:true})}}catch(e){process.send({error:e.message});process.exit(3)}});
}).catch(e=>{console.error(e.stack);process.exit(2)});
`

test('canonical paths converge folder, project-file, symlink and case aliases; hard links are rejected', async (t) => {
  const { canonicalProject } = require(modulePath),
    f = fixture(t)
  const alias = path.join(f.folder, 'alias.json')
  fs.symlinkSync(f.file, alias)
  assert.deepEqual(await canonicalProject(f.folder), {
    file: await fs.promises.realpath(f.file),
    folder: await fs.promises.realpath(f.folder),
  })
  assert.deepEqual(await canonicalProject(alias), await canonicalProject(f.file))
  const alternateCase = path.join(f.folder, 'PROJECT.JSON')
  if (fs.existsSync(alternateCase))
    assert.deepEqual(await canonicalProject(alternateCase), await canonicalProject(f.file))
  fs.linkSync(f.file, path.join(f.folder, 'hardlink.json'))
  await assert.rejects(canonicalProject(f.file), /hard.?link|multiple names/i)
})

test('simultaneous subprocess reclaimers never both enter the same dead owner lease', async (t) => {
  const f = fixture(t),
    old = child(holder, [f.file])
  await old.message()
  old.proc.kill('SIGKILL')
  await old.done
  const contender = `
  const {acquireProjectLease}=require(process.argv[1]);
  process.on('message',async message=>{if(message!=='go')return;try{
   const lease=await acquireProjectLease(process.argv[2],{kind:'contender'});process.send({state:'acquired'});
   process.on('message',async next=>{if(next==='release'){await lease.release();process.exit(0)}});
  }catch(e){process.send({state:'blocked',error:e.message},()=>process.exit(0))}});process.send({state:'ready'});
  `
  const a = child(contender, [f.file]),
    b = child(contender, [f.folder])
  t.after(() => {
    a.proc.kill('SIGKILL')
    b.proc.kill('SIGKILL')
  })
  assert.equal((await a.message()).state, 'ready')
  assert.equal((await b.message()).state, 'ready')
  a.proc.send('go')
  b.proc.send('go')
  const results = await Promise.all([a.message(), b.message()])
  assert.equal(results.filter((value) => value.state === 'acquired').length, 1)
  assert.equal(results.filter((value) => value.state === 'blocked').length, 1)
  const winner = results[0].state === 'acquired' ? a : b
  winner.proc.send('release')
  assert.deepEqual(
    (await Promise.all([a.done, b.done])).map((r) => r.code),
    [0, 0],
  )
})

const crashWorker = `
const path=require('path'),exclusive=require(path.join(path.dirname(process.argv[1]),'exclusive_rename'));
const rename=exclusive.renameExclusive;
exclusive.renameExclusive=async(from,to)=>{await rename(from,to);
 const boundary=process.argv[3];
 if(boundary==='published'&&to.endsWith('.lock')||boundary==='guard'&&to.endsWith('.lock.reclaim')||boundary==='captured'&&to.includes('-stale-')||boundary==='release'&&to.includes('-released-')){
  process.send({checkpoint:boundary,path:to},()=>process.kill(process.pid,'SIGKILL'));await new Promise(()=>{});
 }
};
require(process.argv[1]).acquireProjectLease(process.argv[2],{kind:'crash-fixture'}).then(async lease=>{
 if(process.argv[3]==='release'){await lease.release()}else process.send({unexpected:true});
}).catch(e=>{console.error(e.stack);process.exit(2)});
`

test('a crash after complete owner publication leaves a reclaimable lease', async (t) => {
  const { acquireProjectLease } = require(modulePath),
    f = fixture(t),
    interrupted = child(crashWorker, [f.file, 'published'])
  const event = await interrupted.message()
  assert.equal(event.checkpoint, 'published')
  assert.equal((await interrupted.done).signal, 'SIGKILL')
  const bytes = fs.readFileSync(path.join(event.path, 'owner.json'))
  const next = await acquireProjectLease(f.folder, { kind: 'plan' })
  await next.release()
  const history = path.join(f.folder, '.album-studio-project-lock-history')
  assert.ok(
    fs.readdirSync(history).some((name) => fs.readFileSync(path.join(history, name, 'owner.json')).equals(bytes)),
  )
})

for (const boundary of ['guard', 'captured', 'release']) {
  test(`an interrupted ${boundary} mutation fails closed without deleting recovery bytes`, async (t) => {
    const { acquireProjectLease } = require(modulePath),
      f = fixture(t)
    if (boundary !== 'release') {
      const old = child(holder, [f.file])
      await old.message()
      old.proc.kill('SIGKILL')
      await old.done
    }
    const interrupted = child(crashWorker, [f.file, boundary]),
      event = await interrupted.message()
    assert.equal(event.checkpoint, boundary)
    assert.equal((await interrupted.done).signal, 'SIGKILL')
    const bytes = fs.readFileSync(path.join(event.path, 'owner.json'))
    await assert.rejects(acquireProjectLease(f.folder, { kind: 'render' }), /reclamation guard|recovery|interrupted/i)
    assert.deepEqual(fs.readFileSync(path.join(event.path, 'owner.json')), bytes)
  })
}

test('helper timeout after a completed OS move is resolved through exact owner evidence', async (t) => {
  const { acquireProjectLease } = require(modulePath),
    f = fixture(t),
    exclusive = require('../lib/exclusive_rename'),
    rename = exclusive.renameExclusive
  t.mock.method(exclusive, 'renameExclusive', async (...args) => {
    await rename(...args)
    throw Object.assign(new Error('simulated helper timeout after completed syscall'), { code: 'ETIMEDOUT' })
  })
  const lease = await acquireProjectLease(f.file, { kind: 'edit' })
  await lease.assertOwned()
  await lease.release()
  assert.equal(fs.existsSync(lease.lockPath), false)
})

test('an initially unguarded contender cannot start work in the stale-reclaimer publication gap', async (t) => {
  const { acquireProjectLease } = require(modulePath),
    f = fixture(t),
    old = child(holder, [f.file])
  await old.message()
  old.proc.kill('SIGKILL')
  await old.done
  const worker = `
  const path=require('path'),exclusive=require(path.join(path.dirname(process.argv[1]),'exclusive_rename'));
  const rename=exclusive.renameExclusive;let paused=false;
  const pause=phase=>new Promise(resolve=>{process.once('message',()=>resolve());process.send({phase})});
  exclusive.renameExclusive=async(from,to)=>{
   if(process.argv[3]==='normal'&&!paused&&from.includes('.candidate-')&&to.endsWith('.lock')){paused=true;await pause('before-publication')}
   await rename(from,to);
   if(process.argv[3]==='reclaimer'&&to.includes('-stale-'))await pause('old-captured');
  };
  require(process.argv[1]).acquireProjectLease(process.argv[2],{kind:process.argv[3]}).then(lease=>{
   process.send({state:'acquired'});process.on('message',async message=>{if(message==='release'){await lease.release();process.exit(0)}});
  }).catch(e=>{process.send({state:'blocked',error:e.message},()=>process.exit(0))});
  `
  const normal = child(worker, [f.file, 'normal'])
  t.after(() => normal.proc.kill('SIGKILL'))
  assert.equal((await normal.message()).phase, 'before-publication')
  const reclaimer = child(worker, [f.file, 'reclaimer'])
  t.after(() => reclaimer.proc.kill('SIGKILL'))
  assert.equal((await reclaimer.message()).phase, 'old-captured')
  normal.proc.send('go')
  const rejected = await normal.message()
  assert.equal(rejected.state, 'blocked')
  assert.match(rejected.error, /recovery|raced|lock/i)
  assert.equal((await normal.done).code, 0)
  reclaimer.proc.send('go')
  assert.equal((await reclaimer.message()).state, 'acquired')
  await assert.rejects(acquireProjectLease(f.folder, { kind: 'edit' }), /busy|another/i)
  reclaimer.proc.send('release')
  assert.equal((await reclaimer.done).code, 0)
})

test('a private retirement-name collision never overwrites unexpected bytes or loses the live lock', async (t) => {
  const { acquireProjectLease } = require(modulePath),
    f = fixture(t),
    lease = await acquireProjectLease(f.file, { kind: 'edit' })
  const exclusive = require('../lib/exclusive_rename'),
    rename = exclusive.renameExclusive
  const bytes = Buffer.from('unrelated recovery evidence'),
    owner = fs.readFileSync(path.join(lease.lockPath, 'owner.json'))
  let foreign
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    if (from === lease.lockPath) {
      foreign = to
      fs.mkdirSync(to)
      fs.writeFileSync(path.join(to, 'customer.txt'), bytes)
    }
    return rename(from, to)
  })
  await assert.rejects(lease.release(), /preserv|EEXIST|exists/i)
  assert.deepEqual(fs.readFileSync(path.join(foreign, 'customer.txt')), bytes)
  assert.deepEqual(fs.readFileSync(path.join(lease.lockPath, 'owner.json')), owner)
  await lease.assertOwned()
  t.mock.restoreAll()
  await lease.release()
})

test('an owner edited at the capture boundary is restored intact and never silently released', async (t) => {
  const { acquireProjectLease } = require(modulePath),
    f = fixture(t),
    lease = await acquireProjectLease(f.file, { kind: 'edit' })
  const exclusive = require('../lib/exclusive_rename'),
    rename = exclusive.renameExclusive
  const owner = JSON.parse(fs.readFileSync(path.join(lease.lockPath, 'owner.json'))),
    changed = Buffer.from(JSON.stringify({ ...owner, token: '0'.repeat(64) }))
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    if (from === lease.lockPath) fs.writeFileSync(path.join(from, 'owner.json'), changed)
    return rename(from, to)
  })
  await assert.rejects(lease.release(), /changed|preserv/i)
  assert.deepEqual(fs.readFileSync(path.join(lease.lockPath, 'owner.json')), changed)
  await assert.rejects(lease.assertOwned(), /changed|preserv/i)
})

test('replacing the album directory at the same spelling invalidates the old lease', async (t) => {
  const { acquireProjectLease } = require(modulePath),
    f = fixture(t),
    lease = await acquireProjectLease(f.file, { kind: 'edit' })
  const moved = `${f.folder}-moved`
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }))
  const text = fs.readFileSync(f.file)
  fs.renameSync(f.folder, moved)
  fs.mkdirSync(f.folder)
  fs.writeFileSync(f.file, text)
  await assert.rejects(lease.assertOwned(), /directory|path|changed/i)
  assert.ok(fs.existsSync(path.join(moved, path.basename(lease.lockPath), 'owner.json')))
})

test('a separate live helper blocks aliases and release lets another helper acquire without changing project bytes', async (t) => {
  const { acquireProjectLease } = require(modulePath),
    f = fixture(t),
    bytes = fs.readFileSync(f.file)
  const running = child(holder, [f.folder])
  t.after(() => running.proc.kill('SIGKILL'))
  const ready = await running.message()
  assert.equal(ready.ready, true)
  const alias = path.join(f.folder, 'alias.json')
  fs.symlinkSync(f.file, alias)
  await assert.rejects(acquireProjectLease(alias, { kind: 'edit' }), /busy|another|running|in use/i)
  running.proc.send('release')
  assert.equal((await running.done).code, 0)
  const next = await acquireProjectLease(f.file, { kind: 'plan' })
  assert.notEqual(next.token, ready.token)
  await next.assertOwned()
  await next.release()
  await next.release()
  assert.deepEqual(fs.readFileSync(f.file), bytes)
})

test('real helpers with different timezone and locale environments cannot steal a live process lease', async (t) => {
  const f = fixture(t),
    owner = child(holder, [f.file], { TZ: 'Pacific/Honolulu', LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8' })
  t.after(async () => {
    if (owner.proc.exitCode === null && owner.proc.signalCode === null) owner.proc.kill('SIGKILL')
    await owner.done
  })
  const held = await owner.message()
  const attempt = `require(process.argv[1]).acquireProjectLease(process.argv[2],{kind:'different-environment'}).then(async l=>{await l.release();process.send({stolen:true},()=>process.exit(0))},e=>process.send({blocked:true,error:e.message},()=>process.exit(0)))`
  const contender = child(attempt, [f.folder], { TZ: 'Asia/Tokyo', LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' })
  const result = await contender.message()
  await contender.done
  assert.equal(result.blocked, true, JSON.stringify(result))
  assert.equal(JSON.parse(fs.readFileSync(path.join(held.lockPath, 'owner.json'))).token, held.token)
  owner.proc.send('release')
  assert.equal((await owner.done).code, 0)
})

test('a killed same-host helper is reclaimed while its complete owner evidence is retained', async (t) => {
  const { acquireProjectLease } = require(modulePath),
    f = fixture(t)
  const running = child(holder, [f.file]),
    ready = await running.message()
  running.proc.kill('SIGKILL')
  await running.done
  const prior = fs.readFileSync(path.join(ready.lockPath, 'owner.json'))
  const next = await acquireProjectLease(f.file, { kind: 'render' })
  assert.notEqual(next.token, ready.token)
  await next.assertOwned()
  await next.release()
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name === 'owner.json') found.push(fs.readFileSync(file))
    }
  }
  walk(f.folder)
  assert.ok(
    found.some((bytes) => bytes.equals(prior)),
    'stale lock evidence is retired, never unlinked',
  )
})

test('unexpected lock bytes or symlinks fail closed and are preserved', async (t) => {
  const { acquireProjectLease } = require(modulePath),
    f = fixture(t)
  const lease = await acquireProjectLease(f.file, { kind: 'edit' })
  const extra = path.join(lease.lockPath, 'customer-note.txt'),
    bytes = Buffer.from('preserve this unexpected file')
  fs.writeFileSync(extra, bytes)
  await assert.rejects(lease.assertOwned(), /unexpected|changed|preserv/i)
  await assert.rejects(lease.release(), /unexpected|changed|preserv/i)
  await assert.rejects(acquireProjectLease(f.folder, { kind: 'render' }), /unexpected|changed|preserv/i)
  assert.deepEqual(fs.readFileSync(extra), bytes)
})

test('malformed, oversized, foreign-host and unknown live owners are never stolen', async (t) => {
  const { acquireProjectLease } = require(modulePath)
  for (const mode of ['malformed', 'oversized', 'foreign', 'unknown-live', 'symlink']) {
    const f = fixture(t),
      lease = await acquireProjectLease(f.file, { kind: 'edit' })
    const file = path.join(lease.lockPath, 'owner.json'),
      owner = JSON.parse(fs.readFileSync(file))
    let bytes
    if (mode === 'malformed') bytes = Buffer.from('{broken')
    else if (mode === 'oversized') bytes = Buffer.alloc(65537, 0x20)
    else if (mode === 'foreign') bytes = Buffer.from(JSON.stringify({ ...owner, host: 'f'.repeat(64) }))
    else if (mode === 'unknown-live') bytes = Buffer.from(JSON.stringify({ ...owner, token: '0'.repeat(64) }))
    else {
      const outside = path.join(f.folder, 'outside.json')
      fs.writeFileSync(outside, JSON.stringify(owner))
      fs.unlinkSync(file)
      fs.symlinkSync(outside, file)
      bytes = fs.readFileSync(outside)
    }
    if (mode !== 'symlink') fs.writeFileSync(file, bytes)
    await assert.rejects(acquireProjectLease(f.folder, { kind: 'render' }), /busy|owner|lock|host|preserv|symlink/i)
    assert.deepEqual(fs.readFileSync(file), bytes)
  }
})

test('serialization queues short operations, releases failed tails and keeps separate projects independent', async (t) => {
  const { serializeProject } = require(modulePath),
    f = fixture(t),
    order = []
  let proceed
  const wait = new Promise((resolve) => {
    proceed = resolve
  })
  const first = serializeProject(f.file, async () => {
    order.push('first')
    await wait
    throw new Error('fixture failure')
  })
  const second = serializeProject(f.file, async () => {
    order.push('second')
    return 2
  })
  const other = fixture(t)
  assert.equal(await serializeProject(other.file, async () => 3), 3)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['first'])
  proceed()
  await assert.rejects(first, /fixture failure/)
  assert.equal(await second, 2)
  assert.deepEqual(order, ['first', 'second'])
  assert.equal(await serializeProject(f.file, async () => 4), 4)
})

test('a held lease that finds a reclamation guard reports its lock lost', async (t) => {
  const { acquireProjectLease } = require(modulePath)
  const f = fixture(t),
    lease = await acquireProjectLease(f.file),
    guardPath = `${lease.lockPath}.reclaim`
  fs.mkdirSync(guardPath)
  await assert.rejects(lease.assertOwned(), (error) => {
    assert.deepEqual(
      [error.code, error.lockPath, error.message],
      [
        'PROJECT_LOCK_LOST',
        guardPath,
        `Project ownership is being recovered or released; wait before publishing. Existing lock evidence has been preserved at ${guardPath}.`,
      ],
    )
    return true
  })
  fs.rmdirSync(guardPath)
  await lease.release()
})

test('a guard that cannot be retired fails the release, alone or after the lock itself failed', async (t) => {
  const { acquireProjectLease } = require(modulePath)
  const exclusive = require('../lib/exclusive_rename'),
    move = exclusive.renameExclusive
  for (const lockToo of [false, true]) {
    const f = fixture(t),
      lease = await acquireProjectLease(f.file),
      guardPath = `${lease.lockPath}.reclaim`,
      failing = new Set([guardPath, ...(lockToo ? [lease.lockPath] : [])])
    // Fail the moves that retire the guard (and the lock), not the move that publishes the guard.
    t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
      if (failing.delete(from))
        throw Object.assign(new Error(`injected move failure for ${path.basename(from)}`), { code: 'EIO' })
      return move(from, to)
    })
    const error = await lease.release().then(
      () => null,
      (e) => e,
    )
    const guardFailure = `injected move failure for ${path.basename(guardPath)} Both lock locations were preserved for inspection: ${guardPath}; `
    if (lockToo) {
      assert.ok(error.message.startsWith(`injected move failure for ${path.basename(lease.lockPath)} `), error.message)
      assert.ok(error.message.includes(` Guard release failed: ${guardFailure}`), error.message)
      assert.equal(error.lockPath, lease.lockPath)
      assert.equal(fs.existsSync(lease.lockPath), true)
    } else {
      assert.ok(error.message.startsWith(guardFailure), error.message)
      assert.equal(error.lockPath, guardPath)
      assert.equal(fs.existsSync(lease.lockPath), false)
      await lease.release() // already released: nothing more to do
    }
    assert.equal(fs.existsSync(guardPath), true)
    exclusive.renameExclusive.mock.restore()
  }
})

test('concurrent releases share one release, and a failed release can be retried', async (t) => {
  const { acquireProjectLease } = require(modulePath)
  const f = fixture(t),
    lease = await acquireProjectLease(f.file),
    history = path.join(f.folder, '.album-studio-project-lock-history'),
    releases = () => fs.readdirSync(history).filter((name) => name.includes('-released-')).length
  await Promise.all([lease.release(), lease.release()])
  assert.equal(fs.existsSync(lease.lockPath), false)
  assert.equal(releases(), 1)
  await lease.release()
  assert.equal(releases(), 1)

  const g = fixture(t),
    second = await acquireProjectLease(g.file),
    exclusive = require('../lib/exclusive_rename'),
    move = exclusive.renameExclusive
  let failures = 1
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    if (from === second.lockPath && failures-- > 0)
      throw Object.assign(new Error('injected lock move failure'), { code: 'EIO' })
    return move(from, to)
  })
  await assert.rejects(second.release(), /^Error: injected lock move failure|injected lock move failure/)
  assert.equal(fs.existsSync(second.lockPath), true)
  await second.release()
  assert.equal(fs.existsSync(second.lockPath), false)
})

test('a refused acquisition retires its unused owner and names the lock', async (t) => {
  const { acquireProjectLease } = require(modulePath)
  const f = fixture(t),
    held = await acquireProjectLease(f.file)
  const error = await acquireProjectLease(f.file).then(
    () => null,
    (e) => e,
  )
  assert.deepEqual([error.code, error.lockPath], ['PROJECT_BUSY', held.lockPath])
  assert.deepEqual(
    fs.readdirSync(f.folder).filter((name) => name.includes('.candidate-')),
    [],
  )
  const history = fs.readdirSync(path.join(f.folder, '.album-studio-project-lock-history'))
  assert.equal(history.filter((name) => name.includes('-unused-')).length, 1)
  await held.release()
})
