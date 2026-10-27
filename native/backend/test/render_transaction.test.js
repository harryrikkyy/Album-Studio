'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn } = require('child_process')
const modulePath = path.resolve(__dirname, '../lib/render_transaction')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const capabilities = { assertOwned: async () => {}, assertOutput: async () => {} }
function fixture(t, { missing = false, size } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'as-render-transaction-')))
  const albumFile = path.join(root, 'project.json'), outputFolder = path.join(root, 'output'), spreadId = 'spread_fixture'
  const sheet = path.join(outputFolder, '.album-studio', 'sheets', `${spreadId}.psd`)
  const cache = path.join(outputFolder, '.album-studio', 'render-cache.json'), source = path.join(root, 'source.psd')
  const old = size ? crypto.randomBytes(size) : Buffer.from('old customer PSD with manual layer bytes')
  const next = size ? crypto.randomBytes(size) : Buffer.from('next rendered PSD with new full-resolution layers')
  fs.mkdirSync(path.dirname(sheet), { recursive: true })
  fs.writeFileSync(albumFile, '{"marker":"project revision"}\n'); fs.writeFileSync(source, next)
  const cacheData = { version: 2, albumFile, spreads: { untouched: { marker: 'preserve other spreads' } } }
  if (!missing) { fs.writeFileSync(sheet, old); cacheData.spreads[spreadId] = { path: sheet, outputFolder, hash: 'prior-recipe', sheetDigest: sha(old) }; fs.writeFileSync(cache, JSON.stringify(cacheData, null, 3) + '\n') }
  const oldCache = missing ? null : fs.readFileSync(cache)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, albumFile, outputFolder, spreadId, sheet, cache, source, old, next, oldCache, cacheData }
}
async function input(f) {
  const { fingerprintRenderFile } = require(modulePath)
  return { albumFile: f.albumFile, outputFolder: f.outputFolder, spreadId: f.spreadId, source: f.source, sourceDigest: sha(f.next), sheetBefore: await fingerprintRenderFile(f.sheet), cacheBefore: f.oldCache && sha(f.oldCache), expectedProjectRevision: sha(fs.readFileSync(f.albumFile)), cacheNext: { ...f.cacheData, spreads: { ...f.cacheData.spreads, [f.spreadId]: { path: f.sheet, outputFolder: f.outputFolder, hash: 'new-recipe' } } } }
}
function files(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(root, e.name)) : [path.join(root, e.name)])
}
const pending = f => fs.readdirSync(path.dirname(f.cache)).filter(n => /^render-[a-f0-9-]{36}$/.test(n)).map(n => path.join(path.dirname(f.cache), n))

test('commits exact PSD/cache revisions with detached old and next history', async t => {
  const { publishRender, recoverRenders } = require(modulePath), f = fixture(t), p = await input(f)
  const r = await publishRender(p, capabilities)
  assert.equal(r.committed, true); assert.deepEqual(fs.readFileSync(f.sheet), f.next)
  const cached = JSON.parse(fs.readFileSync(f.cache))
  assert.equal(cached.spreads[f.spreadId].sheetDigest, sha(f.next)); assert.equal(cached.spreads[f.spreadId].sheet, r.sheetRecord.stamp)
  assert.equal(sha(fs.readFileSync(f.cache)), r.cacheRevision); assert.deepEqual(cached.spreads.untouched, f.cacheData.spreads.untouched)
  assert.deepEqual(fs.readFileSync(path.join(r.historyPath, 'old-cache.json')), f.oldCache)
  assert.deepEqual(fs.readFileSync(path.join(r.historyPath, 'old-sheet.psd')), f.old)
  fs.writeFileSync(f.sheet, 'later manual public sheet edit'); fs.writeFileSync(f.cache, 'later public cache edit')
  assert.deepEqual(fs.readFileSync(path.join(r.historyPath, 'next-sheet.psd')), f.next)
  assert.deepEqual(fs.readFileSync(path.join(r.historyPath, 'old-cache.json')), f.oldCache)
  assert.deepEqual((await recoverRenders(p, capabilities)).recovered, [])
})

test('first render supports absent sheet and cache without adopting unrelated files', async t => {
  const { publishRender } = require(modulePath), f = fixture(t, { missing: true }), p = await input(f)
  const unrelated = path.join(path.dirname(f.sheet), 'spread_other.psd'); fs.writeFileSync(unrelated, 'customer bytes')
  await publishRender(p, capabilities)
  assert.deepEqual(fs.readFileSync(f.sheet), f.next); assert.equal(fs.readFileSync(unrelated, 'utf8'), 'customer bytes')
})

