'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { tmpdir } = require('./fixtures')
const { createDispatcher } = require('../server')
const { jsonLines } = require('../lib/json_lines')
function fixture(options = {}) {
  const replies = [], dispatch = createDispatcher({ allowed: () => true, reply: message => replies.push(message), ...options })
  return { replies, dispatch }
}
test('null, primitive and malformed envelopes cannot crash dispatch or invoke business logic', async () => {
  let invoked = 0
  const f = fixture({ registry: { 'system.ping': async () => { invoked++; return { pong: null, node: process.version } } } })
  for (const line of ['null', '[]', '4', '"text"', '{invalid', '{"method":"system.ping"}', '{"id":1,"method":"system.ping","params":[]}']) await f.dispatch(line)
  assert.equal(invoked, 0); assert.equal(f.replies.length, 1); assert.equal(f.replies[0].code, 'CONTRACT_INVALID')
})
test('valid method parameters and results are enforced at the dispatcher, with unsupported results reported after completion', async () => {
  const f = fixture({ registry: { 'system.ping': async p => ({ pong: p.n, extra: true }) } })
  await f.dispatch(JSON.stringify({ id: 1, method: 'system.ping', params: { n: 4 } }))
  assert.equal(f.replies[0].ok, false); assert.equal(f.replies[0].code, 'CONTRACT_INVALID'); assert.equal(f.replies[0].retryable, false)
  assert.match(f.replies[0].error, /operation completed.*Reopen/)
})
test('domain recovery metadata and commit state reach the protocol error reply', async () => {
  const f = fixture({ registry: { 'system.ping': async () => { throw Object.assign(new Error('retirement needs review'), { code: 'RENDER_HISTORY', renderCommitted: true, recoveryRequired: true, retainedPath: '/safe/history', sourceCode: 'EIO' }) } } })
  await f.dispatch(JSON.stringify({ id: 3, method: 'system.ping' }))
  assert.deepEqual(f.replies[0], { id: 3, ok: false, error: 'retirement needs review', code: 'RENDER_HISTORY', renderCommitted: true, recoveryRequired: true, retainedPath: '/safe/history', sourceCode: 'EIO' })
})
test('bounded dispatcher refuses duplicate and excess requests and releases slots after failure', async () => {
  let finish
  const waiting = new Promise(resolve => { finish = resolve }), f = fixture({ maximum: 1, registry: { 'system.ping': async () => { await waiting; return { pong: null, node: process.version } } } })
  const first = f.dispatch('{"id":1,"method":"system.ping"}')
  await f.dispatch('{"id":1,"method":"system.ping"}'); await f.dispatch('{"id":2,"method":"system.ping"}')
  assert.deepEqual(f.replies.map(reply => reply.code), ['REQUEST_DUPLICATE', 'REQUEST_BUSY'])
  finish(); await first; await f.dispatch('{"id":3,"method":"system.ping"}')
  assert.equal(f.replies.at(-1).ok, true)
})
test('UTF-8 lines are framed across chunks, CRLF and final unterminated input', () => {
  const lines = [], framing = jsonLines(line => lines.push(line)), bytes = Buffer.from('{"name":"क"}\r\n{"ok":true}')
  for (const byte of bytes) framing.write(Buffer.from([byte]))
  framing.end(); assert.deepEqual(lines, ['{"name":"क"}', '{"ok":true}']); assert.equal(framing.bufferedBytes, 0)
})
test('oversized unterminated protocol lines never retain more than their budget and resynchronise at newline', () => {
  const lines = [], invalid = [], framing = jsonLines(line => lines.push(line), error => invalid.push(error), 64)
  for (let i = 0; i < 1000; i++) { framing.write(Buffer.alloc(32, 65)); assert.ok(framing.bufferedBytes <= 64) }
  framing.write(Buffer.from('\n{"id":1}\n')); framing.end()
  assert.equal(invalid.length, 1); assert.deepEqual(lines, ['{"id":1}']); assert.equal(framing.bufferedBytes, 0)
})
test('invalid UTF-8 cannot be silently converted into a different JSON string or path', () => {
  const lines = [], invalid = [], framing = jsonLines(line => lines.push(line), error => invalid.push(error))
  framing.write(Buffer.concat([Buffer.from('{"path":"'), Buffer.from([0xff]), Buffer.from('"}\n{"id":1}\n')]))
  framing.end(); assert.deepEqual(lines, ['{"id":1}']); assert.equal(invalid.length, 1)
})
test('fragmented input coalesces into bounded slabs rather than retaining a buffer per byte', () => {
  const framing = jsonLines(() => {}), byte = Buffer.from('a')
  for (let i = 0; i < 1024 * 1024; i++) framing.write(byte)
  assert.equal(framing.bufferedBytes, 1024 * 1024); assert.equal(framing.bufferedChunks, 16)
  framing.write(Buffer.from('\n')); assert.equal(framing.bufferedBytes, 0); assert.equal(framing.bufferedChunks, 0)
})
test('the real stdio server survives malformed and oversized requests and flushes its final replies', async t => {
  const root = tmpdir(); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, ALBUM_STUDIO_CACHE_DIR: path.join(root, 'cache'), ALBUM_STUDIO_DATA_DIR: path.join(root, 'data') }, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', diagnostic = '', timer
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { diagnostic += bytes })
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal }))
    timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`stdio server did not settle: ${diagnostic}`)) }, 10000)
  })
  child.stdin.write('null\n[]\n{"id":1,"method":"system.ping","params":[]}\n')
  child.stdin.write(Buffer.alloc(8 * 1024 * 1024 + 1, 65))
  child.stdin.write('\n{"id":2,"method":"system.ping","params":{"n":"after oversized line"}}\n')
  child.stdin.end('{"id":3,"method":"system.ping","params":{"n":"final without newline"}}')
  const terminal = await exited.finally(() => clearTimeout(timer))
  assert.deepEqual(terminal, { code: 0, signal: null }, diagnostic)
  const lines = output.trim().split('\n').map(line => JSON.parse(line)), replies = lines.filter(item => item.id)
  assert.equal(lines[0].event, 'backend.ready'); assert.equal(replies.length, 3)
  assert.equal(replies.find(reply => reply.id === 1).code, 'CONTRACT_INVALID')
  assert.equal(replies.find(reply => reply.id === 2).result.pong, 'after oversized line')
  assert.equal(replies.find(reply => reply.id === 3).result.pong, 'final without newline')
  assert.match(diagnostic, /byte limit/)
})
test('a broken output channel stops admission and terminates visibly instead of reporting successful delivery', async t => {
  const root = tmpdir(); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], { env: { ...process.env, ALBUM_STUDIO_DATA_DIR: path.join(root, 'data'), ALBUM_STUDIO_CACHE_DIR: path.join(root, 'cache') }, stdio: ['pipe', 'pipe', 'pipe'] })
  let diagnostic = '', timer
  child.stderr.on('data', bytes => { diagnostic += bytes }); child.stdin.on('error', () => {})
  child.stdout.destroy()
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal }))
    timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`broken-channel server did not settle: ${diagnostic}`)) }, 10000)
  })
  child.stdin.write('{"id":1,"method":"system.ping"}\n')
  const terminal = await exited.finally(() => clearTimeout(timer))
  assert.deepEqual(terminal, { code: 1, signal: null }, diagnostic)
  assert.match(diagnostic, /protocol output failed.*completed operations must be verified/i)
})
