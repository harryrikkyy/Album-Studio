// A render's PSD and ownership cache form one durable transaction. Cooperating readers
// must recover under both project/output leases before trusting either public name.
// Large sheets are streamed through 1 MiB buffers; no customer/recovery file is deleted.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { isDeepStrictEqual } = require('util')
const MAX_CACHE_BYTES = 64 * 1024 * 1024
const MAX_JOURNAL_BYTES = 65536
const MAX_SHEET_BYTES = Number.MAX_SAFE_INTEGER // The supported positional file-offset bound, not an in-memory allocation.
const STAGE = /^render-[a-f0-9-]{36}$/
const SHA = /^[a-f0-9]{64}$/
const stat = file => fs.promises.lstat(file, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error })
const sameNode = (a, b) => !!a && !!b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
const content = (a, b) => !!a && !!b && a.digest === b.digest && a.size === b.size
const matches = (a, b) => content(a, b) && a.stamp === b.stamp
const owned = (a, b) => matches(a, b) && sameNode(a.node, b.node) && a.mode === b.mode
const changed = what => new Error(`The ${what} changed during rendering. Existing files and detached recovery snapshots were preserved; review them before retrying.`)
function stopped(check) { if (check && check()) { const error = new Error('Rendering was cancelled before commit.'); error.code = 'RENDER_CANCELLED'; throw error } }

// The same stream/revision primitive will guard native document publication.
const readRecord = require('./verified_file').createVerifiedFileReader({ label: 'Render', changed })

