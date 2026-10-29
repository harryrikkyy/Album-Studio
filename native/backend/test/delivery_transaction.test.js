'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { tmpdir } = require('./fixtures')
const { fileStamp } = require('../lib/cache')
const exclusiveRename = require('../lib/exclusive_rename')
const { publishDelivery, recoverDeliveries, verifyOwnedArtifact } = require('../lib/delivery_transaction')
const runFile = promisify(execFile)

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

async function fixture(t, { existing = true, strong = true } = {}) {
  const root = fs.realpathSync(tmpdir())
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sheets = path.join(root, 'exports'),
    metadata = path.join(sheets, '.album-studio')
  const paths = {
    sheets,
    high: path.join(root, 'JPEG-High-Res'),
    low: path.join(root, 'JPEG-Low-Res'),
    pdf: path.join(root, 'Example - Low Res.pdf'),
    cache: path.join(metadata, 'export-cache.json'),
  }
  for (const folder of [metadata, paths.high, paths.low]) fs.mkdirSync(folder, { recursive: true })
  const stage = fs.mkdtempSync(path.join(metadata, 'delivery-')),
    albumFile = path.join(root, 'project.json')
  const targets = [path.join(paths.high, 'Page_001.jpg'), path.join(paths.low, 'Page_001.jpg'), paths.pdf]
  const files = targets.map((target, i) => ({ target, source: path.join(stage, `prepared-${i}`) }))
  const cache = { version: 2, albumFile, spreads: {}, ownedFiles: {}, ...(strong ? { ownedDigests: {} } : {}) }
  for (const [i, file] of files.entries()) {
    fs.writeFileSync(file.source, `next delivery ${i}`)
    fs.utimesSync(file.source, 1700000000, 1700000000)
    if (existing) {
      fs.writeFileSync(file.target, `previous delivery ${i}`)
      fs.utimesSync(file.target, 1600000000, 1600000000)
      cache.ownedFiles[file.target] = await fileStamp(file.target)
      if (strong) cache.ownedDigests[file.target] = digest(file.target)
    }
  }
  if (existing) {
    cache.spreads.first = {
      n: 1,
      high: { path: targets[0], stamp: cache.ownedFiles[targets[0]] },
      low: { path: targets[1], stamp: cache.ownedFiles[targets[1]] },
    }
    cache.pdf = { path: targets[2], stamp: cache.ownedFiles[targets[2]] }
    fs.writeFileSync(paths.cache, JSON.stringify(cache, null, 1))
  }
  const previous = targets.concat(paths.cache).map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null))
  const makeCache = (records) => ({
    version: 2,
    albumFile,
    generation: 'next',
    spreads: {
      first: {
        n: 1,
        high: { path: targets[0], stamp: records[0].stamp },
        low: { path: targets[1], stamp: records[1].stamp },
      },
    },
    pdf: { path: paths.pdf, stamp: records[2].stamp },
  })
  return { root, paths, stage, albumFile, targets, files, cache, previous, makeCache }
}

async function publish(f, extra = {}) {
  return publishDelivery(f.files, f.cache, f.stage, {
    paths: f.paths,
    albumFile: f.albumFile,
    makeCache: f.makeCache,
    ...extra,
  })
}

function injectCapture(t, hook) {
  const rename = fs.promises.rename.bind(fs.promises),
    exclusive = exclusiveRename.renameExclusive.bind(exclusiveRename)
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    await hook(from, to)
    return rename(from, to)
  })
  t.mock.method(exclusiveRename, 'renameExclusive', async (from, to) => {
    await hook(from, to)
    return exclusive(from, to)
  })
}

function assertPrevious(f) {
  f.targets.concat(f.paths.cache).forEach((file, index) => {
    if (f.previous[index] === null) assert.equal(fs.existsSync(file), false, `${file} stays absent`)
    else assert.deepEqual(fs.readFileSync(file), f.previous[index], `${file} keeps its previous bytes`)
  })
}

function assertNext(f) {
  for (const [i, target] of f.targets.entries()) assert.equal(fs.readFileSync(target, 'utf8'), `next delivery ${i}`)
  const cache = JSON.parse(fs.readFileSync(f.paths.cache, 'utf8'))
  assert.equal(cache.generation, 'next')
  for (const target of f.targets) {
    assert.equal(cache.ownedDigests[target], digest(target))
    assert.match(cache.ownedFiles[target], /^\d+:\d+$/)
  }
  assert.equal(cache.spreads.first.high.digest, digest(f.targets[0]))
  assert.equal(cache.pdf.digest, digest(f.paths.pdf))
}

function historyOf(f) {
  return path.join(path.dirname(f.paths.cache), 'delivery-history', path.basename(f.stage))
}

function assertClean(f) {
  assert.equal(fs.existsSync(f.stage), false)
  assert.deepEqual(fs.readdirSync(path.dirname(f.paths.cache)).sort(), ['delivery-history', 'export-cache.json'])
  assert.ok(
    fs.existsSync(path.join(historyOf(f), 'journal.json')),
    'completed recovery data is retained outside the active stage scan',
  )
  for (const file of f.files)
    assert.ok(
      fs.existsSync(path.join(historyOf(f), path.basename(file.source))),
      'prepared recovery bytes are never deleted automatically',
    )
}

