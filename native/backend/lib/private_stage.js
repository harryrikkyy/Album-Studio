// Private decoder work is a capability, never an invitation to remove arbitrary names.
// Nonempty stages are retained atomically. Node has no conditional unlink of an exact inode;
// reclamation therefore needs an explicit, separately reviewed history policy.
// Records describe files created by this operation, not permanent ownership of old names.
// Budgets are checked before stage/copy/reservation, per canonical history parent. They are
// conservative refusal policies, not distributed reservations against all native writers.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { fileDigest, snapshotFile } = require('./cache')
const exclusive = require('./exclusive_rename')
/** @typedef {import('../../contracts/runtime').RecoverableError} RecoverableError */
const HISTORY = '.album-studio-stage-history'
const DEFAULT_LIMITS = Object.freeze({
  maxHistoryBytes: 8 * 1024 ** 3,
  maxHistoryStages: 256,
  minFreeBytes: 256 * 1024 ** 2,
})
const sameNode = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino
const sameRevision = (a, b) =>
  sameNode(a, b) && ['size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].every((k) => a[k] === b[k])
const stat = (file) =>
  fs.promises.lstat(file, { bigint: true }).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
/** @returns {RecoverableError} */
function preserved(file, detail, code = 'PRIVATE_STAGE_PRESERVED') {
  return Object.assign(
    new Error(`${detail} Private work was preserved at ${file}. Inspect it before retrying; no history was pruned.`),
    { code, retainedPath: file },
  )
}
function relocateEvidence(error, from, to, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return
  seen.add(error)
  const relocate = (file) =>
    typeof file === 'string' && (file === from || file.startsWith(`${from}${path.sep}`))
      ? to + file.slice(from.length)
      : file
  for (const key of ['retainedPath', 'snapshotPath']) if (error[key]) error[key] = relocate(error[key])
  if (Array.isArray(error.retainedPaths)) error.retainedPaths = error.retainedPaths.map(relocate)
  if (error.retirement?.retainedPath) error.retirement.retainedPath = relocate(error.retirement.retainedPath)
  relocateEvidence(error.cleanupError, from, to, seen)
  relocateEvidence(error.cause, from, to, seen)
}
async function directory(file) {
  const info = await stat(file)
  if (!info?.isDirectory() || info.isSymbolicLink() || (await fs.promises.realpath(file)) !== file)
    throw preserved(file, 'The private work directory is missing, aliased or uncertain.')
  return info
}
async function names(file) {
  const found = [],
    dir = await fs.promises.opendir(file)
  for await (const entry of dir) {
    if (found.length >= 10000) throw preserved(file, 'Private work exceeds the bounded 10000-entry inspection limit.')
    found.push(entry.name)
  }
  return found.sort()
}
async function usage(folder, depth = 0, state = { bytes: 0, entries: 0 }) {
  if (depth > 32)
    throw preserved(
      folder,
      'Private history exceeds the bounded directory-depth inspection limit.',
      'PRIVATE_STAGE_BUDGET',
    )
  const before = await directory(folder)
  for (const name of await names(folder)) {
    if (++state.entries > 10000)
      throw preserved(folder, 'Private history exceeds the bounded entry inspection limit.', 'PRIVATE_STAGE_BUDGET')
    const file = path.join(folder, name),
      info = await stat(file)
    if (!info || info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw preserved(file, 'Private history has an unknown or changed entry.', 'PRIVATE_STAGE_BUDGET')
    if (info.isDirectory()) await usage(file, depth + 1, state)
    else state.bytes += Number(info.size)
    if (!Number.isSafeInteger(state.bytes))
      throw preserved(folder, 'Private history size is outside supported bounds.', 'PRIVATE_STAGE_BUDGET')
  }
  if (!sameNode(before, await directory(folder)))
    throw preserved(folder, 'Private history changed during inspection.', 'PRIVATE_STAGE_BUDGET')
  return state
}
async function budget(parent, limits, requested = 0) {
  const history = path.join(parent, HISTORY),
    info = await stat(history)
  const current = info ? await usage(history) : { bytes: 0 }
  const stages = info ? (await names(history)).length : 0
  if (current.bytes + requested > limits.maxHistoryBytes || stages >= limits.maxHistoryStages)
    throw preserved(
      history,
      `Private history reached its configured retention budget (${limits.maxHistoryBytes} bytes, ${limits.maxHistoryStages} stages).`,
      'PRIVATE_STAGE_BUDGET',
    )
  const available = await fs.promises.statfs(parent, { bigint: true })
  if (available.bavail * available.bsize < BigInt(limits.minFreeBytes) + BigInt(requested))
    throw preserved(
      history,
      `Private work would cross the configured ${limits.minFreeBytes}-byte free-space reserve.`,
      'PRIVATE_STAGE_BUDGET',
    )
  return { ...current, stages }
}
async function createPrivateStage(parent, prefix = '.source-', options = {}) {
  if (typeof prefix !== 'string' || !prefix || path.basename(prefix) !== prefix)
    throw new Error('A private stage requires a simple filename prefix.')
  const limits = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(limits)) if (options[key] !== undefined) limits[key] = options[key]
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('Private work budgets must be nonnegative safe byte/count limits.')
  await fs.promises.mkdir(parent, { recursive: true, mode: 0o700 })
  const canonical = await fs.promises.realpath(parent),
    parentIdentity = await directory(canonical)
  const historyParent = await fs.promises.realpath(options.historyParent || canonical),
    historyIdentity = await directory(historyParent)
  await budget(historyParent, limits)
  const folder = await fs.promises.mkdtemp(path.join(canonical, prefix)),
    identity = await directory(folder),
    records = new Map()
  let finished = false
  const assertParents = async () => {
    if (
      !sameNode(await directory(canonical), parentIdentity) ||
      !sameNode(await directory(historyParent), historyIdentity) ||
      !sameNode(await directory(folder), identity)
    )
      throw preserved(folder, 'A private work parent or stage changed identity.')
  }
  const stage = {
    path: folder,
    async assertFiles() {
      // Read-only verification remains useful during a transaction ownership transfer.
      // Transaction metadata may be added afterward, but generated records stay exact.
      await assertParents()
      for (const [name, record] of records) {
        const file = path.join(folder, name)
        if (
          !sameRevision(record.identity, await stat(file)) ||
          (await fileDigest(file)) !== record.digest ||
          !sameRevision(record.identity, await stat(file))
        )
          throw preserved(folder, 'A prepared private output changed after its creation record.')
      }
    },
    async transfer() {
      await assertParents()
      if (finished) throw new Error('This private work capability has already been retired or transferred.')
      await stage.assertFiles()
      const entries = await names(folder)
      if (entries.length !== records.size || entries.some((name) => !records.has(name)))
        throw preserved(folder, 'Unknown files appeared before the private work ownership transfer.')
      finished = true
      stage.transferred = true
      return folder
    },
    async reserveBytes(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new Error('Private work reservations require nonnegative safe byte lengths.')
      await assertParents()
      return budget(historyParent, limits, bytes + (await usage(folder)).bytes)
    },
    /** @param {string} file @param {{ digest?: string, readOnly?: boolean }} [options] */
    async register(file, { digest, readOnly = false } = {}) {
      await assertParents()
      if (path.dirname(file) !== folder || records.has(path.basename(file)))
        throw preserved(folder, 'A private work registration is outside this stage or already registered.')
      const before = await stat(file)
      if (!before?.isFile() || before.nlink !== 1n || (readOnly && before.mode & 0o222n))
        throw preserved(folder, 'A generated private file is aliased or not independently owned.')
      const actual = await fileDigest(file),
        after = await stat(file)
      if (!sameRevision(before, after) || (digest && digest !== actual))
        throw preserved(folder, 'A generated private file changed before ownership was recorded.')
      records.set(path.basename(file), { identity: after, digest: actual, readOnly })
      return file
    },
    forget(file) {
      if (path.dirname(file) !== folder) throw new Error('Cannot transfer another private stage file.')
      records.delete(path.basename(file))
    },
    async snapshot(file, digest) {
      await assertParents()
      const input = await fs.promises.lstat(file, { bigint: true })
      if (!input.isFile() || input.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw preserved(folder, 'A snapshot source is not a bounded regular file.')
      await stage.reserveBytes(Number(input.size))
      const frozen = await snapshotFile(file, folder, digest)
      return stage.register(frozen, { digest, readOnly: true })
    },
    async cleanup() {
      if (finished) throw new Error('This private work capability has already been retired.')
      await assertParents()
      const entries = await names(folder)
      let reason =
        entries.length === records.size && entries.every((name) => records.has(name))
          ? null
          : 'The private stage contains unknown or missing files.'
      for (const name of entries) {
        const record = records.get(name)
        if (!record) continue
        const file = path.join(folder, name)
        try {
          if (
            !sameRevision(record.identity, await stat(file)) ||
            (await fileDigest(file)) !== record.digest ||
            !sameRevision(record.identity, await stat(file))
          )
            reason = 'A private stage file was edited, replaced or aliased.'
        } catch (_) {
          reason = 'A private stage file became unreadable or changed.'
        }
      }
      if (!entries.length && !records.size) {
        try {
          await fs.promises.rmdir(folder)
          finished = true
          return { retainedPath: null, bytes: 0, reason: null }
        } catch (error) {
          if (!['ENOTEMPTY', 'EEXIST'].includes(error.code))
            throw preserved(folder, `Empty private stage removal failed: ${error.message}`)
          reason = 'An unknown file appeared at the private stage removal boundary.'
        }
      }
      const history = path.join(historyParent, HISTORY)
      await fs.promises.mkdir(history, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error
      })
      const historyNode = await directory(history)
      await assertParents()
      const retained = path.join(history, crypto.randomUUID())
      try {
        await exclusive.renameExclusive(folder, retained)
      } catch (error) {
        const original = await stat(folder),
          captured = await stat(retained)
        if (original || !sameNode(captured, identity)) {
          const failure = preserved(
            sameNode(captured, identity) ? retained : folder,
            `Atomic private stage retention failed: ${error.message}; inspect both ${folder} and ${retained}.`,
          )
          failure.retainedPaths = [folder, retained]
          throw failure
        }
      }
      finished = true
      if (!sameNode(await directory(history), historyNode))
        throw preserved(retained, 'The private history parent changed during retention.')
      if (!sameNode(await stat(retained), identity))
        throw preserved(retained, 'The captured private stage changed identity; all captured names were retained.')
      // Inspect the captured tree again: a file may appear after the first enumeration.
      const capturedNames = await names(retained)
      if (JSON.stringify(capturedNames) !== JSON.stringify(entries))
        reason = 'Private stage contents changed at the retention boundary.'
      for (const name of capturedNames) {
        const record = records.get(name)
        if (!record) {
          reason = 'The private stage contains an unknown file.'
          continue
        }
        const file = path.join(retained, name)
        try {
          if (
            !sameRevision(record.identity, await stat(file)) ||
            (await fileDigest(file)) !== record.digest ||
            !sameRevision(record.identity, await stat(file))
          )
            reason = 'A captured private file was edited or replaced.'
        } catch (_) {
          reason = 'A captured private file became unreadable or changed.'
        }
      }
      let bytes = null
      try {
        bytes = (await usage(retained)).bytes
      } catch (_) {
        reason = reason || 'Private work size could not be verified.'
      }
      const result = { retainedPath: retained, bytes, reason }
      stage.retirement = result
      if (reason) throw Object.assign(preserved(retained, reason), { retirement: result })
      return result
    },
  }
  return stage
}
/**
 * @param {RecoverableError & { retirement?: { retainedPath?: string } } | null} [failure]
 * @param {{ onRetired?: (retirement: { retainedPath: string }) => unknown }} [options]
 */
async function finishPrivateStage(stage, failure = null, options) {
  let retirement
  try {
    retirement = await stage.cleanup()
    if (failure && retirement.retainedPath) {
      relocateEvidence(failure, stage.path, retirement.retainedPath)
      failure.retainedPaths = [
        ...new Set([failure.retainedPath, ...(failure.retainedPaths || []), retirement.retainedPath].filter(Boolean)),
      ]
      failure.retainedPath = failure.retainedPath || retirement.retainedPath
      failure.retirement = retirement
      failure.message += ` Private work was retained at ${retirement.retainedPath}.`
    }
    if (options?.onRetired) await options.onRetired(retirement)
  } catch (cleanup) {
    if (cleanup.retainedPath) relocateEvidence(failure, stage.path, cleanup.retainedPath)
    else if (retirement?.retainedPath) cleanup.retainedPath = retirement.retainedPath
    if (!failure) failure = cleanup
    else {
      failure.cleanupError = cleanup
      failure.retainedPaths = [
        ...new Set(
          [
            failure.retainedPath,
            ...(failure.retainedPaths || []),
            cleanup.retainedPath,
            ...(cleanup.retainedPaths || []),
          ].filter(Boolean),
        ),
      ]
      // The outermost uncertain stage is the primary inspection location. Earlier
      // source copies and nested recovery paths remain in the explicit path list.
      failure.retainedPath = cleanup.retainedPath || failure.retainedPath
      failure.message += ` Private cleanup also needs review: ${cleanup.message}`
    }
  }
  if (failure) throw failure
  return retirement
}
async function withPrivateStage(parent, prefix, work, options) {
  const stage = await createPrivateStage(parent, prefix, options)
  let result, failure
  try {
    result = await work(stage)
  } catch (error) {
    failure = error
  }
  await finishPrivateStage(stage, failure, options)
  return result
}
async function privateStageUsage(parent) {
  const canonical = await fs.promises.realpath(parent).catch((error) => {
    if (error.code === 'ENOENT') return path.resolve(parent)
    throw error
  })
  const historyPath = path.join(canonical, HISTORY),
    info = await stat(historyPath)
  return {
    historyPath,
    bytes: info ? (await usage(historyPath)).bytes : 0,
    stages: info ? (await names(historyPath)).length : 0,
    limits: { ...DEFAULT_LIMITS },
    automaticPruning: false,
  }
}
module.exports = {
  createPrivateStage,
  finishPrivateStage,
  withPrivateStage,
  privateStageUsage,
  DEFAULT_LIMITS,
  HISTORY,
}