const { syncDirectory, directory, writeNew, writeCommitPart, copyDetached, move } = require('./publication_io').createPublicationIO({ subject: 'render', changed, readRecord })
const fingerprintRenderFile = file => readRecord(file)
const description = r => r && Object.fromEntries(Object.entries(r).filter(([key]) => key !== 'bytes'))
async function contextOf(p, capabilities) {
  if (!capabilities || typeof capabilities.assertOwned !== 'function' || typeof capabilities.assertOutput !== 'function') throw new Error('Render publication/recovery requires owned project and output capabilities.')
  if (!p || typeof p.albumFile !== 'string' || !path.isAbsolute(p.albumFile) || typeof p.outputFolder !== 'string' || !path.isAbsolute(p.outputFolder)) throw new Error('Render project and output paths must be absolute.')
  await capabilities.assertOwned(); await capabilities.assertOutput(p.outputFolder)
  const albumFile = await fs.promises.realpath(p.albumFile), output = await fs.promises.realpath(p.outputFolder)
  const outputNode = await directory(output), metadata = path.join(output, '.album-studio')
  const metadataNode = await directory(metadata, true), sheets = path.join(metadata, 'sheets'), sheetsNode = await directory(sheets, true)
  return { albumFile, logicalOutput: p.outputFolder, output, outputNode, metadata, metadataNode, sheets, sheetsNode, capabilities }
}
async function assertContext(c) {
  await c.capabilities.assertOwned(); await c.capabilities.assertOutput(c.logicalOutput)
  if (await fs.promises.realpath(c.logicalOutput) !== c.output || await fs.promises.realpath(c.albumFile) !== c.albumFile || !sameNode(c.outputNode, await directory(c.output)) || !sameNode(c.metadataNode, await directory(c.metadata)) || !sameNode(c.sheetsNode, await directory(c.sheets))) throw changed('project/output capability identity')
}
function failureAt(stage, error, committed = false, result) {
  const retained = error.recoveryStage || stage
  const failure = new Error(`${error.message} Render recovery evidence is retained at ${retained}. Preserve that folder and the current sheet/cache before retrying.`, { cause: error })
  failure.recoveryStage = retained; failure.recoveryJournal = path.join(retained, 'journal.json')
  if (error.code) failure.code = error.code
  if (error.renderRestored !== undefined) failure.renderRestored = error.renderRestored
  if (error.recoveryRequired) failure.recoveryRequired = true
  if (committed || error.renderCommitted) { failure.renderCommitted = true; if (result) Object.assign(failure, result) }
  return failure
}
const validNode = n => n && /^\d+$/.test(n.dev) && /^\d+$/.test(n.ino)
const validRecord = (r, maximum) => r && SHA.test(r.digest || '') && /^\d+$/.test(r.size || '') && BigInt(r.size) <= BigInt(maximum) && /^\d+:\d+$/.test(r.stamp || '') && validNode(r.node) && Number.isInteger(r.mode) && r.mode >= 0 && r.mode <= 0o777 && Number.isFinite(r.mtimeMs) && Number.isFinite(r.atimeMs)
async function journalOf(c, stage) {
  const stageNode = await directory(stage), raw = await readRecord(path.join(stage, 'journal.json'), MAX_JOURNAL_BYTES, true)
  if (!raw) throw new Error('The render recovery journal is missing.')
  if (raw.mode & 0o222) throw changed('immutable render journal permissions')
  let journal
  try { journal = JSON.parse(raw.bytes) } catch (_) { throw new Error('The render recovery journal is invalid JSON.') }
  if (!journal || journal.version !== 1 || journal.albumFile !== c.albumFile || journal.output !== c.output || journal.name !== path.basename(stage) || !STAGE.test(journal.name) || !sameNode(journal.stageNode, stageNode) || journal.commitNode !== undefined && !validNode(journal.commitNode) || !SHA.test(journal.projectRevision || '') || typeof journal.spreadId !== 'string' || !/^spread_[a-zA-Z0-9_-]+$/.test(journal.spreadId) || journal.spreadId.length > 200 || !Array.isArray(journal.entries) || journal.entries.length !== 2) throw new Error('Invalid render recovery identity; no public files were changed.')
  const targets = [path.join(c.sheets, `${journal.spreadId}.psd`), path.join(c.metadata, 'render-cache.json')]
  const allowed = new Set(['journal.json', 'commit.part.json', 'commit.json'])
  for (const [i, entry] of journal.entries.entries()) {
    const kind = i ? 'cache' : 'sheet', limit = i ? MAX_CACHE_BYTES : MAX_SHEET_BYTES
    const old = `old-${kind}${i ? '.json' : '.psd'}`, next = `next-${kind}${i ? '.json' : '.psd'}`, install = `install-${kind}${i ? '.json' : '.psd'}`
    if (!entry || entry.kind !== kind || entry.target !== targets[i] || entry.old !== old || entry.next !== next || entry.install !== install || entry.capture !== `captured-${kind}` || entry.discard !== `discard-${kind}` || entry.before !== null && !validRecord(entry.before, limit) || !validRecord(entry.after, limit)) throw new Error('Invalid render snapshot paths or revisions; no public files were changed.')
    for (const name of [old, next, install, entry.capture, entry.discard]) allowed.add(name)
    for (const [name, expected, identity] of [[old, entry.before, false], [next, entry.after, false], [install, entry.after, true], [entry.capture, entry.before, true], [entry.discard, entry.after, true]]) {
      const actual = await readRecord(path.join(stage, name), limit)
      if ((!expected && actual) || expected && [old, next].includes(name) && !actual || actual && !(identity ? owned(actual, expected) : matches(actual, expected))) throw changed(`retained render ${name}`)
      if (actual && [old, next].includes(name) && actual.mode & 0o222) throw changed(`immutable render ${name} permissions`)
    }
  }
  for (const name of await fs.promises.readdir(stage)) {
    if (!allowed.has(name) && !/^restore-(sheet|cache)-[a-f0-9-]{36}$/.test(name)) throw new Error(`Unexpected render recovery entry ${path.join(stage, name)} was preserved.`)
    const info = await stat(path.join(stage, name))
    if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw changed('render recovery entry')
    if (name === 'commit.part.json' && info.size > BigInt(MAX_JOURNAL_BYTES)) throw changed('render commit preparation')
  }
  const marker = await readRecord(path.join(stage, 'commit.json'), MAX_JOURNAL_BYTES, true)
  if (marker) {
    if (journal.commitNode && !sameNode(marker.node, journal.commitNode)) throw changed('durable render commit identity')
    if (marker.mode & 0o222) throw changed('immutable render commit permissions')
    let value
    try { value = JSON.parse(marker.bytes) } catch (_) { throw new Error('The render commit marker is invalid JSON.') }
    if (!value || value.version !== 1 || value.journal !== raw.digest) throw new Error('The render commit marker does not match the exact journal revision.')
  }
  return { journal, digest: raw.digest, committed: !!marker }
}
async function optionalPublic(file, maximum) {
  const info = await stat(file)
  if (!info) return null
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) return { foreign: true }
  return readRecord(file, maximum)
}
async function inspect(c, journal, pending) {
  await assertContext(c)
  const results = []
  for (const [i, entry] of journal.entries.entries()) {
    const current = await optionalPublic(entry.target, i ? MAX_CACHE_BYTES : MAX_SHEET_BYTES)
    const old = matches(current, entry.before), next = owned(current, entry.after)
    if (pending && current && !old && !next) throw new Error(`Render rollback conflict at ${entry.target}. A manual or unrelated file was preserved.`)
    results.push({ entry, current, old, next })
  }
  return results
}
async function returnCaptured(c, stage, entry, file, actual) {
  if (!actual || await stat(entry.target)) return
  const restore = path.join(stage, `restore-${entry.kind}-${crypto.randomUUID()}`)
  await copyDetached(file, restore, actual); await assertContext(c)
  try { await move(restore, entry.target) } catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error }
}
async function retire(c, stage) {
  await journalOf(c, stage); await assertContext(c)
  const history = path.join(c.metadata, 'render-history'); await directory(history, true)
  const destination = path.join(history, path.basename(stage)), before = await stat(stage)
  try { await move(stage, destination) } catch (error) {
    if (!await stat(stage) && sameNode(before, await stat(destination))) throw failureAt(destination, error)
    throw error
  }
  try { await journalOf(c, destination) } catch (error) { throw failureAt(destination, error) }
  return destination
}
async function recoverStage(c, stage) {
  let committed = false
  try {
    const state = await journalOf(c, stage), { journal } = state; committed = state.committed
    const entries = await inspect(c, journal, !committed)
    if (!committed) {
      // Validate both public names before modifying either. Then roll cache back first.
      for (const { entry, old, next } of entries.reverse()) {
        if (next && !old) {
          await assertContext(c)
          const discard = path.join(stage, entry.discard)
          if (await stat(discard)) throw new Error(`A duplicate discard file ${discard} prevents automatic rollback.`)
          await move(entry.target, discard)
          const captured = await readRecord(discard)
          if (!owned(captured, entry.after)) { await returnCaptured(c, stage, entry, discard, captured); throw changed('sheet/cache during rollback capture') }
        }
        if (!old && entry.before) {
          const restore = path.join(stage, `restore-${entry.kind}-${crypto.randomUUID()}`)
          await copyDetached(path.join(stage, entry.old), restore, entry.before)
          await assertContext(c); await move(restore, entry.target)
        }
      }
      const final = await inspect(c, journal, true)
      if (final.some(({ entry, current, old }) => entry.before ? !old : !!current)) throw new Error('The restored render pair changed; recovery evidence was preserved.')
    }
    // A durable commit is final. Later customer edits are never rewritten during retirement.
    return { state: committed ? 'committed' : 'restored', historyPath: await retire(c, stage) }
  } catch (error) { throw failureAt(stage, error, committed) }
}
async function recoverInContext(c) {
  await assertContext(c)
  const recovered = [], orphanStages = []
  for (const name of (await fs.promises.readdir(c.metadata)).sort()) {
    if (name.startsWith('.render-prepare-')) { orphanStages.push(path.join(c.metadata, name)); continue }
    if (!STAGE.test(name)) continue
    recovered.push({ stage: path.join(c.metadata, name), ...await recoverStage(c, path.join(c.metadata, name)) })
  }
  return { recovered, orphanStages }
}
async function recoverRenders(p, capabilities) { return recoverInContext(await contextOf(p, capabilities)) }
async function checkSnapshot(c, p) {
  await assertContext(c); stopped(c.capabilities.isCancelled)
  const project = await readRecord(c.albumFile, MAX_CACHE_BYTES)
  if (!project || project.digest !== p.expectedProjectRevision) throw changed('project revision')
  if (c.capabilities.validateSnapshot) await c.capabilities.validateSnapshot()
  stopped(c.capabilities.isCancelled)
}
function parseCache(record, albumFile) {
  if (!record) return {}
  let value
  try { value = JSON.parse(record.bytes) } catch (_) { throw new Error('The existing render cache is invalid JSON; its bytes were preserved.') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version === 2 && (!value.spreads || typeof value.spreads !== 'object' || Array.isArray(value.spreads))) throw new Error('The existing render cache structure is invalid; its bytes were preserved.')
  if (value.albumFile !== undefined && value.albumFile !== albumFile) throw new Error('The rendered-sheet folder belongs to another project; choose a separate output folder.')
  return value
}

