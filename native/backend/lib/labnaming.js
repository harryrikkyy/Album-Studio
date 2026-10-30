// labnaming.js — files for the print lab's naming tool (the Electron app's Renamer): the sheets
// of an order folder with small thumbnails, and a rename that can't collide and can be undone.
// The names themselves are computed by the interface (ui/src/lab_naming.ts).

'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { cacheRoot, contentFileKey } = require('./cache')
const { deriveCached, derivedKey, sourceIdentity, unchangedSource, consumeSnapshot } = require('./raw')

const SHEET = /\.(jpe?g|png|psd|psb)$/i
const THUMB_EDGE = 480
const getSharp = () => require('../../../src/sharp_config').getSharp()
/** @typedef {import('../../contracts/runtime').RecoverableError} RecoverableError */

/** The JPEG preview Photoshop stores in a PSD's image resources (id 1036, or 1033), if any. */
function psdThumbnail(buf) {
  if (buf.length < 34 || buf.toString('latin1', 0, 4) !== '8BPS') return null
  let at = 26
  at += 4 + buf.readUInt32BE(at) // colour mode data
  if (at + 4 > buf.length) return null
  const end = at + 4 + buf.readUInt32BE(at)
  at += 4
  while (at + 12 <= end && at + 12 <= buf.length) {
    if (buf.toString('latin1', at, at + 4) !== '8BIM') return null
    const id = buf.readUInt16BE(at + 4)
    const nameLen = buf[at + 6]
    let p = at + 6 + 1 + nameLen
    if ((1 + nameLen) % 2) p++
    if (p + 4 > buf.length || p + 4 > end) return null
    const size = buf.readUInt32BE(p)
    const data = p + 4
    if (data + size > buf.length || data + size > end) return null
    if ((id === 1036 || id === 1033) && size > 28) return buf.subarray(data + 28, data + size)
    at = data + size + (size % 2)
  }
  return null
}

