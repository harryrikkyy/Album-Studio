'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')
const { tmpdir } = require('./fixtures')
const { createPrivateStage, withPrivateStage, privateStageUsage } = require('../lib/private_stage')
const { fileDigest } = require('../lib/cache')
const exclusive = require('../lib/exclusive_rename')
const fixture = (t) => {
  const root = tmpdir()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('unchanged read-only snapshots are independently retained with metrics', async (t) => {
  const root = fixture(t),
    file = path.join(root, 'original.jpg')
  fs.writeFileSync(file, 'source bytes')
  const stage = await createPrivateStage(root),
    frozen = await stage.snapshot(file, await fileDigest(file)),
    frozenInode = fs.statSync(frozen).ino
  const result = await stage.cleanup()
  assert.equal(result.reason, null)
  assert.equal(result.bytes, 12)
  assert.equal(fs.existsSync(stage.path), false)
  const saved = path.join(result.retainedPath, path.basename(frozen))
  assert.equal(fs.statSync(saved).ino, frozenInode)
  assert.notEqual(fs.statSync(saved).ino, fs.statSync(file).ino)
  assert.equal(fs.statSync(saved).mode & 0o222, 0)
  assert.equal((await privateStageUsage(root)).bytes, 12)
})
test('empty cleanup cannot remove files appearing at the rmdir boundary', async (t) => {
  const root = fixture(t),
    stage = await createPrivateStage(root),
    rmdir = fs.promises.rmdir.bind(fs.promises)
  t.mock.method(fs.promises, 'rmdir', async (folder) => {
    if (folder === stage.path) fs.writeFileSync(path.join(folder, 'customer.txt'), 'racing manual bytes')
    return rmdir(folder)
  })
  const error = await stage.cleanup().then(
    () => null,
    (e) => e,
  )
  assert.equal(error.code, 'PRIVATE_STAGE_PRESERVED')
  assert.equal(fs.readFileSync(path.join(error.retainedPath, 'customer.txt'), 'utf8'), 'racing manual bytes')
})
test('unknown files arriving at atomic capture survive the complete directory move', async (t) => {
  const root = fixture(t),
    stage = await createPrivateStage(root),
    file = path.join(stage.path, 'known.jpg')
  fs.writeFileSync(file, 'known')
  await stage.register(file)
  const move = exclusive.renameExclusive
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    if (from === stage.path) fs.writeFileSync(path.join(from, 'customer.txt'), 'late manual bytes')
    return move(from, to)
  })
  const error = await stage.cleanup().then(
    () => null,
    (e) => e,
  )
  assert.equal(error.code, 'PRIVATE_STAGE_PRESERVED')
  assert.equal(fs.readFileSync(path.join(error.retainedPath, 'customer.txt'), 'utf8'), 'late manual bytes')
})
test('a colliding history destination is never replaced or removed', async (t) => {
  const root = fixture(t),
    stage = await createPrivateStage(root),
    file = path.join(stage.path, 'known.jpg')
  fs.writeFileSync(file, 'known')
  await stage.register(file)
  t.mock.method(crypto, 'randomUUID', () => 'fixed-collision')
  const history = path.join(root, '.album-studio-stage-history'),
    collision = path.join(history, 'fixed-collision')
  fs.mkdirSync(collision, { recursive: true })
  fs.writeFileSync(path.join(collision, 'customer.txt'), 'existing history')
  await assert.rejects(stage.cleanup(), /retention failed|preserv/i)
  assert.equal(fs.readFileSync(path.join(collision, 'customer.txt'), 'utf8'), 'existing history')
  assert.equal(fs.readFileSync(file, 'utf8'), 'known')
})
test('an uncertain completed native move is reconciled without a second mutation', async (t) => {
  const root = fixture(t),
    stage = await createPrivateStage(root),
    file = path.join(stage.path, 'known.jpg')
  fs.writeFileSync(file, 'known')
  await stage.register(file)
  const move = exclusive.renameExclusive
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    await move(from, to)
    throw new Error('helper timeout after successful syscall')
  })
  const result = await stage.cleanup()
  assert.equal(result.reason, null)
  assert.equal(fs.readFileSync(path.join(result.retainedPath, 'known.jpg'), 'utf8'), 'known')
})
test('a completed capture followed by a new source name reports both retained paths', async (t) => {
  const root = fixture(t),
    stage = await createPrivateStage(root),
    file = path.join(stage.path, 'known.jpg')
  fs.writeFileSync(file, 'known')
  await stage.register(file)
  const move = exclusive.renameExclusive
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    await move(from, to)
    fs.mkdirSync(from)
    fs.writeFileSync(path.join(from, 'customer.txt'), 'new source owner')
    throw new Error('ambiguous helper completion')
  })
  const error = await stage.cleanup().then(
    () => null,
    (e) => e,
  )
  assert.equal(error.retainedPaths.length, 2)
  assert.equal(fs.readFileSync(path.join(stage.path, 'customer.txt'), 'utf8'), 'new source owner')
  assert.equal(fs.readFileSync(path.join(error.retainedPath, 'known.jpg'), 'utf8'), 'known')
})
test('a substituted stage is preserved without following its customer symlink', async (t) => {
  const root = fixture(t),
    stage = await createPrivateStage(root),
    saved = path.join(root, 'displaced'),
    outside = path.join(root, 'customer')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'original'), 'customer bytes')
  fs.renameSync(stage.path, saved)
  fs.symlinkSync(outside, stage.path)
  await assert.rejects(stage.cleanup(), /uncertain|aliased|preserv/i)
  assert.equal(fs.readFileSync(path.join(outside, 'original'), 'utf8'), 'customer bytes')
  assert.equal(fs.lstatSync(stage.path).isSymbolicLink(), true)
  assert.equal(fs.existsSync(saved), true)
})
test('history and free-space caps refuse before creating another stage or source copy', async (t) => {
  const root = fixture(t),
    stage = await createPrivateStage(root),
    file = path.join(stage.path, 'known.jpg')
  fs.writeFileSync(file, 'known')
  await stage.register(file)
  const retained = await stage.cleanup()
  await assert.rejects(
    createPrivateStage(root, '.source-', { maxHistoryBytes: 4 }),
    (error) => error.code === 'PRIVATE_STAGE_BUDGET',
  )
  await assert.rejects(
    createPrivateStage(root, '.source-', { maxHistoryStages: 1 }),
    (error) => error.code === 'PRIVATE_STAGE_BUDGET',
  )
  const original = fs.promises.statfs.bind(fs.promises)
  t.mock.method(fs.promises, 'statfs', async (...args) => ({ ...(await original(...args)), bavail: 1n, bsize: 1n }))
  await assert.rejects(createPrivateStage(root), (error) => error.code === 'PRIVATE_STAGE_BUDGET')
  assert.equal(fs.readFileSync(path.join(retained.retainedPath, 'known.jpg'), 'utf8'), 'known')
})
test('retention caps apply through aliases in a separate real process', async (t) => {
  const root = fixture(t),
    alias = path.join(root, 'alias'),
    parent = path.join(root, 'cache')
  fs.mkdirSync(parent)
  fs.symlinkSync(parent, alias)
  const stage = await createPrivateStage(parent),
    file = path.join(stage.path, 'known.jpg')
  fs.writeFileSync(file, 'known')
  await stage.register(file)
  await stage.cleanup()
  const script = `require(${JSON.stringify(require.resolve('../lib/private_stage'))}).createPrivateStage(process.argv[1], '.source-', {maxHistoryStages:1}).then(()=>process.exit(2),e=>{process.stdout.write(e.code);process.exit(e.code==='PRIVATE_STAGE_BUDGET'?0:3)})`
  const child = spawnSync(process.execPath, ['-e', script, alias], { encoding: 'utf8', timeout: 10000 })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout, 'PRIVATE_STAGE_BUDGET')
  const metrics = await privateStageUsage(alias)
  assert.equal(metrics.historyPath, path.join(parent, '.album-studio-stage-history'))
  assert.equal(metrics.stages, 1)
})
test('primary decoder errors retain their identity and recovery evidence', async (t) => {
  const root = fixture(t),
    primary = Object.assign(new Error('decoder failed'), { code: 'DECODER_FAILED' })
  const error = await withPrivateStage(root, '.source-', async (stage) => {
    fs.writeFileSync(path.join(stage.path, 'partial.jpg'), 'partial decoder bytes')
    throw primary
  }).then(
    () => null,
    (e) => e,
  )
  assert.equal(error, primary)
  assert.equal(error.code, 'DECODER_FAILED')
  assert.equal(error.cleanupError.code, 'PRIVATE_STAGE_PRESERVED')
  assert.equal(fs.readFileSync(path.join(error.retainedPath, 'partial.jpg'), 'utf8'), 'partial decoder bytes')
})
test('nested retirement reports the final existing location after its parent stage moves', async (t) => {
  const root = fixture(t)
  const error = await withPrivateStage(root, '.outer-', async (outer) =>
    withPrivateStage(outer.path, '.inner-', async (inner) => {
      fs.writeFileSync(path.join(inner.path, 'customer.txt'), 'nested customer bytes')
      throw new Error('nested decoder failed')
    }),
  ).then(
    () => null,
    (e) => e,
  )
  assert.ok(error.retainedPath)
  assert.equal(fs.existsSync(error.retainedPath), true)
  assert.ok(
    error.retainedPaths.every((file) => fs.existsSync(file)),
    'every reported recovery path must track its final location',
  )
  const nested = error.retainedPaths.find((file) => fs.existsSync(path.join(file, 'customer.txt')))
  assert.ok(nested)
  assert.equal(fs.readFileSync(path.join(nested, 'customer.txt'), 'utf8'), 'nested customer bytes')
})
test('transfer refuses an owned output edited after registration', async (t) => {
  const root = fixture(t),
    stage = await createPrivateStage(root),
    file = path.join(stage.path, 'prepared.jpg')
  fs.writeFileSync(file, 'generated bytes')
  await stage.register(file)
  fs.writeFileSync(file, 'manual replacement')
  await assert.rejects(stage.transfer(), (error) => error.code === 'PRIVATE_STAGE_PRESERVED')
  const error = await stage.cleanup().then(
    () => null,
    (e) => e,
  )
  assert.equal(fs.readFileSync(path.join(error.retainedPath, 'prepared.jpg'), 'utf8'), 'manual replacement')
})

