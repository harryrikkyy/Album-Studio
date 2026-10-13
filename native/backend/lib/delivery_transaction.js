// Durable publication for the JPEG/PDF set and its ownership cache. Readers must call
// recoverDeliveries before trusting delivery files: individual names cannot switch atomically.
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { isDeepStrictEqual } = require('util')

const STAGE = /^delivery-[A-Za-z0-9-]{6,80}$/
const JOURNAL = 'journal.json'
const LOCK = '.delivery.lock'
const RECLAIM = '.delivery.recovery.lock'
const localKey = Symbol.for('album-studio.delivery-locks')
const localLocks = globalThis[localKey] || (globalThis[localKey] = new Map())
const unsupportedLinks = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'EMLINK'])

async function syncDirectory(folder) {
  let handle
  try { handle = await fs.promises.open(folder, 'r'); await handle.sync() } catch (error) {
    // These filesystems offer no directory fsync. File contents are still flushed; this
    // best-effort fallback is not a claim of hardware power-loss durability on those drives.
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EISDIR'].includes(error.code)) throw error
  } finally { if (handle) await handle.close() }
}

function sameIdentity(a, b) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key])
}

/** Hash through a no-follow handle and reject files changing while they are read. */
async function fingerprint(file, flush = false) {
  let handle
  try {
    const before = await fs.promises.lstat(file, { bigint: true })
    if (!before.isFile()) throw new Error(`Delivery file ${file} is not a regular file; symlinks are not supported.`)
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = await handle.stat({ bigint: true })
    if (!sameIdentity(before, opened)) throw new Error(`Delivery file ${file} changed while it was opened.`)
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead
    }
    if (flush) await handle.sync()
    const after = await handle.stat({ bigint: true })
    const named = await fs.promises.lstat(file, { bigint: true })
    if (!sameIdentity(opened, after) || !sameIdentity(after, named)) throw new Error(`Delivery file ${file} changed while its content was checked.`)
    return { digest: hash.digest('hex'), size: String(after.size), stamp: `${after.size}:${Math.round(Number(after.mtimeNs) / 1e6)}`, mode: Number(after.mode) & 0o777, mtimeMs: Number(after.mtimeNs) / 1e6, atimeMs: Number(after.atimeNs) / 1e6 }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  } finally { if (handle) await handle.close() }
}

function matchesContent(a, b) { return !!a && !!b && a.digest === b.digest && a.size === b.size }
function matches(a, b) { return matchesContent(a, b) && a.stamp === b.stamp }
function validFingerprint(value) {
  return value && /^[a-f0-9]{64}$/.test(value.digest) && /^\d+$/.test(value.size) && /^\d+:\d+$/.test(value.stamp) && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777 && Number.isFinite(value.mtimeMs) && Number.isFinite(value.atimeMs)
}

async function realDirectory(folder, create = false) {
  if (create) await fs.promises.mkdir(folder, { recursive: false }).catch((error) => { if (error.code !== 'EEXIST') throw error })
  const st = await fs.promises.lstat(folder)
  if (!st.isDirectory() || st.isSymbolicLink() || await fs.promises.realpath(folder) !== folder) throw new Error(`Delivery directory ${folder} is a symlink or has changed. Preserve the recovery files before retrying.`)
}

async function contextOf(paths) {
  if (!paths || !['sheets', 'high', 'low', 'pdf', 'cache'].every((key) => typeof paths[key] === 'string' && path.isAbsolute(paths[key]))) throw new Error('Delivery paths must be absolute.')
  const rawRoot = path.dirname(path.resolve(paths.sheets)), root = await fs.promises.realpath(rawRoot)
  const translate = (file) => {
    const relative = path.relative(rawRoot, path.resolve(file))
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Delivery paths must stay inside their output parent.')
    return path.join(root, relative)
  }
  const canonical = Object.fromEntries(Object.entries(paths).filter(([key]) => ['sheets', 'high', 'low', 'pdf', 'cache'].includes(key)).map(([key, value]) => [key, translate(value)]))
  if (canonical.high !== path.join(root, 'JPEG-High-Res') || canonical.low !== path.join(root, 'JPEG-Low-Res') || path.dirname(canonical.pdf) !== root || !canonical.pdf.endsWith('.pdf') || canonical.cache !== path.join(canonical.sheets, '.album-studio', 'export-cache.json')) throw new Error('Unexpected delivery folder or ownership cache layout.')
  await realDirectory(canonical.sheets)
  const metadata = path.dirname(canonical.cache)
  await realDirectory(metadata, true)
  await syncDirectory(canonical.sheets)
  return { paths: canonical, root, rawRoot, metadata, translate }
}

