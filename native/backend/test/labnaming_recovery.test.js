'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')
const { promisify } = require('util')
const { tmpdir } = require('./fixtures')
const { renameSheets, listSheets } = require('../lib/labnaming')
const runFile = promisify(execFile)

function fixture(t) {
  const folder = tmpdir()
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  for (const name of ['A', 'B', 'C']) fs.writeFileSync(path.join(folder, `${name}.jpg`), `original ${name}`)
  return {
    folder,
    p: (name) => path.join(folder, name),
    ops: [
      { fromPath: path.join(folder, 'A.jpg'), toBaseName: 'B' },
      { fromPath: path.join(folder, 'B.jpg'), toBaseName: 'C' },
      { fromPath: path.join(folder, 'C.jpg'), toBaseName: 'A' },
    ],
  }
}

function injectMove(t, hook) {
  const rename = fs.promises.rename.bind(fs.promises)
  const link = fs.promises.link.bind(fs.promises)
  t.mock.method(fs.promises, 'rename', async (from, to) => {
    await hook(from, to)
    return rename(from, to)
  })
  t.mock.method(fs.promises, 'link', async (from, to) => {
    await hook(from, to)
    return link(from, to)
  })
}

function originalFiles(folder) {
  for (const name of ['A', 'B', 'C'])
    assert.equal(fs.readFileSync(path.join(folder, `${name}.jpg`), 'utf8'), `original ${name}`)
  assert.deepEqual(fs.readdirSync(folder).sort(), ['A.jpg', 'B.jpg', 'C.jpg'])
}

test('a failure after one committed rename restores every original in a cyclic rename', async (t) => {
  const { folder, ops } = fixture(t)
  let failed = false
  injectMove(t, (from, to) => {
    if (!failed && path.basename(from).startsWith('.as-rename-') && path.basename(to) === 'C.jpg') {
      failed = true
      throw new Error('injected phase-two failure')
    }
  })
  await assert.rejects(renameSheets({ folder, ops }), /injected phase-two failure/)
  originalFiles(folder)
})

test('blocked rollback retains a journal that a restarted module recovers before listing', async (t) => {
  const { folder, ops } = fixture(t)
  let failed = false
  injectMove(t, (from, to) => {
    if (!failed && path.basename(from).startsWith('.as-rename-') && path.basename(to) === 'C.jpg') {
      failed = true
      throw new Error('injected phase-two failure')
    }
    if (failed && path.basename(from).startsWith('.as-rename-') && path.basename(to) === 'A.jpg')
      throw new Error('drive refused restoration')
  })
  const error = await renameSheets({ folder, ops }).then(
    () => assert.fail('rename must fail'),
    (e) => e,
  )
  assert.ok(
    error.recoveryJournal && fs.existsSync(error.recoveryJournal),
    'the recovery plan is durable and discoverable',
  )
  assert.match(error.message, /recovery|recover|restor/i)
  t.mock.restoreAll()
  delete require.cache[require.resolve('../lib/labnaming')]
  const restarted = require('../lib/labnaming')
  const listed = await restarted.listSheets({ folder })
  assert.deepEqual(
    listed.sheets.map((s) => s.fileName),
    ['A.jpg', 'B.jpg', 'C.jpg'],
  )
  originalFiles(folder)
})

test('a destination appearing during commit is preserved without replacing a source', async (t) => {
  const { folder, p } = fixture(t)
  let appeared = false
  injectMove(t, (_from, to) => {
    if (!appeared && path.basename(to) === 'New.jpg') {
      appeared = true
      fs.writeFileSync(to, 'unrelated file')
    }
  })
  await assert.rejects(renameSheets({ folder, ops: [{ fromPath: p('A.jpg'), toBaseName: 'New' }] }), /exist|EEXIST/)
  assert.equal(fs.readFileSync(p('A.jpg'), 'utf8'), 'original A')
  assert.equal(fs.readFileSync(p('New.jpg'), 'utf8'), 'unrelated file')
  assert.deepEqual(fs.readdirSync(folder).sort(), ['A.jpg', 'B.jpg', 'C.jpg', 'New.jpg'])
})