/**
 * cacheBefore is the exact SHA-256 of bytes read before construction, or null if absent.
 * sheetBefore is the verified prior digest/stamp (fingerprintRenderFile is convenient), or null.
 * cacheNext carries the complete next cache and recipe record; this function fills the final
 * detached install's path/stamp/digest before writing the immutable journal. Logical output
 * paths stay logical in the cache; physical paths are journal capability checks only.
 */
async function publishRender(p, capabilities) {
  if (!p || !/^spread_[a-zA-Z0-9_-]+$/.test(p.spreadId || '') || p.spreadId.length > 200 || typeof p.source !== 'string' || !path.isAbsolute(p.source) || !SHA.test(p.sourceDigest || '') || !SHA.test(p.expectedProjectRevision || '') || p.cacheBefore !== null && !SHA.test(p.cacheBefore || '') || p.sheetBefore !== null && (!p.sheetBefore || !SHA.test(p.sheetBefore.digest || '') || !/^\d+:\d+$/.test(p.sheetBefore.stamp || ''))) throw new Error('Render publication requires stable spread identity and exact prior/source/project revisions.')
  if (capabilities && capabilities.validateSnapshot !== undefined && typeof capabilities.validateSnapshot !== 'function' || capabilities && capabilities.isCancelled !== undefined && typeof capabilities.isCancelled !== 'function') throw new Error('Render snapshot/cancellation validators must be functions.')
  const c = await contextOf(p, capabilities); await recoverInContext(c); await checkSnapshot(c, p)
  const sheet = path.join(c.sheets, `${p.spreadId}.psd`), cacheFile = path.join(c.metadata, 'render-cache.json')
  const beforeSheet = await readRecord(sheet), beforeCache = await readRecord(cacheFile, MAX_CACHE_BYTES, true)
  if (p.sheetBefore ? !matches(beforeSheet, { ...p.sheetBefore, size: p.sheetBefore.size || p.sheetBefore.stamp.split(':')[0] }) : beforeSheet) throw changed('previous sheet revision')
  if (p.cacheBefore ? !beforeCache || beforeCache.digest !== p.cacheBefore : beforeCache) throw changed('render-cache revision')
  const oldCache = parseCache(beforeCache, c.albumFile), source = await readRecord(p.source)
  if (!source || source.digest !== p.sourceDigest) throw changed('staged source revision')
  if (!p.cacheNext || p.cacheNext.version !== 2 || p.cacheNext.albumFile !== c.albumFile || !p.cacheNext.spreads || typeof p.cacheNext.spreads !== 'object' || Array.isArray(p.cacheNext.spreads) || !p.cacheNext.spreads[p.spreadId]) throw new Error('The next render cache must identify the canonical project and rendered spread.')
  if (oldCache.version === 2) {
    const unchanged = value => Object.fromEntries(Object.entries(value.spreads).filter(([id]) => id !== p.spreadId))
    if (!isDeepStrictEqual(unchanged(oldCache), unchanged(p.cacheNext))) throw new Error('The next render cache changes another spread; preserve its exact ownership record.')
  }
  const logicalSheet = path.join(c.logicalOutput, '.album-studio', 'sheets', `${p.spreadId}.psd`)
  const proposed = p.cacheNext.spreads[p.spreadId]
  if (proposed.path !== undefined && path.resolve(proposed.path) !== path.resolve(logicalSheet) || proposed.outputFolder !== undefined && path.resolve(proposed.outputFolder) !== path.resolve(c.logicalOutput)) throw new Error('The next sheet record is outside the reserved logical output path.')
  const prepared = await fs.promises.mkdtemp(path.join(c.metadata, '.render-prepare-')), name = `render-${crypto.randomUUID()}`, stage = path.join(c.metadata, name)
  let exposed = false, committed = false, result
  try {
    const snapshot = await copyDetached(p.source, path.join(prepared, 'next-sheet.psd'), source, 0o400)
    const installSheet = await copyDetached(path.join(prepared, 'next-sheet.psd'), path.join(prepared, 'install-sheet.psd'), { ...snapshot, mode: source.mode })
    if (beforeSheet) await copyDetached(sheet, path.join(prepared, 'old-sheet.psd'), beforeSheet, 0o400)
    if (beforeCache) await copyDetached(cacheFile, path.join(prepared, 'old-cache.json'), beforeCache, 0o400)
    const nextCache = { ...p.cacheNext, spreads: { ...p.cacheNext.spreads, [p.spreadId]: { ...proposed, path: logicalSheet, outputFolder: c.logicalOutput, sheet: installSheet.stamp, sheetDigest: installSheet.digest } } }
    const bytes = Buffer.from(JSON.stringify(nextCache, null, 1))
    if (bytes.length > MAX_CACHE_BYTES) throw new Error('The next render cache exceeds its supported 64 MiB JSON policy.')
    await writeNew(path.join(prepared, 'next-cache.json'), bytes, 0o400)
    const nextCacheRecord = await readRecord(path.join(prepared, 'next-cache.json'), MAX_CACHE_BYTES)
    const installCache = await copyDetached(path.join(prepared, 'next-cache.json'), path.join(prepared, 'install-cache.json'), { ...nextCacheRecord, mode: beforeCache ? beforeCache.mode : 0o600 })
    const entries = [['sheet', sheet, beforeSheet, installSheet], ['cache', cacheFile, beforeCache, installCache]].map(([kind, target, before, after]) => ({ kind, target, before: description(before), after: description(after), old: `old-${kind}${kind === 'sheet' ? '.psd' : '.json'}`, next: `next-${kind}${kind === 'sheet' ? '.psd' : '.json'}`, install: `install-${kind}${kind === 'sheet' ? '.psd' : '.json'}`, capture: `captured-${kind}`, discard: `discard-${kind}` }))
    // Reserve the marker's independent inode before sealing the journal. Its contents
    // are filled only after both public files pass verification; an identical-byte
    // substituted marker can never acquire this transaction's restart authority.
    const commitNode = await writeNew(path.join(prepared, 'commit.part.json'), '', 0o600)
    const journal = { version: 1, albumFile: c.albumFile, output: c.output, name, stageNode: await directory(prepared), spreadId: p.spreadId, projectRevision: p.expectedProjectRevision, entries, commitNode }
    const journalBytes = Buffer.from(JSON.stringify(journal)), journalRevision = crypto.createHash('sha256').update(journalBytes).digest('hex')
    await writeNew(path.join(prepared, 'journal.json'), journalBytes, 0o400); await syncDirectory(prepared)
    const exactJournal = async () => { const state = await journalOf(c, stage); if (state.digest !== journalRevision) throw changed('durable render journal revision'); return state }
    await checkSnapshot(c, p); await move(prepared, stage); exposed = true
    await exactJournal()
    result = { committed: true, sheetRecord: { ...description(installSheet), path: logicalSheet, outputFolder: c.logicalOutput }, cacheRevision: installCache.digest, cache: nextCache, cacheData: nextCache }
    for (const entry of entries) {
      await checkSnapshot(c, p)
      await exactJournal()
      const current = await readRecord(entry.target, entry.kind === 'cache' ? MAX_CACHE_BYTES : MAX_SHEET_BYTES)
      if (entry.before ? !owned(current, entry.before) : current) throw changed(`existing ${entry.kind} at publication`)
      if (entry.before) {
        await move(entry.target, path.join(stage, entry.capture))
        const captured = await readRecord(path.join(stage, entry.capture))
        if (!owned(captured, entry.before)) { await returnCaptured(c, stage, entry, path.join(stage, entry.capture), captured); throw changed(`${entry.kind} at atomic capture`) }
      }
      await checkSnapshot(c, p); await move(path.join(stage, entry.install), entry.target)
      if (!owned(await readRecord(entry.target), entry.after)) throw changed(`installed ${entry.kind}`)
    }
    await exactJournal()
    const publicEntries = await inspect(c, journal, true)
    if (publicEntries.some(({ next }) => !next)) throw changed('published sheet/cache ownership')
    await checkSnapshot(c, p)
    const markerBytes = Buffer.from(JSON.stringify({ version: 1, journal: journalRevision })), markerDigest = crypto.createHash('sha256').update(markerBytes).digest('hex')
    await writeCommitPart(stage, markerBytes, commitNode)
    // Honour stop/source changes even if they occur during the commit record's write/fsync.
    await checkSnapshot(c, p); await exactJournal()
    const marker = await readRecord(path.join(stage, 'commit.part.json'), MAX_JOURNAL_BYTES)
    if (!marker || marker.digest !== markerDigest || marker.size !== String(markerBytes.length) || !sameNode(marker.node, commitNode) || marker.mode & 0o222) throw changed('exact render commit preparation bytes or identity')
    await move(path.join(stage, 'commit.part.json'), path.join(stage, 'commit.json'), commitNode)
    await exactJournal(); committed = true
    return { ...result, historyPath: await retire(c, stage) }
  } catch (error) {
    if (!exposed && !await stat(prepared) && await stat(stage)) exposed = true
    if (exposed && await stat(stage)) {
      try {
        const state = await journalOf(c, stage); committed = state.committed
        const recovery = await recoverStage(c, stage); error.recoveryStage = recovery.historyPath
        if (!state.committed) error.renderRestored = true
      } catch (recovery) { error.message += ` ${recovery.message}`; error.recoveryStage = recovery.recoveryStage || stage; error.recoveryRequired = true; if (recovery.renderCommitted) committed = true }
    }
    throw failureAt(exposed ? stage : prepared, error, committed, result)
  }
}

module.exports = { publishRender, recoverRenders, fingerprintRenderFile }
