'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { tmpdir } = require('./fixtures')
const { PhotoCraftSession } = require('../lib/photocraft')

async function bounded(promise, ms = 1000) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation did not settle in time')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function makeSession(t, { missing = false, ignoreTermination = false, malformed = false, ...options } = {}) {
  const dir = tmpdir()
  const binary = path.join(dir, 'engine')
  if (!missing) {
    fs.writeFileSync(
      binary,
      `#!${process.execPath}
const readline = require('readline')
${malformed ? 'process.stdout.write(\'null\\ninvalid JSON\\n{"id":"wrong"}\\n\')' : ''}
${ignoreTermination ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)" : ''}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'stall') return
  if (msg.method === 'exit') { process.stderr.write('fixture engine stopped\\n'); process.exit(7) }
  if (msg.method === 'fail') { process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: 'bad command' }) + '\\n'); return }
  process.stdout.write(JSON.stringify({ id: msg.id, ok: true, result: msg.params }) + '\\n')
})
`,
      { mode: 0o755 },
    )
  }
  const previous = process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI
  process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI = binary
  const pc = new PhotoCraftSession({
    writeRoot: dir,
    requestTimeoutMs: 100,
    shutdownTimeoutMs: 40,
    forceKillTimeoutMs: 200,
    ...options,
  })
  if (previous === undefined) delete process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI
  else process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI = previous
  t.after(async () => {
    pc.proc.kill('SIGKILL')
    await bounded(pc.close()).catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return pc
}

test('missing engine rejects commands and shutdown settles without an exit event', async (t) => {
  const pc = makeSession(t, { missing: true })
  await assert.rejects(bounded(pc.call('echo')), /couldn't start|didn't accept/)
  await bounded(pc.close())
  assert.equal(pc.waiting.size, 0)
  await assert.rejects(bounded(pc.call('echo')), /couldn't start|stopped|closed/)
})

test('engine responses retain IDs, errors and legitimate requests before the deadline', async (t) => {
  const pc = makeSession(t, { requestTimeoutMs: 1000 })
  assert.deepEqual(await pc.call('echo', { value: 42 }), { value: 42 })
  await assert.rejects(pc.call('fail'), /bad command/)
  assert.deepEqual(await pc.call('echo', { value: 43 }), { value: 43 })
  assert.equal(pc.waiting.size, 0)
  await bounded(pc.close())
})

test('hung commands reject all pending calls and make the session unavailable', async (t) => {
  const pc = makeSession(t, { requestTimeoutMs: 1000, ignoreTermination: true })
  await pc.call('echo', { ready: true })
  pc.requestTimeoutMs = 60
  const requests = await bounded(Promise.allSettled([pc.call('stall'), pc.call('stall')]))
  assert.ok(requests.every((r) => r.status === 'rejected' && /timed out/.test(r.reason.message)))
  assert.equal(pc.waiting.size, 0)
  await assert.rejects(bounded(pc.call('echo')), /timed out|stopped|closed/)
  await bounded(pc.close())
  assert.equal(pc.proc.signalCode, 'SIGKILL')
})

test('shutdown escalates to SIGKILL when the engine ignores EOF and SIGTERM', async (t) => {
  const pc = makeSession(t, { ignoreTermination: true, requestTimeoutMs: 1000 })
  await pc.call('echo', { ready: true })
  const pending = assert.rejects(pc.call('stall'), /closing|closed|stopped/)
  await bounded(Promise.all([pc.close(), pc.close(), pending]))
  assert.equal(pc.proc.signalCode, 'SIGKILL')
  await assert.rejects(bounded(pc.call('echo')), /closing|closed|stopped/)
})

test('an unexpected exit rejects pending and future requests', async (t) => {
  const pc = makeSession(t, { requestTimeoutMs: 1000 })
  await assert.rejects(pc.call('exit'), /PhotoCraft stopped \(7\).*fixture engine stopped/)
  await assert.rejects(bounded(pc.call('echo')), /stopped/)
  await bounded(pc.close())
})

test('a cyclic request fails immediately without leaking a pending response', async (t) => {
  const pc = makeSession(t, { requestTimeoutMs: 1000 })
  const params = {}
  params.self = params
  await assert.rejects(pc.call('echo', params), /circular/i)
  assert.equal(pc.waiting.size, 0)
  assert.deepEqual(await pc.call('echo', { ready: true }), { ready: true })
})

test('malformed engine output is ignored without breaking a valid response', async (t) => {
  const pc = makeSession(t, { malformed: true, requestTimeoutMs: 1000 })
  assert.deepEqual(await pc.call('echo', { ready: true }), { ready: true })
})

test('shutdown reports its process when even SIGKILL cannot complete within the final deadline', async (t) => {
  const pc = makeSession(t, { ignoreTermination: true, requestTimeoutMs: 1000 })
  await pc.call('echo', { ready: true })
  t.mock.method(pc.proc, 'kill', () => false)
  try {
    await assert.rejects(bounded(pc.close()), new RegExp(`process ${pc.proc.pid} did not stop after SIGKILL`))
  } finally {
    t.mock.restoreAll()
    pc.proc.kill('SIGKILL')
    await bounded(pc.exited)
  }
})

test('write sandbox allows dot-prefixed names within the root and rejects traversal', async (t) => {
  const pc = makeSession(t, { requestTimeoutMs: 1000 })
  assert.equal(pc.writePath(path.join(pc.writeRoot, '..preview.jpg')), '..preview.jpg')
  assert.throws(() => pc.writePath(path.join(pc.writeRoot, '..', 'outside.jpg')), /outside/)
  assert.throws(() => pc.writePath(pc.writeRoot), /outside/)
})