test('duplicate source operations fail before any file is moved', async (t) => {
  const { folder, p } = fixture(t)
  await assert.rejects(
    renameSheets({
      folder,
      ops: [
        { fromPath: p('A.jpg'), toBaseName: 'New' },
        { fromPath: p('A.jpg'), toBaseName: 'Other' },
      ],
    }),
    /more than once|duplicate|twice/,
  )
  originalFiles(folder)
})

test('concurrent renames of a folder are rejected before racing file operations', async (t) => {
  const { folder, p } = fixture(t)
  let release
  let entered
  const paused = new Promise((resolve) => {
    release = resolve
  })
  const started = new Promise((resolve) => {
    entered = resolve
  })
  injectMove(t, async (from) => {
    if (path.basename(from) === 'A.jpg') {
      entered()
      await paused
    }
  })
  const first = renameSheets({ folder, ops: [{ fromPath: p('A.jpg'), toBaseName: 'New' }] })
  try {
    await started
    await assert.rejects(
      renameSheets({ folder, ops: [{ fromPath: p('B.jpg'), toBaseName: 'Other' }] }),
      /already|progress|busy/i,
    )
    await assert.rejects(listSheets({ folder }), /already|progress|busy/i)
  } finally {
    release()
    await first
  }
  assert.equal(fs.readFileSync(p('New.jpg'), 'utf8'), 'original A')
  assert.equal(fs.readFileSync(p('B.jpg'), 'utf8'), 'original B')
})

test('filesystems without hard links use exclusive copies and preserve contents and metadata', async (t) => {
  const { folder, p, ops } = fixture(t)
  fs.chmodSync(p('A.jpg'), 0o640)
  const timestamp = new Date('2021-02-03T04:05:06.000Z')
  fs.utimesSync(p('A.jpg'), timestamp, timestamp)
  let attempted = 0
  t.mock.method(fs.promises, 'link', async () => {
    attempted++
    throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' })
  })
  const result = await renameSheets({ folder, ops })
  assert.ok(attempted >= 6, 'staging and commit both exercised the fallback')
  assert.equal(fs.readFileSync(p('B.jpg'), 'utf8'), 'original A')
  assert.equal(fs.statSync(p('B.jpg')).mode & 0o777, 0o640)
  assert.ok(Math.abs(fs.statSync(p('B.jpg')).mtimeMs - timestamp.getTime()) < 1)
  await renameSheets({ folder, ops: result.undo })
  originalFiles(folder)
})

test('copy fallback still refuses a destination appearing during commit', async (t) => {
  const { folder, p } = fixture(t)
  t.mock.method(fs.promises, 'link', async () => {
    throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' })
  })
  const copy = fs.promises.copyFile.bind(fs.promises)
  t.mock.method(fs.promises, 'copyFile', async (from, to, flags) => {
    if (path.basename(to) === 'New.jpg') fs.writeFileSync(to, 'unrelated file')
    return copy(from, to, flags)
  })
  await assert.rejects(renameSheets({ folder, ops: [{ fromPath: p('A.jpg'), toBaseName: 'New' }] }), /EEXIST/)
  assert.equal(fs.readFileSync(p('A.jpg'), 'utf8'), 'original A')
  assert.equal(fs.readFileSync(p('New.jpg'), 'utf8'), 'unrelated file')
  assert.deepEqual(fs.readdirSync(folder).sort(), ['A.jpg', 'B.jpg', 'C.jpg', 'New.jpg'])
})

