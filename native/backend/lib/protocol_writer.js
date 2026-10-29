// Bounded JSON-line output. Admission is explicit: retry the same unsent reply after
// capacity returns, never re-run a completed operation to manufacture another reply.
'use strict'
/** @typedef {import('../../contracts/runtime').RecoverableError} RecoverableError */
const DEFAULTS = Object.freeze({
  maxMessageBytes: 64 * 1024 * 1024,
  maxQueuedBytes: 64 * 1024 * 1024,
  maxQueuedMessages: 128,
  maxWaiters: 128,
  writeTimeoutMs: 120000,
})
/**
 * A write failure, with what the queue knows about the message's delivery.
 * @typedef {Error & {
 *   code?: string, admitted?: boolean, submitted?: boolean, deliveryUnknown?: boolean, requiredBytes?: number
 * }} ProtocolFailure
 */
function failure(code, message, item, cause) {
  /** @type {ProtocolFailure} */
  const error = new Error(message, cause ? { cause } : undefined)
  error.code = code
  if (item) {
    error.admitted = !!item.admitted
    error.submitted = !!item.submitted
    error.deliveryUnknown = !!item.submitted
  }
  return error
}
function createProtocolWriter(stream, options = {}) {
  if (
    !stream ||
    typeof stream.write !== 'function' ||
    typeof stream.on !== 'function' ||
    typeof stream.removeListener !== 'function'
  )
    throw new Error('A protocol writer requires a writable stream with lifecycle events.')
  const limits = { ...DEFAULTS, ...options }
  for (const key of Object.keys(DEFAULTS))
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > Number.MAX_SAFE_INTEGER)
      throw new Error(`Protocol ${key} must be a positive safe integer.`)
  if (limits.maxMessageBytes > limits.maxQueuedBytes || limits.writeTimeoutMs > 2147483647)
    throw new Error('Protocol message bytes must fit the queue and the write deadline must fit a timer.')
  const queue = [],
    capacityWaiters = [],
    flushWaiters = []
  let active = null,
    queuedBytes = 0,
    terminal = null,
    accepted = 0,
    completed = 0,
    rejected = 0,
    completedBytes = 0
  const rejectedItem = { admitted: false, submitted: false }
  const hasCapacity = (bytes) => queue.length < limits.maxQueuedMessages && queuedBytes + bytes <= limits.maxQueuedBytes
  const terminalError = (item) =>
    failure(
      'PROTOCOL_STREAM_FAILED',
      `The protocol output is unavailable: ${terminal?.message || 'the stream closed'}. Inspect completed work before retrying an operation.`,
      item,
      terminal,
    )
  function notify() {
    for (let i = capacityWaiters.length - 1; i >= 0; i--) {
      if (hasCapacity(capacityWaiters[i].bytes)) capacityWaiters.splice(i, 1)[0].resolve()
    }
    if (!queue.length) for (const waiter of flushWaiters.splice(0)) waiter.resolve()
  }
  function failAll(cause) {
    if (terminal) return
    terminal = cause instanceof Error ? cause : new Error(String(cause || 'The writable stream failed.'))
    const pending = queue.splice(0)
    active = null
    queuedBytes = 0
    for (const item of pending) {
      if (item.settled) continue
      item.settled = true
      item.cancel?.()
      rejected++
      item.reject(terminalError(item))
    }
    for (const waiter of [...capacityWaiters.splice(0), ...flushWaiters.splice(0)])
      waiter.reject(terminalError(rejectedItem))
  }
  stream.on('error', failAll)
  stream.on('close', () => failAll(new Error('The writable stream closed.')))
  stream.on('finish', () => failAll(new Error('The writable stream finished.')))
  function pump() {
    if (active || terminal || !queue.length) return
    if (stream.destroyed || stream.writableEnded || stream.writable === false) {
      failAll(new Error('The writable stream is no longer open.'))
      return
    }
    const item = queue[0]
    active = item
    let callbackDone = false,
      returned = false,
      needsDrain = false,
      drainSeen = false
    const clean = () => {
      clearTimeout(timer)
      stream.removeListener('drain', onDrain)
    }
    const finish = () => {
      if (item.settled || !returned || !callbackDone || (needsDrain && !drainSeen)) return
      item.settled = true
      clean()
      queue.shift()
      queuedBytes -= item.bytes
      active = null
      completed++
      completedBytes += item.bytes
      item.resolve()
      notify()
      pump()
    }
    const onDrain = () => {
      drainSeen = true
      item.backpressured = false
      finish()
    }
    const timer = setTimeout(
      () =>
        failAll(
          Object.assign(
            new Error(`The protocol write did not complete within ${limits.writeTimeoutMs} ms.`),
            /** @satisfies {Partial<RecoverableError>} */ ({
              code: 'PROTOCOL_WRITE_TIMEOUT',
            }),
          ),
        ),
      limits.writeTimeoutMs,
    )
    item.cancel = clean
    // Install before write: custom/native streams can synchronously call back or drain.
    stream.on('drain', onDrain)
    try {
      item.submitted = true
      const acceptedByStream = stream.write(item.buffer, (error) => {
        if (error) {
          failAll(error)
          return
        }
        callbackDone = true
        finish()
      })
      returned = true
      needsDrain = !acceptedByStream
      item.backpressured = needsDrain && !drainSeen
      if (!needsDrain) stream.removeListener('drain', onDrain)
      finish()
    } catch (error) {
      failAll(error)
    }
  }
  return {
    get stats() {
      return Object.freeze({
        pendingMessages: queue.length,
        pendingBytes: queuedBytes,
        capacityWaiters: capacityWaiters.length,
        flushWaiters: flushWaiters.length,
        accepted,
        completed,
        rejected,
        completedBytes,
        backpressured: !!active?.backpressured,
        failed: !!terminal,
        limits: { ...limits },
      })
    },
    write(message) {
      if (terminal) {
        rejected++
        return Promise.reject(terminalError(rejectedItem))
      }
      let text, bytes
      try {
        text = JSON.stringify(message)
        if (typeof text !== 'string') throw new Error('The protocol message has no JSON representation.')
        bytes = Buffer.byteLength(text, 'utf8') + 1
      } catch (error) {
        rejected++
        return Promise.reject(
          failure(
            'PROTOCOL_SERIALIZE',
            'The protocol message could not be serialized; no bytes were submitted.',
            rejectedItem,
            error,
          ),
        )
      }
      if (bytes > limits.maxMessageBytes) {
        rejected++
        return Promise.reject(
          failure(
            'PROTOCOL_MESSAGE_LIMIT',
            `The protocol frame exceeds its ${limits.maxMessageBytes}-byte limit; no bytes were submitted.`,
            rejectedItem,
          ),
        )
      }
      if (!hasCapacity(bytes)) {
        rejected++
        const error = failure(
          'PROTOCOL_CAPACITY',
          'The bounded protocol output queue is full. Wait for capacity and retry the same unsent message.',
          rejectedItem,
        )
        error.requiredBytes = bytes
        return Promise.reject(error)
      }
      return new Promise((resolve, reject) => {
        const item = {
          buffer: Buffer.from(`${text}\n`, 'utf8'),
          bytes,
          resolve,
          reject,
          admitted: true,
          submitted: false,
          settled: false,
        }
        queue.push(item)
        queuedBytes += bytes
        accepted++
        pump()
      })
    },
    // This waits for space, not a reservation. Concurrent callers must retry admission.
    waitForCapacity(bytes = 1) {
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > limits.maxMessageBytes)
        return Promise.reject(
          failure(
            'PROTOCOL_MESSAGE_LIMIT',
            'Choose a capacity request within the protocol message-byte limit.',
            rejectedItem,
          ),
        )
      if (terminal) return Promise.reject(terminalError(rejectedItem))
      if (hasCapacity(bytes)) return Promise.resolve()
      if (capacityWaiters.length + flushWaiters.length >= limits.maxWaiters)
        return Promise.reject(
          failure(
            'PROTOCOL_WAITERS_LIMIT',
            'Too many protocol capacity/flush waiters are already registered.',
            rejectedItem,
          ),
        )
      return new Promise((resolve, reject) => capacityWaiters.push({ bytes, resolve, reject }))
    },
    flush() {
      if (terminal) return Promise.reject(terminalError(rejectedItem))
      if (!queue.length) return Promise.resolve()
      if (capacityWaiters.length + flushWaiters.length >= limits.maxWaiters)
        return Promise.reject(
          failure(
            'PROTOCOL_WAITERS_LIMIT',
            'Too many protocol capacity/flush waiters are already registered.',
            rejectedItem,
          ),
        )
      return new Promise((resolve, reject) => flushWaiters.push({ resolve, reject }))
    },
  }
}
module.exports = { createProtocolWriter, DEFAULTS }
