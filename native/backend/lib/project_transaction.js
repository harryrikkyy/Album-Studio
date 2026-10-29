// Revision-checked project saves. A flushed immutable journal precedes every public-name
// mutation; old snapshots and captured customer files are retained in permanent history.
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const exclusive = require('./exclusive_rename')
const MAX_PROJECT_BYTES = 64 * 1024 * 1024
const MAX_JOURNAL_BYTES = 65536
const SAVE = /^save-[a-f0-9-]{36}$/
const revisionOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const sameNode = (a, b) => a && b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
const sameRead = (a, b) => sameNode(a, b) && ['size', 'mtimeNs', 'ctimeNs'].every((k) => a[k] === b[k])
const nodeOf = (st) => ({ dev: String(st.dev), ino: String(st.ino) })
const stat = (file) =>
  fs.promises.lstat(file, { bigint: true }).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
const changed = () =>
  new Error(
    'The project or its backup changed during saving. The current revision and recovery copies have been preserved; review them before retrying.',
  )

async function record(file, maximum = MAX_PROJECT_BYTES) {
  const before = await stat(file)
  if (!before) return null
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum))
    throw new Error(
      `Project recovery file ${file} must be a regular, independent file no larger than ${maximum} bytes. Preserve the existing entry before retrying.`,
    )
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameRead(before, opened)) throw changed()
    const bytes = Buffer.alloc(Number(opened.size) + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    const after = await handle.stat({ bigint: true }),
      named = await stat(file)
    if (!sameRead(opened, after) || !sameRead(after, named) || BigInt(length) !== opened.size) throw changed()
    return {
      bytes: bytes.subarray(0, length),
      digest: revisionOf(bytes.subarray(0, length)),
      size: length,
      node: nodeOf(after),
      mode: Number(after.mode) & 0o777,
    }
  } finally {
    await handle.close()
  }
}
const matches = (actual, expected) =>
  !!actual && !!expected && actual.digest === expected.digest && actual.size === expected.size
const publicOwned = (actual, expected, node) => matches(actual, expected) && sameNode(actual.node, node)
const description = (r) => ({ digest: r.digest, size: r.size })

async function syncDirectory(folder) {
  const handle = await fs.promises.open(folder, 'r')
  try {
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EISDIR'].includes(error.code)) throw error
  } finally {
    await handle.close()
  }
}
async function realDirectory(folder, create = false) {
  if (create)
    await fs.promises.mkdir(folder, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error
    })
  const info = await stat(folder)
  if (!info || !info.isDirectory() || info.isSymbolicLink() || (await fs.promises.realpath(folder)) !== folder)
    throw new Error(
      `Project recovery directory ${folder} changed or is not a real directory. Preserve it for inspection.`,
    )
  return info
}
async function contextOf(file) {
  const folder = await fs.promises.realpath(path.dirname(path.resolve(file)))
  const target = path.join(folder, path.basename(file))
  const base = `.album-studio-project-state-${revisionOf(path.basename(target)).slice(0, 24)}`
  return { file: target, folder, metadata: path.join(folder, base) }
}
async function writeNew(file, bytes, mode = 0o600) {
  const handle = await fs.promises.open(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
    mode,
  )
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
async function copyNew(source, target, expected) {
  if (!matches(await record(source), expected)) throw changed()
  await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE)
  const copied = await record(target)
  if (!matches(copied, expected) || !matches(await record(source), expected)) throw changed()
  const handle = await fs.promises.open(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    if (!sameNode(nodeOf(await handle.stat({ bigint: true })), copied.node)) throw changed()
    await handle.sync()
  } finally {
    await handle.close()
  }
  return copied
}
async function move(from, to) {
  const before = await stat(from)
  if (!before) throw new Error(`The project recovery source ${from} is missing.`)
  try {
    await exclusive.renameExclusive(from, to)
  } catch (error) {
    // A timed-out child can have completed its syscall. Accept only the exact moved node.
    if ((await stat(from)) || !sameNode(before, await stat(to))) throw error
  }
  if (!sameNode(before, await stat(to))) throw changed()
  await syncDirectory(path.dirname(from))
  if (path.dirname(from) !== path.dirname(to)) await syncDirectory(path.dirname(to))
}
function recoveryError(stage, error) {
  const retained = error.recoveryStage || stage
  const failure = new Error(
    `${error.message} Project recovery evidence is retained at ${retained}. Keep that folder and the current project/backup before retrying.`,
    { cause: error },
  )
  failure.recoveryStage = retained
  if (error.projectCommitted) failure.projectCommitted = true
  if (error.code) failure.code = error.code
  return failure
}
const validDescription = (r) =>
  r && /^[a-f0-9]{64}$/.test(r.digest) && Number.isSafeInteger(r.size) && r.size >= 0 && r.size <= MAX_PROJECT_BYTES