test('stale cache/project/source revisions and foreign cache ownership preserve all public bytes', async t => {
  const { publishRender } = require(modulePath)
  for (const kind of ['cache', 'project', 'source', 'owner']) {
    const f = fixture(t), p = await input(f)
    if (kind === 'cache') fs.appendFileSync(f.cache, ' ')
    if (kind === 'project') fs.appendFileSync(f.albumFile, ' ')
    if (kind === 'source') fs.writeFileSync(f.source, 'different source')
    if (kind === 'owner') { const other = path.join(f.root, 'other.json'); fs.writeFileSync(other, '{}'); fs.writeFileSync(f.cache, JSON.stringify({ version: 2, albumFile: other, spreads: {} })); p.cacheBefore = sha(fs.readFileSync(f.cache)) }
    const beforeCache = fs.readFileSync(f.cache), beforeSheet = fs.readFileSync(f.sheet)
    await assert.rejects(publishRender(p, capabilities), /revision|changed|another project|source/i)
    assert.deepEqual(fs.readFileSync(f.cache), beforeCache); assert.deepEqual(fs.readFileSync(f.sheet), beforeSheet)
  }
})

test('missing capabilities, output substitutions, symlinks and hard-linked sheets fail closed', async t => {
  const { publishRender } = require(modulePath)
  for (const kind of ['lease', 'output', 'symlink', 'hardlink']) {
    const f = fixture(t), p = await input(f), external = path.join(f.root, 'external.psd'); fs.writeFileSync(external, 'unrelated external original')
    if (kind === 'symlink') { fs.unlinkSync(f.sheet); fs.symlinkSync(external, f.sheet) }
    if (kind === 'hardlink') fs.linkSync(f.sheet, path.join(f.root, 'linked-old.psd'))
    const caps = kind === 'lease' ? {} : kind === 'output' ? { ...capabilities, assertOutput: async () => { throw new Error('output capability changed') } } : capabilities
    await assert.rejects(publishRender(p, caps), /capability|lease|output|regular|independent|link/i)
    assert.deepEqual(fs.readFileSync(f.cache), f.oldCache); assert.equal(fs.readFileSync(external, 'utf8'), 'unrelated external original')
  }
})

test('preserves logical symlink output paths while reserving the physical namespace', async t => {
  const { publishRender } = require(modulePath), f = fixture(t), p = await input(f), alias = path.join(f.root, 'logical-output')
  fs.symlinkSync(f.outputFolder, alias)
  p.outputFolder = alias; p.cacheNext.spreads[f.spreadId].path = path.join(alias, '.album-studio', 'sheets', `${f.spreadId}.psd`); p.cacheNext.spreads[f.spreadId].outputFolder = alias
  const checked = []; const r = await publishRender(p, { ...capabilities, assertOutput: async requested => { checked.push(requested); assert.equal(requested, alias) } })
  const record = JSON.parse(fs.readFileSync(f.cache)).spreads[f.spreadId]
  assert.equal(record.path, p.cacheNext.spreads[f.spreadId].path); assert.equal(record.outputFolder, alias); assert.ok(checked.length > 2); assert.equal(r.sheetRecord.path, record.path)
})

test('manual edits at sheet capture and occupied install names retain exact customer bytes', async t => {
  const { publishRender } = require(modulePath), exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive
  for (const at of ['capture', 'install']) {
    const f = fixture(t), p = await input(f), manual = Buffer.from(`manual ${at} customer sheet`)
    t.mock.method(exclusive, 'renameExclusive', async (from, to) => { if (at === 'capture' && from === f.sheet) fs.writeFileSync(from, manual); if (at === 'install' && to === f.sheet && path.basename(from) === 'install-sheet.psd') fs.writeFileSync(to, manual, { flag: 'wx' }); return rename(from, to) })
    await assert.rejects(publishRender(p, capabilities), /changed|conflict|exist|recovery/i)
    assert.deepEqual(fs.readFileSync(f.sheet), manual); assert.deepEqual(fs.readFileSync(f.cache), f.oldCache)
    assert.ok(files(f.root).some(file => fs.lstatSync(file).isFile() && fs.readFileSync(file).equals(f.old)))
    t.mock.restoreAll()
  }
})

test('ENOSPC before publication and after sheet installation preserves/restores the old pair', async t => {
  const { publishRender } = require(modulePath), exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive
  for (const at of ['prepare', 'cache']) {
    const f = fixture(t), p = await input(f)
    t.mock.method(exclusive, 'renameExclusive', async (from, to) => { if (at === 'prepare' && /^render-[a-f0-9-]{36}$/.test(path.basename(to)) || at === 'cache' && to === f.cache && path.basename(from) === 'install-cache.json') { const e = new Error(`ENOSPC ${at}`); e.code = 'ENOSPC'; throw e } return rename(from, to) })
    await assert.rejects(publishRender(p, capabilities), /ENOSPC|recovery/i)
    assert.deepEqual(fs.readFileSync(f.sheet), f.old); assert.deepEqual(fs.readFileSync(f.cache), f.oldCache)
    t.mock.restoreAll()
  }
})