async function killedAt(f, boundary, operation = 'publish') {
  const input = {
    files: f.files,
    cache: f.cache,
    stage: f.stage,
    paths: f.paths,
    albumFile: f.albumFile,
    targets: f.targets,
  }
  const script = `
const fs = require('fs'), path = require('path')
const input = ${JSON.stringify(input)}, boundary = ${JSON.stringify(boundary)}
const die = () => process.kill(process.pid, 'SIGKILL')
const rename = fs.promises.rename.bind(fs.promises), link = fs.promises.link.bind(fs.promises), copy = fs.promises.copyFile.bind(fs.promises), open = fs.promises.open.bind(fs.promises)
const exclusive = require(${JSON.stringify(require.resolve('../lib/exclusive_rename'))}), atomic = exclusive.renameExclusive.bind(exclusive)
exclusive.renameExclusive = async (from, to) => {
  await atomic(from, to)
  if (boundary === 'old-to-backup' && to === path.join(input.stage, 'backup-0')) die()
  if (boundary === 'cache-to-backup' && to === path.join(input.stage, 'backup-3')) die()
  if (boundary === 'rollback-discard' && to === path.join(input.stage, 'discard-0')) die()
  if (boundary === 'committed-cleanup' && from === input.stage && path.dirname(to) === path.join(path.dirname(input.paths.cache), 'delivery-history')) die()
}
fs.promises.open = async (file, ...args) => {
  const handle = await open(file, ...args)
  const utimes = handle.utimes.bind(handle)
  handle.utimes = async (...values) => {
    await utimes(...values)
    if (boundary === 'new-install' && file === input.targets[0]) die()
    if (boundary === 'cache-install' && file === input.paths.cache) die()
    if (boundary === 'restored-install' && file === input.targets[0]) die()
  }
  if (boundary === 'reclaim-guard' && file === path.join(path.dirname(input.paths.cache), '.delivery.recovery.lock')) {
    const write = handle.writeFile.bind(handle)
    handle.writeFile = async (...values) => { await write(...values); die() }
  }
  return handle
}
fs.promises.rename = async (from, to) => {
  await rename(from, to)
  if (boundary === 'committed-marker' && to === path.join(input.stage, 'journal.json') && JSON.parse(fs.readFileSync(to)).phase === 'committed') die()
}
fs.promises.link = async (from, to) => {
  await link(from, to)
  if (boundary === 'prepared-journal' && to === path.join(input.stage, 'journal.json')) die()
}
fs.promises.copyFile = async (from, to, flags) => {
  if (boundary === 'partial-copy' && to === input.targets[0]) { await fs.promises.writeFile(to, 'part', { flag: 'wx' }); die() }
  await copy(from, to, flags)
  if (boundary === 'new-copy' && to === input.targets[0]) die()
}
const transaction = require(${JSON.stringify(require.resolve('../lib/delivery_transaction'))})
const makeCache = (records) => ({ version: 2, albumFile: input.albumFile, generation: 'next', spreads: { first: { n: 1, high: { path: input.targets[0], stamp: records[0].stamp }, low: { path: input.targets[1], stamp: records[1].stamp } } }, pdf: { path: input.paths.pdf, stamp: records[2].stamp } })
const work = ${JSON.stringify(operation)} === 'publish'
  ? transaction.publishDelivery(input.files, input.cache, input.stage, { paths: input.paths, albumFile: input.albumFile, makeCache })
  : transaction.recoverDeliveries(input.paths, { albumFile: input.albumFile })
work.then(() => process.exit(0), (e) => { console.error(e.stack); process.exit(1) })
`
  await assert.rejects(runFile(process.execPath, ['-e', script], { timeout: 15000 }), (error) => {
    assert.equal(error.signal, 'SIGKILL', error.stderr || error.message)
    return true
  })
  assert.ok(
    fs.existsSync(path.join(f.stage, 'journal.json')) || fs.existsSync(path.join(historyOf(f), 'journal.json')),
    'the killed process retains its recovery journal or retired history',
  )
}

test('complete delivery and its cache publish together with content ownership', async (t) => {
  const f = await fixture(t)
  let validated = 0
  const records = await publish(f, {
    validateSnapshot: async () => {
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.stage, 'journal.json'))).phase, 'pending')
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.stage, 'journal.json.new'))).phase, 'committed')
      assertNext(f)
      validated++
    },
  })
  assert.equal(validated, 1, 'successful snapshot validation occurs before the atomic committed marker')
  assert.equal(records.length, 3)
  for (const record of records) {
    assert.equal(record.stamp, await fileStamp(record.target))
    assert.equal(record.digest, digest(record.target))
  }
  assertNext(f)
  assertClean(f)
})

test('later public-file edits cannot change any retained delivery source, backup or discard', async (t) => {
  for (const rollback of [false, true])
    await t.test(rollback ? 'restored delivery' : 'committed delivery', async (tt) => {
      const f = await fixture(tt)
      if (rollback)
        await assert.rejects(
          publish(f, {
            validateSnapshot: async () => {
              throw new Error('source revision changed before commit')
            },
          }),
          /source revision changed before commit/,
        )
      else await publish(f)
      if (rollback) assertPrevious(f)
      else assertNext(f)
      assertClean(f)
      const history = historyOf(f),
        journal = JSON.parse(fs.readFileSync(path.join(history, 'journal.json')))
      const retained = new Map()
      for (const entry of journal.entries)
        for (const name of [entry.source, entry.backup, entry.discard]) {
          const file = path.join(history, name)
          if (fs.existsSync(file)) retained.set(file, fs.readFileSync(file))
        }
      for (const target of f.targets.concat(f.paths.cache))
        fs.writeFileSync(target, `ordinary later edit to ${path.basename(target)}`)
      for (const [file, expected] of retained)
        assert.deepEqual(
          fs.readFileSync(file),
          expected,
          `retained recovery bytes changed through a public-file alias: ${file}`,
        )
      for (const entry of journal.entries) {
        const source = path.join(history, rollback ? entry.backup : entry.source)
        assert.notEqual(
          fs.statSync(source).ino,
          fs.statSync(entry.target).ino,
          'public files must have independent inodes from their recovery copies',
        )
      }
    })
})