function allowedTarget(context, file, cache = false) {
  if (cache) return file === context.paths.cache
  return file === context.paths.pdf || [context.paths.high, context.paths.low].includes(path.dirname(file)) && /^Page_\d+\.jpg$/.test(path.basename(file))
}

async function checkTargetDirectory(context, file, create = false) {
  if (file === context.paths.cache) return realDirectory(context.metadata)
  const folder = path.dirname(file)
  if (folder !== context.root) {
    await realDirectory(folder, create)
    if (create) await syncDirectory(context.root)
  } else await realDirectory(context.root)
}

async function readOwner(lockFile) {
  let text
  try { text = await fs.promises.readFile(lockFile, 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  let owner
  try { owner = JSON.parse(text) } catch (_) { throw new Error(`Invalid delivery lock ${lockFile}; preserve it for inspection.`) }
  if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !/^[a-f0-9]{32}$/.test(owner.token)) throw new Error(`Invalid delivery lock ${lockFile}; preserve it for inspection.`)
  let alive = true
  if (owner.pid === process.pid && localLocks.get(path.dirname(lockFile)) !== owner.token) alive = false
  else try { process.kill(owner.pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false }
  return { ...owner, text, alive }
}

async function locked(context, work) {
  if (localLocks.has(context.metadata)) throw new Error('Delivery publication or recovery is already in progress for this album.')
  const token = crypto.randomBytes(16).toString('hex'), lockFile = path.join(context.metadata, LOCK), reclaimFile = path.join(context.metadata, RECLAIM)
  localLocks.set(context.metadata, token)
  let held = false, result, failure
  const createLock = async () => {
    const handle = await fs.promises.open(lockFile, 'wx', 0o600)
    held = true
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync() } finally { await handle.close() }
    await syncDirectory(context.metadata)
  }
  const reclaim = async () => {
    let guard
    try { guard = await fs.promises.open(reclaimFile, 'wx', 0o600) } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const failure = new Error(`Delivery lock recovery is already in progress, or was interrupted. Preserve and inspect ${reclaimFile} before retrying.`)
      failure.recoveryLock = reclaimFile; throw failure
    }
    let failure
    try {
      await guard.writeFile(JSON.stringify({ pid: process.pid, token })); await guard.sync()
      // Serialise stale removers and re-read the owner after claiming the guard. A normal
      // contender that acquires a vacant name can win safely; it will never be unlinked.
      const owner = await readOwner(lockFile)
      if (owner && owner.alive) throw new Error('Delivery publication or recovery is already in progress for this album.')
      if (owner) await fs.promises.unlink(lockFile)
      try { await createLock() } catch (error) {
        if (error.code === 'EEXIST' && !held) throw new Error('Delivery publication or recovery is already in progress for this album.')
        throw error
      }
    } catch (error) { failure = error }
    try {
      await guard.close()
      const owner = await readOwner(reclaimFile)
      if (!owner || owner.token !== token) {
        const error = new Error(`Delivery recovery guard ${reclaimFile} changed; it was preserved.`)
        error.recoveryLock = reclaimFile; throw error
      }
      await fs.promises.unlink(reclaimFile).catch((error) => { error.recoveryLock = reclaimFile; throw error })
      await syncDirectory(context.metadata)
    } catch (error) {
      if (failure) { failure.message += ` Delivery recovery guard cleanup failed: ${error.message}`; failure.recoveryLock = reclaimFile }
      else failure = error
    }
    if (failure) throw failure
  }
  try {
    for (let attempt = 0; attempt < 3 && !held; attempt++) {
      if (await fs.promises.lstat(reclaimFile).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })) {
        const error = new Error(`Delivery lock recovery is already in progress, or was interrupted. Preserve and inspect ${reclaimFile} before retrying.`)
        error.recoveryLock = reclaimFile; throw error
      }
      try {
        await createLock()
      } catch (error) {
        if (error.code !== 'EEXIST' || held) throw error
        const owner = await readOwner(lockFile)
        if (owner && owner.alive) throw new Error('Delivery publication or recovery is already in progress for this album.')
        if (owner) await reclaim()
      }
    }
    if (!held) throw new Error('Delivery lock changed during recovery; retry after the other process finishes.')
    result = await work()
  } catch (error) { failure = error }
  try {
    if (held) {
      const owner = await readOwner(lockFile)
      if (!owner || owner.token !== token) throw new Error('Delivery lock ownership changed during publication.')
      await fs.promises.unlink(lockFile); await syncDirectory(context.metadata)
    }
  } catch (error) {
    if (failure) failure.message += ` Delivery lock cleanup failed: ${error.message}`
    else {
      failure = new Error(`Delivery finished, but lock cleanup failed: ${error.message}`, { cause: error })
      if (Array.isArray(result)) failure.deliveryCommitted = true
    }
    failure.recoveryLock = lockFile
  }
  localLocks.delete(context.metadata)
  if (failure) throw failure
  return result
}