test('stop before/during publication rolls back but stop after commit keeps the committed pair', async t => {
  const { publishRender } = require(modulePath), exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive
  for (const at of ['before', 'sheet', 'commit']) {
    const f = fixture(t), p = await input(f); let stop = at === 'before'
    t.mock.method(exclusive, 'renameExclusive', async (from, to) => { await rename(from, to); if (at === 'sheet' && to === f.sheet || at === 'commit' && path.basename(to) === 'commit.json') stop = true })
    const promise = publishRender(p, { ...capabilities, isCancelled: () => stop })
    if (at === 'commit') { const r = await promise; assert.equal(r.committed, true); assert.deepEqual(fs.readFileSync(f.sheet), f.next) }
    else { await assert.rejects(promise, /cancelled|stopped/i); assert.deepEqual(fs.readFileSync(f.sheet), f.old); assert.deepEqual(fs.readFileSync(f.cache), f.oldCache) }
    t.mock.restoreAll()
  }
})

const crashScript = `
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const modulePath=process.argv[1],p=JSON.parse(fs.readFileSync(process.argv[2])),at=process.argv[3];
const exclusive=require(path.join(path.dirname(modulePath),'exclusive_rename')),rename=exclusive.renameExclusive;
exclusive.renameExclusive=async(from,to)=>{await rename(from,to);const b=path.basename(to);
const hit=at==='journal'&&/^render-[a-f0-9-]{36}$/.test(b)||at==='sheet-captured'&&b==='captured-sheet'||at==='sheet-installed'&&to===p.cacheNext.spreads[p.spreadId].path||at==='cache-captured'&&b==='captured-cache'||at==='cache-installed'&&to===path.join(p.outputFolder,'.album-studio','render-cache.json')||at==='commit'&&b==='commit.json'||at==='history'&&path.basename(path.dirname(to))==='render-history';
if(hit){process.send({checkpoint:at},()=>process.kill(process.pid,'SIGKILL'));await new Promise(()=>{})}};
require(modulePath).publishRender(p,{assertOwned:async()=>{},assertOutput:async()=>{}}).then(()=>process.exit(3),e=>{process.send({error:e.stack});process.exit(4)});
`
async function killed(f, p, at) {
  const config = path.join(f.root, `input-${at}.json`); fs.writeFileSync(config, JSON.stringify(p))
  const child = spawn(process.execPath, ['-e', crashScript, modulePath, config, at], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env })
  let message, stderr = ''; child.on('message', m => { message = m }); child.stderr.on('data', b => { stderr += b })
  const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Crash checkpoint ${at} not reached: ${JSON.stringify(message)} ${stderr}`)) }, 15000); child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) }); child.on('error', reject) })
  assert.equal(result.signal, 'SIGKILL', JSON.stringify(message) + stderr); assert.equal(message.checkpoint, at)
}
for (const at of ['journal', 'sheet-captured', 'sheet-installed', 'cache-captured', 'cache-installed', 'commit', 'history']) {
  test(`SIGKILL at ${at} recovers the exact pending/committed pair idempotently`, async t => {
    const { recoverRenders } = require(modulePath), f = fixture(t), p = await input(f)
    await killed(f, p, at)
    const r = await recoverRenders(p, capabilities), committed = ['commit', 'history'].includes(at)
    assert.deepEqual(fs.readFileSync(f.sheet), committed ? f.next : f.old)
    if (!committed) assert.deepEqual(fs.readFileSync(f.cache), f.oldCache)
    else assert.equal(JSON.parse(fs.readFileSync(f.cache)).spreads[f.spreadId].sheetDigest, sha(f.next))
    assert.equal(pending(f).length, 0); assert.deepEqual((await recoverRenders(p, capabilities)).recovered, [])
    if (at !== 'history') assert.equal(r.recovered[0].state, committed ? 'committed' : 'restored')
  })
}

test('pending recovery preserves a manual public edit and a malformed/foreign journal', async t => {
  const { recoverRenders } = require(modulePath)
  for (const kind of ['manual', 'journal', 'foreign']) {
    const f = fixture(t), p = await input(f); await killed(f, p, 'cache-installed')
    const stage = pending(f)[0], journal = path.join(stage, 'journal.json'), manual = Buffer.from('manual after interrupted render')
    if (kind === 'manual') fs.writeFileSync(f.sheet, manual)
    if (kind === 'journal') { fs.chmodSync(journal, 0o600); fs.writeFileSync(journal, '{ broken recovery identity'); fs.chmodSync(journal, 0o400) }
    if (kind === 'foreign') { const j = JSON.parse(fs.readFileSync(journal)); j.albumFile = path.join(f.root, 'other-project.json'); fs.chmodSync(journal, 0o600); fs.writeFileSync(journal, JSON.stringify(j)); fs.chmodSync(journal, 0o400) }
    const cacheBytes = fs.readFileSync(f.cache), sheetBytes = fs.readFileSync(f.sheet)
    await assert.rejects(recoverRenders(p, capabilities), /conflict|journal|identity|recovery|changed/i)
    assert.deepEqual(fs.readFileSync(f.cache), cacheBytes); assert.deepEqual(fs.readFileSync(f.sheet), sheetBytes); assert.ok(fs.existsSync(stage))
  }
})

test('committed recovery preserves later manual edits and reports commit cleanup failures', async t => {
  const { recoverRenders } = require(modulePath), f = fixture(t), p = await input(f); await killed(f, p, 'commit')
  fs.writeFileSync(f.sheet, 'manual after durable commit'); fs.writeFileSync(f.cache, 'manual cache after durable commit')
  const r = await recoverRenders(p, capabilities)
  assert.equal(r.recovered[0].state, 'committed'); assert.equal(fs.readFileSync(f.sheet, 'utf8'), 'manual after durable commit'); assert.equal(fs.readFileSync(f.cache, 'utf8'), 'manual cache after durable commit')
})

test('streams large PSDs with a fixed read allocation instead of buffering the file', async t => {
  const { fingerprintRenderFile } = require(modulePath), f = fixture(t), file = path.join(f.root, 'large-sparse.psb')
  const fd = fs.openSync(file, 'wx'); fs.ftruncateSync(fd, 96 * 1024 * 1024); fs.closeSync(fd)
  const alloc = Buffer.alloc, sizes = []; t.mock.method(Buffer, 'alloc', (size, ...args) => { sizes.push(size); assert.ok(size <= 1024 * 1024, 'stream allocation must be fixed'); return alloc(size, ...args) })
  const r = await fingerprintRenderFile(file); assert.equal(r.size, String(96 * 1024 * 1024)); assert.ok(sizes.length)
})

/** Bytes read from sheet-sized files (PSDs and captured/discarded sheets) while `run` executes. */
async function sheetBytesRead(t, run) {
  const open = fs.promises.open, owners = new WeakMap(), probe = await open(__filename), proto = Object.getPrototypeOf(probe)
  await probe.close()
  const read = proto.read; let bytes = 0
  t.mock.method(fs.promises, 'open', async (file, ...args) => { const handle = await open(file, ...args); owners.set(handle, String(file)); return handle })
  t.mock.method(proto, 'read', async function (...args) { const result = await read.apply(this, args); if (/\.psd$|-sheet$/.test(owners.get(this) || '')) bytes += result.bytesRead; return result })
  try { await run() } finally { t.mock.restoreAll() }
  return bytes
}

test('publication hashes each retained sheet once instead of at every journal check', async t => {
  const { publishRender } = require(modulePath), size = 1024 * 1024
  // Reads per sheet byte, one pass each because every read is checked against a known digest: the
  // previous sheet and source gates, each detached copy's source and copy, the captured original and
  // the public pair just before commit. Journal checks between steps compare identities, not bytes.
  for (const [missing, budget] of [[true, 6], [false, 10]]) {
    const f = fixture(t, { missing, size }), p = await input(f)
    const reads = await sheetBytesRead(t, () => publishRender(p, capabilities)) / size
    assert.ok(reads <= budget, `${missing ? 'a first' : 'a repeated'} render read its sheets ${reads} times; the budget is ${budget}`)
    assert.deepEqual(fs.readFileSync(f.sheet), f.next)
  }
})

test('a retained snapshot rewritten in place during publication is hashed again and blocks the commit', async t => {
  const { publishRender } = require(modulePath), exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive, f = fixture(t), p = await input(f)
  let edited
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    await rename(from, to)
    if (edited || to !== f.sheet || path.basename(from) !== 'install-sheet.psd') return
    edited = path.join(path.dirname(from), 'old-sheet.psd') // Same size and mode, different bytes.
    const bytes = fs.readFileSync(edited); bytes[0] ^= 0xff
    fs.chmodSync(edited, 0o600); fs.writeFileSync(edited, bytes); fs.chmodSync(edited, 0o400)
  })
  const error = await publishRender(p, capabilities).then(() => null, e => e)
  assert.ok(edited); assert.ok(error); assert.ok(!error.renderCommitted); assert.match(error.message, /retained render old-sheet/)
  assert.ok(files(path.dirname(f.cache)).every(file => path.basename(file) !== 'commit.json'))
  assert.ok(files(f.root).some(file => fs.readFileSync(file).equals(f.old)), 'the captured original keeps the previous sheet')
})

test('a sheet replaced after its revision gate stays published instead of being captured', async t => {
  const { publishRender } = require(modulePath), exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive, f = fixture(t), p = await input(f)
  const replacement = Buffer.from('sheet saved by another editor'), saved = path.join(path.dirname(f.sheet), 'saved-by-editor.psd')
  let node
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    await rename(from, to)
    if (!node && /^render-[a-f0-9-]{36}$/.test(path.basename(to))) { fs.writeFileSync(saved, replacement); fs.renameSync(saved, f.sheet); node = fs.statSync(f.sheet).ino }
  })
  const error = await publishRender(p, capabilities).then(() => null, e => e)
  assert.ok(node); assert.ok(error); assert.ok(!error.renderCommitted); assert.match(error.message, /existing sheet/)
  assert.equal(fs.statSync(f.sheet).ino, node); assert.deepEqual(fs.readFileSync(f.sheet), replacement); assert.deepEqual(fs.readFileSync(f.cache), f.oldCache)
})

test('a same-stamp in-place ABA yields mismatched full passes rather than a hybrid accepted digest', async t => {
  const { fingerprintRenderFile } = require(modulePath), f = fixture(t), file = path.join(f.root, 'coarse-time.psb')
  const chunk = 1024 * 1024, original = Buffer.alloc(3 * chunk, 0x41), mutation = Buffer.alloc(chunk, 0x42)
  fs.writeFileSync(file, original)
  const baseline = fs.lstatSync(file, { bigint: true }), open = fs.promises.open, lstat = fs.promises.lstat
  t.mock.method(fs.promises, 'lstat', async (target, ...args) => target === file ? baseline : lstat(target, ...args))
  t.mock.method(fs.promises, 'open', async (target, ...args) => {
    const handle = await open(target, ...args)
    if (target !== file) return handle
    const read = handle.read.bind(handle); let first = true
    handle.stat = async () => baseline // Explicit coarse-time/identity oracle, not dependent on APFS timestamps.
    handle.read = async (buffer, offset, length, position) => {
      if (first && position === chunk) { const fd = fs.openSync(file, 'r+'); fs.writeSync(fd, mutation, 0, chunk, chunk); fs.closeSync(fd) }
      const result = await read(buffer, offset, length, position)
      if (first && position === 2 * chunk) { const fd = fs.openSync(file, 'r+'); fs.writeSync(fd, original, chunk, chunk, chunk); fs.closeSync(fd) }
      if (position === original.length) first = false
      return result
    }
    return handle
  })
  await assert.rejects(fingerprintRenderFile(file), /content|changed/i)
  assert.deepEqual(fs.readFileSync(file), original)
})

test('true partial-write and precommit fsync ENOSPC leave a recoverable old pair', async t => {
  const { publishRender, recoverRenders } = require(modulePath), open = fs.promises.open
  for (const at of ['snapshot-write', 'commit-flush']) {
    const f = fixture(t), p = await input(f); let injected = false
    t.mock.method(fs.promises, 'open', async (target, ...args) => {
      const handle = await open(target, ...args)
      if (!injected && at === 'snapshot-write' && path.basename(target) === 'next-sheet.psd') {
        const write = handle.write.bind(handle)
        handle.write = async (...call) => { injected = true; await write(call[0], call[1], 1, call[3]); throw Object.assign(new Error('ENOSPC partial snapshot write'), { code: 'ENOSPC' }) }
      }
      if (!injected && at === 'commit-flush' && path.basename(target) === 'commit.part.json' && fs.existsSync(f.sheet) && sha(fs.readFileSync(f.sheet)) === sha(f.next)) handle.sync = async () => { injected = true; throw Object.assign(new Error('ENOSPC commit flush'), { code: 'ENOSPC' }) }
      return handle
    })
    await assert.rejects(publishRender(p, capabilities), error => error.code === 'ENOSPC' && !error.renderCommitted && /recovery evidence/.test(error.message))
    assert.ok(injected); assert.deepEqual(fs.readFileSync(f.sheet), f.old); assert.deepEqual(fs.readFileSync(f.cache), f.oldCache)
    t.mock.restoreAll(); const recovered = await recoverRenders(p, capabilities)
    if (at === 'snapshot-write') assert.equal(recovered.orphanStages.length, 1)
  }
})

test('a stop during commit fsync is honoured before the durable marker rename', async t => {
  const { publishRender } = require(modulePath), f = fixture(t), p = await input(f), open = fs.promises.open; let stop = false
  t.mock.method(fs.promises, 'open', async (target, ...args) => {
    const handle = await open(target, ...args)
    if (path.basename(target) === 'commit.part.json' && fs.existsSync(f.sheet) && sha(fs.readFileSync(f.sheet)) === sha(f.next)) { const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); stop = true } }
    return handle
  })
  await assert.rejects(publishRender(p, { ...capabilities, isCancelled: () => stop }), error => error.code === 'RENDER_CANCELLED' && !error.renderCommitted)
  assert.deepEqual(fs.readFileSync(f.sheet), f.old); assert.deepEqual(fs.readFileSync(f.cache), f.oldCache)
})

test('source validator failure after sheet installation restores the old sheet/cache', async t => {
  const { publishRender } = require(modulePath), f = fixture(t), p = await input(f), exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive
  let invalid = false
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => { await rename(from, to); if (to === f.sheet) invalid = true })
  await assert.rejects(publishRender(p, { ...capabilities, validateSnapshot: async () => { if (invalid) throw new Error('original source changed after rendering') } }), /original source changed/i)
  assert.deepEqual(fs.readFileSync(f.sheet), f.old); assert.deepEqual(fs.readFileSync(f.cache), f.oldCache)
})

test('cleanup errors before/after history movement keep committed metadata and exact evidence paths', async t => {
  const { publishRender, recoverRenders } = require(modulePath), exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive, open = fs.promises.open
  for (const at of ['before-history', 'after-history']) {
    const f = fixture(t), p = await input(f); let retained, moved = false
    t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
      if (path.basename(path.dirname(to)) === 'render-history') {
        retained = at === 'before-history' ? from : to
        if (at === 'before-history') throw Object.assign(new Error('ENOSPC history move'), { code: 'ENOSPC' })
        await rename(from, to); moved = true; return
      }
      return rename(from, to)
    })
    if (at === 'after-history') t.mock.method(fs.promises, 'open', async (target, ...args) => { const handle = await open(target, ...args); if (moved && path.basename(target) === 'render-history') handle.sync = async () => { throw Object.assign(new Error('ENOSPC history directory flush'), { code: 'ENOSPC' }) }; return handle })
    const error = await publishRender(p, capabilities).then(() => null, e => e)
    assert.ok(error); assert.equal(error.renderCommitted, true); assert.equal(error.committed, true)
    assert.equal(error.recoveryStage, retained); assert.equal(error.recoveryJournal, path.join(retained, 'journal.json')); assert.ok(fs.existsSync(error.recoveryJournal))
    assert.equal(error.cacheRevision, sha(fs.readFileSync(f.cache))); assert.deepEqual(error.cacheData, JSON.parse(fs.readFileSync(f.cache))); assert.equal(error.sheetRecord.digest, sha(f.next))
    assert.deepEqual(fs.readFileSync(f.sheet), f.next); assert.deepEqual(fs.readFileSync(path.join(retained, 'old-sheet.psd')), f.old)
    t.mock.restoreAll(); await recoverRenders(p, capabilities)
    assert.deepEqual(fs.readFileSync(f.sheet), f.next)
  }
})

test('a helper error after a completed exact move is reconciled without duplicate publication', async t => {
  const { publishRender } = require(modulePath), exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive, f = fixture(t), p = await input(f)
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => { await rename(from, to); throw Object.assign(new Error('helper timed out after syscall'), { code: 'ETIMEDOUT' }) })
  const r = await publishRender(p, capabilities); assert.equal(r.committed, true); assert.deepEqual(fs.readFileSync(f.sheet), f.next); assert.equal(pending(f).length, 0)
})

const recoveryCrash = `
const fs=require('fs'),path=require('path');const mod=process.argv[1],p=JSON.parse(fs.readFileSync(process.argv[2])),at=process.argv[3];
const exclusive=require(path.join(path.dirname(mod),'exclusive_rename')),rename=exclusive.renameExclusive;
exclusive.renameExclusive=async(from,to)=>{await rename(from,to);const b=path.basename(to);
const hit=at==='cache-discard'&&b==='discard-cache'||at==='sheet-discard'&&b==='discard-sheet'||at==='cache-restored'&&b==='render-cache.json'||at==='sheet-restored'&&b===p.spreadId+'.psd';
if(hit){process.send({checkpoint:at},()=>process.kill(process.pid,'SIGKILL'));await new Promise(()=>{})}};
require(mod).recoverRenders(p,{assertOwned:async()=>{},assertOutput:async()=>{}}).then(()=>process.exit(3),e=>{process.send({error:e.stack});process.exit(4)});
`
for (const at of ['cache-discard', 'cache-restored', 'sheet-discard', 'sheet-restored']) {
  test(`SIGKILL during recovery at ${at} can be recovered again without losing either prior revision`, async t => {
    const { recoverRenders } = require(modulePath), f = fixture(t), p = await input(f); await killed(f, p, 'cache-installed')
    const config = path.join(f.root, 'recovery-input.json'); fs.writeFileSync(config, JSON.stringify(p))
    const child = spawn(process.execPath, ['-e', recoveryCrash, modulePath, config, at], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let message, stderr = ''; child.on('message', m => { message = m }); child.stderr.on('data', b => { stderr += b })
    const result = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Recovery checkpoint not reached: ${JSON.stringify(message)} ${stderr}`)) }, 15000); child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) }); child.on('error', reject) })
    assert.equal(result.signal, 'SIGKILL', JSON.stringify(message) + stderr); assert.equal(message.checkpoint, at)
    await recoverRenders(p, capabilities); assert.deepEqual(fs.readFileSync(f.sheet), f.old); assert.deepEqual(fs.readFileSync(f.cache), f.oldCache)
    assert.deepEqual((await recoverRenders(p, capabilities)).recovered, [])
  })
}

