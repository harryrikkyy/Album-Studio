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
/**
 * A file publication's result, plus the receipt and retained input this broker adds.
 * @typedef {Awaited<ReturnType<typeof publishFiles>> & { fileReceipt?: object, inputHistory?: string }} BrokerResult
 */
const { isPrivateName } = require('./publication_paths')
const { createPublicationIO } = require('./publication_io')
/** @typedef {import('../../contracts/runtime').RecoverableError} RecoverableError */
const MAX_HEADER = 65536
const SHA = /^[a-f0-9]{64}$/
const invalid = (message) =>
  Object.assign(new Error(message), /** @satisfies {Partial<RecoverableError>} */ ({ code: 'PUBLICATION_PROTOCOL' }))
const changed = (message) =>
  Object.assign(new Error(message), /** @satisfies {Partial<RecoverableError>} */ ({ code: 'PUBLICATION_CONFLICT' }))
const io = createPublicationIO({ subject: 'native publication', changed, readRecord: fingerprintFile })
function exactKeys(value, keys) {
  return (
    value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((k) => keys.includes(k))
  )
}
function inputReader(input) {
  const iterator = input[Symbol.asyncIterator]()
  let buffer = Buffer.alloc(0),
    ended = false
  async function chunk() {
    if (!buffer.length && !ended) {
      const item = await iterator.next()
      ended = !!item.done
      buffer = ended ? Buffer.alloc(0) : Buffer.from(item.value)
    }
  }
  async function consume(length, sink) {
    let remaining = length
    while (remaining) {
      await chunk()
      if (ended) throw invalid('The native publication input ended before the declared bytes arrived.')
      const count = Math.min(remaining, buffer.length),
        part = buffer.subarray(0, count)
      await sink(part)
      buffer = buffer.subarray(count)
      remaining -= count
    }
  }
  async function exact(length) {
    const parts = []
    await consume(length, (part) => parts.push(Buffer.from(part)))
    return Buffer.concat(parts, length)
  }
  return {
    consume,
    async json() {
      const length = (await exact(4)).readUInt32BE()
      if (!length || length > MAX_HEADER) throw invalid('The native publication header exceeds its 64 KiB limit.')
      const bytes = await exact(length)
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      } catch (_) {
        throw invalid('The native publication header is not valid UTF-8 JSON.')
      }
    },
    async end() {
      await chunk()
      if (buffer.length || !ended) throw invalid('Unexpected trailing native publication bytes.')
    },
  }
}
/** @returns {Promise<void>} */
function write(output, value) {
  const bytes = JSON.stringify(value) + '\n'
  if (Buffer.byteLength(bytes) > MAX_HEADER)
    return Promise.reject(invalid('The native publication reply exceeded its 64 KiB limit.'))
  return new Promise((resolve, reject) => output.write(bytes, (error) => (error ? reject(error) : resolve())))
}
function errorValue(error) {
  const out = {
    message: String((error && error.message) || error).slice(0, 12000),
    code: typeof error.code === 'string' ? error.code.slice(0, 128) : 'PUBLICATION_FAILED',
  }
  for (const key of [
    'recoveryStage',
    'recoveryJournal',
    'publicationCommitted',
    'publicationRestored',
    'recoveryRequired',
  ])
    if (['string', 'boolean'].includes(typeof error[key]))
      out[key] = typeof error[key] === 'string' ? error[key].slice(0, 32768) : error[key]
  return out
}
// Absolute only: these paths decide whether the conflict check runs, so they must not resolve
// against the broker's working directory.
function optionalPath(value) {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 32768 &&
      value.isWellFormed() &&
      !value.includes('\0') &&
      path.isAbsolute(value))
  )
}
function sourceRevision(e) {
  return (
    typeof e.digest === 'string' &&
    typeof e.size === 'string' &&
    SHA.test(e.digest) &&
    /^(0|[1-9]\d{0,15})$/.test(e.size || '') &&
    BigInt(e.size) <= BigInt(Number.MAX_SAFE_INTEGER)
  )
}
// The request's own shape: version 1, an absolute and well-formed target, and an expectation.
function validRequestShape(request) {
  return (
    exactKeys(request, ['version', 'target', 'expected']) &&
    request.version === 1 &&
    typeof request.target === 'string' &&
    request.target.length <= 32768 &&
    !request.target.includes('\0') &&
    request.target.isWellFormed() &&
    path.isAbsolute(request.target) &&
    !!request.expected
  )
}
const EXPECTATION_FIELDS = Object.freeze({
  overwrite: ['mode'],
  new: ['mode'],
  source: ['mode', 'digest', 'size'],
  exact: ['mode', 'record'],
  document: ['mode', 'currentPath', 'sourcePath', 'digest', 'size', 'publication'],
})
// Exactly the mode's fields, with a valid revision for the source and exact modes.
function validExpectationFields(e) {
  const fields = EXPECTATION_FIELDS[e.mode]
  return (
    Array.isArray(fields) &&
    exactKeys(e, fields) &&
    !(e.mode === 'source' && !sourceRevision(e)) &&
    !(e.mode === 'exact' && !matchesFileRevision(e.record, e.record))
  )
}
// A document names its current and origin paths and carries decoder evidence, or none at all.
function validDocumentEvidence(e) {
  return (
    optionalPath(e.currentPath) &&
    optionalPath(e.sourcePath) &&
    ((e.digest === null && e.size === null) || sourceRevision(e))
  )
}
// An earlier receipt, if any, is an exact revision of an absolute path.
function validEarlierReceipt(publication) {
  return (
    publication === null ||
    (exactKeys(publication, ['path', 'revision', 'replacesSource']) &&
      optionalPath(publication.path) &&
      publication.path !== null &&
      typeof publication.replacesSource === 'boolean' &&
      matchesFileRevision(publication.revision, publication.revision))
  )
}
function requestOf(request) {
  if (!validRequestShape(request))
    throw invalid('Native publication requires an absolute target and explicit overwrite expectation.')
  const e = request.expected
  if (!validExpectationFields(e)) throw invalid('Native publication has an invalid prior-revision expectation.')
  if (e.mode === 'document') {
    if (!validDocumentEvidence(e))
      throw invalid('Native document publication requires explicit current/origin paths and decoder evidence.')
    if (!validEarlierReceipt(e.publication))
      throw invalid('Native document publication has an invalid earlier receipt.')
  }
  return request
}
async function canonicalName(name) {
  const file = path.resolve(name)
  try {
    return await fs.promises.realpath(file)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    try {
      return path.join(await fs.promises.realpath(path.dirname(file)), path.basename(file))
    } catch (parentError) {
      if (parentError.code !== 'ENOENT') throw parentError
      return file
    }
  }
}
// A new file that already exists, or a source or exact revision the file no longer matches.
function fixedModeConflict(e, before) {
  return (
    (e.mode === 'new' && before) ||
    (e.mode === 'source' && (!before || before.digest !== e.digest || before.size !== e.size)) ||
    (e.mode === 'exact' && !matchesFileRevision(before, e.record))
  )
}
// Which of a document's recorded paths name the target on disk, resolved in this order.
async function documentAliases(target, e) {
  const physical = await canonicalName(target)
  const current = e.currentPath !== null && (await canonicalName(e.currentPath)) === physical
  const previous = e.publication !== null && (await canonicalName(e.publication.path)) === physical
  const source = e.sourcePath !== null && (await canonicalName(e.sourcePath)) === physical
  return { current, previous, source }
}
async function validateExpectation(target, before, e) {
  const conflict = () =>
    changed(
      'The document no longer matches its earlier publication revision. Preserve both versions before saving again.',
    )
  if (e.mode !== 'document') {
    if (fixedModeConflict(e, before)) throw conflict()
    return false
  }
  const { current, previous, source } = await documentAliases(target, e)
  if (previous) {
    if (!matchesFileRevision(before, e.publication.revision)) throw conflict()
  } else if (current && source) {
    if (!sourceRevision(e) || !before || before.digest !== e.digest || before.size !== e.size) throw conflict()
  } else if (current)
    throw changed(
      'This document has no verified revision for its current file. Preserve it by saving a copy to a different name.',
    )
  // A different target is the user's explicit Save As/Copy choice. It still uses
  // the exact revision captured under this actor's capabilities, never an in-place rebase.
  return current
}

