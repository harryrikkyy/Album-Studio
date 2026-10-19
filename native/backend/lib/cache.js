// cache.js — where derived files live (template backdrops, RAW previews): the user's Caches
// folder, which macOS may clear, so everything here can be made again from the originals.

'use strict'

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MAX_DIGEST_READS = 4
let digestReads = 0
const waitingReads = []
async function withDigestSlot(work) {
  if (digestReads < MAX_DIGEST_READS) digestReads++
  else await new Promise((resolve) => waitingReads.push(resolve))
  try { return await work() } finally {
    if (waitingReads.length) waitingReads.shift()()
    else digestReads--
  }
}

function cacheRoot() {
  return process.env.ALBUM_STUDIO_CACHE_DIR || path.join(os.homedir(), 'Library', 'Caches', 'Album Studio')
}

/** A short key that changes whenever the file is replaced or edited. */
function fileKey(file, st) {
  return crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16)
}

/** Verified source contents, read through a no-follow handle with a bounded buffer.
 * Do not cache this globally by size/time: the original can change while those stay equal.
 */
async function fileEvidence(file, { prefixBytes = 0, expectedDigest } = {}) {
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0 || prefixBytes > 1024 * 1024 || expectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error('Source evidence requires a bounded prefix and valid expected revision.')
  return withDigestSlot(async () => {
    const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((k) => a[k] === b[k])
    const changed = () => Object.assign(new Error(`The source ${file} changed while its content was read. Retry from a stable source file.`), { code: 'SOURCE_CHANGED' })
    const before = await fs.promises.lstat(file, { bigint: true })
    if (!before.isFile()) throw new Error(`The source ${file} is not a regular file. Resolve its symlink or restore the original before continuing.`)
    let handle
    try {
      handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
      const opened = await handle.stat({ bigint: true })
      if (!same(before, opened)) throw changed()
      if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`The source ${file} exceeds the supported file size.`)
      const buffer = Buffer.alloc(1024 * 1024)
      let prefix = Buffer.alloc(0)
      const pass = async (capturePrefix = false) => {
        const hash = crypto.createHash('sha256')
        let position = 0
        while (position < Number(opened.size)) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(opened.size) - position), position)
          if (!bytesRead) throw changed()
          if (capturePrefix && position < prefixBytes) prefix = Buffer.concat([prefix, buffer.subarray(0, Math.min(bytesRead, prefixBytes - position))])
          hash.update(buffer.subarray(0, bytesRead)); position += bytesRead
        }
        if ((await handle.read(buffer, 0, 1, position)).bytesRead || BigInt(position) !== opened.size) throw changed()
        return hash.digest('hex')
      }
      const first = await pass(true), second = await pass()
      const after = await handle.stat({ bigint: true }), named = await fs.promises.lstat(file, { bigint: true })
      if (first !== second || expectedDigest !== undefined && first !== expectedDigest || !same(opened, after) || !same(after, named)) throw changed()
      return { digest: first, prefix }
    } finally { if (handle) await handle.close() }
  })
}

async function fileDigest(file) { return (await fileEvidence(file)).digest }

/** Read metadata only, without claiming a revision of the rest of the file. Two matching
 * bounded reads and descriptor/name checks reject unstable headers. Rendering and publication
 * must continue to use full fileEvidence/readVerifiedBuffer/snapshotFile evidence. */
async function readFileHeader(file, maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024 * 1024) throw new Error('Choose a header budget from 1 byte to 1 MiB.')
  return withDigestSlot(async () => {
    const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key])
    const changed = () => Object.assign(new Error(`The source ${file} changed while its header was read. Retry from a stable source file.`), { code: 'SOURCE_CHANGED' })
    const before = await fs.promises.lstat(file, { bigint: true })
    if (!before.isFile()) throw new Error(`The source ${file} is not a regular file. Resolve its symlink or restore the original before continuing.`)
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    try {
      const opened = await handle.stat({ bigint: true })
      if (!same(before, opened)) throw changed()
      const length = Number(opened.size < BigInt(maximum) ? opened.size : BigInt(maximum))
      const pass = async () => {
        const bytes = Buffer.alloc(length)
        let position = 0
        while (position < length) {
          const { bytesRead } = await handle.read(bytes, position, length - position, position)
          if (!bytesRead) throw changed()
          position += bytesRead
        }
        return bytes
      }
      const first = await pass(), second = await pass()
      const after = await handle.stat({ bigint: true }), named = await fs.promises.lstat(file, { bigint: true })
      if (!first.equals(second) || !same(opened, after) || !same(after, named)) throw changed()
      return first
    } finally { await handle.close() }
  })
}