test('writable/edited detached snapshots and oversized cache inputs fail before changing public files', async t => {
  const { publishRender, recoverRenders } = require(modulePath)
  for (const kind of ['writable', 'edited', 'oversize']) {
    const f = fixture(t), p = await input(f)
    if (kind === 'oversize') {
      const fd = fs.openSync(f.cache, 'r+'); fs.ftruncateSync(fd, 64 * 1024 * 1024 + 1); fs.closeSync(fd)
      const size = fs.statSync(f.cache).size
      await assert.rejects(publishRender(p, capabilities), /policy|regular/i); assert.equal(fs.statSync(f.cache).size, size); assert.deepEqual(fs.readFileSync(f.sheet), f.old)
      continue
    }
    await killed(f, p, 'cache-installed')
    const snapshot = path.join(pending(f)[0], 'old-sheet.psd'); fs.chmodSync(snapshot, 0o600)
    if (kind === 'edited') { fs.writeFileSync(snapshot, 'modified detached recovery snapshot'); fs.chmodSync(snapshot, 0o400) }
    const sheetBytes = fs.readFileSync(f.sheet), cacheBytes = fs.readFileSync(f.cache)
    await assert.rejects(recoverRenders(p, capabilities), /changed|permissions|immutable/i)
    assert.deepEqual(fs.readFileSync(f.sheet), sheetBytes); assert.deepEqual(fs.readFileSync(f.cache), cacheBytes)
  }
})