test('readiness verifies digest ownership and rejects same-stamp edits, symlinks and invalid records', async (t) => {
  const f = await fixture(t),
    file = f.targets[0],
    stamp = await fileStamp(file),
    expected = digest(file)
  assert.equal(await verifyOwnedArtifact(file, stamp, expected), true)
  assert.equal(
    await verifyOwnedArtifact(file, stamp),
    true,
    'legacy ownership preserves the existing stamp-only policy',
  )
  assert.equal(await verifyOwnedArtifact(file, stamp, 'invalid-digest'), false)
  assert.equal(await verifyOwnedArtifact(file, 'invalid-stamp', expected), false)
  assert.equal(await verifyOwnedArtifact(path.join(f.root, 'missing.jpg'), stamp, expected), false)
  const alias = path.join(f.root, 'alias.jpg')
  fs.symlinkSync(file, alias)
  assert.equal(await verifyOwnedArtifact(alias, stamp, expected), false)
  const st = fs.statSync(file)
  fs.writeFileSync(file, 'external delivery 0')
  fs.utimesSync(file, st.atime, st.mtime)
  assert.equal(await fileStamp(file), stamp, 'the mutation deliberately preserves size and timestamp')
  assert.equal(await verifyOwnedArtifact(file, stamp, expected), false)
  assert.equal(await verifyOwnedArtifact(file, stamp), true, 'this known legacy limitation is explicit')
})

test('first publication and legacy stamp ownership upgrade to digest ownership', async (t) => {
  for (const options of [{ existing: false }, { strong: false }])
    await t.test(JSON.stringify(options), async (tt) => {
      const f = await fixture(tt, options)
      await publish(f)
      assertNext(f)
      assertClean(f)
    })
})

test('caught data and cache failures restore every previous byte', async (t) => {
  for (const index of [1, 3])
    await t.test(`backup-${index}`, async (tt) => {
      const f = await fixture(tt)
      injectCapture(tt, (_from, to) => {
        if (to === path.join(f.stage, `backup-${index}`))
          throw Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' })
      })
      await assert.rejects(publish(f), /simulated full disk/)
      assertPrevious(f)
      assertClean(f)
    })
})

test('cache construction fails before exposing any prepared delivery file', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    publish(f, {
      makeCache: () => {
        throw new Error('cache build failed')
      },
    }),
    /cache build failed/,
  )
  assertPrevious(f)
  assert.equal(fs.existsSync(path.join(f.stage, 'journal.json')), false)
})

test('a cache or target edit while an asynchronous cache builder runs is rejected before publication', async (t) => {
  for (const target of ['cache', 'jpeg'])
    await t.test(target, async (tt) => {
      const f = await fixture(tt),
        changed = target === 'cache' ? f.paths.cache : f.targets[1]
      const makeCache = async (records) => {
        await new Promise((resolve) => setImmediate(resolve))
        fs.writeFileSync(changed, 'external edit during cache building')
        return f.makeCache(records)
      }
      await assert.rejects(publish(f, { makeCache }), /changed while its ownership cache was prepared/)
      assert.equal(fs.readFileSync(changed, 'utf8'), 'external edit during cache building')
      for (const [index, file] of f.targets.concat(f.paths.cache).entries())
        if (file !== changed) assert.deepEqual(fs.readFileSync(file), f.previous[index])
      assert.equal(fs.existsSync(path.join(f.stage, 'journal.json')), false)
    })
})

test('source revision changes during final validation or marker flush restore the complete previous delivery', async (t) => {
  for (const boundary of ['final-validation', 'commit-record-flush'])
    await t.test(boundary, async (tt) => {
      const f = await fixture(tt),
        source = path.join(f.root, 'synthetic-render-source')
      fs.writeFileSync(source, 'the captured source revision')
      const expected = digest(source)
      let changed = false,
        checks = 0
      const mutate = () => {
        if (!changed) {
          changed = true
          fs.writeFileSync(source, 'an externally changed source')
        }
      }
      const lstat = fs.promises.lstat.bind(fs.promises)
      tt.mock.method(fs.promises, 'lstat', async (file, ...args) => {
        if (
          boundary === 'final-validation' &&
          file === f.targets[0] &&
          fs.existsSync(f.paths.cache) &&
          JSON.parse(fs.readFileSync(f.paths.cache)).generation === 'next'
        )
          mutate()
        return lstat(file, ...args)
      })
      const open = fs.promises.open.bind(fs.promises)
      tt.mock.method(fs.promises, 'open', async (file, ...args) => {
        const handle = await open(file, ...args)
        if (boundary === 'commit-record-flush' && file === path.join(f.stage, 'journal.json.new')) {
          const sync = handle.sync.bind(handle)
          tt.mock.method(handle, 'sync', async () => {
            await sync()
            if (JSON.parse(fs.readFileSync(file)).phase === 'committed') mutate()
          })
        }
        return handle
      })
      await assert.rejects(
        publish(f, {
          validateSnapshot: async () => {
            checks++
            if (digest(source) !== expected) throw new Error('captured source revision changed')
          },
        }),
        /captured source revision changed/,
      )
      assert.equal(checks, 1)
      assert.equal(changed, true)
      assertPrevious(f)
      assertClean(f)
    })
})

test('a snapshot validator must be a function before publication can begin', async (t) => {
  const f = await fixture(t)
  await assert.rejects(publish(f, { validateSnapshot: 'invalid' }), /snapshot validator|validateSnapshot/)
  assertPrevious(f)
  assert.equal(fs.existsSync(path.join(f.stage, 'journal.json')), false)
})

test('cancellation before publication, between files and after cache publication restores the complete prior set', async (t) => {
  for (const boundary of [
    'before',
    'second-file',
    'cache',
    'final-validation',
    'commit-record-flush',
    'snapshot-validation',
  ])
    await t.test(boundary, async (tt) => {
      const f = await fixture(tt),
        copy = fs.promises.copyFile.bind(fs.promises)
      let stop = boundary === 'before'
      tt.mock.method(fs.promises, 'copyFile', async (from, to, flags) => {
        await copy(from, to, flags)
        if ((boundary === 'second-file' && to === f.targets[1]) || (boundary === 'cache' && to === f.paths.cache))
          stop = true
      })
      const lstat = fs.promises.lstat.bind(fs.promises)
      tt.mock.method(fs.promises, 'lstat', async (file, ...args) => {
        if (
          boundary === 'final-validation' &&
          file === f.targets[0] &&
          fs.existsSync(f.paths.cache) &&
          JSON.parse(fs.readFileSync(f.paths.cache)).generation === 'next'
        )
          stop = true
        return lstat(file, ...args)
      })
      const open = fs.promises.open.bind(fs.promises)
      tt.mock.method(fs.promises, 'open', async (file, ...args) => {
        const handle = await open(file, ...args)
        if (boundary === 'commit-record-flush' && file === path.join(f.stage, 'journal.json.new')) {
          const sync = handle.sync.bind(handle)
          tt.mock.method(handle, 'sync', async () => {
            await sync()
            if (JSON.parse(fs.readFileSync(file)).phase === 'committed') stop = true
          })
        }
        return handle
      })
      await assert.rejects(
        publish(f, {
          isCancelled: () => stop,
          ...(boundary === 'snapshot-validation'
            ? {
                validateSnapshot: async () => {
                  await new Promise((resolve) => setImmediate(resolve))
                  stop = true
                },
              }
            : {}),
        }),
        (error) => error.code === 'DELIVERY_CANCELLED',
      )
      assertPrevious(f)
      if (boundary !== 'before') assertClean(f)
    })
})

