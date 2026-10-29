'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { Writable } = require('stream')
const { createProtocolWriter } = require('../lib/protocol_writer')
const observed = (promise) => {
  promise.catch(() => {})
  return promise
}
class Controlled extends EventEmitter {
  constructor(accepts = false) {
    super()
    this.accepts = accepts
    this.frames = []
    this.callbacks = []
  }
  write(bytes, callback) {
    this.frames.push(bytes.toString('utf8'))
    this.callbacks.push(callback)
    return this.accepts
  }
  finish(index = 0) {
    this.callbacks[index]()
    this.emit('drain')
  }
}
function fixture(t, options = {}, stream = new Controlled()) {
  const writer = createProtocolWriter(stream, { writeTimeoutMs: 5000, ...options })
  t.after(() => stream.emit('close'))
  return { stream, writer, write: (value) => observed(writer.write(value)) }
}
test('a real Writable is serialized and waits for native backpressure before the next frame', async (t) => {
  class SlowWritable extends Writable {
    constructor() {
      super({ highWaterMark: 1 })
      this.frames = []
      this.callbacks = []
    }
    _write(bytes, _encoding, done) {
      this.frames.push(bytes.toString('utf8'))
      this.callbacks.push(done)
    }
  }
  const stream = new SlowWritable(),
    f = fixture(t, {}, stream),
    first = f.write({ seq: 1 }),
    second = f.write({ seq: 2 })
  assert.equal(stream.frames.length, 1)
  assert.equal(f.writer.stats.pendingMessages, 2)
  stream.callbacks[0]()
  await first
  assert.equal(stream.frames.length, 2)
  stream.callbacks[1]()
  await second
  await f.writer.flush()
  assert.deepEqual(stream.frames, ['{"seq":1}\n', '{"seq":2}\n'])
  assert.equal(f.writer.stats.pendingBytes, 0)
})
test('a successful callback does not bypass an outstanding drain', async (t) => {
  const f = fixture(t),
    first = f.write({ seq: 1 }),
    second = f.write({ seq: 2 })
  let done = false
  first.then(() => {
    done = true
  })
  f.stream.callbacks[0]()
  await Promise.resolve()
  assert.equal(done, false)
  assert.equal(f.stream.frames.length, 1)
  f.stream.emit('drain')
  await first
  assert.equal(f.stream.frames.length, 2)
  f.stream.finish(1)
  await second
})
test('drain does not bypass an outstanding write callback', async (t) => {
  const f = fixture(t),
    first = f.write({ seq: 1 }),
    second = f.write({ seq: 2 })
  assert.equal(f.writer.stats.backpressured, true)
  f.stream.emit('drain')
  await Promise.resolve()
  assert.equal(f.stream.frames.length, 1)
  assert.equal(f.writer.stats.backpressured, false)
  f.stream.callbacks[0]()
  await first
  assert.equal(f.stream.frames.length, 2)
  f.stream.finish(1)
  await second
})
test('nonbackpressured writes still await their callbacks', async (t) => {
  const f = fixture(t, {}, new Controlled(true)),
    first = f.write(1),
    second = f.write(2)
  assert.equal(f.stream.frames.length, 1)
  f.stream.callbacks[0]()
  await first
  assert.equal(f.stream.frames.length, 2)
  f.stream.callbacks[1]()
  await second
})
test('synchronous callback and drain before a false return do not deadlock', async (t) => {
  const stream = new Controlled()
  stream.write = function (bytes, callback) {
    this.frames.push(bytes.toString())
    callback()
    this.emit('drain')
    return false
  }
  const f = fixture(t, {}, stream)
  await f.write(1)
  await f.write(2)
  await f.writer.flush()
  assert.deepEqual(stream.frames, ['1\n', '2\n'])
})
test('queued byte and message limits include the active frame and reject without submission', async (t) => {
  const f = fixture(t, { maxMessageBytes: 16, maxQueuedBytes: 16, maxQueuedMessages: 2 }),
    first = f.write({ x: 1 }),
    second = f.write({ x: 2 })
  assert.equal(f.writer.stats.pendingBytes, 16)
  await assert.rejects(
    f.write({ x: 3 }),
    (e) =>
      e.code === 'PROTOCOL_CAPACITY' && e.admitted === false && e.submitted === false && e.deliveryUnknown === false,
  )
  assert.equal(f.stream.frames.length, 1)
  const ready = observed(f.writer.waitForCapacity(8))
  f.stream.finish(0)
  await first
  await ready
  const third = f.write({ x: 3 })
  assert.equal(f.writer.stats.pendingBytes, 16)
  f.stream.finish(1)
  await second
  f.stream.finish(2)
  await third
  assert.deepEqual(f.stream.frames, ['{"x":1}\n', '{"x":2}\n', '{"x":3}\n'])
})
test('frame limits measure UTF-8 plus newline before admission', async (t) => {
  const f = fixture(t, { maxMessageBytes: 5, maxQueuedBytes: 5 }),
    accepted = f.write('é')
  await assert.rejects(
    f.write('éé'),
    (e) => e.code === 'PROTOCOL_MESSAGE_LIMIT' && e.admitted === false && e.submitted === false,
  )
  assert.equal(f.writer.stats.pendingBytes, 5)
  f.stream.finish()
  await accepted
  assert.equal(f.stream.frames[0], '"é"\n')
})
test('byte-pressure rejection reports the exact capacity needed to avoid a busy retry loop', async (t) => {
  const f = fixture(t, { maxMessageBytes: 16, maxQueuedBytes: 16 }),
    first = f.write({ x: 1 })
  const error = await f.write({ xx: 2 }).then(
    () => null,
    (e) => e,
  )
  assert.equal(error.code, 'PROTOCOL_CAPACITY')
  assert.equal(error.requiredBytes, 9)
  let ready = false
  const waiting = observed(
    f.writer.waitForCapacity(error.requiredBytes).then(() => {
      ready = true
    }),
  )
  await Promise.resolve()
  assert.equal(ready, false)
  f.stream.finish()
  await first
  await waiting
  const retried = f.write({ xx: 2 })
  f.stream.finish(1)
  await retried
})
test('serialization failures do not poison the channel or create queued bytes', async (t) => {
  const f = fixture(t),
    cyclic = {}
  cyclic.self = cyclic
  await assert.rejects(f.write(cyclic), (e) => e.code === 'PROTOCOL_SERIALIZE' && e.submitted === false)
  await assert.rejects(f.write(undefined), (e) => e.code === 'PROTOCOL_SERIALIZE')
  assert.equal(f.writer.stats.pendingBytes, 0)
  const valid = f.write(null)
  f.stream.finish()
  await valid
  assert.equal(f.stream.frames[0], 'null\n')
})
test('stream errors distinguish an uncertain submitted frame from accepted but unsent frames', async (t) => {
  const f = fixture(t, { maxQueuedMessages: 2 }),
    first = f.write(1),
    second = f.write(2),
    ready = observed(f.writer.waitForCapacity()),
    flush = observed(f.writer.flush())
  const cause = Object.assign(new Error('native pipe closed'), { code: 'EPIPE' })
  f.stream.emit('error', cause)
  await assert.rejects(
    first,
    (e) =>
      e.code === 'PROTOCOL_STREAM_FAILED' &&
      e.admitted === true &&
      e.submitted === true &&
      e.deliveryUnknown === true &&
      e.cause === cause,
  )
  await assert.rejects(second, (e) => e.admitted === true && e.submitted === false && e.deliveryUnknown === false)
  await assert.rejects(ready, /unavailable/)
  await assert.rejects(flush, /unavailable/)
  await assert.rejects(f.write(3), (e) => e.admitted === false && e.submitted === false)
  assert.equal(f.writer.stats.pendingBytes, 0)
  assert.equal(f.writer.stats.pendingMessages, 0)
  assert.equal(f.writer.stats.failed, true)
})
test('write callback failures settle every accepted frame exactly once', async (t) => {
  const f = fixture(t),
    first = f.write(1),
    second = f.write(2)
  f.stream.callbacks[0](new Error('write callback failed'))
  await assert.rejects(first, /write callback failed/)
  await assert.rejects(second, /write callback failed/)
  f.stream.callbacks[0]()
  f.stream.emit('drain')
  assert.equal(f.stream.frames.length, 1)
  assert.equal(f.writer.stats.rejected, 2)
})
test('a synchronous write exception has uncertain submission and fails queued work closed', async (t) => {
  const stream = new Controlled()
  stream.write = () => {
    throw new Error('write syscall threw')
  }
  const f = fixture(t, {}, stream)
  await assert.rejects(f.write(1), (e) => e.submitted === true && e.deliveryUnknown === true)
  await assert.rejects(f.write(2), (e) => e.submitted === false)
})
test('a blocked pipe reaches a bounded deadline without resubmitting or leaking its queue', async (t) => {
  const f = fixture(t, { writeTimeoutMs: 20 }),
    first = f.write(1),
    second = f.write(2)
  await assert.rejects(first, (e) => e.submitted === true && e.cause.code === 'PROTOCOL_WRITE_TIMEOUT')
  await assert.rejects(second, (e) => e.submitted === false)
  assert.equal(f.writer.stats.pendingMessages, 0)
  assert.equal(f.stream.frames.length, 1)
})
test('capacity and flush waiter metadata is bounded independently of frame bytes', async (t) => {
  const f = fixture(t, { maxQueuedMessages: 1, maxWaiters: 1 }),
    first = f.write(1),
    ready = observed(f.writer.waitForCapacity())
  await assert.rejects(f.writer.flush(), (e) => e.code === 'PROTOCOL_WAITERS_LIMIT')
  await assert.rejects(f.writer.waitForCapacity(), (e) => e.code === 'PROTOCOL_WAITERS_LIMIT')
  f.stream.finish()
  await first
  await ready
  await f.writer.flush()
  assert.equal(f.writer.stats.capacityWaiters, 0)
  assert.equal(f.writer.stats.flushWaiters, 0)
})
test('an unexpectedly closed stream rejects pending terminal messages instead of silently dropping them', async (t) => {
  const f = fixture(t),
    terminal = f.write({ event: 'export.finished', data: { deliveryCommitted: true } })
  f.stream.emit('close')
  await assert.rejects(terminal, (e) => e.admitted === true && e.submitted === true && e.deliveryUnknown === true)
  assert.equal(f.writer.stats.completed, 0)
})
test('invalid queue configuration and impossible capacity requests fail explicitly', async (t) => {
  assert.throws(() => createProtocolWriter(new Controlled(), { maxMessageBytes: 100, maxQueuedBytes: 99 }), /fit/)
  assert.throws(() => createProtocolWriter(new Controlled(), { writeTimeoutMs: Infinity }), /safe integer/)
  const f = fixture(t)
  await assert.rejects(f.writer.waitForCapacity(0), (e) => e.code === 'PROTOCOL_MESSAGE_LIMIT')
  await f.writer.flush()
  assert.equal(f.writer.stats.pendingMessages, 0)
})