function mutateJournal(file) {
  const value = JSON.parse(fs.readFileSync(file)); value.projectRevision = '0'.repeat(64)
  fs.chmodSync(file, 0o600); fs.writeFileSync(file, JSON.stringify(value)); fs.chmodSync(file, 0o400)
}
for (const at of ['before-exposure', 'sheet-installed', 'commit-flush']) test(`an exact journal revision change at ${at} cannot become a valid commit`, async t => {
  const { publishRender } = require(modulePath), f = fixture(t), p = await input(f), exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive, open = fs.promises.open
  let injected = false
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    if (at === 'before-exposure' && /^render-[a-f0-9-]{36}$/.test(path.basename(to))) { injected = true; mutateJournal(path.join(from, 'journal.json')) }
    await rename(from, to)
    if (at === 'sheet-installed' && to === f.sheet && !injected) { injected = true; mutateJournal(path.join(path.dirname(from), 'journal.json')) }
  })
  if (at === 'commit-flush') t.mock.method(fs.promises, 'open', async (file, ...args) => {
    const handle = await open(file, ...args)
    if (path.basename(file) === 'commit.part.json' && fs.existsSync(f.sheet) && sha(fs.readFileSync(f.sheet)) === sha(f.next)) {
      const sync = handle.sync.bind(handle); handle.sync = async () => { await sync(); if (!injected) { injected = true; mutateJournal(path.join(path.dirname(file), 'journal.json')) } }
    }
    return handle
  })
  const error = await publishRender(p, capabilities).then(() => null, e => e)
  assert.ok(injected); assert.ok(error, 'a schema-valid journal edit must be rejected, even when all source files remain valid')
  assert.ok(!error.renderCommitted); assert.match(error.message, /journal.*revision|journal.*changed/i)
  assert.deepEqual(fs.readFileSync(f.sheet), f.old); assert.deepEqual(fs.readFileSync(f.cache), f.oldCache)
  assert.ok(fs.existsSync(error.recoveryStage)); assert.ok(fs.existsSync(error.recoveryJournal))
  assert.ok(files(path.dirname(f.cache)).every(file => path.basename(file) !== 'commit.json'), 'no committed marker may authorize the mutated journal')
})