test('a captured file that cannot be read at retention is kept, with that reason', async (t) => {
  const root = fixture(t),
    stage = await createPrivateStage(root),
    file = path.join(stage.path, 'output.jpg')
  fs.writeFileSync(file, 'generated bytes')
  await stage.register(file)
  const move = exclusive.renameExclusive,
    open = fs.promises.open
  let retained
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    await move(from, to)
    retained = to
  })
  // Once the stage has moved into history, its file can't be opened again.
  t.mock.method(fs.promises, 'open', async function (target, ...rest) {
    if (retained && String(target).startsWith(retained + path.sep))
      throw Object.assign(new Error(`EACCES: permission denied, open '${target}'`), { code: 'EACCES' })
    return open.call(this, target, ...rest)
  })
  const error = await stage.cleanup().then(
    () => null,
    (e) => e,
  )
  const reason = 'A captured private file became unreadable or changed.'
  assert.equal(
    error.message,
    `${reason} Private work was preserved at ${retained}. Inspect it before retrying; no history was pruned.`,
  )
  assert.deepEqual([error.code, error.retainedPath], ['PRIVATE_STAGE_PRESERVED', retained])
  assert.deepEqual(error.retirement, { retainedPath: retained, bytes: 15, reason })
  assert.equal(fs.readFileSync(path.join(retained, 'output.jpg'), 'utf8'), 'generated bytes')
  assert.equal(fs.existsSync(stage.path), false)
})

test('a retained stage whose size cannot be measured reports no size, with that reason', async (t) => {
  const root = fixture(t),
    stage = await createPrivateStage(root),
    file = path.join(stage.path, 'output.jpg')
  fs.writeFileSync(file, 'generated bytes')
  await stage.register(file)
  const move = exclusive.renameExclusive,
    opendir = fs.promises.opendir
  let retained,
    listings = 0
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    await move(from, to)
    retained = to
  })
  // The retained stage is listed once for its names, then again to measure it: fail the second.
  t.mock.method(fs.promises, 'opendir', async function (target, ...rest) {
    if (retained && target === retained && ++listings === 2)
      throw Object.assign(new Error(`EACCES: permission denied, opendir '${target}'`), { code: 'EACCES' })
    return opendir.call(this, target, ...rest)
  })
  const error = await stage.cleanup().then(
    () => null,
    (e) => e,
  )
  const reason = 'Private work size could not be verified.'
  assert.equal(
    error.message,
    `${reason} Private work was preserved at ${retained}. Inspect it before retrying; no history was pruned.`,
  )
  assert.deepEqual(error.retirement, { retainedPath: retained, bytes: null, reason })
  assert.equal(listings, 2)
})
