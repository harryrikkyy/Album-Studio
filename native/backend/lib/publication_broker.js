// Private, one-operation stdio worker for the native platform adapter. It owns
// both namespace leases and filesystem I/O; no parent-side write can outlive it.
// JSON headers are bounded; document bytes stream outside the GUI JSON protocol.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { TextDecoder } = require('util')
const { acquirePublicationDirectories } = require('./namespace_lock')
const { publishFiles, recoverFiles, fingerprintFile, matchesFileRevision } = require('./file_publication')
const { createPublicationIO } = require('./publication_io')
const MAX_HEADER = 65536
const SHA = /^[a-f0-9]{64}$/
const invalid = message => Object.assign(new Error(message), { code: 'PUBLICATION_PROTOCOL' })
const changed = message => Object.assign(new Error(message), { code: 'PUBLICATION_CONFLICT' })
const io = createPublicationIO({ subject: 'native publication', changed, readRecord: fingerprintFile })
function exactKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)) }
function inputReader(input) {
  const iterator = input[Symbol.asyncIterator](); let buffer = Buffer.alloc(0), ended = false
  async function chunk() {
    if (!buffer.length && !ended) { const item = await iterator.next(); ended = !!item.done; buffer = ended ? Buffer.alloc(0) : Buffer.from(item.value) }
  }
  async function consume(length, sink) {
    let remaining = length
    while (remaining) {
      await chunk()
      if (ended) throw invalid('The native publication input ended before the declared bytes arrived.')
      const count = Math.min(remaining, buffer.length), part = buffer.subarray(0, count)
      await sink(part); buffer = buffer.subarray(count); remaining -= count
    }
  }
  async function exact(length) { const parts = []; await consume(length, part => parts.push(Buffer.from(part))); return Buffer.concat(parts, length) }
  return { consume, async json() {
    const length = (await exact(4)).readUInt32BE()
    if (!length || length > MAX_HEADER) throw invalid('The native publication header exceeds its 64 KiB limit.')
    const bytes = await exact(length)
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch (_) { throw invalid('The native publication header is not valid UTF-8 JSON.') }
  }, async end() { await chunk(); if (buffer.length || !ended) throw invalid('Unexpected trailing native publication bytes.') } }
}
function write(output, value) {
  const bytes = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(bytes) > MAX_HEADER) return Promise.reject(invalid('The native publication reply exceeded its 64 KiB limit.'))
  return new Promise((resolve, reject) => output.write(bytes, error => error ? reject(error) : resolve()))
}
function errorValue(error) {
  const out = { message: String(error && error.message || error).slice(0, 12000), code: typeof error.code === 'string' ? error.code.slice(0, 128) : 'PUBLICATION_FAILED' }
  for (const key of ['recoveryStage', 'recoveryJournal', 'publicationCommitted', 'publicationRestored', 'recoveryRequired']) if (['string', 'boolean'].includes(typeof error[key])) out[key] = typeof error[key] === 'string' ? error[key].slice(0, 32768) : error[key]
  return out
}
function requestOf(request) {
  if (!exactKeys(request, ['version', 'target', 'expected']) || request.version !== 1 || typeof request.target !== 'string' || request.target.length > 32768 || request.target.includes('\0') || !request.target.isWellFormed() || !path.isAbsolute(request.target) || !exactKeys(request.expected, ['mode', 'record', 'digest', 'size'])) throw invalid('Native publication requires an absolute target and explicit overwrite expectation.')
  const e = request.expected
  if (!['overwrite', 'new', 'source', 'exact'].includes(e.mode) || e.mode === 'source' && (!SHA.test(e.digest || '') || !/^(0|[1-9]\d{0,15})$/.test(e.size || '')) || e.mode === 'exact' && (!e.record || typeof e.record !== 'object' || Array.isArray(e.record))) throw invalid('Native publication has an invalid prior-revision expectation.')
  // These are serialization scopes, not album adoption or arbitrary control-session rights.
  return request
}
async function run({ input = process.stdin, output = process.stdout } = {}) {
  const reader = inputReader(input)
  let lease, result, failure, inputStage
  let deadline = setTimeout(() => input.destroy(invalid('Native publication admission timed out.')), 30000)
  deadline.unref()
  try {
    const request = requestOf(await reader.json()), folder = path.dirname(request.target), name = path.basename(request.target)
    if (name.startsWith('.album-studio') || name === '.' || name === '..' || name.length > 255) throw invalid('The publication target is reserved or has an invalid file name.')
    clearTimeout(deadline)
    deadline = setTimeout(() => input.destroy(invalid('Native publication preparation timed out.')), 6 * 60 * 60 * 1000)
    deadline.unref()
    lease = await acquirePublicationDirectories([request.target])
    await recoverFiles(folder, lease)
    const before = await fingerprintFile(request.target), e = request.expected
    if (e.mode === 'new' && before || e.mode === 'source' && (!before || before.digest !== e.digest || before.size !== e.size) || e.mode === 'exact' && !matchesFileRevision(before, e.record)) throw changed('The document no longer matches its earlier publication revision. Preserve both versions before saving again.')
    await write(output, { version: 1, state: 'ready', before })
    const payload = await reader.json()
    if (!exactKeys(payload, ['length', 'digest']) || !Number.isSafeInteger(payload.length) || payload.length < 0 || !SHA.test(payload.digest || '')) throw invalid('Native document bytes require a safe declared length and SHA-256.')
    await lease.assertOwned()
    const physical = await fs.promises.realpath(folder), metadata = path.join(physical, '.album-studio-publications')
    await io.directory(metadata)
    const stage = await fs.promises.mkdtemp(path.join(metadata, '.prepare-input-')), source = path.join(stage, 'source')
    inputStage = stage
    const handle = await fs.promises.open(source, 'wx', 0o600), hash = crypto.createHash('sha256')
    let readFailure
    try {
      await reader.consume(payload.length, async bytes => { hash.update(bytes); await handle.writeFile(bytes) })
      await handle.chmod(0o400); await handle.sync()
    } catch (error) { readFailure = error }
    try { await handle.close() } catch (error) { if (readFailure) readFailure.message += ` Closing the staged file also failed: ${error.message}`; else readFailure = error }
    if (readFailure) throw Object.assign(readFailure, { recoveryStage: stage })
    if (hash.digest('hex') !== payload.digest) throw Object.assign(invalid('The native document bytes did not match their declared SHA-256.'), { recoveryStage: stage })
    await lease.assertOwned()
    await write(output, { version: 1, state: 'prepared' })
    const decision = await reader.json()
    if (!exactKeys(decision, ['commit']) || decision.commit !== true) throw invalid('The native publication was not explicitly committed.')
    await reader.end()
    result = await publishFiles({ folder, entries: [{ name, source, sourceDigest: payload.digest, before }] }, lease)
    const inputs = path.join(metadata, 'inputs')
    try {
      await lease.assertOwned(); await io.directory(inputs, true)
      const retained = path.join(inputs, path.basename(stage))
      await io.move(stage, retained)
      result.inputHistory = retained
    } catch (error) { Object.assign(error, { publicationCommitted: true, recoveryStage: stage }); throw error }
  } catch (error) {
    if (!error.recoveryStage && inputStage) error.recoveryStage = inputStage
    failure = error
  }
  clearTimeout(deadline)
  input.destroy()
  if (lease) {
    try { await lease.release() } catch (error) {
      if (failure) failure.message += ` Namespace release also failed: ${error.message}`
      else { failure = error; if (result && result.committed) Object.assign(failure, { publicationCommitted: true, recoveryStage: result.historyPath }) }
    }
  }
  await write(output, failure ? { version: 1, state: 'failed', error: errorValue(failure) } : { version: 1, state: 'committed', result })
  return !failure
}
module.exports = { run, requestOf }