for (const kind of ['wrong-json', 'same-bytes-new-inode', 'writable', 'symlink']) test(`a ${kind} commit-part substitution fails before the marker can commit`, async t => {
  const { publishRender } = require(modulePath), f = fixture(t), p = await input(f), open = fs.promises.open; let injected = false
  const displaced = path.join(f.root, 'displaced-commit-part.json')
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    const handle = await open(file, ...args)
    if (path.basename(file) === 'commit.part.json' && fs.existsSync(f.sheet) && sha(fs.readFileSync(f.sheet)) === sha(f.next)) {
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        await sync(); if (injected) return; injected = true
        const bytes = fs.readFileSync(file)
        if (kind === 'wrong-json') { fs.chmodSync(file, 0o600); fs.writeFileSync(file, JSON.stringify({ version: 1, journal: '0'.repeat(64) })); fs.chmodSync(file, 0o400) }
        if (kind === 'same-bytes-new-inode') { fs.renameSync(file, displaced); fs.writeFileSync(file, bytes, { mode: 0o400, flag: 'wx' }) }
        if (kind === 'writable') fs.chmodSync(file, 0o600)
        if (kind === 'symlink') { fs.renameSync(file, displaced); fs.symlinkSync(displaced, file) }
      }
    }
    return handle
  })
  const error = await publishRender(p, capabilities).then(() => null, e => e)
  assert.ok(injected); assert.ok(error); assert.ok(!error.renderCommitted, 'an unverified marker cannot classify the sheet/cache as committed')
  assert.ok(files(path.dirname(f.cache)).every(file => path.basename(file) !== 'commit.json'))
  if (kind !== 'symlink') { assert.deepEqual(fs.readFileSync(f.sheet), f.old); assert.deepEqual(fs.readFileSync(f.cache), f.oldCache) }
  else { assert.equal(fs.existsSync(displaced), true); assert.ok(fs.existsSync(error.recoveryStage), 'a nonregular unknown entry is retained for explicit review') }
})

