// server.js — Album Studio's background helper (Node.js, no Electron).
//
// The native shell starts this process and talks to it over stdin/stdout, one JSON object per
// line:
//   in:  {"id": 7, "method": "album.open", "params": {...}}
//   out: {"id": 7, "ok": true, "result": ...} | {"id": 7, "ok": false, "error": "..."}
//   out: {"event": "thumbs.progress", "data": {...}}   (unsolicited progress)
// stdout carries protocol lines only; diagnostics go to stderr, which the shell logs.

'use strict'

const readline = require('readline')
const util = require('util')

// stdout is the protocol: anything a module prints (some shared modules log with
// console.log) goes to stderr, the shell's log, instead of breaking a reply line.
for (const level of ['log', 'info', 'debug']) {
  console[level] = (...args) => process.stderr.write(util.format(...args) + '\n')
}

const { permits } = require('./lib/account')
const { methods } = require('./methods')

/** @param {object} msg */
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

/** Push an unsolicited event to the interface (progress, completion). */
function emit(event, data) {
  send({ event, data })
}

async function dispatch(line) {
  let req
  try {
    req = JSON.parse(line)
  } catch (_) {
    process.stderr.write(`backend: ignored a line that is not JSON: ${line.slice(0, 200)}\n`)
    return
  }
  const { id, method, params } = req
  const fn = Object.prototype.hasOwnProperty.call(methods, method) ? methods[method] : null
  if (!fn) {
    send({ id, ok: false, error: `unknown method \`${method}\`` })
    return
  }
  if (!permits(method)) {
    send({ id, ok: false, error: 'Sign in to Album Studio first.', code: 'signedOut' })
    return
  }
  try {
    const result = await fn(params || {}, { emit })
    send({ id, ok: true, result: result === undefined ? null : result })
  } catch (e) {
    send({ id, ok: false, error: e && e.message ? e.message : String(e) })
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  // Requests run concurrently; each reply carries its id. When the shell closes our input, the
  // requests already running still finish and answer before the process exits.
  const inFlight = new Set()
  rl.on('line', (line) => {
    if (!line.trim()) return
    const p = dispatch(line).finally(() => inFlight.delete(p))
    inFlight.add(p)
  })
  // No process.exit(): a pipe write still in progress would be cut off. Once input is closed and
  // the last reply is handed to stdout, nothing keeps the event loop alive and Node exits after
  // flushing it.
  rl.on('close', () => { Promise.allSettled([...inFlight]).then(() => { process.exitCode = 0 }) })
  process.on('uncaughtException', (e) => process.stderr.write(`backend: uncaught ${e && e.stack || e}\n`))
  process.on('unhandledRejection', (e) => process.stderr.write(`backend: unhandled ${e && e.stack || e}\n`))
  emit('backend.ready', { pid: process.pid, node: process.version })
}

module.exports = { dispatch }