async function saveJournal(stage, journal, initial = false) {
  const file = path.join(stage, JOURNAL), temporary = path.join(stage, `${JOURNAL}.new`)
  if (!initial) await checkTemporaryJournal(temporary, journal)
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | (initial ? fs.constants.O_EXCL : fs.constants.O_TRUNC) | (fs.constants.O_NOFOLLOW || 0)
  const handle = await fs.promises.open(temporary, flags, 0o600)
  try { await handle.writeFile(JSON.stringify(journal) + '\n'); await handle.sync() } finally { await handle.close() }
  if (initial) {
    try { await fs.promises.link(temporary, file) } catch (error) {
      if (!unsupportedLinks.has(error.code)) throw error
      await fs.promises.copyFile(temporary, file, fs.constants.COPYFILE_EXCL)
      const copied = await fs.promises.open(file, 'r')
      try { await copied.sync() } finally { await copied.close() }
    }
    await fs.promises.unlink(temporary)
  }
  else await fs.promises.rename(temporary, file)
  await syncDirectory(stage)
}

async function readJournalFile(file) {
  const state = await fs.promises.lstat(file)
  if (!state.isFile() || state.isSymbolicLink()) throw new Error(`Recovery journal ${file} is not a regular file; it was preserved.`)
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    try { return JSON.parse(await handle.readFile('utf8')) } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new Error(`Invalid delivery recovery journal JSON at ${file}; it was preserved.`)
    }
  } finally { await handle.close() }
}