test('a pending rollback failure reports existing detached history after successful restoration', async t => {
  const { publishRender } = require(modulePath), f = fixture(t), p = await input(f), exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => { if (to === f.cache && path.basename(from) === 'install-cache.json') throw Object.assign(new Error('ENOSPC pending cache install'), { code: 'ENOSPC' }); return rename(from, to) })
  const error = await publishRender(p, capabilities).then(() => null, e => e)
  assert.equal(error.code, 'ENOSPC'); assert.ok(!error.renderCommitted); assert.ok(fs.existsSync(error.recoveryStage)); assert.ok(fs.existsSync(error.recoveryJournal))
  assert.equal(path.basename(path.dirname(error.recoveryStage)), 'render-history')
  assert.deepEqual(fs.readFileSync(f.sheet), f.old); assert.deepEqual(fs.readFileSync(f.cache), f.oldCache)
})

test('a substituted identical-byte committed marker cannot gain restart authority', async t => {
  const { recoverRenders } = require(modulePath), f = fixture(t), p = await input(f); await killed(f, p, 'commit')
  const stage = pending(f)[0], marker = path.join(stage, 'commit.json'), bytes = fs.readFileSync(marker)
  const originalMarker = path.join(f.root, 'displaced-legitimate-marker.json'); fs.renameSync(marker, originalMarker); fs.writeFileSync(marker, bytes, { mode: 0o400, flag: 'wx' })
  const sheet = fs.readFileSync(f.sheet), cache = fs.readFileSync(f.cache)
  await assert.rejects(recoverRenders(p, capabilities), /commit identity|changed/i)
  assert.deepEqual(fs.readFileSync(f.sheet), sheet); assert.deepEqual(fs.readFileSync(f.cache), cache); assert.deepEqual(fs.readFileSync(originalMarker), bytes)
})