test('unowned, edited and same-stamp content edits cannot be replaced', async (t) => {
  for (const kind of ['unowned', 'edited', 'same-stamp'])
    await t.test(kind, async (tt) => {
      const f = await fixture(tt)
      if (kind === 'unowned') {
        delete f.cache.ownedFiles[f.targets[0]]
        delete f.cache.spreads.first.high
      } else {
        const st = fs.statSync(f.targets[0])
        fs.writeFileSync(f.targets[0], kind === 'same-stamp' ? 'external delivery 0' : 'an external edit')
        if (kind === 'same-stamp') fs.utimesSync(f.targets[0], st.atime, st.mtime)
      }
      const edited = fs.readFileSync(f.targets[0])
      await assert.rejects(publish(f), /unowned|edited/)
      assert.deepEqual(fs.readFileSync(f.targets[0]), edited)
      for (const [i, file] of f.targets.slice(1).entries()) assert.deepEqual(fs.readFileSync(file), f.previous[i + 1])
    })
})

test('ownership cache from another album or a concurrently changed cache is preserved', async (t) => {
  for (const change of ['album', 'content'])
    await t.test(change, async (tt) => {
      const f = await fixture(tt),
        disk = {
          ...f.cache,
          ...(change === 'album' ? { albumFile: path.join(f.root, 'other-project.json') } : { externalEdit: true }),
        }
      fs.writeFileSync(f.paths.cache, JSON.stringify(disk))
      const bytes = fs.readFileSync(f.paths.cache)
      await assert.rejects(publish(f), /cache changed|another album/)
      assert.deepEqual(fs.readFileSync(f.paths.cache), bytes)
      f.targets.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), f.previous[index]))
    })
})

test('an absent ownership cache cannot be replaced by caller claims about existing files', async (t) => {
  const f = await fixture(t)
  fs.unlinkSync(f.paths.cache)
  await assert.rejects(publish(f), /cache is missing|caller data/)
  f.targets.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), f.previous[index]))
  assert.equal(fs.existsSync(path.join(f.stage, 'journal.json')), false)
})

test('a destination appearing at the exclusive install boundary survives with backups and journal', async (t) => {
  const f = await fixture(t),
    copy = fs.promises.copyFile.bind(fs.promises)
  let inserted = false
  t.mock.method(fs.promises, 'copyFile', async (from, to, flags) => {
    if (!inserted && to === f.targets[0]) {
      inserted = true
      fs.writeFileSync(to, 'unrelated new file')
    }
    return copy(from, to, flags)
  })
  const error = await publish(f).then(
    () => assert.fail('publication must reject a collision'),
    (e) => e,
  )
  assert.ok(error.recoveryJournal && fs.existsSync(error.recoveryJournal))
  assert.equal(fs.readFileSync(f.targets[0], 'utf8'), 'unrelated new file')
  assert.deepEqual(fs.readFileSync(path.join(f.stage, 'backup-0')), f.previous[0])
  t.mock.restoreAll()
  await assert.rejects(recoverDeliveries(f.paths, { albumFile: f.albumFile }), /rollback conflict/)
  assert.ok(fs.existsSync(error.recoveryJournal))
  fs.unlinkSync(f.targets[0])
  await recoverDeliveries(f.paths, { albumFile: f.albumFile })
  assertPrevious(f)
  assertClean(f)
})

test('a replacement file at the copy-metadata boundary keeps its bytes, mode and timestamps', async (t) => {
  for (const symlink of [false, true])
    await t.test(symlink ? 'symlink replacement' : 'regular replacement', async (tt) => {
      const f = await fixture(tt),
        copy = fs.promises.copyFile.bind(fs.promises),
        outside = path.join(f.root, 'unrelated-file')
      fs.writeFileSync(outside, 'unrelated customer bytes', { mode: 0o600 })
      fs.utimesSync(outside, 1500000000, 1500000000)
      const before = fs.statSync(outside)
      let replaced = false
      tt.mock.method(fs.promises, 'copyFile', async (from, to, flags) => {
        await copy(from, to, flags)
        if (!replaced && to === f.targets[0]) {
          replaced = true
          fs.renameSync(to, path.join(f.root, 'captured-new-delivery'))
          if (symlink) fs.symlinkSync(outside, to)
          else fs.renameSync(outside, to)
        }
      })
      const error = await publish(f).then(
        () => assert.fail('replacement must fail closed'),
        (e) => e,
      )
      const preserved = symlink ? outside : f.targets[0],
        after = fs.statSync(preserved)
      assert.equal(fs.readFileSync(preserved, 'utf8'), 'unrelated customer bytes')
      assert.equal(after.mode, before.mode, 'metadata restoration must not chmod an unrelated replacement')
      assert.equal(after.mtimeMs, before.mtimeMs, 'metadata restoration must not retimestamp an unrelated replacement')
      assert.ok(fs.existsSync(error.recoveryJournal))
    })
})

