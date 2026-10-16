// server.js — Album Studio's background helper (Node.js, no Electron).
//
// The native shell starts this process and talks to it over stdin/stdout, one JSON object per
// line:
//   in:  {"id": 7, "method": "album.open", "params": {...}}
//   out: {"id": 7, "ok": true, "result": ...} | {"id": 7, "ok": false, "error": "..."}
//   out: {"event": "thumbs.progress", "data": {...}}   (unsolicited progress)
// stdout carries protocol lines only; diagnostics go to stderr, which the shell logs.

'use strict'

const util = require('util')
const { jsonLines, MAX_LINE_BYTES } = require('./lib/json_lines')
const { createProtocolWriter } = require('./lib/protocol_writer')
const { validateRequest, validateResult, validateEvent, serializeError } = require('../contracts/runtime')

// stdout is the protocol: anything a module prints (some shared modules log with
// console.log) goes to stderr, the shell's log, instead of breaking a reply line.
for (const level of ['log', 'info', 'debug']) {
  console[level] = (...args) => process.stderr.write(util.format(...args) + '\n')
}

const { permits } = require('./lib/account')
const { methods } = require('./methods')
const output = createProtocolWriter(process.stdout)
let channelFailure = null
function outputFailed(error) {
  if (channelFailure) return
  channelFailure = error
  process.stderr.write(`backend: protocol output failed; completed operations must be verified before retrying: ${error.message}\n`)
  if (require.main === module) {
    // Stop admitting new operations. Existing filesystem/engine work completes under
    // its current capabilities; the native parent receives a terminal channel failure.
    process.exitCode = 1
    process.stdin.destroy()
  }
}

/** @param {object} msg */
function send(msg) {
  const pending = output.write(msg)
  // Progress producers may be synchronous. Every event write is still observed;
  // output failure closes admission visibly instead of silently dropping an event.
  pending.catch(outputFailed)
  return pending
}

/** Push an unsolicited event to the interface (progress, completion). */
function emit(event, data) {
  return send(validateEvent({ event, data }))
}

function createDispatcher({ registry = methods, allowed = permits, reply = send, event = emit, maximum = 128 } = {}) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 128) throw new Error('Choose a request concurrency limit from 1 to 128.')
  const active = new Set()
  return async function dispatch(line) {
    let request, id, invoked = false, completed = false, held = false
    try {
      if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return
      try { request = JSON.parse(line) } catch (_) { process.stderr.write('backend: ignored invalid JSON protocol input\n'); return }
      if (request && typeof request === 'object' && Number.isSafeInteger(request.id) && request.id > 0) id = request.id
      validateRequest(request)
      const { method, params = {} } = request
      const fn = Object.prototype.hasOwnProperty.call(registry, method) ? registry[method] : null
      if (typeof fn !== 'function') throw Object.assign(new Error(`unknown method \`${method}\``), { code: 'METHOD_UNKNOWN' })
      if (active.has(id)) throw Object.assign(new Error('This request id is already running.'), { code: 'REQUEST_DUPLICATE' })
      if (active.size >= maximum) throw Object.assign(new Error('Album Studio is handling too many requests. Wait for a current operation to finish.'), { code: 'REQUEST_BUSY', retryable: true })
      if (!allowed(method)) throw Object.assign(new Error('Sign in to Album Studio first.'), { code: 'signedOut' })
      active.add(id); held = true; invoked = true
      const value = await fn(params, { emit: event }), result = value === undefined ? null : value
      completed = true
      validateResult(method, result)
      await reply({ id, ok: true, result })
    } catch (error) {
      if (typeof error.code === 'string' && error.code.startsWith('PROTOCOL_')) throw error // never send a second, possibly duplicate reply after a channel failure
      if (id === undefined) { process.stderr.write('backend: ignored malformed request without a valid reply id\n'); return }
      if (error.code === 'METHOD_UNKNOWN' && typeof request.method === 'string') error.message = `unknown method \`${request.method.slice(0, 1024)}\``
      if (completed && ['CONTRACT_INVALID', 'PROTOCOL_LIMIT'].includes(error.code)) {
        error.message = `The operation completed, but its reply did not match the supported format. Reopen the album to verify its state before retrying. ${error.message}`
        error.retryable = false
      }
      // Errors before dispatch cannot report a completed operation. Errors thrown by the
      // domain keep their commit/recovery metadata, rather than collapsing to a string.
      const failure = serializeError(error)
      if (!invoked && error.code === 'CONTRACT_INVALID') failure.retryable = false
      await reply({ id, ok: false, ...failure })
    } finally { if (held) active.delete(id) }
  }
}
const dispatch = createDispatcher()

if (require.main === module) {
  // Requests run concurrently; each reply carries its id. When the shell closes our input, the
  // requests already running still finish and answer before the process exits.
  const inFlight = new Set()
  const input = jsonLines((line) => {
    const p = dispatch(line).catch(outputFailed).finally(() => inFlight.delete(p))
    inFlight.add(p)
  }, message => process.stderr.write(`backend: ${message}\n`))
  process.stdin.on('data', chunk => input.write(chunk))
  // No process.exit(): a pipe write still in progress would be cut off. Once input is closed and
  // the last reply is handed to stdout, nothing keeps the event loop alive and Node exits after
  // flushing it.
  process.stdin.on('end', () => {
    input.end()
    Promise.allSettled([...inFlight]).then(() => output.flush()).catch(outputFailed).finally(() => { process.exitCode = channelFailure ? 1 : 0 })
  })
  process.on('uncaughtException', (e) => process.stderr.write(`backend: uncaught ${e && e.stack || e}\n`))
  process.on('unhandledRejection', (e) => process.stderr.write(`backend: unhandled ${e && e.stack || e}\n`))
  emit('backend.ready', { pid: process.pid, node: process.version })
}

module.exports = { dispatch, createDispatcher }
