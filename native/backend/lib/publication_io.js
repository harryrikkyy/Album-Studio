// @ts-check
// Shared filesystem mechanics for journalled publication. The caller owns domain
// authorization, expected revisions, journal validation and recovery decisions.
'use strict'
const fs = require('fs')
const path = require('path')
const exclusive = require('./exclusive_rename')
/**
 * @typedef {import('./verified_file').FileNode} FileNode
 * @typedef {import('./verified_file').FileRecord} FileRecord
 * @typedef {import('./verified_file').ReadRecord} ReadRecord
 * @typedef {Map<string, { info: fs.BigIntStats, record: FileRecord }>} KnownSnapshots
 */
/** @param {string} file @returns {Promise<fs.BigIntStats | null>} */
const stat = file => fs.promises.lstat(file, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error })
/** @param {fs.BigIntStats} st @returns {FileNode} */
const node = st => ({ dev: String(st.dev), ino: String(st.ino) })
/** @param {{ dev: unknown, ino: unknown } | null | undefined} a @param {{ dev: unknown, ino: unknown } | null | undefined} b */
const sameNode = (a, b) => !!a && !!b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
/** @param {fs.BigIntStats | null} a @param {fs.BigIntStats | null} b */
const sameRead = (a, b) => !!a && !!b && sameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.nlink === b.nlink
/** @param {FileRecord | null} a @param {{ digest: string, size: string, stamp: string }} b @returns {a is FileRecord} */
const matches = (a, b) => !!a && !!b && a.digest === b.digest && a.size === b.size && a.stamp === b.stamp
// An lstat that still describes a verified record: the same regular inode, size, mtime and mode. No bytes are read.
/** @param {fs.BigIntStats | null} info @param {FileRecord} r */
const sameIdentity = (info, r) => !!info && info.isFile() && info.nlink === 1n && sameNode(info, r.node) &&
  String(info.size) === r.size && Number(info.mtimeNs) / 1e6 === r.mtimeMs && (Number(info.mode) & 0o777) === r.mode