test('an unrelated file appearing at a private backup destination is never overwritten', async (t) => {
  const f = await fixture(t),
    backup = path.join(f.stage, 'backup-0')
  let inserted = false
  injectCapture(t, (_from, to) => {
    if (!inserted && to === backup) {
      inserted = true
      fs.writeFileSync(to, 'unrelated private backup record')
    }
  })
  const error = await publish(f).then(
    () => assert.fail('backup collision must reject publication'),
    (e) => e,
  )
  assert.equal(fs.readFileSync(backup, 'utf8'), 'unrelated private backup record')
  assert.ok(fs.existsSync(error.recoveryJournal))
  assertPrevious(f)
})

test('an unrelated file appearing at a private discard destination is never overwritten during rollback', async (t) => {
  const f = await fixture(t),
    discard = path.join(f.stage, 'discard-0'),
    copy = fs.promises.copyFile.bind(fs.promises)
  let failed = false,
    inserted = false
  t.mock.method(fs.promises, 'copyFile', async (from, to, flags) => {
    if (!failed && to === f.targets[1]) {
      failed = true
      throw new Error('publication failure before rollback')
    }
    return copy(from, to, flags)
  })
  injectCapture(t, (_from, to) => {
    if (!inserted && to === discard) {
      inserted = true
      fs.writeFileSync(to, 'unrelated private discard record')
    }
  })
  const error = await publish(f).then(
    () => assert.fail('publication must fail'),
    (e) => e,
  )
  assert.equal(fs.readFileSync(discard, 'utf8'), 'unrelated private discard record')
  assert.deepEqual(fs.readFileSync(path.join(f.stage, 'backup-0')), f.previous[0])
  assert.ok(fs.existsSync(error.recoveryJournal))
})

test('a recovery backup changed after enumeration is preserved with its journal', async (t) => {
  const f = await fixture(t),
    backup = path.join(f.stage, 'backup-0'),
    readdir = fs.promises.readdir.bind(fs.promises)
  let changed = false
  t.mock.method(fs.promises, 'readdir', async (folder, ...args) => {
    if (
      !changed &&
      folder === f.stage &&
      fs.existsSync(path.join(f.stage, 'journal.json')) &&
      JSON.parse(fs.readFileSync(path.join(f.stage, 'journal.json'))).phase === 'committed'
    ) {
      changed = true
      fs.writeFileSync(backup, 'external recovery backup edit')
    }
    return readdir(folder, ...args)
  })
  const error = await publish(f).then(
    () => assert.fail('backup edit must retain recovery evidence'),
    (e) => e,
  )
  assert.equal(error.deliveryCommitted, true)
  assert.equal(fs.readFileSync(backup, 'utf8'), 'external recovery backup edit')
  assert.ok(fs.existsSync(error.recoveryJournal))
  assertNext(f)
})

test('a history destination appearing during retirement is preserved without replacing either directory', async (t) => {
  const f = await fixture(t),
    history = historyOf(f)
  let inserted = false
  injectCapture(t, (from, to) => {
    if (!inserted && from === f.stage && to === history) {
      inserted = true
      fs.mkdirSync(history)
      fs.writeFileSync(path.join(history, 'customer-record'), 'unrelated history')
    }
  })
  const error = await publish(f).then(
    () => assert.fail('history collision must retain the active stage'),
    (e) => e,
  )
  assert.equal(error.deliveryCommitted, true)
  assert.equal(fs.readFileSync(path.join(history, 'customer-record'), 'utf8'), 'unrelated history')
  assert.ok(fs.existsSync(path.join(f.stage, 'journal.json')))
  assert.ok(fs.existsSync(path.join(f.stage, 'backup-0')))
  assertNext(f)
})

test('an edit racing history retirement is retained and reported at the actual history path', async (t) => {
  const f = await fixture(t),
    history = historyOf(f)
  let changed = false
  injectCapture(t, (from, to) => {
    if (!changed && from === f.stage && to === history) {
      changed = true
      fs.writeFileSync(path.join(f.stage, 'backup-0'), 'edit racing atomic history move')
    }
  })
  const error = await publish(f).then(
    () => assert.fail('late history edit must be reported'),
    (e) => e,
  )
  assert.equal(error.deliveryCommitted, true)
  assert.equal(error.recoveryStage, history)
  assert.equal(error.recoveryJournal, path.join(history, 'journal.json'))
  assert.equal(fs.existsSync(f.stage), false)
  assert.equal(fs.readFileSync(path.join(history, 'backup-0'), 'utf8'), 'edit racing atomic history move')
  assertNext(f)
})

test('a helper error after completed history movement reports the actual retained journal', async (t) => {
  for (const rollback of [false, true])
    await t.test(rollback ? 'restored' : 'committed', async (tt) => {
      const f = await fixture(tt),
        history = historyOf(f),
        move = exclusiveRename.renameExclusive.bind(exclusiveRename),
        copy = fs.promises.copyFile.bind(fs.promises)
      let failedPublication = false,
        failedRetirement = false
      if (rollback)
        tt.mock.method(fs.promises, 'copyFile', async (from, to, flags) => {
          if (!failedPublication && to === f.targets[1]) {
            failedPublication = true
            throw new Error('publication failed before history retirement')
          }
          return copy(from, to, flags)
        })
      tt.mock.method(exclusiveRename, 'renameExclusive', async (from, to) => {
        await move(from, to)
        if (!failedRetirement && from === f.stage && to === history) {
          failedRetirement = true
          throw Object.assign(new Error('helper stopped after its atomic move'), { code: 'ETIMEDOUT' })
        }
      })
      const error = await publish(f).then(
        () => assert.fail('helper uncertainty must report retained evidence'),
        (e) => e,
      )
      assert.equal(error.recoveryStage, history)
      assert.equal(error.recoveryJournal, path.join(history, 'journal.json'))
      assert.ok(fs.existsSync(error.recoveryJournal))
      assert.equal(fs.existsSync(f.stage), false)
      if (rollback) {
        assert.equal(error.deliveryCommitted, undefined)
        assertPrevious(f)
      } else {
        assert.equal(error.deliveryCommitted, true)
        assertNext(f)
      }
    })
})