async function readHead(file, bytes) {
  const fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** A small cached thumbnail of a sheet, and its pixel size. */
async function thumbFor(file) {
  const ext = path.extname(file).toLowerCase()
  const dir = path.join(cacheRoot(), 'lab-thumbs')
  const sourceKey = await contentFileKey(file),
    recipe = 'lab-preview-sharp480-jpeg78-v2-frozen'
  const identity = await sourceIdentity(file)
  const out = path.join(dir, `${derivedKey(sourceKey, recipe)}.jpg`)
  return consumeSnapshot(file, sourceKey, dir, async (frozen) => {
    const sharp = getSharp()
    let width
    let height
    let input = frozen
    if (ext === '.psd' || ext === '.psb') {
      const head = await readHead(frozen, 4 << 20)
      if (head.length < 26 || head.toString('latin1', 0, 4) !== '8BPS' || ![1, 2].includes(head.readUInt16BE(4)))
        throw new Error(`The PSD/PSB ${file} has an invalid header; its preview could not be verified.`)
      height = head.readUInt32BE(14)
      width = head.readUInt32BE(18)
      input = psdThumbnail(head)
    } else {
      const meta = await sharp(frozen, { failOn: 'error' }).metadata()
      width = meta.width
      height = meta.height
    }
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
      throw new Error(`The sheet ${file} has invalid dimensions; its preview could not be verified.`)
    if (!input) {
      await unchangedSource(file, sourceKey, identity)
      return {
        thumb: null,
        width,
        height,
        warning:
          'A stored PSD/PSB JPEG preview could not be read within the first 4 MiB. The layered sheet has not been rendered or visually verified.',
      }
    }
    await unchangedSource(file, sourceKey, identity)
    await deriveCached(
      file,
      out,
      sourceKey,
      recipe,
      (tmp) =>
        sharp(input, { failOn: 'error' })
          .rotate()
          .resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside' })
          .jpeg({ quality: 78 })
          .toFile(tmp),
      { width, height },
    )
    await unchangedSource(file, sourceKey, identity)
    return { thumb: out, width, height }
  })
}

/** The sheets of a folder (JPEG, PNG, PSD, PSB), in natural name order. */
async function listSheets({ folder }) {
  if (!folder) throw new Error('missing `folder`')
  return withFolderLock(folder, false, async (canonical, journals) => {
    for (const journal of journals) await recoverJournal(canonical, journal)
    return listSheetsUnlocked(folder)
  })
}

async function listSheetsUnlocked(folder) {
  const entries = await fs.promises.readdir(folder, { withFileTypes: true }).catch(() => {
    throw new Error(`The folder ${folder} isn’t there. The drive may be disconnected.`)
  })
  const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.') && SHEET.test(e.name)).map((e) => e.name)
  files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  const out = []
  for (const name of files) {
    const file = path.join(folder, name)
    const t = await thumbFor(file).catch((error) => ({
      thumb: null,
      width: 0,
      height: 0,
      error: `Preview unavailable: ${error.message}. The sheet and existing previews have been preserved.`,
    }))
    out.push({ path: file, fileName: name, baseName: name.replace(/\.[^.]+$/, ''), ext: path.extname(name), ...t })
  }
  return { folder, name: path.basename(folder), sheets: out }
}

// eslint-disable-next-line no-control-regex -- control characters are exactly what a file name can't hold
const BAD = /[/:\\\u0000-\u001f]/

const JOURNAL = /^\.as-rename-([a-f0-9]{16})\.json$/
const LOCK = '.as-lab-rename.lock'
// Share locks even if a diagnostic reloads this module in the same helper process.
const processLockKey = Symbol.for('album-studio.lab-rename-locks')
const processLocks =
  globalThis[processLockKey] || (globalThis[processLockKey] = { folders: new Set(), tokens: new Set() })
const folderLocks = processLocks.folders

function identity(st) {
  return { dev: String(st.dev), ino: String(st.ino), size: String(st.size), mtimeNs: String(st.mtimeNs) }
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function fileState(file, entry) {
  let st
  try {
    st = await fs.promises.lstat(file, { bigint: true })
  } catch (e) {
    if (e.code === 'ENOENT') return 'missing'
    throw e
  }
  if (!st.isFile()) return 'foreign'
  const current = identity(st)
  if (entry.identity.ino !== '0' && Object.keys(entry.identity).every((key) => current[key] === entry.identity[key]))
    return 'owned'
  // Copies on exFAT/SMB acquire a new inode. Their content must match the journaled source.
  if (entry.digest && current.size === entry.identity.size && (await hashFile(file)) === entry.digest) return 'owned'
  return 'foreign'
}

async function syncFolder(folder) {
  let handle
  try {
    handle = await fs.promises.open(folder, 'r')
    await handle.sync()
  } catch (e) {
    // Some removable/network filesystems do not implement directory fsync.
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EISDIR'].includes(e.code)) throw e
  } finally {
    if (handle) await handle.close()
  }
}

async function saveJournal(file, journal, initial = false) {
  const out = initial ? file : `${file}.new`
  const handle = await fs.promises.open(out, initial ? 'wx' : 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(journal) + '\n')
    await handle.sync()
  } finally {
    await handle.close()
  }
  if (!initial) await fs.promises.rename(out, file)
  await syncFolder(path.dirname(file))
}

async function removeOwned(file, entry) {
  const state = await fileState(file, entry)
  if (state === 'foreign') throw new Error(`Recovery will not replace or delete the unrelated file ${file}.`)
  if (state === 'owned') {
    await fs.promises.unlink(file)
    await syncFolder(path.dirname(file))
  }
}

/** Exclusive moves avoid rename() silently replacing a file created after preflight. */
async function moveExclusive(from, to, entry, journal, journalFile) {
  if ((await fileState(from, entry)) !== 'owned')
    throw new Error(`The sheet ${from} changed or disappeared during renaming.`)
  try {
    await fs.promises.link(from, to)
  } catch (e) {
    if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'EMLINK'].includes(e.code)) throw e
    // Preserve support for exFAT and SMB, which may not allow hard links. The digest is
    // flushed before copying so restart recovery can identify the complete copy.
    if (!entry.digest) {
      entry.digest = await hashFile(from)
      await saveJournal(journalFile, journal)
    }
    const st = await fs.promises.stat(from)
    await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE)
    await fs.promises.chmod(to, st.mode)
    await fs.promises.utimes(to, st.atime, st.mtime)
    const handle = await fs.promises.open(to, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    if ((await hashFile(to)) !== entry.digest || (await hashFile(from)) !== entry.digest) {
      throw new Error(`The sheet ${from} changed during copying. Both files were preserved for recovery.`)
    }
  }
  await syncFolder(path.dirname(to))
  await fs.promises.unlink(from)
  await syncFolder(path.dirname(from))
}