const validNode = (n) => n && /^\d+$/.test(n.dev) && /^\d+$/.test(n.ino)
async function journalOf(context, stage) {
  await realDirectory(stage)
  const raw = await record(path.join(stage, 'journal.json'), MAX_JOURNAL_BYTES)
  if (!raw) throw new Error('The project recovery journal is missing.')
  let journal
  try {
    journal = JSON.parse(raw.bytes)
  } catch (_) {
    throw new Error('The project recovery journal is invalid JSON.')
  }
  if (
    !journal ||
    journal.version !== 1 ||
    journal.file !== context.file ||
    journal.folder !== context.folder ||
    journal.name !== path.basename(stage) ||
    !SAVE.test(journal.name) ||
    !validDescription(journal.old) ||
    !validDescription(journal.next) ||
    (journal.backup !== null && !validDescription(journal.backup)) ||
    !validNode(journal.installProject) ||
    !validNode(journal.installBackup)
  )
    throw new Error('Invalid project recovery identity or snapshot bounds; no public files were changed.')
  const allowed = new Set([
    'journal.json',
    'old-project.json',
    'next-project.json',
    'old-backup',
    'install-project.json',
    'install-backup',
    'captured-project',
    'captured-backup',
    'discard-project',
    'discard-backup',
    'commit.json',
    'commit.part.json',
  ])
  for (const name of await fs.promises.readdir(stage)) {
    if (!allowed.has(name) && !/^restore-(project|backup)-[a-f0-9-]{36}$/.test(name))
      throw new Error(`Unexpected project recovery entry ${path.join(stage, name)}; it was preserved.`)
    const info = await stat(path.join(stage, name))
    if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
      throw new Error(`Non-regular project recovery entry ${path.join(stage, name)}; it was preserved.`)
  }
  for (const [name, expected] of [
    ['old-project.json', journal.old],
    ['next-project.json', journal.next],
    ...(journal.backup ? [['old-backup', journal.backup]] : []),
  ]) {
    if (!matches(await record(path.join(stage, name)), expected))
      throw new Error(`The retained project snapshot ${path.join(stage, name)} changed; it was preserved.`)
  }
  const committed = await record(path.join(stage, 'commit.json'), MAX_JOURNAL_BYTES)
  if (committed) {
    let value
    try {
      value = JSON.parse(committed.bytes)
    } catch (_) {
      throw new Error('The project commit marker is invalid.')
    }
    if (value.version !== 1 || value.journal !== raw.digest)
      throw new Error('The project commit marker does not match its journal.')
  }
  return { journal, digest: raw.digest, committed: !!committed }
}
async function retire(context, stage) {
  await journalOf(context, stage)
  const history = path.join(context.metadata, 'history')
  await realDirectory(history, true)
  const target = path.join(history, path.basename(stage))
  const before = await stat(stage)
  try {
    await move(stage, target)
  } catch (error) {
    if (!(await stat(stage)) && sameNode(before, await stat(target))) throw recoveryError(target, error)
    throw error
  }
  try {
    await journalOf(context, target)
  } catch (error) {
    throw recoveryError(target, error)
  }
  return target
}
async function optionalPublic(file) {
  const info = await stat(file)
  if (!info) return null
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) return { foreign: true }
  return record(file)
}
async function restoreOne(context, stage, journal, which, assertOwned) {
  const project = which === 'project',
    file = context.file + (project ? '' : '.bak')
  const expected = project ? journal.next : journal.old,
    install = project ? journal.installProject : journal.installBackup
  const capturedPath = path.join(stage, `captured-${which}`),
    baseline = path.join(stage, project ? 'old-project.json' : 'old-backup')
  let current = await optionalPublic(file)
  if (current && publicOwned(current, expected, install)) {
    await assertOwned()
    const discard = path.join(stage, `discard-${which}`)
    if (await stat(discard)) throw new Error(`An existing discard copy ${discard} prevents automatic rollback.`)
    await move(file, discard)
    const captured = await record(discard)
    if (!matches(captured, expected)) {
      // A customer edited at the capture boundary. Return those exact bytes exclusively.
      if (!(await stat(file))) {
        const restore = path.join(stage, `restore-${which}-${crypto.randomUUID()}`)
        await copyNew(discard, restore, captured)
        await move(restore, file)
      }
      throw changed()
    }
    current = null
  }
  // A current foreign/manual entry is authoritative. Never overwrite it while rolling back.
  if (current) return { preservedExternal: !matches(current, project ? journal.old : journal.backup) }
  const captured = await record(capturedPath)
  const source = captured ? capturedPath : baseline,
    expectedOld = captured || (project ? journal.old : journal.backup)
  if (!expectedOld) return { preservedExternal: false }
  const restored = path.join(stage, `restore-${which}-${crypto.randomUUID()}`)
  await copyNew(source, restored, expectedOld)
  await assertOwned()
  try {
    await move(restored, file)
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
    return { preservedExternal: true }
  }
  return { preservedExternal: false }
}
async function recoverStage(context, stage, assertOwned) {
  let committed = false
  try {
    const state = await journalOf(context, stage),
      { journal } = state
    committed = state.committed
    await assertOwned()
    if (!state.committed) {
      await restoreOne(context, stage, journal, 'project', assertOwned)
      await restoreOne(context, stage, journal, 'backup', assertOwned)
    }
    // Committed public files can have been edited later. Retirement never rewrites them.
    await journalOf(context, stage)
    return await retire(context, stage)
  } catch (error) {
    if (committed) error.projectCommitted = true
    throw recoveryError(stage, error)
  }
}
async function recoverProject(file, { assertOwned } = {}) {
  if (typeof assertOwned !== 'function') throw new Error('Project recovery requires an owned album lease.')
  const context = await contextOf(file),
    found = await stat(context.metadata)
  if (!found) return { recovered: [] }
  await realDirectory(context.metadata)
  const recovered = []
  for (const name of (await fs.promises.readdir(context.metadata)).filter((n) => SAVE.test(n)).sort()) {
    recovered.push(await recoverStage(context, path.join(context.metadata, name), assertOwned))
  }
  return { recovered }
}