test('exclusive copies remain available without hard links and preserve timestamps', async (t) => {
  const f = await fixture(t)
  t.mock.method(fs.promises, 'link', async () => {
    throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' })
  })
  await publish(f)
  assertNext(f)
  assertClean(f)
  for (const target of f.targets) assert.equal(fs.statSync(target).mtimeMs, 1700000000000)
})

test('a synchronous commit-journal flush failure restores the old set before a marker is installed', async (t) => {
  const f = await fixture(t),
    open = fs.promises.open.bind(fs.promises)
  let injected = false
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    const handle = await open(file, ...args)
    if (file === path.join(f.stage, 'journal.json.new')) {
      const sync = handle.sync.bind(handle)
      t.mock.method(handle, 'sync', async () => {
        if (!injected && JSON.parse(fs.readFileSync(file)).phase === 'committed') {
          injected = true
          throw Object.assign(new Error('commit flush failed'), { code: 'EIO' })
        }
        return sync()
      })
    }
    return handle
  })
  await assert.rejects(publish(f), /commit flush failed/)
  assert.equal(injected, true)
  assertPrevious(f)
  assertClean(f)
})

test('a history retirement failure after commit reports committed status and restart keeps the new set', async (t) => {
  const f = await fixture(t)
  injectCapture(t, (from, to) => {
    if (from === f.stage && to === historyOf(f))
      throw Object.assign(new Error('history retirement refused'), { code: 'EIO' })
  })
  const error = await publish(f).then(
    () => assert.fail('cleanup must fail'),
    (e) => e,
  )
  assert.equal(error.deliveryCommitted, true)
  assert.ok(fs.existsSync(error.recoveryJournal))
  assertNext(f)
  t.mock.restoreAll()
  const result = await recoverDeliveries(f.paths, { albumFile: f.albumFile })
  assert.equal(result.recovered[0].state, 'committed')
  assertNext(f)
  assertClean(f)
})

test('an edit racing the capture of an old target is preserved in its recovery backup', async (t) => {
  const f = await fixture(t)
  let changed = false
  injectCapture(t, (from, to) => {
    if (!changed && to === path.join(f.stage, 'backup-0')) {
      changed = true
      fs.writeFileSync(from, 'external edit racing capture')
    }
  })
  const error = await publish(f).then(
    () => assert.fail('concurrent edit must fail'),
    (e) => e,
  )
  assert.ok(error.recoveryJournal && fs.existsSync(error.recoveryJournal))
  assert.equal(fs.readFileSync(path.join(f.stage, 'backup-0'), 'utf8'), 'external edit racing capture')
  assert.equal(fs.readFileSync(f.targets[0], 'utf8'), 'external edit racing capture')
  f.targets.slice(1).forEach((file, index) => assert.deepEqual(fs.readFileSync(file), f.previous[index + 1]))
})

test('an edit racing rollback remains at its name and in a retained recovery copy', async (t) => {
  const f = await fixture(t)
  await killedAt(f, 'new-install')
  let changed = false
  injectCapture(t, (from, to) => {
    if (!changed && to === path.join(f.stage, 'discard-0')) {
      changed = true
      fs.writeFileSync(from, 'external edit racing rollback')
    }
  })
  await assert.rejects(recoverDeliveries(f.paths, { albumFile: f.albumFile }), /rollback conflict/)
  assert.equal(fs.readFileSync(f.targets[0], 'utf8'), 'external edit racing rollback')
  assert.equal(fs.readFileSync(path.join(f.stage, 'discard-0'), 'utf8'), 'external edit racing rollback')
  assert.deepEqual(fs.readFileSync(path.join(f.stage, 'backup-0')), f.previous[0])
  assert.ok(fs.existsSync(path.join(f.stage, 'journal.json')))
})

test('a symlink or unknown file at the temporary journal name cannot be overwritten or deleted', async (t) => {
  for (const kind of ['symlink', 'regular'])
    await t.test(kind, async (tt) => {
      const f = await fixture(tt)
      await killedAt(f, 'new-install')
      const referent = path.join(f.root, 'customer-record'),
        temporary = path.join(f.stage, 'journal.json.new')
      fs.writeFileSync(referent, 'keep customer record')
      if (kind === 'symlink') fs.symlinkSync(referent, temporary)
      else fs.writeFileSync(temporary, 'customer notes')
      await assert.rejects(recoverDeliveries(f.paths, { albumFile: f.albumFile }), /regular file|Unexpected|JSON/)
      assert.equal(fs.readFileSync(referent, 'utf8'), 'keep customer record')
      assert.ok(fs.lstatSync(temporary))
      assert.ok(fs.existsSync(path.join(f.stage, 'backup-0')))
      assert.ok(fs.existsSync(path.join(f.stage, 'journal.json')))
    })
})

test('restart restores the previous set at actual SIGKILL publication boundaries', async (t) => {
  for (const boundary of [
    'prepared-journal',
    'old-to-backup',
    'new-install',
    'new-copy',
    'cache-to-backup',
    'cache-install',
  ])
    await t.test(boundary, async (tt) => {
      const f = await fixture(tt)
      await killedAt(f, boundary)
      const recovery = await recoverDeliveries(f.paths, { albumFile: f.albumFile })
      assert.equal(recovery.recovered[0].state, 'restored')
      assertPrevious(f)
      assertClean(f)
    })
})

test('restart keeps the complete new set after committed marker and interrupted cleanup', async (t) => {
  for (const boundary of ['committed-marker', 'committed-cleanup'])
    await t.test(boundary, async (tt) => {
      const f = await fixture(tt)
      await killedAt(f, boundary)
      const recovery = await recoverDeliveries(f.paths, { albumFile: f.albumFile })
      if (boundary === 'committed-marker') assert.equal(recovery.recovered[0].state, 'committed')
      else assert.equal(recovery.recovered.length, 0, 'history is retained and never replayed as an active transaction')
      assert.deepEqual(recovery.orphanStages, [], 'the durable history root is excluded from active recovery scanning')
      assertNext(f)
      assertClean(f)
    })
})