// Reads the request and refuses a reserved target name, as typed or as spelled on disk.
async function admit(reader) {
  const request = requestOf(await reader.json()),
    folder = path.dirname(request.target),
    name = path.basename(request.target)
  const reserved = () => invalid('The publication target is reserved or has an invalid file name.')
  if (isPrivateName(name) || name === '.' || name === '..' || name.length > 255) throw reserved()
  // An existing target is also judged by its name on disk, which macOS may spell differently.
  const existing = await fs.promises.realpath(request.target).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing && isPrivateName(path.basename(existing))) throw reserved()
  return { request, folder, name }
}
const validPayload = (payload) =>
  exactKeys(payload, ['length', 'digest']) &&
  Number.isSafeInteger(payload.length) &&
  payload.length >= 0 &&
  SHA.test(payload.digest || '')
// Streams the declared bytes into the stage's read-only source file, hashing them on the way.
async function stageInput(reader, payload, stage, source) {
  const handle = await fs.promises.open(source, 'wx', 0o600),
    hash = crypto.createHash('sha256')
  let readFailure
  try {
    await reader.consume(payload.length, async (bytes) => {
      hash.update(bytes)
      await handle.writeFile(bytes)
    })
    await handle.chmod(0o400)
    await handle.sync()
  } catch (error) {
    readFailure = error
  }
  try {
    await handle.close()
  } catch (error) {
    if (readFailure) readFailure.message += ` Closing the staged file also failed: ${error.message}`
    else readFailure = error
  }
  if (readFailure)
    throw Object.assign(readFailure, /** @satisfies {Partial<RecoverableError>} */ ({ recoveryStage: stage }))
  if (hash.digest('hex') !== payload.digest)
    throw Object.assign(
      invalid('The native document bytes did not match their declared SHA-256.'),
      /** @satisfies {Partial<RecoverableError>} */ ({
        recoveryStage: stage,
      }),
    )
}
// Retains the staged input in history. The save has committed, so a failure here says so.
async function keepInputHistory(lease, metadata, stage, result) {
  const inputs = path.join(metadata, 'inputs')
  try {
    await lease.assertOwned()
    await io.directory(inputs, true)
    const retained = path.join(inputs, path.basename(stage))
    await io.move(stage, retained)
    result.inputHistory = retained
  } catch (error) {
    Object.assign(
      error,
      /** @satisfies {Partial<RecoverableError & { publicationCommitted: boolean }>} */ ({
        publicationCommitted: true,
        recoveryStage: stage,
      }),
    )
    throw error
  }
}
// Releases the namespace lease. A release failure joins an earlier failure, or becomes the
// failure itself and keeps a committed save's evidence.
async function releaseLease(lease, failure, result) {
  try {
    await lease.release()
  } catch (error) {
    if (failure) failure.message += ` Namespace release also failed: ${error.message}`
    else {
      failure = error
      if (result && result.committed)
        Object.assign(
          failure,
          /** @satisfies {Partial<RecoverableError & { publicationCommitted: boolean }>} */ ({
            publicationCommitted: true,
            recoveryStage: result.historyPath,
          }),
        )
    }
  }
  return failure
}