async function saveProject(file, data, expectedRevision, { assertOwned } = {}) {
  if (typeof assertOwned !== 'function' || !/^[a-f0-9]{64}$/.test(expectedRevision || ''))
    throw new Error('A project save requires its exact read revision and an owned album lease.')
  await recoverProject(file, { assertOwned })
  const context = await contextOf(file),
    previous = await record(context.file)
  if (!previous || previous.digest !== expectedRevision) throw changed()
  const backup = await record(`${context.file}.bak`)
  const text = JSON.stringify(data, null, 2)
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_PROJECT_BYTES)
    throw new Error('The project JSON exceeds the supported 64 MiB save budget.')
  await assertOwned()
  await realDirectory(context.metadata, true)
  const prepared = await fs.promises.mkdtemp(path.join(context.metadata, '.prepare-'))
  const name = `save-${crypto.randomUUID()}`,
    stage = path.join(context.metadata, name)
  let published = false,
    committed = false,
    committedRevision = null
  try {
    await writeNew(path.join(prepared, 'old-project.json'), previous.bytes, previous.mode)
    await writeNew(path.join(prepared, 'next-project.json'), text, previous.mode)
    if (backup) await writeNew(path.join(prepared, 'old-backup'), backup.bytes, backup.mode)
    const next = await record(path.join(prepared, 'next-project.json'))
    const installedProject = await copyNew(
      path.join(prepared, 'next-project.json'),
      path.join(prepared, 'install-project.json'),
      next,
    )
    const installedBackup = await copyNew(
      path.join(prepared, 'old-project.json'),
      path.join(prepared, 'install-backup'),
      previous,
    )
    const journal = {
      version: 1,
      file: context.file,
      folder: context.folder,
      name,
      old: description(previous),
      next: description(next),
      backup: backup ? description(backup) : null,
      installProject: installedProject.node,
      installBackup: installedBackup.node,
    }
    await writeNew(path.join(prepared, 'journal.json'), JSON.stringify(journal))
    await syncDirectory(prepared)
    await move(prepared, stage)
    published = true
    const state = await journalOf(context, stage)
    await assertOwned()
    const existingBackup = await record(`${context.file}.bak`)
    if (backup ? !matches(existingBackup, backup) : existingBackup) throw changed()
    if (backup) {
      await move(`${context.file}.bak`, path.join(stage, 'captured-backup'))
      if (!matches(await record(path.join(stage, 'captured-backup')), backup)) throw changed()
    }
    await move(path.join(stage, 'install-backup'), `${context.file}.bak`)
    await assertOwned()
    await move(context.file, path.join(stage, 'captured-project'))
    if (!matches(await record(path.join(stage, 'captured-project')), previous)) throw changed()
    await assertOwned()
    await move(path.join(stage, 'install-project.json'), context.file)
    if (
      !publicOwned(await record(context.file), next, installedProject.node) ||
      !publicOwned(await record(`${context.file}.bak`), previous, installedBackup.node)
    )
      throw changed()
    await assertOwned()
    await writeNew(path.join(stage, 'commit.part.json'), JSON.stringify({ version: 1, journal: state.digest }))
    await move(path.join(stage, 'commit.part.json'), path.join(stage, 'commit.json'))
    committed = true
    committedRevision = next.digest
    const historyPath = await retire(context, stage)
    return { revision: next.digest, committed: true, historyPath }
  } catch (error) {
    if (!published && !(await stat(prepared)) && (await stat(stage))) published = true
    if (published && (await stat(stage))) {
      try {
        const current = await journalOf(context, stage)
        if (current.committed) {
          committed = true
          committedRevision = current.journal.next.digest
        }
        await recoverStage(context, stage, assertOwned)
      } catch (recovery) {
        error.message += ` ${recovery.message}`
        error.recoveryStage = recovery.recoveryStage || stage
      }
    } else if (await stat(prepared)) error.message += ` Unpublished recovery snapshots remain at ${prepared}.`
    if (committed) {
      error.projectCommitted = true
      error.revision = committedRevision
      error.message = `The project was saved, but recovery evidence needs review. ${error.message}`
    }
    throw error
  }
}