/** Decode bytes from the exact verified revision, rather than reopening a mutable path. */
async function readVerifiedBuffer(file, expectedDigest, maximum = 512 * 1024 * 1024) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(expectedDigest || '')) throw new Error('Buffered source consumption requires an expected revision and a budget up to 512 MiB.')
  const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(k => a[k] === b[k])
  const changed = () => Object.assign(new Error(`The source ${file} changed before its verified bytes could be consumed. Retry from the current revision.`), { code: 'SOURCE_CHANGED' })
  const before = await fs.promises.lstat(file, { bigint: true })
  if (!before.isFile() || before.size > BigInt(maximum)) throw new Error(`The source ${file} must be a regular file within the ${maximum}-byte decoding budget.`)
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!same(before, opened)) throw changed()
    const bytes = Buffer.allocUnsafe(Number(opened.size)), extra = Buffer.alloc(1)
    let position = 0
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, Math.min(1024 * 1024, bytes.length - position), position)
      if (!bytesRead) throw changed()
      position += bytesRead
    }
    const end = await handle.read(extra, 0, 1, position), after = await handle.stat({ bigint: true }), named = await fs.promises.lstat(file, { bigint: true })
    if (end.bytesRead || !same(opened, after) || !same(after, named) || crypto.createHash('sha256').update(bytes).digest('hex') !== expectedDigest) throw changed()
    return bytes
  } finally { await handle.close() }
}

async function contentFileKey(file) {
  return contentKey(file, await fileDigest(file))
}

function contentKey(file, digest) {
  return crypto.createHash('sha256').update(JSON.stringify([path.resolve(file), digest])).digest('hex')
}