async function checkTemporaryJournal(file, journal) {
  let candidate
  try { candidate = await readJournalFile(file) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  if (!candidate || candidate.version !== journal.version || candidate.root !== journal.root || candidate.metadata !== journal.metadata || candidate.stage !== journal.stage || candidate.albumFile !== journal.albumFile || !['pending', 'rollingBack', 'committed'].includes(candidate.phase) || !isDeepStrictEqual(candidate.entries, journal.entries)) throw new Error(`Unexpected recovery journal copy ${file}; it was preserved.`)
}

function recoveryError(stage, error) {
  const out = new Error(`Delivery needs recovery. Keep ${stage} and its journal/backups; reconnect the drive or resolve the file conflict before exporting again. ${error.message}`, { cause: error })
  out.recoveryJournal = path.join(stage, JOURNAL); out.recoveryStage = stage
  if (error.code) out.code = error.code
  return out
}

function validateJournal(context, stage, journal, albumFile) {
  if (!journal || journal.version !== 1 || journal.root !== context.root || journal.metadata !== context.metadata || journal.stage !== stage || typeof journal.albumFile !== 'string' || !path.isAbsolute(journal.albumFile) || albumFile && journal.albumFile !== albumFile || !['pending', 'rollingBack', 'committed'].includes(journal.phase) || !Array.isArray(journal.entries) || !journal.entries.length) throw new Error('Invalid delivery recovery journal or album identity; no files were changed.')
  const targets = new Set(), sources = new Set()
  for (const [i, entry] of journal.entries.entries()) {
    const cache = i === journal.entries.length - 1
    if (!entry || typeof entry.source !== 'string' || entry.source.includes('\\') || [...entry.source].some((c) => c.charCodeAt(0) < 32) || path.basename(entry.source) !== entry.source || ['.', '..', JOURNAL, `${JOURNAL}.new`].includes(entry.source) || entry.source.startsWith('backup-') || entry.source.startsWith('discard-') || cache && entry.source !== 'cache.next.json' || entry.backup !== `backup-${i}` || entry.discard !== `discard-${i}` || typeof entry.target !== 'string' || !allowedTarget(context, entry.target, cache) || entry.before !== null && !validFingerprint(entry.before) || !validFingerprint(entry.after)) throw new Error('Invalid delivery entry; no files were changed.')
    if (targets.has(entry.target.toLowerCase()) || sources.has(entry.source.toLowerCase())) throw new Error('Duplicate delivery recovery entry; no files were changed.')
    targets.add(entry.target.toLowerCase()); sources.add(entry.source.toLowerCase())
  }
}

/** Install without replacing a file which appeared after the ownership check. */
async function installExclusive(source, target, expected) {
  if (!matches(await fingerprint(source, true), expected)) throw new Error(`Delivery recovery copy ${source} changed.`)
  try { await fs.promises.link(source, target) } catch (error) {
    if (!unsupportedLinks.has(error.code)) throw error
    await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE)
    await fs.promises.chmod(target, expected.mode)
    await fs.promises.utimes(target, expected.atimeMs / 1000, expected.mtimeMs / 1000)
  }
  if (!matches(await fingerprint(target, true), expected) || !matches(await fingerprint(source), expected)) throw new Error(`Delivery file ${target} changed during copying; both copies were preserved.`)
  await syncDirectory(path.dirname(target))
}

async function returnCapturedEdit(source, target, captured) {
  // The atomic capture can win a race with an external edit. Return that exact edited
  // version to its name if it is still vacant, while retaining the recovery copy.
  if (!captured) return
  try { if (!await fingerprint(target)) await installExclusive(source, target, captured) } catch (_) { /* Both paths are reported by the recovery error; never replace an occupied name. */ }
}

async function inspectEntries(context, stage, journal) {
  const inspected = []
  for (const entry of journal.entries) {
    await checkTargetDirectory(context, entry.target, true)
    const current = await fingerprint(entry.target), backup = await fingerprint(path.join(stage, entry.backup)), discard = await fingerprint(path.join(stage, entry.discard))
    // A complete exclusive fallback copy can be killed before its timestamps are restored.
    // Its full content checksum proves ownership during rollback; committed files must also
    // retain the stamp which the cache records.
    const old = matches(current, entry.before), next = journal.phase === 'committed' ? matches(current, entry.after) : matchesContent(current, entry.after)
    if (current && !old && !next || backup && !matches(backup, entry.before) || discard && !matchesContent(discard, entry.after)) throw new Error(`Delivery rollback conflict at ${entry.target}; its edited/unrelated file and recovery copies were preserved.`)
    if (journal.phase === 'committed') {
      if (!next) throw new Error(`Committed delivery conflict at ${entry.target}; the journal and backups were preserved.`)
    } else if (entry.before && !old && !backup) throw new Error(`Delivery recovery cannot locate the previous file ${entry.target}.`)
    inspected.push({ entry, current, backup, discard, old, next })
  }
  return inspected
}