function recoveryError(file, error) {
  /** @type {RecoverableError} */
  const out = new Error(
    `Lab renaming needs recovery. Keep ${file} and reconnect the drive or resolve the reported file conflict, then reopen the folder. ${error.message}`,
    { cause: error },
  )
  out.recoveryJournal = file
  return out
}

const plainName = (value) =>
  typeof value === 'string' && value !== '.' && value !== '..' && path.basename(value) === value && !BAD.test(value)
const decimalIdentity = (identity) =>
  !!identity &&
  ['dev', 'ino', 'size', 'mtimeNs'].every((k) => typeof identity[k] === 'string' && /^-?\d+$/.test(identity[k]))
// A journal this module wrote: its own file name, version 1, this folder and a known phase.
function validRenameJournal(folder, journal, match) {
  return (
    !!match &&
    !!journal &&
    typeof journal === 'object' &&
    journal.version === 1 &&
    journal.folder === folder &&
    ['staging', 'committing'].includes(journal.phase) &&
    Array.isArray(journal.entries)
  )
}
// One staged sheet: plain names, the exact temporary name, a decimal identity, and digest
// evidence wherever the file system reports no inode.
function validRenameEntry(entry, i, match) {
  return (
    !!entry &&
    plainName(entry.from) &&
    plainName(entry.to) &&
    !entry.from.startsWith('.as-') &&
    !entry.to.startsWith('.') &&
    entry.tmp === `.as-rename-${match[1]}-${i}${path.extname(entry.from)}` &&
    decimalIdentity(entry.identity) &&
    !(entry.digest && !/^[a-f0-9]{64}$/.test(entry.digest)) &&
    !(entry.identity.ino === '0' && !entry.digest)
  )
}
function validateJournal(folder, file, journal) {
  const match = path.basename(file).match(JOURNAL)
  if (!validRenameJournal(folder, journal, match))
    throw new Error('Invalid rename recovery journal; inspect it before continuing.')
  const sources = new Set()
  const targets = new Set()
  for (const [i, entry] of journal.entries.entries()) {
    if (!validRenameEntry(entry, i, match))
      throw new Error('Invalid sheet entry in rename recovery journal; no files were moved.')
    if (sources.has(entry.from.toLowerCase()) || targets.has(entry.to.toLowerCase()))
      throw new Error('Duplicate sheet entries in rename recovery journal; no files were moved.')
    sources.add(entry.from.toLowerCase())
    targets.add(entry.to.toLowerCase())
  }
}

/** Restore incomplete transactions before another rename or folder listing, including after restart. */
async function recoverJournal(folder, file) {
  try {
    const journal = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    validateJournal(folder, file, journal)
    if (journal.phase === 'committing') {
      const failures = []
      // Put committed outputs back into their private slots first, so cycles cannot collide.
      for (const entry of journal.entries) {
        const tmp = path.join(folder, entry.tmp)
        const to = path.join(folder, entry.to)
        try {
          const staged = await fileState(tmp, entry)
          const committed = await fileState(to, entry)
          if (staged === 'foreign') throw new Error(`Recovery found an unrelated file at ${tmp}.`)
          if (staged === 'owned') {
            if (committed === 'owned') await removeOwned(to, entry) // interrupted link/copy before unlink
          } else if (committed === 'owned') await moveExclusive(to, tmp, entry, journal, file)
          else throw new Error(`Recovery cannot locate the sheet originally named ${entry.from}.`)
        } catch (e) {
          failures.push(e.message)
        }
      }
      if (failures.length) throw new Error(failures.join(' '))
      journal.phase = 'staging'
      await saveJournal(file, journal)
    }
    const failures = []
    for (const entry of journal.entries) {
      const from = path.join(folder, entry.from)
      const tmp = path.join(folder, entry.tmp)
      try {
        const original = await fileState(from, entry)
        const staged = await fileState(tmp, entry)
        if (original === 'foreign' || staged === 'foreign')
          throw new Error(`Recovery will not overwrite an unrelated file at ${original === 'foreign' ? from : tmp}.`)
        if (original === 'owned') {
          if (staged === 'owned') await removeOwned(tmp, entry)
        } else if (staged === 'owned') await moveExclusive(tmp, from, entry, journal, file)
        else throw new Error(`Recovery cannot locate the sheet originally named ${entry.from}.`)
      } catch (e) {
        failures.push(e.message)
      }
    }
    if (failures.length) throw new Error(failures.join(' '))
    await fs.promises.unlink(file)
    await fs.promises.unlink(`${file}.new`).catch((e) => {
      if (e.code !== 'ENOENT') throw e
    })
    await syncFolder(folder)
  } catch (e) {
    throw recoveryError(file, e)
  }
}

