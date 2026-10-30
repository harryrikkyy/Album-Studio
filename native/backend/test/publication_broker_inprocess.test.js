'use strict'
// The native publication broker run in this process, so its failure paths can be injected:
// unresolvable targets, a staged file that won't close, a retained input that can't move into
// history after commit, and a namespace release that fails. Replies must keep their fields.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { PassThrough } = require('node:stream')
const { tmpdir } = require('./fixtures')
const exclusive = require('../lib/exclusive_rename')
const namespace = require('../lib/namespace_lock')
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const injected = (message) => Object.assign(new Error(message), { code: 'EIO' })
function frame(value) {
  const b = Buffer.from(JSON.stringify(value)),
    h = Buffer.alloc(4)
  h.writeUInt32BE(b.length)
  return Buffer.concat([h, b])
}
function fixture(t) {
  const root = tmpdir(),
    output = path.join(root, 'Sheets'),
    target = path.join(output, 'manual.psd')
  fs.mkdirSync(output)
  fs.writeFileSync(target, 'customer bytes')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return {
    output,
    target,
    next: Buffer.from('saved document bytes'),
    stages: path.join(output, '.album-studio-publications'),
  }
}
function broker(f, module = require('../lib/publication_broker')) {
  const input = new PassThrough(),
    output = new PassThrough(),
    replies = [],
    waiting = []
  let text = ''
  output.on('data', (chunk) => {
    text += chunk
    for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n')) {
      const value = JSON.parse(text.slice(0, end))
      text = text.slice(end + 1)
      if (waiting.length) waiting.shift()(value)
      else replies.push(value)
    }
  })
  const done = module.run({ input, output })
  input.write(frame({ version: 1, target: f.target, expected: { mode: 'overwrite' } }))
  return {
    input,
    done,
    next: () => (replies.length ? Promise.resolve(replies.shift()) : new Promise((resolve) => waiting.push(resolve))),
    send(bytes, declared = bytes.length, digest = sha(bytes)) {
      input.write(frame({ length: declared, digest }))
      input.write(bytes)
    },
  }
}
const inputStage = (f, stage) =>
  assert.ok(
    stage.startsWith(path.join(f.stages, '.prepare-input-')) && fs.readdirSync(stage).join() === 'source',
    `${stage} should be the kept input stage`,
  )

test('a target whose name on disk cannot be resolved fails before any bytes are read', async (t) => {
  const f = fixture(t)
  fs.rmSync(f.target)
  fs.symlinkSync(f.target, f.target)
  const b = broker(f)
  const reply = await b.next()
  assert.deepEqual(Object.keys(reply.error), ['message', 'code'])
  assert.equal(reply.state, 'failed')
  assert.equal(reply.error.code, 'ELOOP')
  assert.ok(reply.error.message.includes(f.target))
  assert.equal(await b.done, false)
  assert.equal(fs.existsSync(f.stages), false)
})

test('a staged document that cannot be closed keeps its stage, alone or after a short read', async (t) => {
  for (const short of [false, true]) {
    const f = fixture(t),
      open = fs.promises.open
    t.mock.method(fs.promises, 'open', async function (file, ...rest) {
      const handle = await open.call(this, file, ...rest)
      if (String(file).endsWith(`${path.sep}source`)) {
        const close = handle.close
        handle.close = async () => {
          await close.call(handle)
          throw injected('injected close failure')
        }
      }
      return handle
    })
    const b = broker(f)
    assert.equal((await b.next()).state, 'ready')
    b.send(f.next, f.next.length + (short ? 10 : 0))
    if (short) b.input.end()
    const { state, error } = await b.next()
    assert.equal(state, 'failed')
    assert.deepEqual(
      { ...error, recoveryStage: undefined },
      {
        message: short
          ? 'The native publication input ended before the declared bytes arrived. Closing the staged file also failed: injected close failure'
          : 'injected close failure',
        code: short ? 'PUBLICATION_PROTOCOL' : 'EIO',
        recoveryStage: undefined,
      },
    )
    inputStage(f, error.recoveryStage)
    assert.equal(await b.done, false)
    assert.equal(fs.readFileSync(f.target, 'utf8'), 'customer bytes')
    fs.promises.open.mock.restore()
  }
})

test('a committed save whose input cannot move into history says it was committed', async (t) => {
  const f = fixture(t),
    rename = exclusive.renameExclusive
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    if (to.includes(`${path.sep}inputs${path.sep}`)) throw injected('injected history move failure')
    return rename(from, to)
  })
  const b = broker(f)
  assert.equal((await b.next()).state, 'ready')
  b.send(f.next)
  assert.equal((await b.next()).state, 'prepared')
  b.input.end(frame({ commit: true }))
  const { state, error } = await b.next()
  assert.equal(state, 'failed')
  assert.deepEqual(
    { ...error, recoveryStage: undefined },
    { message: 'injected history move failure', code: 'EIO', recoveryStage: undefined, publicationCommitted: true },
  )
  inputStage(f, error.recoveryStage)
  assert.equal(await b.done, false)
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'saved document bytes')
})

test('a namespace release failure is reported after a commit, or appended to an earlier failure', async (t) => {
  for (const earlier of [false, true]) {
    const f = fixture(t),
      acquire = namespace.acquirePublicationDirectories
    t.mock.method(namespace, 'acquirePublicationDirectories', async (...args) => {
      const lease = await acquire(...args),
        release = lease.release
      lease.release = async () => {
        await release.call(lease)
        throw injected('injected release failure')
      }
      return lease
    })
    // The broker binds acquirePublicationDirectories when it loads, so load a copy after the mock.
    const file = require.resolve('../lib/publication_broker'),
      saved = require.cache[file]
    delete require.cache[file]
    const fresh = require(file)
    require.cache[file] = saved
    const b = broker(f, fresh)
    assert.equal((await b.next()).state, 'ready')
    b.send(f.next, f.next.length, earlier ? 'f'.repeat(64) : sha(f.next))
    if (!earlier) {
      assert.equal((await b.next()).state, 'prepared')
      b.input.end(frame({ commit: true }))
    }
    const { state, error } = await b.next()
    assert.equal(state, 'failed')
    if (earlier) {
      assert.deepEqual(
        { ...error, recoveryStage: undefined },
        {
          message:
            'The native document bytes did not match their declared SHA-256. Namespace release also failed: injected release failure',
          code: 'PUBLICATION_PROTOCOL',
          recoveryStage: undefined,
        },
      )
      inputStage(f, error.recoveryStage)
      assert.equal(fs.readFileSync(f.target, 'utf8'), 'customer bytes')
    } else {
      assert.deepEqual(
        { ...error, recoveryStage: undefined },
        { message: 'injected release failure', code: 'EIO', recoveryStage: undefined, publicationCommitted: true },
      )
      assert.ok(error.recoveryStage.startsWith(path.join(f.stages, 'history', 'files-')))
      assert.ok(fs.existsSync(error.recoveryStage))
      assert.equal(fs.readFileSync(f.target, 'utf8'), 'saved document bytes')
    }
    assert.equal(await b.done, false)
    namespace.acquirePublicationDirectories.mock.restore()
  }
})