async function cleanup(context, stage, journal) {
  // Only remove a fully validated private stage. An unexpected file could be a customer's
  // recovery copy; never recursively discard it simply because its parent has our name.
  const allowed = new Set([JOURNAL, `${JOURNAL}.new`])
  await checkTemporaryJournal(path.join(stage, `${JOURNAL}.new`), journal)
  for (const entry of journal.entries) {
    for (const [name, expected] of [[entry.source, entry.after], [entry.backup, entry.before], [entry.discard, entry.after]]) {
      allowed.add(name)
      const actual = await fingerprint(path.join(stage, name))
      if (actual && !(name === entry.discard ? matchesContent(actual, expected) : matches(actual, expected))) throw new Error(`Unknown or edited recovery file ${path.join(stage, name)}; the delivery journal was preserved.`)
    }
  }
  const names = await fs.promises.readdir(stage)
  if (names.some((name) => !allowed.has(name))) throw new Error(`Unexpected files in ${stage}; the delivery journal and backups were preserved.`)
  for (const name of names.filter((name) => name !== JOURNAL && name !== `${JOURNAL}.new`)) await fs.promises.unlink(path.join(stage, name))
  await syncDirectory(stage)
  await fs.promises.unlink(path.join(stage, `${JOURNAL}.new`)).catch((error) => { if (error.code !== 'ENOENT') throw error })
  await fs.promises.unlink(path.join(stage, JOURNAL)); await syncDirectory(stage)
  await fs.promises.rmdir(stage); await syncDirectory(context.metadata)
}

async function recoverStage(context, stage, albumFile) {
  let journal, validated = false
  try {
    await realDirectory(stage)
    journal = await readJournalFile(path.join(stage, JOURNAL))
    validateJournal(context, stage, journal, albumFile)
    validated = true
    const entries = await inspectEntries(context, stage, journal)
    if (journal.phase !== 'committed') {
      journal.phase = 'rollingBack'; await saveJournal(stage, journal)
      for (const state of entries.reverse()) {
        const { entry } = state
        // Capturing the published name, instead of unlinking it, retains any edit racing
        // recovery. A later checksum mismatch keeps the captured file and journal.
        if (state.next && !state.old) {
          if (state.discard) throw new Error(`Duplicate publication copies at ${entry.target}; inspect the recovery stage.`)
          await fs.promises.rename(entry.target, path.join(stage, entry.discard))
          await syncDirectory(path.dirname(entry.target)); await syncDirectory(stage)
          const captured = await fingerprint(path.join(stage, entry.discard))
          if (!matchesContent(captured, entry.after)) {
            await returnCapturedEdit(path.join(stage, entry.discard), entry.target, captured)
            throw new Error(`Delivery rollback conflict: ${entry.target} changed during restoration; its captured file at ${path.join(stage, entry.discard)} was preserved.`)
          }
        }
        if (entry.before && !state.old) await installExclusive(path.join(stage, entry.backup), entry.target, entry.before)
      }
      await inspectEntries(context, stage, journal)
    }
    await cleanup(context, stage, journal)
    return journal.phase === 'committed' ? 'committed' : 'restored'
  } catch (error) {
    const failure = recoveryError(stage, error)
    if (validated && journal.phase === 'committed') failure.deliveryCommitted = true
    throw failure
  }
}

async function recoverUnlocked(context, albumFile) {
  const recovered = [], orphanStages = []
  for (const name of (await fs.promises.readdir(context.metadata)).filter((name) => STAGE.test(name)).sort()) {
    const stage = path.join(context.metadata, name)
    await realDirectory(stage)
    const hasJournal = await fs.promises.lstat(path.join(stage, JOURNAL)).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
    if (hasJournal) recovered.push({ stage, state: await recoverStage(context, stage, albumFile) })
    else orphanStages.push(stage) // No publication began; preserve unfinished preparation.
  }
  return { recovered, orphanStages }
}

async function recoverDeliveries(paths, { albumFile } = {}) {
  const context = await contextOf(paths)
  return locked(context, () => recoverUnlocked(context, albumFile))
}

/** Cache readiness: new records verify content, while legacy records retain stamp policy. */
async function verifyOwnedArtifact(file, stamp, digest) {
  if (typeof file !== 'string' || typeof stamp !== 'string' || !/^\d+:\d+$/.test(stamp) || digest != null && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))) return false
  try {
    const st = await fs.promises.lstat(file, { bigint: true })
    if (!st.isFile() || `${st.size}:${Math.round(Number(st.mtimeNs) / 1e6)}` !== stamp) return false
    if (digest == null) return true
    const actual = await fingerprint(file)
    return !!actual && actual.stamp === stamp && actual.digest === digest
  } catch (_) { return false }
}

