import test from 'node:test'
import assert from 'node:assert/strict'
import { albumQueue } from '../src/album_queue.ts'

test('queued edit and undo retain the album selected when requested', async () => {
  let album: { path: string } | null = { path: 'A' }
  const queue = albumQueue(() => album), requests: string[] = []
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const firstStarted = new Promise<void>((resolve) => { started = resolve })
  const first = queue(async (a) => { started(); await blocked; requests.push(`edit:${a.path}`) })
  await firstStarted
  const second = queue(async (a) => { requests.push(`undo:${a.path}`) })
  album = { path: 'B' }
  release(); await Promise.all([first, second])
  assert.deepEqual(requests, ['edit:A', 'undo:A'])
})

test('an operation requested without an album cannot mutate an album opened later', async () => {
  let album: { path: string } | null = null
  const queue = albumQueue(() => album), requests: string[] = []
  const pending = queue(async (a) => { requests.push(a.path) })
  album = { path: 'B' }
  assert.equal(await pending, null)
  assert.deepEqual(requests, [])
})

test('a failed edit does not strand later work, including a captured different album', async () => {
  let album: { path: string } | null = { path: 'A' }
  const queue = albumQueue(() => album)
  const first = queue(async () => { throw new Error('write failed') })
  const second = queue(async (a) => a.path)
  album = { path: 'B' }
  const third = queue(async (a) => a.path)
  await assert.rejects(first, /write failed/)
  assert.equal(await second, 'A')
  assert.equal(await third, 'B')
})
