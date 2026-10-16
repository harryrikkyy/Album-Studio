// Compare-and-publish for a batch in one physical directory. Callers retain the
// namespace/domain capabilities throughout preparation, commit and recovery.
// Existing and proposed bytes are detached history, never hard links or garbage.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const MAX_JOURNAL = 1024 * 1024
const SHA = /^[a-f0-9]{64}$/
const STAGE = /^files-[a-f0-9-]{36}$/
const stat = file => fs.promises.lstat(file, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error })
const sameNode = (a, b) => !!a && !!b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
const matches = (a, b) => !!a && !!b && a.digest === b.digest && a.size === b.size && a.stamp === b.stamp
const owned = (a, b) => matches(a, b) && sameNode(a.node, b.node) && a.mode === b.mode
const changed = what => Object.assign(new Error(`The ${what} changed during file publication. Existing files and recovery evidence were preserved.`), { code: 'PUBLICATION_CONFLICT' })
const readRecord = require('./verified_file').createVerifiedFileReader({ label: 'Publication', changed })
const { directory, syncDirectory, writeNew, writeCommitPart, copyDetached, move } = require('./publication_io').createPublicationIO({ subject: 'file publication', changed, readRecord })
const validNode = n => !!n && /^\d{1,24}$/.test(n.dev) && /^\d{1,24}$/.test(n.ino)
const validRecord = r => !!r && SHA.test(r.digest || '') && /^(0|[1-9]\d{0,15})$/.test(r.size || '') && BigInt(r.size) <= BigInt(Number.MAX_SAFE_INTEGER) && /^\d{1,16}:\d{1,16}$/.test(r.stamp || '') && validNode(r.node) && Number.isInteger(r.mode) && r.mode >= 0 && r.mode <= 0o777 && Number.isFinite(r.mtimeMs) && Number.isFinite(r.atimeMs)
const validName = n => typeof n === 'string' && n.length > 0 && n.length <= 255 && n.isWellFormed() && !['.', '..'].includes(n) && path.basename(n) === n && !n.includes('\0') && !n.startsWith('.album-studio')
function failureAt(stage, error, committed = false, result) {
  const retained = error.recoveryStage || stage
  const failure = new Error(`${error.message} File publication evidence is retained at ${retained}.`, { cause: error })
  Object.assign(failure, { code: error.code || 'PUBLICATION_FAILED', recoveryStage: retained, recoveryJournal: path.join(retained, 'journal.json'), publicationCommitted: committed || !!error.publicationCommitted })
  if (error.publicationRestored) failure.publicationRestored = true
  if (error.recoveryRequired) failure.recoveryRequired = true
  if (failure.publicationCommitted && result) Object.assign(failure, result)
  return failure
}
async function context(folder, capabilities) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || !capabilities || typeof capabilities.assertOwned !== 'function' || typeof capabilities.assertTarget !== 'function' || capabilities.validateSnapshot !== undefined && typeof capabilities.validateSnapshot !== 'function' || capabilities.isCancelled !== undefined && typeof capabilities.isCancelled !== 'function') throw new Error('File publication requires an absolute directory and owned namespace/domain capabilities.')
  await capabilities.assertOwned()
  const physical = await fs.promises.realpath(folder), parentNode = await directory(physical)
  const metadata = path.join(physical, '.album-studio-publications'), metadataNode = await directory(metadata, true)
  return { logical: folder, physical, parentNode, metadata, metadataNode, capabilities }
}
async function assertContext(c, target) {
  await c.capabilities.assertOwned()
  if (target) await c.capabilities.assertTarget(path.join(c.logical, target))
  if (await fs.promises.realpath(c.logical) !== c.physical || !sameNode(await directory(c.physical), c.parentNode) || !sameNode(await directory(c.metadata), c.metadataNode)) throw changed('publication directory identity')
}
async function checkSnapshot(c) {
  await assertContext(c)
  if (c.capabilities.validateSnapshot) await c.capabilities.validateSnapshot()
  if (c.capabilities.isCancelled && c.capabilities.isCancelled()) throw Object.assign(new Error('File publication was cancelled before commit.'), { code: 'PUBLICATION_CANCELLED' })
}
async function journalOf(c, stage) {
  const stageNode = await directory(stage), raw = await readRecord(path.join(stage, 'journal.json'), MAX_JOURNAL, true)
  if (!raw || raw.mode & 0o222) throw changed('immutable publication journal')
  let journal
  try { journal = JSON.parse(raw.bytes) } catch (_) { throw changed('publication journal JSON') }
  if (!journal || journal.version !== 1 || journal.folder !== c.physical || journal.name !== path.basename(stage) || !STAGE.test(journal.name) || !sameNode(journal.parentNode, c.parentNode) || !sameNode(journal.metadataNode, c.metadataNode) || !sameNode(journal.stageNode, stageNode) || !validNode(journal.commitNode) || !Array.isArray(journal.entries) || !journal.entries.length || journal.entries.length > 256) throw changed('publication journal identity')
  const names = new Set(), allowed = new Set(['journal.json', 'commit.part.json', 'commit.json'])
  for (const [i, entry] of journal.entries.entries()) {
    if (!entry || !validName(entry.name) || names.has(entry.name) || entry.before !== null && !validRecord(entry.before) || !validRecord(entry.after)) throw changed('publication entry identity')
    names.add(entry.name)
    for (const prefix of ['old', 'next', 'install', 'captured', 'discard']) {
      const name = `${prefix}-${i}`, actual = await readRecord(path.join(stage, name)), expected = prefix === 'old' || prefix === 'captured' ? entry.before : entry.after
      allowed.add(name)
      if (!expected && actual || expected && ['old', 'next'].includes(prefix) && !actual || actual && !(prefix === 'old' || prefix === 'next' ? matches(actual, expected) && !(actual.mode & 0o222) : owned(actual, expected))) throw changed(`retained publication ${name}`)
    }
  }
  for (const name of await fs.promises.readdir(stage)) {
    if (!allowed.has(name) && !/^restore-\d{1,3}-[a-f0-9-]{36}$/.test(name)) throw changed('unexpected publication recovery entry')
    const info = await stat(path.join(stage, name))
    if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || name === 'commit.part.json' && info.size > BigInt(MAX_JOURNAL)) throw changed('publication recovery file identity')
  }
  const marker = await readRecord(path.join(stage, 'commit.json'), MAX_JOURNAL, true)
  if (marker) {
    if (!sameNode(marker.node, journal.commitNode) || marker.mode & 0o222) throw changed('durable publication commit identity')
    let value
    try { value = JSON.parse(marker.bytes) } catch (_) { throw changed('publication commit JSON') }
    if (!value || value.version !== 1 || value.journal !== raw.digest) throw changed('exact publication commit revision')
  }
  return { journal, digest: raw.digest, committed: !!marker }
}
async function inspect(c, journal, pending) {
  await assertContext(c)
  const results = []
  for (const [i, entry] of journal.entries.entries()) {
    await assertContext(c, entry.name)
    const target = path.join(c.physical, entry.name), info = await stat(target)
    const current = !info ? null : info.isFile() && !info.isSymbolicLink() && info.nlink === 1n ? await readRecord(target) : { foreign: true }
    const old = matches(current, entry.before), next = owned(current, entry.after)
    if (pending && current && !old && !next) throw changed(`manual or unrelated public file ${target}`)
    results.push({ i, entry, target, current, old, next })
  }
  return results
}
async function retire(c, stage) {
  await journalOf(c, stage); await assertContext(c)
  const history = path.join(c.metadata, 'history'); await directory(history, true)
  const destination = path.join(history, path.basename(stage)), before = await stat(stage)
  try { await move(stage, destination) } catch (error) {
    if (!await stat(stage) && sameNode(before, await stat(destination))) throw failureAt(destination, error)
    throw error
  }
  try { await journalOf(c, destination) } catch (error) { throw failureAt(destination, error) }
  return destination
}
async function returnCaptured(c, stage, i, file, target, actual) {
  if (!actual || await stat(target)) return
  const restore = path.join(stage, `restore-${i}-${crypto.randomUUID()}`)
  await copyDetached(file, restore, actual); await assertContext(c)
  try { await move(restore, target) } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error }
}
async function recoverStage(c, stage) {
  let committed = false
  try {
    const state = await journalOf(c, stage); committed = state.committed
    const entries = await inspect(c, state.journal, !committed)
    if (!committed) {
      for (const { i, entry, target, old, next } of entries.reverse()) {
        if (next && !old) {
          await assertContext(c, entry.name)
          const discard = path.join(stage, `discard-${i}`)
          if (await stat(discard)) throw changed('duplicate publication discard')
          await move(target, discard)
          const captured = await readRecord(discard)
          if (!owned(captured, entry.after)) { await returnCaptured(c, stage, i, discard, target, captured); throw changed('public file during rollback capture') }
        }
        if (!old && entry.before) {
          const restore = path.join(stage, `restore-${i}-${crypto.randomUUID()}`)
          await copyDetached(path.join(stage, `old-${i}`), restore, entry.before)
          await assertContext(c, entry.name); await move(restore, target)
        }
      }
      const final = await inspect(c, state.journal, true)
      if (final.some(({ entry, current, old }) => entry.before ? !old : !!current)) throw changed('restored publication batch')
    }
    return { state: committed ? 'committed' : 'restored', historyPath: await retire(c, stage) }
  } catch (error) { throw failureAt(stage, error, committed) }
}
async function recoverInContext(c) {
  await assertContext(c)
  const recovered = [], orphanStages = []
  for (const name of (await fs.promises.readdir(c.metadata)).sort()) {
    if (name.startsWith('.prepare-')) orphanStages.push(path.join(c.metadata, name))
    else if (STAGE.test(name)) recovered.push({ stage: path.join(c.metadata, name), ...await recoverStage(c, path.join(c.metadata, name)) })
    else if (['history', 'inputs'].includes(name)) await directory(path.join(c.metadata, name))
    else throw changed('unknown publication metadata entry')
  }
  return { recovered, orphanStages }
}
async function recoverFiles(folder, capabilities) { return recoverInContext(await context(folder, capabilities)) }