/** Permit a missing project name only when a complete, bounded pending journal retains it. */
async function recoveryLocation(input) {
  const supplied = typeof input === 'string' ? input : input && input.file
  if (typeof supplied !== 'string' || !supplied) return null
  let candidate = path.resolve(supplied),
    info = await stat(candidate)
  for (let i = 0; info && info.isSymbolicLink() && i < 16; i++) {
    candidate = path.resolve(path.dirname(candidate), await fs.promises.readlink(candidate))
    info = await stat(candidate)
  }
  if (info && info.isDirectory()) candidate = path.join(await fs.promises.realpath(candidate), 'project.json')
  if (await stat(candidate)) return null
  const context = await contextOf(candidate)
  if (!(await stat(context.metadata))) return null
  await realDirectory(context.metadata)
  for (const name of (await fs.promises.readdir(context.metadata)).filter((n) => SAVE.test(n))) {
    const stage = path.join(context.metadata, name),
      state = await journalOf(context, stage)
    if (state.committed)
      throw recoveryError(
        stage,
        new Error('A committed project is missing; restore it through an explicit recovery review.'),
      )
    if (await record(path.join(stage, 'captured-project'))) return { file: context.file, folder: context.folder }
  }
  return null
}

async function readProjectSnapshot(file) {
  const current = await record(file)
  if (!current)
    throw Object.assign(new Error(`The project ${file} is missing; recover its journal before reading it.`), {
      code: 'ENOENT',
    })
  return { data: JSON.parse(current.bytes), revision: current.digest }
}

module.exports = { saveProject, recoverProject, recoveryLocation, readProjectSnapshot, revisionOf, MAX_PROJECT_BYTES }