test('the additive commit-node field keeps older version-one committed journals recoverable', async t => {
  const { recoverRenders } = require(modulePath), f = fixture(t), p = await input(f); await killed(f, p, 'commit')
  const stage = pending(f)[0], file = path.join(stage, 'journal.json'), marker = path.join(stage, 'commit.json'), journal = JSON.parse(fs.readFileSync(file))
  delete journal.commitNode
  const bytes = Buffer.from(JSON.stringify(journal)); fs.chmodSync(file, 0o600); fs.writeFileSync(file, bytes); fs.chmodSync(file, 0o400)
  fs.chmodSync(marker, 0o600); fs.writeFileSync(marker, JSON.stringify({ version: 1, journal: sha(bytes) })); fs.chmodSync(marker, 0o400)
  const r = await recoverRenders(p, capabilities)
  assert.equal(r.recovered[0].state, 'committed'); assert.deepEqual(fs.readFileSync(f.sheet), f.next); assert.equal(pending(f).length, 0)
})

test('a stopped job whose rollback meets a manual edit reports recovery required instead of claiming restoration', async t => {
  const { publishRender } = require(modulePath), f = fixture(t), p = await input(f), exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive
  const manual = Buffer.from('manual sheet after cancellation'); let stop = false, edited = false
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => { await rename(from, to); if (!stop && to === f.sheet && path.basename(from) === 'install-sheet.psd') stop = true })
  const error = await publishRender(p, { ...capabilities, isCancelled: () => { if (stop && !edited) { edited = true; fs.writeFileSync(f.sheet, manual) } return stop } }).then(() => null, e => e)
  assert.equal(error.code, 'RENDER_CANCELLED'); assert.equal(error.recoveryRequired, true); assert.ok(!error.renderRestored); assert.ok(!error.renderCommitted)
  assert.match(error.message, /rollback conflict/i); assert.doesNotMatch(error.message, /previous sheet and cache were restored/i)
  assert.deepEqual(fs.readFileSync(f.sheet), manual); assert.deepEqual(fs.readFileSync(f.cache), f.oldCache); assert.ok(fs.existsSync(error.recoveryJournal))
})