test('corrupt copy results preserve the source and a recovery journal instead of deleting data', async (t) => {
  const { folder, p } = fixture(t)
  t.mock.method(fs.promises, 'link', async () => {
    throw Object.assign(new Error('hard links unsupported'), { code: 'ENOTSUP' })
  })
  t.mock.method(fs.promises, 'copyFile', async (_from, to) => {
    await fs.promises.writeFile(to, 'corrupt copy', { flag: 'wx' })
  })
  const error = await renameSheets({ folder, ops: [{ fromPath: p('A.jpg'), toBaseName: 'New' }] }).then(
    () => assert.fail('corrupt copy must fail'),
    (e) => e,
  )
  assert.ok(error.recoveryJournal && fs.existsSync(error.recoveryJournal))
  assert.equal(fs.readFileSync(p('A.jpg'), 'utf8'), 'original A')
  assert.match(error.message, /changed during copying/)
})

test('restart recovers process crashes at staging, commit and incomplete exclusive-move boundaries', async (t) => {
  for (const boundary of ['staged-unlink', 'committed-unlink', 'committed-link', 'staged-copy']) {
    await t.test(boundary, async (childTest) => {
      const { folder, ops } = fixture(childTest)
      const modulePath = require.resolve('../lib/labnaming')
      const script = `
const fs = require('fs')
const path = require('path')
const boundary = ${JSON.stringify(boundary)}
const link = fs.promises.link.bind(fs.promises)
const unlink = fs.promises.unlink.bind(fs.promises)
const copy = fs.promises.copyFile.bind(fs.promises)
fs.promises.link = async (from, to) => {
  if (boundary === 'staged-copy') throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' })
  await link(from, to)
  if (boundary === 'committed-link' && path.basename(to) === 'B.jpg') process.exit(23)
}
fs.promises.unlink = async (file) => {
  await unlink(file)
  if (boundary === 'staged-unlink' && path.basename(file) === 'A.jpg') process.exit(23)
  if (boundary === 'committed-unlink' && /^\\.as-rename-.*-0\\.jpg$/.test(path.basename(file))) process.exit(23)
}
fs.promises.copyFile = async (from, to, flags) => {
  await copy(from, to, flags)
  if (boundary === 'staged-copy') process.exit(23)
}
require(${JSON.stringify(modulePath)}).renameSheets(${JSON.stringify({ folder, ops })}).then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
`
      await assert.rejects(runFile(process.execPath, ['-e', script]), (e) => e.code === 23)
      assert.ok(
        fs.readdirSync(folder).some((name) => /^\.as-rename-.*\.json$/.test(name)),
        'crash leaves a durable recovery plan',
      )
      const listed = await listSheets({ folder })
      assert.deepEqual(
        listed.sheets.map((sheet) => sheet.fileName),
        ['A.jpg', 'B.jpg', 'C.jpg'],
      )
      originalFiles(folder)
    })
  }
})

test('recovery rejects traversal in a journal before touching files outside the folder', async (t) => {
  const { folder } = fixture(t)
  const canonical = fs.realpathSync(folder)
  const journalFile = path.join(folder, '.as-rename-1234567890abcdef.json')
  fs.writeFileSync(
    journalFile,
    JSON.stringify({
      version: 1,
      folder: canonical,
      phase: 'staging',
      entries: [
        {
          from: '../outside.jpg',
          to: 'New.jpg',
          tmp: '.as-rename-1234567890abcdef-0.jpg',
          identity: { dev: '1', ino: '1', size: '1', mtimeNs: '1' },
        },
      ],
    }),
  )
  await assert.rejects(listSheets({ folder }), /Invalid sheet entry/)
  for (const name of ['A', 'B', 'C'])
    assert.equal(fs.readFileSync(path.join(folder, `${name}.jpg`), 'utf8'), `original ${name}`)
  assert.ok(fs.existsSync(journalFile), 'the invalid journal is retained for inspection')
})