async function lockOwner(file) {
  try {
    const owner = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !/^[a-f0-9]{16}$/.test(owner.token))
      throw new Error(`Inspect the invalid folder lock ${file} before renaming.`)
    if (owner.pid === process.pid && !processLocks.tokens.has(owner.token)) return false
    try {
      process.kill(owner.pid, 0)
      return true
    } catch (e) {
      if (e.code !== 'ESRCH') return true
    }
    return false
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

async function withFolderLock(folder, rename, work) {
  let canonical
  try {
    canonical = await fs.promises.realpath(folder)
  } catch (_) {
    throw new Error(`The folder ${folder} isn’t there. The drive may be disconnected.`)
  }
  if (folderLocks.has(canonical)) throw new Error('A lab rename or recovery is already in progress for this folder.')
  folderLocks.add(canonical)
  const lockFile = path.join(canonical, LOCK)
  const token = crypto.randomBytes(8).toString('hex')
  let held = false
  let failure
  let result
  try {
    const journals = (await fs.promises.readdir(canonical))
      .filter((f) => JOURNAL.test(f))
      .sort()
      .map((f) => path.join(canonical, f))
    const owner = await lockOwner(lockFile)
    if (owner === true) throw new Error('A lab rename or recovery is already in progress for this folder.')
    if (rename || journals.length) {
      if (owner === false) await fs.promises.unlink(lockFile)
      const handle = await fs.promises.open(lockFile, 'wx', 0o600)
      held = true
      processLocks.tokens.add(token)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }))
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    result = await work(canonical, journals)
  } catch (e) {
    failure = e
  } finally {
    try {
      if (held) await fs.promises.unlink(lockFile)
    } catch (e) {
      if (e.code !== 'ENOENT') {
        if (failure) {
          failure.recoveryLock = lockFile
          failure.message += ` Folder lock cleanup also failed: ${e.message}`
        } else {
          /** @type {RecoverableError} */
          const error = new Error(
            `The rename finished, but folder lock cleanup failed at ${lockFile}. Reconnect the drive before retrying. ${e.message}`,
            { cause: e },
          )
          error.recoveryLock = lockFile
          failure = error
        }
      }
    } finally {
      processLocks.tokens.delete(token)
      folderLocks.delete(canonical)
    }
  }
  if (failure) throw failure
  return result
}

/**
 * Rename sheets inside `folder`: `ops` [{fromPath, toBaseName}] keep each file's extension. Two
 * phases (every file to a temporary name, then to its new one), so swapping 00 and 01 works.
 * Returns the reverse operations, to undo it.
 */
async function renameSheets({ folder, ops }) {
  if (!folder || !Array.isArray(ops)) throw new Error('missing `folder` or `ops`')
  return withFolderLock(folder, true, async (canonical, journals) => {
    for (const journal of journals) await recoverJournal(canonical, journal)
    return renameSheetsUnlocked(folder, canonical, ops)
  })
}

async function renameSheetsUnlocked(folder, canonical, ops) {
  const plan = await planRenames(folder, canonical, ops)
  await refuseOverwrites(plan)
  if (!plan.length) return { renamed: 0, undo: [] }
  const { journal, journalFile } = renameJournal(canonical, plan)
  await applyRenames(canonical, journal, journalFile)
  return {
    renamed: plan.length,
    undo: plan.map((p) => ({ fromPath: p.to, toBaseName: path.basename(p.from).replace(/\.[^.]+$/, '') })),
  }
}

