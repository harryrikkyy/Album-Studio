import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as Bridge from '../src/bridge.ts'

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/bridge.ts')
const bundle = build({
  entryPoints: [source],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
}).then((result) => result.outputFiles[0]!.text)
let sequence = 0
async function fixture(t: test.TestContext, post?: (message: string) => void) {
  const previous = globalThis.window,
    sent: { id: number; method: string; params: unknown }[] = [],
    timers = new Set<number>()
  const originalClear = globalThis.clearTimeout.bind(globalThis)
  t.mock.method(globalThis, 'clearTimeout', (id: ReturnType<typeof setTimeout>) => {
    timers.delete(Number(id))
    originalClear(id)
  })
  const window = {
    ipc: {
      postMessage(text: string) {
        sent.push(JSON.parse(text))
        post?.(text)
      },
    },
    setTimeout(fn: () => void, ms: number) {
      const id = Number(
        setTimeout(() => {
          timers.delete(id)
          fn()
        }, ms),
      )
      timers.add(id)
      return id
    },
  } as unknown as Window & typeof globalThis
  globalThis.window = window
  const bridge: typeof Bridge = await import(
    `data:text/javascript;base64,${Buffer.from((await bundle) + `\n// fixture ${sequence++}`).toString('base64')}`
  )
  t.after(() => {
    for (const id of timers) originalClear(id)
    globalThis.window = previous
  })
  return { bridge, window, sent, timers }
}

test('the actual bundled browser bridge validates a request and its matching method result', async (t) => {
  const f = await fixture(t),
    answer = f.bridge.call('system.ping', { n: 7 })
  assert.equal(f.sent.length, 1)
  assert.equal(f.timers.size, 1)
  f.window.__asReply!({ id: f.sent[0]!.id, ok: true, result: { pong: 7, node: 'v22.23.3' } })
  assert.deepEqual(await answer, { pong: 7, node: 'v22.23.3' })
  assert.equal(f.timers.size, 0)
})
test('invalid parameters, timeouts and cyclic values never create a pending native request', async (t) => {
  const f = await fixture(t)
  await assert.rejects(f.bridge.call('album.open', { path: '' }), /Invalid/)
  await assert.rejects(f.bridge.call('system.ping', {}, Infinity), /timeout/)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  await assert.rejects(f.bridge.call('system.ping', { n: cyclic } as never), /Cyclic/)
  assert.equal(f.sent.length, 0)
  assert.equal(f.timers.size, 0)
})
test('native post failures settle the waiter immediately and clear its timeout', async (t) => {
  const f = await fixture(t, () => {
    throw new Error('native channel closed')
  })
  await assert.rejects(f.bridge.call('system.ping'), /native channel closed/)
  assert.equal(f.timers.size, 0)
})
test('a reply with a valid id but wrong method result rejects and clears its waiter', async (t) => {
  const f = await fixture(t),
    errors: Error[] = []
  f.bridge.onProtocolError((error) => errors.push(error))
  const answer = f.bridge.call('system.ping')
  f.window.__asReply!({ id: f.sent[0]!.id, ok: true, result: { unexpected: 'payload' } })
  await assert.rejects(answer, /Invalid system.ping result/)
  assert.equal(errors.length, 1)
  assert.equal(f.timers.size, 0)
})
test('uncorrelatable malformed replies settle all live waiters without trusting their payload', async (t) => {
  const f = await fixture(t),
    first = f.bridge.call('system.ping'),
    second = f.bridge.call('system.ping')
  f.window.__asReply!(null)
  await assert.rejects(first, /Invalid/)
  await assert.rejects(second, /Invalid/)
  assert.equal(f.timers.size, 0)
})
test('structured recovery and commit errors survive the native reply boundary', async (t) => {
  const f = await fixture(t),
    answer = f.bridge.call('system.ping')
  f.window.__asReply!({
    id: f.sent[0]!.id,
    ok: false,
    error: 'saved, history needs review',
    code: 'RECOVERY_REQUIRED',
    renderCommitted: true,
    recoveryRequired: true,
    retainedPath: '/safe/history',
  })
  await assert.rejects(answer, (error: unknown) => {
    assert.ok(error instanceof f.bridge.RemoteError)
    assert.equal(error.code, 'RECOVERY_REQUIRED')
    assert.equal(error.details.renderCommitted, true)
    assert.equal(error.details.retainedPath, '/safe/history')
    return true
  })
  assert.equal(f.timers.size, 0)
})
test('malformed events are refused, and one failing listener cannot prevent the others from running', async (t) => {
  const f = await fixture(t),
    seen: unknown[] = [],
    errors: Error[] = []
  f.bridge.onProtocolError((error) => errors.push(error))
  f.bridge.onEvent('backend.ready', () => {
    throw new Error('listener failed')
  })
  f.bridge.onEvent('backend.ready', (data) => seen.push(data))
  f.window.__asEvent!({ event: 'backend.ready', data: { pid: 'bad', node: 'v22' } })
  assert.equal(seen.length, 0)
  f.window.__asEvent!({ event: 'backend.ready', data: { pid: 7, node: 'v22.23.3' } })
  assert.deepEqual(seen, [{ pid: 7, node: 'v22.23.3' }])
  assert.equal(errors.length, 2)
})
test('pending request capacity is bounded and recovered after the outstanding replies settle', async (t) => {
  const f = await fixture(t),
    requests = Array.from({ length: 128 }, () => f.bridge.call('system.ping'))
  await assert.rejects(f.bridge.call('system.ping'), /Too many requests/)
  assert.equal(f.sent.length, 128)
  for (const request of f.sent) f.window.__asReply!({ id: request.id, ok: true, result: { pong: null, node: 'v22' } })
  await Promise.all(requests)
  assert.equal(f.timers.size, 0)
  const next = f.bridge.call('system.ping'),
    id = f.sent.at(-1)!.id
  f.window.__asReply!({ id, ok: true, result: { pong: null, node: 'v22' } })
  await next
})
test('native events with an allowed absent payload deliver their declared empty object', async (t) => {
  const f = await fixture(t),
    seen: unknown[] = []
  f.bridge.onEvent('backend.exited', (data) => {
    seen.push(data)
    assert.equal(data.error, undefined)
  })
  f.window.__asEvent!({ event: 'backend.exited' })
  assert.deepEqual(seen, [{}])
})