/** @param {{ subject: string, changed: (what: string) => Error, readRecord: ReadRecord }} options */
function createPublicationIO({ subject, changed, readRecord }) {
  /** @param {string} folder */
  async function syncDirectory(folder) {
    const handle = await fs.promises.open(folder, 'r')
    try { await handle.sync() } catch (error) {
      // Directory fsync is unavailable on some removable/network filesystems. This fallback
      // does not certify hardware power-loss durability on those filesystems.
      const code = /** @type {NodeJS.ErrnoException} */ (error).code
      if (!code || !['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EISDIR'].includes(code)) throw error
    } finally { await handle.close() }
  }
  /** @param {string} folder @param {boolean} [create] @returns {Promise<FileNode>} */
  async function directory(folder, create = false) {
    if (create) await fs.promises.mkdir(folder, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await stat(folder)
    if (!info || !info.isDirectory() || info.isSymbolicLink() || await fs.promises.realpath(folder) !== folder) throw changed(`${subject} directory ${folder}`)
    return node(info)
  }
  /** @param {string} file @param {string | Buffer} bytes @param {number} [mode] @returns {Promise<FileNode>} */
  async function writeNew(file, bytes, mode = 0o600) {
    const handle = await fs.promises.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode)
    try { const identity = node(await handle.stat({ bigint: true })); await handle.writeFile(bytes); await handle.sync(); return identity } finally { await handle.close() }
  }
  /** @param {string} stage @param {Buffer} bytes @param {FileNode} expectedNode */
  async function writeCommitPart(stage, bytes, expectedNode) {
    const file = path.join(stage, 'commit.part.json'), before = await stat(file)
    if (!before || !before.isFile() || before.nlink !== 1n || before.size !== 0n || !sameNode(before, expectedNode)) throw changed(`reserved ${subject} commit identity`)
    const handle = await fs.promises.open(file, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0))
    try {
      if (!sameRead(before, await handle.stat({ bigint: true }))) throw changed(`reserved ${subject} commit identity`)
      await handle.writeFile(bytes); await handle.chmod(0o400); await handle.sync()
    } finally { await handle.close() }
  }
  /**
   * Copy into an exclusive private name, never a hard link or a partially visible public file.
   * @param {string} source @param {string} target @param {FileRecord} expected @param {number} [mode] @returns {Promise<FileRecord>}
   */
  async function copyDetached(source, target, expected, mode = expected.mode) {
    const handle = await fs.promises.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode)
    try {
      const copied = await readRecord(source, Number.MAX_SAFE_INTEGER, false, { expectedDigest: expected.digest, sink: async (bytes, position) => {
        let offset = 0
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset)
          if (!bytesWritten) throw new Error(`The ${subject} snapshot could not be written completely.`)
          offset += bytesWritten
        }
      } })
      if (!matches(copied, expected)) throw changed(`${subject} snapshot source`)
      await handle.chmod(mode); await handle.utimes(expected.atimeMs / 1000, expected.mtimeMs / 1000); await handle.sync()
      const copiedNode = node(await handle.stat({ bigint: true }))
      if (!sameNode(copiedNode, await stat(target))) throw changed(`detached ${subject} snapshot`)
    } finally { await handle.close() }
    const actual = await readRecord(target, Number.MAX_SAFE_INTEGER, false, { expectedDigest: expected.digest })
    if (!matches(actual, expected)) throw changed(`detached ${subject} snapshot bytes`)
    return actual
  }
  // A publication hashes each retained snapshot once. Its later journal checks skip a snapshot whose
  // lstat identity (inode, size, mtime, ctime, mode, links) is unchanged; recovery re-hashes every byte.
  // With one-second timestamps (HFS+), only recovery sees a same-size rewrite within that second.
  /** @param {KnownSnapshots} known @param {string} file @param {FileRecord} record */
  async function remember(known, file, record) {
    const info = await stat(file)
    if (info && sameIdentity(info, record)) known.set(path.basename(file), { info, record })
  }
  /** @param {KnownSnapshots | undefined} known @param {string} file @param {number} [maximum] @returns {Promise<FileRecord | null>} */
  async function retainedRecord(known, file, maximum) {
    const seen = known && known.get(path.basename(file))
    return seen && sameRead(seen.info, await stat(file)) ? seen.record : readRecord(file, maximum)
  }
  // Remove a retired stage once its caller has validated the committed journal that names these
  // entries. Each must still be a regular single-link file; the marker and journal go last, so an
  // interrupted removal stays recognisable, and a name that appeared meanwhile keeps the directory.
  /** @param {string} stage @param {string[]} names */
  async function removeRetired(stage, names) {
    /** @param {string} name */
    const rank = name => ['commit.json', 'journal.json'].indexOf(name)
    for (const name of [...names].sort((a, b) => rank(a) - rank(b))) {
      const file = path.join(stage, name), info = await stat(file)
      if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw changed(`retired ${subject} entry ${file}`)
      await fs.promises.unlink(file)
    }
    await fs.promises.rmdir(stage); await syncDirectory(path.dirname(stage))
  }
  /** @param {string} from @param {string} to @param {FileNode} [expectedNode] */
  async function move(from, to, expectedNode) {
    const before = await stat(from)
    if (!before) throw new Error(`The ${subject} recovery source ${from} is missing.`)
    if (expectedNode && !sameNode(before, expectedNode)) throw changed(`${subject} commit identity before atomic capture`)
    try { await exclusive.renameExclusive(from, to) } catch (error) {
      // Reconcile a helper timeout only if the exact node has moved and source disappeared.
      if (await stat(from) || !sameNode(before, await stat(to))) throw error
    }
    if (!sameNode(before, await stat(to))) throw changed(`atomic ${subject} capture`)
    await syncDirectory(path.dirname(from)); if (path.dirname(from) !== path.dirname(to)) await syncDirectory(path.dirname(to))
  }
  return { syncDirectory, directory, writeNew, writeCommitPart, copyDetached, move, remember, retainedRecord, removeRetired, sameIdentity }
}
module.exports = { createPublicationIO }