test('rollback can itself be killed and restarted without losing previous copies', async (t) => {
  for (const boundary of ['rollback-discard', 'restored-install'])
    await t.test(boundary, async (tt) => {
      const f = await fixture(tt)
      await killedAt(f, 'new-install')
      await killedAt(f, boundary, 'recover')
      await recoverDeliveries(f.paths, { albumFile: f.albumFile })
      assertPrevious(f)
      assertClean(f)
    })
})

test('a killed partial exclusive copy is a recovery conflict, never an excuse to delete unknown bytes', async (t) => {
  const f = await fixture(t)
  await killedAt(f, 'partial-copy')
  await assert.rejects(recoverDeliveries(f.paths, { albumFile: f.albumFile }), /rollback conflict/)
  assert.equal(fs.readFileSync(f.targets[0], 'utf8'), 'part')
  assert.deepEqual(fs.readFileSync(path.join(f.stage, 'backup-0')), f.previous[0])
  assert.ok(fs.existsSync(path.join(f.stage, 'journal.json')))
  fs.renameSync(f.targets[0], path.join(f.root, 'preserved-partial-copy'))
  await recoverDeliveries(f.paths, { albumFile: f.albumFile })
  assertPrevious(f)
  assertClean(f)
})

test('external edits after a kill retain all recovery copies and the journal', async (t) => {
  const f = await fixture(t)
  await killedAt(f, 'new-install')
  const edited = 'customer changed the published file'
  fs.writeFileSync(f.targets[0], edited)
  await assert.rejects(recoverDeliveries(f.paths, { albumFile: f.albumFile }), /rollback conflict/)
  assert.equal(fs.readFileSync(f.targets[0], 'utf8'), edited)
  assert.deepEqual(fs.readFileSync(path.join(f.stage, 'backup-0')), f.previous[0])
  assert.ok(fs.existsSync(path.join(f.stage, 'journal.json')))
})

test('unknown stage files survive recovery and keep the journal and backups', async (t) => {
  const f = await fixture(t)
  await killedAt(f, 'new-install')
  const unknown = path.join(f.stage, 'customer-notes.txt')
  fs.writeFileSync(unknown, 'keep this file')
  await assert.rejects(recoverDeliveries(f.paths, { albumFile: f.albumFile }), /Unexpected files/)
  assert.equal(fs.readFileSync(unknown, 'utf8'), 'keep this file')
  assert.ok(fs.existsSync(path.join(f.stage, 'backup-0')))
  assert.ok(fs.existsSync(path.join(f.stage, 'journal.json')))
})

test('malformed path and album journals fail before mutating delivery files', async (t) => {
  for (const corruption of ['target', 'source', 'album', 'fingerprint'])
    await t.test(corruption, async (tt) => {
      const f = await fixture(tt)
      await killedAt(f, 'new-install')
      const file = path.join(f.stage, 'journal.json'),
        journal = JSON.parse(fs.readFileSync(file))
      const outside = path.join(f.root, 'outside.txt')
      fs.writeFileSync(outside, 'unrelated outside file')
      if (corruption === 'target') journal.entries[0].target = outside
      if (corruption === 'source') journal.entries[0].source = '../outside.txt'
      if (corruption === 'album') journal.albumFile = path.join(f.root, 'other-project.json')
      if (corruption === 'fingerprint') journal.entries[0].after.digest = 'invalid'
      fs.writeFileSync(file, JSON.stringify(journal))
      await assert.rejects(recoverDeliveries(f.paths, { albumFile: f.albumFile }), /Invalid delivery/)
      assert.equal(fs.readFileSync(f.targets[0], 'utf8'), 'next delivery 0')
      assert.equal(fs.readFileSync(outside, 'utf8'), 'unrelated outside file')
      assert.ok(fs.existsSync(file))
      assert.ok(fs.existsSync(path.join(f.stage, 'backup-0')))
    })
})

test('target-directory and staged-source symlinks are rejected without touching their referents', async (t) => {
  for (const kind of ['directory', 'source'])
    await t.test(kind, async (tt) => {
      const f = await fixture(tt),
        outside = path.join(f.root, 'outside')
      fs.mkdirSync(outside)
      if (kind === 'directory') {
        fs.rmSync(f.paths.high, { recursive: true })
        fs.symlinkSync(outside, f.paths.high)
        fs.writeFileSync(path.join(outside, 'Page_001.jpg'), 'unrelated file')
      } else {
        const referent = path.join(outside, 'source')
        fs.writeFileSync(referent, 'unrelated source')
        fs.unlinkSync(f.files[0].source)
        fs.symlinkSync(referent, f.files[0].source)
      }
      await assert.rejects(publish(f), /symlink|regular file/)
      assert.equal(
        fs.readFileSync(path.join(outside, kind === 'directory' ? 'Page_001.jpg' : 'source'), 'utf8'),
        kind === 'directory' ? 'unrelated file' : 'unrelated source',
      )
      assert.equal(fs.existsSync(path.join(f.stage, 'journal.json')), false)
    })
})

test('another process cannot publish or recover while publication holds the album lock', async (t) => {
  const f = await fixture(t),
    copy = fs.promises.copyFile.bind(fs.promises)
  let release, entered
  const paused = new Promise((resolve) => {
      release = resolve
    }),
    ready = new Promise((resolve) => {
      entered = resolve
    })
  t.mock.method(fs.promises, 'copyFile', async (from, to, flags) => {
    if (to === f.targets[0]) {
      entered()
      await paused
    }
    return copy(from, to, flags)
  })
  const work = publish(f)
  try {
    await ready
    const script = `require(${JSON.stringify(require.resolve('../lib/delivery_transaction'))}).recoverDeliveries(${JSON.stringify(f.paths)}, {albumFile:${JSON.stringify(f.albumFile)}}).then(() => process.exit(2), (e) => {console.error(e.message); process.exit(3)})`
    await assert.rejects(
      runFile(process.execPath, ['-e', script]),
      (error) => error.code === 3 && /already in progress/.test(error.stderr),
    )
    await assert.rejects(recoverDeliveries(f.paths, { albumFile: f.albumFile }), /already in progress/)
  } finally {
    release()
    await work
  }
  assertNext(f)
  assertClean(f)
})