/** Copy verified bytes into a private job directory before a decoder consumes them. */
async function snapshotFile(file, folder, digest) {
  if (!/^[a-f0-9]{64}$/.test(digest || '')) throw new Error('A source snapshot requires verified content evidence.')
  await fs.promises.mkdir(folder, { recursive: true, mode: 0o700 })
  const target = path.join(await fs.promises.realpath(folder), `${crypto.randomUUID()}${path.extname(file)}`)
  const sameNode = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino
  const sameRead = (a, b) => sameNode(a, b) && ['size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key])
  const statOrMissing = file => fs.promises.lstat(file, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  let source, destination, created, retainedPath, failure
  try {
    // The file is read-only from creation. The exclusively opened descriptor remains
    // writable to this copy operation; there is no path-based chmod of a later alias.
    destination = await fs.promises.open(target, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o400)
    created = await destination.stat({ bigint: true })
    const before = await fs.promises.lstat(file, { bigint: true })
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The snapshot source must be a regular file within the supported file-offset bounds.')
    source = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const opened = await source.stat({ bigint: true })
    if (!sameRead(before, opened)) throw new Error('The source changed before its snapshot was opened.')
    const buffer = Buffer.alloc(1024 * 1024), copied = crypto.createHash('sha256')
    let position = 0
    while (position < Number(opened.size)) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, Number(opened.size) - position), position)
      if (!bytesRead) throw new Error('The source changed during its snapshot copy.')
      copied.update(buffer.subarray(0, bytesRead))
      let offset = 0
      while (offset < bytesRead) {
        const { bytesWritten } = await destination.write(buffer, offset, bytesRead - offset, position + offset)
        if (!bytesWritten) throw new Error('The source snapshot could not be written completely.')
        offset += bytesWritten
      }
      position += bytesRead
    }
    const extra = await source.read(buffer, 0, 1, position), after = await source.stat({ bigint: true })
    if (extra.bytesRead || !sameRead(opened, after) || !sameRead(after, await fs.promises.lstat(file, { bigint: true })) || copied.digest('hex') !== digest) throw new Error(`The image ${file} changed before its verified snapshot could be made.`)
    await destination.chmod(0o400); await destination.sync()
    const protectedFile = await destination.stat({ bigint: true }), named = await fs.promises.lstat(target, { bigint: true })
    if (!sameNode(created, protectedFile) || !sameNode(protectedFile, named) || !named.isFile() || named.nlink !== 1n || named.mode & 0o222n || protectedFile.mode & 0o222n) throw new Error('The private snapshot name, ownership or read-only permissions changed.')
    if (await fileDigest(target) !== digest || !sameNode(created, await fs.promises.lstat(target, { bigint: true }))) throw new Error('The private snapshot changed before decoder consumption.')
  } catch (error) {
    // Never unlink a failed exclusive destination or a substituted name. An unchanged
    // generated copy can leave the caller's stage only by a no-replace history move.
    if (created) {
      try {
        const current = await fs.promises.lstat(target, { bigint: true })
        if (current.isFile() && current.nlink === 1n && sameNode(current, created)) {
          const history = await fs.promises.mkdtemp(path.join(path.dirname(path.dirname(target)), '.album-studio-snapshot-'))
          const retained = path.join(history, path.basename(target))
          let moveError
          try { await require('./exclusive_rename').renameExclusive(target, retained) } catch (move) { moveError = move }
          const captured = await statOrMissing(retained), remaining = await statOrMissing(target)
          if (captured) retainedPath = retained
          // A timed-out helper can already have performed the syscall. Accept only the
          // exact created inode at the destination and an absent original public name.
          if (moveError && (remaining || !captured || !captured.isFile() || captured.nlink !== 1n || !sameNode(captured, created))) {
            moveError.message += ` Check both ${target} and ${retained}; neither name was removed.`
            throw moveError
          }
          if (!captured) throw new Error(`The snapshot retention destination ${retained} is missing; preserve both recovery paths.`)
          if (!sameNode(captured, created)) {
            // An external file captured at the last boundary goes back exclusively.
            // Reconcile the return too, so its reported evidence path still exists.
            await require('./exclusive_rename').renameExclusive(retained, target).catch(() => {})
            const returned = await statOrMissing(target), stillRetained = await statOrMissing(retained)
            if (!stillRetained && sameNode(returned, captured)) retainedPath = target
            else if (!stillRetained) error.message += ` Check both ${target} and ${retained} after the external path change.`
          }
        }
      } catch (preserve) { error.message += ` Snapshot retention also needs review: ${preserve.message}` }
    }
    failure = new Error(`${error.message} Snapshot evidence was preserved at ${retainedPath || target}; keep it before retrying.`, { cause: error })
    failure.code = 'SNAPSHOT_PRESERVED'; failure.sourceCode = error.code; failure.snapshotPath = retainedPath || target
    if (retainedPath) failure.retainedPath = retainedPath
  } finally {
    const closeErrors = []
    for (const [name, handle] of [['source', source], ['destination', destination]]) {
      if (!handle) continue
      try { await handle.close() } catch (error) { closeErrors.push({ name, error }) }
    }
    if (closeErrors.length) {
      const detail = closeErrors.map(({ name, error }) => `${name}: ${error.message}`).join('; ')
      if (failure) failure.message += ` Snapshot descriptor close also failed: ${detail}`
      else {
        failure = new Error(`Snapshot descriptor close failed: ${detail} Snapshot evidence was preserved at ${retainedPath || target}; keep it before retrying.`, { cause: closeErrors[0].error })
        failure.code = 'SNAPSHOT_PRESERVED'; failure.sourceCode = closeErrors[0].error.code; failure.snapshotPath = retainedPath || target
        if (retainedPath) failure.retainedPath = retainedPath
      }
      failure.closeErrors = closeErrors.map(({ name, error }) => ({ descriptor: name, code: error.code, message: error.message }))
    }
  }
  if (failure) throw failure
  return target
}

async function fileStamp(p) {
  const st = await fs.promises.stat(p).catch(() => null)
  return st ? `${st.size}:${Math.round(st.mtimeMs)}` : 'missing'
}

/** Write a file so readers never see half of it. */
async function writeAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await fs.promises.writeFile(tmp, data)
  await fs.promises.rename(tmp, file)
}

module.exports = { cacheRoot, fileKey, fileStamp, writeAtomic, fileDigest, fileEvidence, readFileHeader, readVerifiedBuffer, contentFileKey, contentKey, snapshotFile }