function ownedFiles(cache) {
  const owned = new Map()
  for (const [file, value] of Object.entries(cache.ownedFiles || {})) owned.set(file, typeof value === 'string' ? { stamp: value, digest: cache.ownedDigests && cache.ownedDigests[file] } : value)
  for (const entry of Object.values(cache.spreads || {})) for (const key of ['high', 'low']) if (entry[key]) owned.set(entry[key].path, { ...owned.get(entry[key].path), ...entry[key] })
  if (cache.pdf) owned.set(cache.pdf.path, { ...owned.get(cache.pdf.path), ...cache.pdf })
  return owned
}

function cancelled(isCancelled) {
  if (isCancelled && isCancelled()) throw Object.assign(new Error('Delivery was cancelled; the previous complete delivery was restored.'), { code: 'DELIVERY_CANCELLED' })
}

/** makeCache(records) builds the next cache from staged stamps, before exposing any file. */
async function publishDelivery(files, cache, suppliedStage, { paths, makeCache, isCancelled, albumFile = cache && cache.albumFile } = {}) {
  if (!cache || typeof albumFile !== 'string' || !path.isAbsolute(albumFile) || cache.albumFile !== albumFile || typeof makeCache !== 'function' || !Array.isArray(files)) throw new Error('Delivery publication requires matching album identity, files, and a cache builder.')
  const context = await contextOf(paths), stage = context.translate(suppliedStage)
  if (path.dirname(stage) !== context.metadata || !STAGE.test(path.basename(stage))) throw new Error('Delivery staging must be a private delivery folder beside the export cache.')
  await realDirectory(stage)
  return locked(context, async () => {
    await recoverUnlocked(context, albumFile)
    cancelled(isCancelled)
    const owned = ownedFiles(cache), entries = [], sources = new Set(), targets = new Set()
    for (const [i, item] of files.entries()) {
      const source = context.translate(item.source), target = context.translate(item.target)
      if (path.dirname(source) !== stage || !allowedTarget(context, target) || /^(?:journal\.json(?:\.new)?|cache\.next\.json|backup-.*|discard-.*)$/.test(path.basename(source)) || targets.has(target.toLowerCase()) || sources.has(source.toLowerCase())) throw new Error('Duplicate or invalid delivery source/target path.')
      targets.add(target.toLowerCase()); sources.add(source.toLowerCase())
      await checkTargetDirectory(context, target, true)
      const after = await fingerprint(source, true), before = await fingerprint(target, true), expected = owned.get(item.target) || owned.get(target)
      if (!after) throw new Error(`Prepared delivery file ${source} is missing.`)
      if (before && (!expected || expected.stamp !== before.stamp || expected.digest && expected.digest !== before.digest)) throw new Error(`Delivery file ${target} is unowned or has been edited. Preserve it elsewhere before exporting.`)
      entries.push({ source: path.basename(source), target, before, after, backup: `backup-${i}`, discard: `discard-${i}` })
    }
    const beforeCache = await fingerprint(context.paths.cache, true)
    if (!beforeCache && entries.some((entry) => entry.before)) throw new Error('The export ownership cache is missing; existing delivery files cannot be claimed from caller data alone.')
    if (beforeCache) {
      let disk
      try { disk = JSON.parse(await fs.promises.readFile(context.paths.cache, 'utf8')) } catch (_) { throw new Error('The existing export cache is unowned or invalid; preserve it before exporting.') }
      if (!isDeepStrictEqual(disk, cache) || !matches(await fingerprint(context.paths.cache), beforeCache)) throw new Error('The export ownership cache changed or belongs to another album; export again after recovery.')
    }
    const records = entries.map((entry, index) => ({ target: files[index].target, stamp: entry.after.stamp, digest: entry.after.digest }))
    let next = await makeCache(records)
    if (Buffer.isBuffer(next) || typeof next === 'string') next = JSON.parse(next.toString())
    else next = JSON.parse(JSON.stringify(next))
    if (!next || next.version !== 2 || next.albumFile !== albumFile) throw new Error('The next export cache must retain the current album identity and version.')
    next.ownedFiles = { ...(next.ownedFiles || {}) }
    next.ownedDigests = { ...(cache.ownedDigests || {}), ...(next.ownedDigests || {}) }
    for (const record of records) { next.ownedFiles[record.target] = record.stamp; next.ownedDigests[record.target] = record.digest }
    for (const spread of Object.values(next.spreads || {})) for (const key of ['high', 'low']) if (spread[key]) {
      const record = records.find((item) => context.translate(item.target) === context.translate(spread[key].path))
      if (record) { spread[key].stamp = record.stamp; spread[key].digest = record.digest }
    }
    if (next.pdf) { const record = records.find((item) => context.translate(item.target) === context.translate(next.pdf.path)); if (record) { next.pdf.stamp = record.stamp; next.pdf.digest = record.digest } }
    cancelled(isCancelled)
    const allowed = new Set(files.map((item) => path.basename(item.source)))
    if ((await fs.promises.readdir(stage)).some((name) => !allowed.has(name))) throw recoveryError(stage, new Error(`Unexpected files in the delivery stage ${stage}; preserve them before publishing.`))
    const cacheSource = path.join(stage, 'cache.next.json'), handle = await fs.promises.open(cacheSource, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(next, null, 1)); await handle.sync() } finally { await handle.close() }
    const i = entries.length
    entries.push({ source: 'cache.next.json', target: context.paths.cache, before: beforeCache, after: await fingerprint(cacheSource, true), backup: `backup-${i}`, discard: `discard-${i}` })
    // Cache building is allowed to be asynchronous. Recheck every old target before the
    // journal and first exposure, then check each one again at its own capture boundary.
    for (const entry of entries) {
      const actual = await fingerprint(entry.target)
      if (entry.before ? !matches(actual, entry.before) : actual) throw new Error(`Delivery file ${entry.target} changed while its ownership cache was prepared.`)
    }
    const journal = { version: 1, root: context.root, metadata: context.metadata, stage, albumFile, phase: 'pending', entries }
    validateJournal(context, stage, journal, albumFile)
    await syncDirectory(stage)
    try { await saveJournal(stage, journal, true) } catch (error) { throw recoveryError(stage, error) }
    try {
      for (const entry of entries) {
        cancelled(isCancelled)
        await checkTargetDirectory(context, entry.target)
        const actual = await fingerprint(entry.target)
        if (entry.before ? !matches(actual, entry.before) : actual) throw new Error(`Delivery file ${entry.target} changed during export.`)
        if (entry.before) {
          await fs.promises.rename(entry.target, path.join(stage, entry.backup))
          await syncDirectory(path.dirname(entry.target)); await syncDirectory(stage)
          const captured = await fingerprint(path.join(stage, entry.backup), true)
          if (!matches(captured, entry.before)) {
            await returnCapturedEdit(path.join(stage, entry.backup), entry.target, captured)
            throw new Error(`Delivery file ${entry.target} changed during publication; its captured file at ${path.join(stage, entry.backup)} was preserved.`)
          }
        }
        cancelled(isCancelled)
        await installExclusive(path.join(stage, entry.source), entry.target, entry.after)
      }
      cancelled(isCancelled)
      await inspectEntries(context, stage, { ...journal, phase: 'committed' })
      journal.phase = 'committed'; await saveJournal(stage, journal)
    } catch (error) {
      try {
        if (await recoverStage(context, stage, albumFile) === 'committed') error.deliveryCommitted = true
      } catch (recovery) {
        const failure = recoveryError(stage, new Error(`${error.message} ${recovery.message}`, { cause: error }))
        if (recovery.deliveryCommitted) failure.deliveryCommitted = true
        throw failure
      }
      throw error
    }
    // A committed marker is final. Cleanup failure must not be reported as rolled-back work.
    try { await cleanup(context, stage, journal) } catch (error) {
      const failure = recoveryError(stage, error); failure.deliveryCommitted = true; throw failure
    }
    return records
  })
}

module.exports = { publishDelivery, recoverDeliveries, verifyOwnedArtifact }