// Every op's checks, in order, and the identity of each sheet that changes name.
async function planRenames(folder, canonical, ops) {
  const plan = []
  const targets = new Set()
  const sources = new Set()
  const physicalSources = new Set()
  for (const op of ops) {
    if (path.dirname(op.fromPath) !== folder) throw new Error(`${op.fromPath} isn’t in ${folder}.`)
    if (sources.has(op.fromPath.toLowerCase()))
      throw new Error('A sheet cannot be renamed more than once in the same operation.')
    sources.add(op.fromPath.toLowerCase())
    const base = String(op.toBaseName || '').trim()
    if (!base || BAD.test(base) || base.startsWith('.')) throw new Error(`“${op.toBaseName}” can’t be a file name.`)
    const ext = path.extname(op.fromPath)
    const to = path.join(folder, base + ext)
    if (targets.has(to.toLowerCase())) throw new Error(`Two sheets would both be called “${base + ext}”.`)
    targets.add(to.toLowerCase())
    if (to !== op.fromPath) {
      const from = path.join(canonical, path.basename(op.fromPath))
      const st = await fs.promises.lstat(from, { bigint: true })
      if (!st.isFile() || path.basename(from).startsWith('.as-')) throw new Error(`${op.fromPath} is not a sheet file.`)
      const physical = `${st.dev}:${st.ino}`
      if (st.ino !== 0n && physicalSources.has(physical))
        throw new Error(
          'Two sheets refer to the same physical file. Make independent copies before renaming them together.',
        )
      physicalSources.add(physical)
      plan.push({
        from: op.fromPath,
        to,
        identity: identity(st),
        ...(st.ino === 0n ? { digest: await hashFile(from) } : {}),
      })
    }
  }
  return plan
}

// A target that is an existing file not being renamed would be overwritten: refuse.
async function refuseOverwrites(plan) {
  const moving = new Set(plan.map((p) => p.from.toLowerCase()))
  for (const p of plan) {
    if (
      !moving.has(p.to.toLowerCase()) &&
      (await fs.promises.access(p.to).then(
        () => true,
        () => false,
      ))
    ) {
      throw new Error(`${path.basename(p.to)} already exists in the folder and isn’t one of the sheets being renamed.`)
    }
  }
}

function renameJournal(canonical, plan) {
  const stamp = crypto.randomBytes(8).toString('hex')
  const journalFile = path.join(canonical, `.as-rename-${stamp}.json`)
  const journal = {
    version: 1,
    folder: canonical,
    phase: 'staging',
    entries: plan.map((p, i) => ({
      from: path.basename(p.from),
      to: path.basename(p.to),
      tmp: `.as-rename-${stamp}-${i}${path.extname(p.from)}`,
      identity: p.identity,
      ...(p.digest ? { digest: p.digest } : {}),
    })),
  }
  return { journal, journalFile }
}

// Saves the journal, moves every sheet to its temporary name and then to its new one, and
// restores the original names from the journal if any step fails.
async function applyRenames(canonical, journal, journalFile) {
  try {
    await saveJournal(journalFile, journal, true)
  } catch (e) {
    throw recoveryError(
      journalFile,
      new Error(`No sheets were moved because the recovery journal could not be saved. ${e.message}`, { cause: e }),
    )
  }
  try {
    for (const entry of journal.entries)
      await moveExclusive(
        path.join(canonical, entry.from),
        path.join(canonical, entry.tmp),
        entry,
        journal,
        journalFile,
      )
    journal.phase = 'committing'
    await saveJournal(journalFile, journal)
    for (const entry of journal.entries)
      await moveExclusive(path.join(canonical, entry.tmp), path.join(canonical, entry.to), entry, journal, journalFile)
    await fs.promises.unlink(journalFile)
    await syncFolder(canonical)
  } catch (e) {
    try {
      await recoverJournal(canonical, journalFile)
    } catch (recovery) {
      throw recoveryError(journalFile, new Error(`${e.message} ${recovery.message}`, { cause: e }))
    }
    throw new Error(`Lab rename failed; the original names were restored. ${e.message}`, { cause: e })
  }
}

module.exports = { listSheets, renameSheets, psdThumbnail }