test('a prepared stage without a journal is preserved and cannot affect delivered files', async (t) => {
  const f = await fixture(t)
  const result = await recoverDeliveries(f.paths, { albumFile: f.albumFile })
  assert.deepEqual(result.recovered, [])
  assert.deepEqual(result.orphanStages, [f.stage])
  assertPrevious(f)
  assert.ok(fs.existsSync(f.files[0].source))
})

test('competing restarted processes cannot unlink a newly acquired lock while reclaiming stale ownership', async (t) => {
  const f = await fixture(t)
  await killedAt(f, 'new-install')
  const script = `require(${JSON.stringify(require.resolve('../lib/delivery_transaction'))}).recoverDeliveries(${JSON.stringify(f.paths)}, {albumFile:${JSON.stringify(f.albumFile)}}).then(() => process.exit(0), (e) => {console.error(e.message); process.exit(3)})`
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => runFile(process.execPath, ['-e', script], { timeout: 15000 })),
  )
  assert.ok(results.some((result) => result.status === 'fulfilled'))
  for (const result of results)
    if (result.status === 'rejected') {
      assert.equal(result.reason.code, 3)
      assert.match(result.reason.stderr, /already in progress/)
    }
  assertPrevious(f)
  assertClean(f)
})

test('an interrupted lock reclamation fails closed and preserves its guard without publishing', async (t) => {
  const f = await fixture(t),
    guard = path.join(path.dirname(f.paths.cache), '.delivery.recovery.lock')
  fs.writeFileSync(guard, 'interrupted recovery guard')
  const error = await publish(f).then(
    () => assert.fail('the interrupted guard must block publication'),
    (e) => e,
  )
  assert.equal(error.recoveryLock, guard)
  assert.equal(fs.readFileSync(guard, 'utf8'), 'interrupted recovery guard')
  assertPrevious(f)
  assert.equal(fs.existsSync(path.join(f.stage, 'journal.json')), false)
})

test('a real SIGKILL during stale-lock reclamation preserves the guard and all delivery recovery data', async (t) => {
  const f = await fixture(t)
  await killedAt(f, 'new-install')
  await killedAt(f, 'reclaim-guard', 'recover')
  const guard = path.join(path.dirname(f.paths.cache), '.delivery.recovery.lock')
  const bytes = fs.readFileSync(guard)
  const error = await recoverDeliveries(f.paths, { albumFile: f.albumFile }).then(
    () => assert.fail('interrupted reclamation must fail closed'),
    (e) => e,
  )
  assert.equal(error.recoveryLock, guard)
  assert.deepEqual(fs.readFileSync(guard), bytes)
  assert.equal(fs.readFileSync(f.targets[0], 'utf8'), 'next delivery 0')
  assert.deepEqual(fs.readFileSync(path.join(f.stage, 'backup-0')), f.previous[0])
  assert.ok(fs.existsSync(path.join(f.stage, 'journal.json')))
  fs.renameSync(guard, path.join(f.root, 'preserved-recovery-guard'))
  await recoverDeliveries(f.paths, { albumFile: f.albumFile })
  assertPrevious(f)
  assertClean(f)
})

test('an edited reclamation guard cannot be removed as if it were still process-owned', async (t) => {
  const f = await fixture(t)
  await killedAt(f, 'new-install')
  const open = fs.promises.open.bind(fs.promises),
    metadata = path.dirname(f.paths.cache),
    guard = path.join(metadata, '.delivery.recovery.lock')
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    const handle = await open(file, ...args)
    if (file === path.join(metadata, '.delivery.lock') && args[0] === 'wx') {
      const write = handle.writeFile.bind(handle)
      t.mock.method(handle, 'writeFile', async (...values) => {
        await write(...values)
        fs.writeFileSync(guard, 'externally changed guard')
      })
    }
    return handle
  })
  await assert.rejects(recoverDeliveries(f.paths, { albumFile: f.albumFile }), /Invalid delivery lock/)
  assert.equal(fs.readFileSync(guard, 'utf8'), 'externally changed guard')
  assert.equal(fs.readFileSync(f.targets[0], 'utf8'), 'next delivery 0')
  assert.deepEqual(fs.readFileSync(path.join(f.stage, 'backup-0')), f.previous[0])
  assert.ok(fs.existsSync(path.join(f.stage, 'journal.json')))
})

test('publication lock cleanup errors retain committed status and a later call clears its own stale owner', async (t) => {
  const f = await fixture(t),
    lock = path.join(path.dirname(f.paths.cache), '.delivery.lock'),
    unlink = fs.promises.unlink.bind(fs.promises)
  t.mock.method(fs.promises, 'unlink', async (file) => {
    if (file === lock) throw Object.assign(new Error('lock cleanup refused'), { code: 'EIO' })
    return unlink(file)
  })
  const error = await publish(f).then(
    () => assert.fail('lock cleanup must fail'),
    (e) => e,
  )
  assert.equal(error.deliveryCommitted, true)
  assert.equal(error.recoveryLock, lock)
  assertNext(f)
  t.mock.restoreAll()
  await recoverDeliveries(f.paths, { albumFile: f.albumFile })
  assertNext(f)
  assertClean(f)
})

test('unsupported directory synchronization is a best-effort fallback while files are flushed', async (t) => {
  const f = await fixture(t),
    open = fs.promises.open.bind(fs.promises)
  let count = 0
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    const handle = await open(file, ...args)
    if ((await handle.stat()).isDirectory())
      t.mock.method(handle, 'sync', async () => {
        count++
        throw Object.assign(new Error('directory fsync unavailable'), { code: 'EINVAL' })
      })
    return handle
  })
  await publish(f)
  assert.ok(count > 10)
  assertNext(f)
  assertClean(f)
})