async function run({ input = process.stdin, output = process.stdout } = {}) {
  const reader = inputReader(input)
  let lease, failure, inputStage
  /** @type {BrokerResult | undefined} */
  let result
  let deadline = setTimeout(() => input.destroy(invalid('Native publication admission timed out.')), 30000)
  deadline.unref()
  try {
    const { request, folder, name } = await admit(reader)
    clearTimeout(deadline)
    deadline = setTimeout(() => input.destroy(invalid('Native publication preparation timed out.')), 6 * 60 * 60 * 1000)
    deadline.unref()
    lease = await acquirePublicationDirectories([request.target])
    await require('./publication_recovery').assertManagedRendersSettled(lease)
    await recoverFiles(folder, lease)
    const before = await fingerprintFile(request.target),
      e = request.expected
    const replacesSource = await validateExpectation(request.target, before, e)
    await write(output, { version: 1, state: 'ready', before })
    const payload = await reader.json()
    if (!validPayload(payload)) throw invalid('Native document bytes require a safe declared length and SHA-256.')
    await lease.assertOwned()
    const physical = await fs.promises.realpath(folder),
      metadata = path.join(physical, '.album-studio-publications')
    await io.directory(metadata)
    const stage = await fs.promises.mkdtemp(path.join(metadata, '.prepare-input-')),
      source = path.join(stage, 'source')
    inputStage = stage
    await stageInput(reader, payload, stage, source)
    await lease.assertOwned()
    await write(output, { version: 1, state: 'prepared' })
    const decision = await reader.json()
    if (!exactKeys(decision, ['commit']) || decision.commit !== true)
      throw invalid('The native publication was not explicitly committed.')
    await reader.end()
    result = await publishFiles({ folder, entries: [{ name, source, sourceDigest: payload.digest, before }] }, lease)
    const { name: _name, ...revision } = result.records[0]
    result.fileReceipt = { path: path.join(physical, name), revision, replacesSource }
    await keepInputHistory(lease, metadata, stage, result)
  } catch (error) {
    if (!error.recoveryStage && inputStage) error.recoveryStage = inputStage
    failure = error
  }
  clearTimeout(deadline)
  input.destroy()
  if (lease) failure = await releaseLease(lease, failure, result)
  await write(
    output,
    failure ? { version: 1, state: 'failed', error: errorValue(failure) } : { version: 1, state: 'committed', result },
  )
  return !failure
}
module.exports = { run, requestOf }