/** Sources are private regular files, streamed into independent snapshots. The caller
 * supplies exact prior records (or null), never a fresh-at-save overwrite permission. */
async function publishFiles({ folder, entries }, capabilities) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 256 || entries.some(e => !e || !validName(e.name) || typeof e.source !== 'string' || !path.isAbsolute(e.source) || !SHA.test(e.sourceDigest || '') || e.before !== null && !validRecord(e.before)) || new Set(entries.map(e => e.name)).size !== entries.length) throw new Error('Publication requires 1–256 distinct file names, exact prior records and staged source digests.')
  const c = await context(folder, capabilities); await recoverInContext(c); await checkSnapshot(c)
  const before = [], sources = []
  for (const entry of entries) {
    await assertContext(c, entry.name)
    const current = await readRecord(path.join(c.physical, entry.name)), source = await readRecord(entry.source)
    if (entry.before ? !owned(current, entry.before) : current) throw changed(`previous revision of ${entry.name}`)
    if (!source || source.digest !== entry.sourceDigest) throw changed(`staged source ${entry.name}`)
    before.push(current); sources.push(source)
  }
  const prepared = await fs.promises.mkdtemp(path.join(c.metadata, '.prepare-')), name = `files-${crypto.randomUUID()}`, stage = path.join(c.metadata, name)
  let exposed = false, committed = false, result
  try {
    const records = []
    for (const [i, entry] of entries.entries()) {
      const next = await copyDetached(entry.source, path.join(prepared, `next-${i}`), sources[i], 0o400)
      const after = await copyDetached(path.join(prepared, `next-${i}`), path.join(prepared, `install-${i}`), { ...next, mode: before[i] ? before[i].mode : 0o600 })
      if (before[i]) await copyDetached(path.join(c.physical, entry.name), path.join(prepared, `old-${i}`), before[i], 0o400)
      records.push({ name: entry.name, before: before[i], after })
    }
    const commitNode = await writeNew(path.join(prepared, 'commit.part.json'), '', 0o600)
    const journal = { version: 1, name, folder: c.physical, parentNode: c.parentNode, metadataNode: c.metadataNode, stageNode: await directory(prepared), entries: records, commitNode }
    const bytes = Buffer.from(JSON.stringify(journal)), revision = crypto.createHash('sha256').update(bytes).digest('hex')
    if (bytes.length > MAX_JOURNAL) throw new Error('The publication journal exceeds its 1 MiB limit.')
    await writeNew(path.join(prepared, 'journal.json'), bytes, 0o400); await syncDirectory(prepared)
    const exactJournal = async () => { const state = await journalOf(c, stage); if (state.digest !== revision) throw changed('durable publication journal revision'); return state }
    await checkSnapshot(c); await move(prepared, stage); exposed = true
    await exactJournal()
    result = { committed: true, records: records.map(e => ({ name: e.name, ...e.after })) }
    for (const [i, entry] of records.entries()) {
      await checkSnapshot(c); await assertContext(c, entry.name); await exactJournal()
      const target = path.join(c.physical, entry.name), current = await readRecord(target)
      if (entry.before ? !owned(current, entry.before) : current) throw changed(`public revision of ${entry.name}`)
      if (entry.before) {
        const capture = path.join(stage, `captured-${i}`)
        await move(target, capture)
        const actual = await readRecord(capture)
        if (!owned(actual, entry.before)) { await returnCaptured(c, stage, i, capture, target, actual); throw changed(`atomic capture of ${entry.name}`) }
      }
      await checkSnapshot(c); await move(path.join(stage, `install-${i}`), target)
      if (!owned(await readRecord(target), entry.after)) throw changed(`installed revision of ${entry.name}`)
    }
    await exactJournal()
    if ((await inspect(c, journal, true)).some(({ next }) => !next)) throw changed('published batch ownership')
    await checkSnapshot(c)
    const markerBytes = Buffer.from(JSON.stringify({ version: 1, journal: revision })), markerDigest = crypto.createHash('sha256').update(markerBytes).digest('hex')
    await writeCommitPart(stage, markerBytes, commitNode)
    await checkSnapshot(c); await exactJournal()
    const marker = await readRecord(path.join(stage, 'commit.part.json'), MAX_JOURNAL)
    if (!marker || marker.digest !== markerDigest || marker.size !== String(markerBytes.length) || !sameNode(marker.node, commitNode) || marker.mode & 0o222) throw changed('exact publication commit preparation')
    await move(path.join(stage, 'commit.part.json'), path.join(stage, 'commit.json'), commitNode)
    await exactJournal(); committed = true
    return { ...result, historyPath: await retire(c, stage) }
  } catch (error) {
    if (!exposed && !await stat(prepared) && await stat(stage)) exposed = true
    if (exposed && await stat(stage)) {
      try {
        const state = await journalOf(c, stage); committed = state.committed
        const recovery = await recoverStage(c, stage); error.recoveryStage = recovery.historyPath
        if (!state.committed) error.publicationRestored = true
      } catch (recovery) { error.message += ` ${recovery.message}`; error.recoveryStage = recovery.recoveryStage || stage; error.recoveryRequired = true; if (recovery.publicationCommitted) committed = true }
    }
    throw failureAt(exposed ? stage : prepared, error, committed, result)
  }
}
module.exports = { publishFiles, recoverFiles, fingerprintFile: readRecord, matchesFileRevision: (actual, expected) => validRecord(expected) && owned(actual, expected) }