test('distinct hard-link source names are rejected before creating an ambiguous recovery plan', async (t) => {
  const { folder, p } = fixture(t)
  fs.linkSync(p('A.jpg'), p('Alias.jpg'))
  await assert.rejects(
    renameSheets({
      folder,
      ops: [
        { fromPath: p('A.jpg'), toBaseName: 'New' },
        { fromPath: p('Alias.jpg'), toBaseName: 'Other' },
      ],
    }),
    /same physical file/,
  )
  assert.equal(fs.readFileSync(p('A.jpg'), 'utf8'), 'original A')
  assert.equal(fs.readFileSync(p('Alias.jpg'), 'utf8'), 'original A')
  assert.deepEqual(fs.readdirSync(folder).sort(), ['A.jpg', 'Alias.jpg', 'B.jpg', 'C.jpg'])
})

test('a journal write failure reports the recovery record and leaves every source untouched', async (t) => {
  const { folder, p } = fixture(t)
  const open = fs.promises.open.bind(fs.promises)
  t.mock.method(fs.promises, 'open', async (file, ...args) => {
    const handle = await open(file, ...args)
    if (/\.as-rename-[a-f0-9]{16}\.json$/.test(file)) {
      const write = handle.writeFile.bind(handle)
      t.mock.method(handle, 'writeFile', async () => {
        await write('{')
        throw Object.assign(new Error('journal drive error'), { code: 'EIO' })
      })
    }
    return handle
  })
  const error = await renameSheets({ folder, ops: [{ fromPath: p('A.jpg'), toBaseName: 'New' }] }).then(
    () => assert.fail('journal write must fail'),
    (e) => e,
  )
  assert.match(error.message, /journal drive error/)
  assert.ok(error.recoveryJournal && fs.existsSync(error.recoveryJournal))
  for (const name of ['A', 'B', 'C']) assert.equal(fs.readFileSync(p(`${name}.jpg`), 'utf8'), `original ${name}`)
})

test('folder-lock cleanup cannot hide a rename failure and a later operation can clear its own stale lock', async (t) => {
  const { folder, p, ops } = fixture(t)
  let failed = false
  injectMove(t, (from, to) => {
    if (!failed && path.basename(from).startsWith('.as-rename-') && path.basename(to) === 'C.jpg') {
      failed = true
      throw new Error('initial rename failure')
    }
  })
  const unlink = fs.promises.unlink.bind(fs.promises)
  t.mock.method(fs.promises, 'unlink', async (file) => {
    if (path.basename(file) === '.as-lab-rename.lock')
      throw Object.assign(new Error('lock cleanup failed'), { code: 'EIO' })
    return unlink(file)
  })
  const error = await renameSheets({ folder, ops }).then(
    () => assert.fail('rename must fail'),
    (e) => e,
  )
  assert.match(error.message, /initial rename failure/)
  assert.match(error.message, /lock cleanup failed/)
  assert.ok(error.recoveryLock && fs.existsSync(error.recoveryLock))
  t.mock.restoreAll()
  const result = await renameSheets({ folder, ops: [{ fromPath: p('A.jpg'), toBaseName: 'New' }] })
  await renameSheets({ folder, ops: result.undo })
  originalFiles(folder)
})

test('filesystems without usable inode identities still preserve an unrelated same-size destination', async (t) => {
  const { folder, p } = fixture(t)
  const lstat = fs.promises.lstat.bind(fs.promises)
  t.mock.method(fs.promises, 'lstat', async (...args) => {
    const st = await lstat(...args)
    st.ino = 0n
    st.mtimeNs = 0n
    return st
  })
  let appeared = false
  injectMove(t, (_from, to) => {
    if (!appeared && path.basename(to) === 'New.jpg') {
      appeared = true
      fs.writeFileSync(to, 'different!') // the same length as "original A"
    }
  })
  await assert.rejects(renameSheets({ folder, ops: [{ fromPath: p('A.jpg'), toBaseName: 'New' }] }), /EEXIST/)
  assert.equal(fs.readFileSync(p('A.jpg'), 'utf8'), 'original A')
  assert.equal(fs.readFileSync(p('New.jpg'), 'utf8'), 'different!')
  assert.deepEqual(fs.readdirSync(folder).sort(), ['A.jpg', 'B.jpg', 'C.jpg', 'New.jpg'])
})
