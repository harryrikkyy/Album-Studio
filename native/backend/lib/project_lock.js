// Cooperative cross-process project leases. Retired and interrupted owner directories are
// evidence, never garbage: no checksum-then-unlink or recursive deletion is used here.
'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')
const exclusiveRename = require('./exclusive_rename')

const MAX_OWNER = 16384
const sharedKey = Symbol.for('album-studio.project-lease-state')
const shared = globalThis[sharedKey] || (globalThis[sharedKey] = { tails: new Map(), host: null })
const digest = (text) => crypto.createHash('sha256').update(text).digest('hex')
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key])
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino
const exists = (file) => fs.promises.lstat(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
function conflict(message, lockPath, code = 'PROJECT_BUSY') {
  const error = new Error(`${message} Existing lock evidence has been preserved${lockPath ? ` at ${lockPath}` : ''}.`)
  error.code = code; if (lockPath) error.lockPath = lockPath
  return error
}
async function canonicalProject(input) {
  const supplied = typeof input === 'string' ? input : input && input.file
  if (typeof supplied !== 'string' || !supplied) throw new Error('Choose an existing project folder or project JSON file.')
  const candidate = path.resolve(supplied)
  let info, file
  try {
    info = await fs.promises.stat(candidate)
    file = await fs.promises.realpath(info.isDirectory() ? path.join(candidate, 'project.json') : candidate)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const retained = await require('./project_transaction').recoveryLocation(input)
    if (!retained) throw error
    if (typeof input === 'object' && input.folder && await fs.promises.realpath(input.folder) !== retained.folder) throw new Error('The supplied project file and folder identify different albums.')
    return retained
  }
  const named = await fs.promises.lstat(file, { bigint: true })
  if (!named.isFile() || named.isSymbolicLink()) throw new Error('The project JSON must resolve to a regular file.')
  if (named.nlink !== 1n) throw new Error('The project JSON has hard links or multiple names. Make an independent project copy before editing it.')
  const folder = await fs.promises.realpath(path.dirname(file))
  if (typeof input === 'object' && input.folder && await fs.promises.realpath(input.folder) !== folder) throw new Error('The supplied project file and folder identify different albums.')
  return { file, folder }
}

/** Callers first obtain canonicalProject; no settled promise tails are retained indefinitely. */
function serializeProject(file, work) {
  const key = path.resolve(file), previous = shared.tails.get(key) || Promise.resolve()
  const next = previous.then(work, work), tail = next.then(() => {}, () => {})
  shared.tails.set(key, tail)
  void tail.then(() => { if (shared.tails.get(key) === tail) shared.tails.delete(key) })
  return next
}
function command(binary, args) {
  return new Promise((resolve, reject) => execFile(binary, args, { timeout: 5000, maxBuffer: 65536, env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())))
}
async function boundedText(file, limit = MAX_OWNER) {
  const before = await fs.promises.lstat(file, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(limit) || before.nlink !== 1n) throw conflict('The project lock owner is oversized, hardlinked or not a regular file.', file, 'PROJECT_LOCK_UNCERTAIN')
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!same(before, opened)) throw conflict('The project lock owner changed while opening it.', file, 'PROJECT_LOCK_UNCERTAIN')
    const bytes = Buffer.alloc(limit + 1)
    let total = 0
    for (;;) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, total)
      total += bytesRead
      if (total > limit) throw conflict('The project lock owner exceeded its bounded size.', file, 'PROJECT_LOCK_UNCERTAIN')
      if (!bytesRead) break
    }
    const after = await handle.stat({ bigint: true }), named = await fs.promises.lstat(file, { bigint: true })
    if (!same(opened, after) || !same(after, named)) throw conflict('The project lock owner changed while reading it.', file, 'PROJECT_LOCK_UNCERTAIN')
    return { text: bytes.toString('utf8', 0, total), identity: after }
  } finally { await handle.close() }
}
async function processStart(pid) {
  if (process.platform === 'darwin') {
    const start = await command('/bin/ps', ['-p', String(pid), '-o', 'lstart='])
    if (!start || start.length > 80) throw new Error('The process start identity could not be verified.')
    return digest(start)
  }
  if (process.platform === 'linux') {
    const value = (await boundedText(`/proc/${pid}/stat`, 8192)).text
    const tail = value.slice(value.lastIndexOf(') ') + 2).split(' '), start = tail[19]
    if (!/^\d+$/.test(start || '')) throw new Error('The process start identity could not be verified.')
    return digest(start)
  }
  throw new Error('This platform has no verified project-lock process identity provider.')
}
async function hostIdentity() {
  if (!shared.host) shared.host = (async () => {
    let machine, boot
    if (process.platform === 'darwin') {
      const hardware = await command('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
      const uuid = /"IOPlatformUUID"\s*=\s*"([a-f0-9-]{36})"/i.exec(hardware)
      if (!uuid) throw new Error('The machine identity could not be verified.')
      machine = uuid[1].toLowerCase()
      boot = await command('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'])
    } else if (process.platform === 'linux') {
      machine = (await boundedText('/etc/machine-id', 256)).text.trim()
      boot = (await boundedText('/proc/sys/kernel/random/boot_id', 256)).text.trim()
    } else throw new Error('This platform has no verified project-lock host identity provider.')
    if (!/^[a-f0-9-]{32,36}$/i.test(machine) || !/^[a-f0-9-]{36}$/i.test(boot)) throw new Error('The host or boot identity is not authoritative.')
    return { host: digest(`${process.platform}:${os.hostname()}:${machine}`), boot: digest(boot.toLowerCase()), start: await processStart(process.pid) }
  })().catch((error) => { shared.host = null; throw conflict(`Project ownership cannot be verified on this host: ${error.message}`, null, 'PROJECT_LOCK_UNCERTAIN') })
  return shared.host
}
async function syncDirectory(folder) {
  const handle = await fs.promises.open(folder, 'r')
  try { await handle.sync() } catch (error) { if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EISDIR'].includes(error.code)) throw error }
  finally { await handle.close() }
}
async function realDirectory(folder, create = false) {
  if (create) await fs.promises.mkdir(folder, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error })
  const info = await fs.promises.lstat(folder, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.promises.realpath(folder) !== folder) throw conflict('A project lock directory is a symlink or changed.', folder, 'PROJECT_LOCK_UNCERTAIN')
  return info
}
async function readOwner(folder, context) {
  const before = await realDirectory(folder)
  if (JSON.stringify((await fs.promises.readdir(folder)).sort()) !== '["owner.json"]') throw conflict('Unexpected files in the project lock directory.', folder, 'PROJECT_LOCK_UNCERTAIN')
  const read = await boundedText(path.join(folder, 'owner.json'))
  let owner
  try { owner = JSON.parse(read.text) } catch (_) { throw conflict('Invalid project lock owner JSON.', folder, 'PROJECT_LOCK_UNCERTAIN') }
  const fields = ['version', 'file', 'folder', 'pid', 'host', 'boot', 'start', 'token', 'kind', 'createdAt']
  if (!owner || Object.keys(owner).length !== fields.length || !fields.every((key) => Object.hasOwn(owner, key)) || owner.version !== 1 || owner.file !== context.file || owner.folder !== context.folder || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !['host', 'boot', 'start', 'token'].every((key) => /^[a-f0-9]{64}$/.test(owner[key])) || typeof owner.kind !== 'string' || !owner.kind || owner.kind.length > 80 || [...owner.kind].some((c) => c.charCodeAt(0) < 32) || typeof owner.createdAt !== 'string' || !Number.isFinite(Date.parse(owner.createdAt))) throw conflict('Invalid project lock owner identity.', folder, 'PROJECT_LOCK_UNCERTAIN')
  if (!same(before, await realDirectory(folder))) throw conflict('The project lock directory changed while reading it.', folder, 'PROJECT_LOCK_UNCERTAIN')
  return { owner, text: read.text, directory: before, record: read.identity }
}
async function ownerAlive(record, local) {
  if (record.host !== local.host) throw conflict('The project lock belongs to another or unverified host; its process cannot be checked safely.', null, 'PROJECT_LOCK_UNCERTAIN')
  if (record.boot !== local.boot) return false
  try { process.kill(record.pid, 0) } catch (error) { if (error.code === 'ESRCH') return false; throw conflict('The project lock process is live or its status is uncertain.', null, 'PROJECT_LOCK_UNCERTAIN') }
  let start
  try { start = await processStart(record.pid) } catch (_) {
    try { process.kill(record.pid, 0) } catch (error) { if (error.code === 'ESRCH') return false }
    throw conflict('The project lock process start identity is uncertain.', null, 'PROJECT_LOCK_UNCERTAIN')
  }
  return start === record.start
}
async function candidate(context, local, kind) {
  const token = crypto.randomBytes(32).toString('hex')
  const folder = await fs.promises.mkdtemp(path.join(context.folder, `${context.base}.candidate-`))
  const owner = { version: 1, file: context.file, folder: context.folder, pid: process.pid, ...local, token, kind, createdAt: new Date().toISOString() }
  const handle = await fs.promises.open(path.join(folder, 'owner.json'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600)
  try { await handle.writeFile(JSON.stringify(owner)); await handle.sync() } finally { await handle.close() }
  await syncDirectory(folder); await syncDirectory(context.folder)
  return { folder, owner, state: await readOwner(folder, context) }
}
async function sameOwner(folder, context, expected) {
  const actual = await readOwner(folder, context)
  if (actual.text !== expected.text || !sameNode(actual.directory, expected.directory) || !same(actual.record, expected.record)) throw conflict('Project lock ownership changed.', folder, 'PROJECT_LOCK_LOST')
  return actual
}
async function moveOwner(from, to, context, expected) {
  try { await exclusiveRename.renameExclusive(from, to) } catch (error) {
    // The bounded helper can report a timeout after its syscall completed. Resolve that
    // outcome through both names and the exact immutable owner, rather than retrying it.
    let completed = false
    if (!await exists(from).catch(() => true) && await exists(to).catch(() => false)) {
      try { await sameOwner(to, context, expected); completed = true } catch (_) { /* Preserve both uncertain names. */ }
    }
    if (!completed) {
      error.message += ` Both lock locations were preserved for inspection: ${from}; ${to}.`
      error.lockPath = from; error.recoveryPath = to
      throw error
    }
  }
}
async function retire(folder, context, expected, reason) {
  await sameOwner(folder, context, expected)
  const history = path.join(context.folder, '.album-studio-project-lock-history')
  await realDirectory(history, true)
  const target = path.join(history, `${context.base}-${reason}-${crypto.randomUUID()}`)
  await moveOwner(folder, target, context, expected)
  try { await sameOwner(target, context, expected) } catch (error) {
    // The exact captured directory remains intact. Restore only to a still-vacant name.
    try { await moveOwner(target, folder, context, expected) } catch (restore) { error.message += ` Recovery evidence retained at ${target}; original path preserved: ${restore.message}` }
    throw error
  }
  await syncDirectory(context.folder); await syncDirectory(history)
  return target
}
async function publish(candidate, target, context) {
  await sameOwner(candidate.folder, context, candidate.state)
  await moveOwner(candidate.folder, target, context, candidate.state)
  const state = await sameOwner(target, context, candidate.state)
  await syncDirectory(context.folder)
  return state
}

async function acquireProjectLease(input, { kind = 'project' } = {}) {
  if (typeof kind !== 'string' || !kind || kind.length > 80 || [...kind].some((c) => c.charCodeAt(0) < 32)) throw new Error('A project lease needs a short operation kind.')
  const canonical = await canonicalProject(input), local = await hostIdentity()
  const context = { ...canonical, base: `.album-studio-project-${digest(path.basename(canonical.file)).slice(0, 24)}` }
  const initialFolder = await realDirectory(context.folder), lockPath = path.join(context.folder, `${context.base}.lock`), guardPath = `${lockPath}.reclaim`
  const prepared = await candidate(context, local, kind)
  let held = null, released = false, releasePromise = null
  const assertFolder = async () => {
    if (!sameNode(initialFolder, await realDirectory(context.folder)) || (await canonicalProject(canonical)).file !== canonical.file) throw conflict('The album directory or project path changed.', lockPath, 'PROJECT_LOCK_LOST')
  }
  const takeGuard = async (operation) => {
    const guard = await candidate(context, local, operation)
    try { await publish(guard, guardPath, context) } catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw conflict('Project lock recovery or release is already in progress or was interrupted. Inspect its preserved reclamation guard before retrying.', guardPath)
      throw error
    }
    return guard
  }
  const releaseGuard = (guard) => retire(guardPath, context, guard.state, 'guard')
  try {
    if (await exists(guardPath)) throw conflict('Project lock recovery or release is already in progress or was interrupted. Inspect the preserved reclamation guard before retrying.', guardPath)
    try { held = await publish(prepared, lockPath, context) } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
      const observed = await readOwner(lockPath, context)
      if (await ownerAlive(observed.owner, local)) throw conflict(`This project is busy in another ${observed.owner.kind} operation. Wait for it to finish.`, lockPath)
      const guard = await takeGuard('stale-owner-recovery')
      let failure
      try {
        const current = await readOwner(lockPath, context)
        if (await ownerAlive(current.owner, local)) throw conflict('This project is busy in another operation.', lockPath)
        await retire(lockPath, context, current, 'stale')
        held = await publish(prepared, lockPath, context)
      } catch (error) { failure = error }
      try { await releaseGuard(guard) } catch (error) { if (failure) failure.message += ` Guard recovery failed: ${error.message}`; else failure = error }
      if (failure) throw failure
    }
    await assertFolder()
    if (await exists(guardPath)) {
      // A reclaimer won the gap between the initial guard check and publication. No caller
      // work has begun. Retire only this complete owner and fail closed while it finishes.
      await retire(lockPath, context, held, 'contended')
      held = null
      throw conflict('Project lock recovery raced acquisition; retry when it finishes.', guardPath)
    }
    await sameOwner(lockPath, context, held)
  } catch (error) {
    if (await exists(prepared.folder).catch(() => false)) {
      try { await retire(prepared.folder, context, prepared.state, 'unused') } catch (retirement) { error.message += ` Unused owner evidence remains at ${prepared.folder}: ${retirement.message}` }
    }
    if (!error.lockPath) error.lockPath = lockPath
    if (held) error.message += ` The acquired owner remains preserved at ${lockPath}; no project work was started.`
    throw error
  }
  const lease = { ...canonical, kind, token: prepared.owner.token, lockPath,
    async assertOwned() {
      if (released) throw conflict('This project lease has already been released.', lockPath, 'PROJECT_LOCK_LOST')
      await assertFolder(); await sameOwner(lockPath, context, held)
      if (await exists(guardPath)) throw conflict('Project ownership is being recovered or released; wait before publishing.', guardPath, 'PROJECT_LOCK_LOST')
    },
    async release() {
      if (released) return
      if (releasePromise) return releasePromise
      releasePromise = (async () => {
        await assertFolder(); await sameOwner(lockPath, context, held)
        const guard = await takeGuard('lease-release')
        let failure
        try { await retire(lockPath, context, held, 'released'); released = true } catch (error) { failure = error }
        try { await releaseGuard(guard) } catch (error) { if (failure) failure.message += ` Guard release failed: ${error.message}`; else failure = error }
        if (failure) throw failure
      })()
      try { await releasePromise } finally { if (!released) releasePromise = null }
    },
  }
  return lease
}

module.exports = { canonicalProject, acquireProjectLease, serializeProject }
