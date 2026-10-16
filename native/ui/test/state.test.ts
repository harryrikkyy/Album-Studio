import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type * as State from '../src/state.ts'
import type { Album } from '../src/types.ts'

const source = fileURLToPath(new URL('../src/state.ts', import.meta.url))
const bundle = build({ entryPoints: [source], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022' }).then(r => r.outputFiles[0]!.text)
const examples = JSON.parse(readFileSync(new URL('../../contracts/examples.json', import.meta.url), 'utf8')).methods
let sequence = 0
async function fixture(t: test.TestContext) {
  const previous = globalThis.window
  const sent: { id: number; method: string }[] = [], timers = new Set<number>()
  const originalClear = globalThis.clearTimeout.bind(globalThis)
  t.mock.method(globalThis, 'clearTimeout', (id: ReturnType<typeof setTimeout>) => { timers.delete(Number(id)); originalClear(id) })
  const window = {
    ipc: { postMessage(text: string) { sent.push(JSON.parse(text)) } },
    setTimeout(fn: () => void, ms: number) { const id = Number(setTimeout(() => { timers.delete(id); fn() }, ms)); timers.add(id); return id },
  } as unknown as Window & typeof globalThis
  globalThis.window = window
  const state: typeof State = await import(`data:text/javascript;base64,${Buffer.from(await bundle + `\n// state fixture ${sequence++}`).toString('base64')}`)
  t.after(() => { for (const id of timers) originalClear(id); globalThis.window = previous })
  return { state, sent, timers,
    answer(index: number, result: unknown) { window.__asReply!({ id: sent[index]!.id, ok: true, result }) },
    fail(index: number, error: string) { window.__asReply!({ id: sent[index]!.id, ok: false, error, code: 'TEST_FAULT' }) },
  }
}
const albumAt = (path: string): Album => ({ ...structuredClone(examples['album.open'][1]), path, name: path, file: `${path}/project.json` })

test('a late album-open response cannot replace the album chosen more recently', async t => {
  const f = await fixture(t), a = f.state.openAlbum('/A'), b = f.state.openAlbum('/B')
  f.answer(1, albumAt('/B')); await b
  f.answer(2, []); await Promise.resolve() // the successful open refreshes recents
  f.answer(0, albumAt('/A')); await a
  assert.equal(f.state.album.value?.path, '/B')
  assert.equal(f.state.place.value, 'plan'); assert.equal(f.state.albumLoading.value, null)
})
test('an older failed open neither clears a newer loading state nor displays an unrelated error', async t => {
  const f = await fixture(t), a = f.state.openAlbum('/A'), b = f.state.openAlbum('/B')
  f.fail(0, 'A is disconnected'); await a
  assert.equal(f.state.albumLoading.value, '/B')
  assert.equal(f.state.albumError.value, null); assert.equal(f.state.toasts.value.length, 0)
  f.answer(1, albumAt('/B')); await b; f.answer(2, []); await Promise.resolve()
})
test('an older recents failure cannot overwrite a successful newer refresh', async t => {
  const f = await fixture(t), first = f.state.loadRecent(), second = f.state.loadRecent()
  f.answer(1, examples['album.recent'][1]); await second
  f.fail(0, 'Old request failed'); await first
  assert.deepEqual(f.state.recent.value, examples['album.recent'][1])
  assert.equal(f.state.recentError.value, null); assert.equal(f.state.recentLoading.value, false)
})
test('failed and genuinely empty recents remain distinguishable through a retry', async t => {
  const f = await fixture(t), failed = f.state.loadRecent()
  f.fail(0, 'The drive is disconnected'); await failed
  assert.equal(f.state.recentError.value, 'The drive is disconnected')
  assert.equal(f.state.recentLoading.value, false)
  const retry = f.state.loadRecent()
  assert.equal(f.state.recentLoading.value, true)
  f.answer(1, []); await retry
  assert.deepEqual(f.state.recent.value, [])
  assert.equal(f.state.recentError.value, null); assert.equal(f.state.recentLoading.value, false)
})
test('actionable errors remain until dismissed even when a caller supplies an expiry', async t => {
  const f = await fixture(t)
  f.state.toast('error', 'Reconnect the album drive', 1)
  assert.equal(f.timers.size, 0); assert.equal(f.state.toasts.value.length, 1)
  f.state.dismissToast(f.state.toasts.value[0]!.id)
  assert.equal(f.state.toasts.value.length, 0)
  f.state.toast('info', 'Spread added', 1000)
  assert.equal(f.timers.size, 1)
})

test('a quiet refresh cannot replace an edit applied while the read was pending', async t => {
  const f = await fixture(t), initial = albumAt('/A')
  f.state.album.value = initial
  const refresh = f.state.openAlbumQuietly('/A')
  f.state.album.value = { ...initial, name: 'A with a newer edit' }
  f.answer(0, { ...initial, name: 'A before the edit' }); await refresh
  assert.equal(f.state.album.value.name, 'A with a newer edit')
})
test('a quiet refresh belongs to the open context that requested it, including while a new album loads', async t => {
  const f = await fixture(t), initial = albumAt('/A')
  f.state.album.value = initial
  const refresh = f.state.openAlbumQuietly('/A'), open = f.state.openAlbum('/B')
  f.answer(0, { ...initial, name: 'A from an older context' }); await refresh
  const nameWhileOpening = f.state.album.value.name
  f.answer(1, albumAt('/B')); await open; f.answer(2, []); await Promise.resolve()
  assert.equal(nameWhileOpening, initial.name)
  assert.equal(f.state.album.value.path, '/B')
})
test('out-of-order quiet refreshes cannot replace the newest confirmed result', async t => {
  const f = await fixture(t), initial = albumAt('/A')
  f.state.album.value = initial
  const first = f.state.openAlbumQuietly('/A'), second = f.state.openAlbumQuietly('/A')
  f.answer(1, { ...initial, name: 'Newest' }); await second
  f.answer(0, { ...initial, name: 'Older' }); await first
  assert.equal(f.state.album.value.name, 'Newest')
})
