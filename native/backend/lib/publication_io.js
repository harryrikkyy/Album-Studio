// Shared filesystem mechanics for journalled publication. The caller owns domain
// authorization, expected revisions, journal validation and recovery decisions.
'use strict'
const fs = require('fs')
const path = require('path')
const exclusive = require('./exclusive_rename')
const stat = file => fs.promises.lstat(file, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error })
const node = st => ({ dev: String(st.dev), ino: String(st.ino) })
const sameNode = (a, b) => !!a && !!b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
const sameRead = (a, b) => sameNode(a, b) && ['size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].every(k => a[k] === b[k])
const matches = (a, b) => !!a && !!b && a.digest === b.digest && a.size === b.size && a.stamp === b.stamp
function createPublicationIO({ subject, changed, readRecord }) {
  async function syncDirectory(folder) {
    const handle = await fs.promises.open(folder, 'r')
    try { await handle.sync() } catch (error) {
      // Directory fsync is unavailable on some removable/network filesystems. This fallback
      // does not certify hardware power-loss durability on those filesystems.
      if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EISDIR'].includes(error.code)) throw error
    } finally { await handle.close() }
  }
  async function directory(folder, create = false) {
    if (create) await fs.promises.mkdir(folder, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
    const info = await stat(folder)
    if (!info || !info.isDirectory() || info.isSymbolicLink() || await fs.promises.realpath(folder) !== folder) throw changed(`${subject} directory ${folder}`)
    return node(info)
  }
  async function writeNew(file, bytes, mode = 0o600) {
    const handle = await fs.promises.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode)
    try { const identity = node(await handle.stat({ bigint: true })); await handle.writeFile(bytes); await handle.sync(); return identity } finally { await handle.close() }
  }
  async function writeCommitPart(stage, bytes, expectedNode) {
    const file = path.join(stage, 'commit.part.json'), before = await stat(file)
    if (!before || !before.isFile() || before.nlink !== 1n || before.size !== 0n || !sameNode(before, expectedNode)) throw changed(`reserved ${subject} commit identity`)
    const handle = await fs.promises.open(file, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0))
    try {
      if (!sameRead(before, await handle.stat({ bigint: true }))) throw changed(`reserved ${subject} commit identity`)
      await handle.writeFile(bytes); await handle.chmod(0o400); await handle.sync()
    } finally { await handle.close() }
  }
  /** Copy into an exclusive private name, never a hard link or a partially visible public file. */
  async function copyDetached(source, target, expected, mode = expected.mode) {
    const handle = await fs.promises.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode)
    try {
      const copied = await readRecord(source, Number.MAX_SAFE_INTEGER, false, async (bytes, position) => {
        let offset = 0
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset)
          if (!bytesWritten) throw new Error(`The ${subject} snapshot could not be written completely.`)
          offset += bytesWritten
        }
      })
      if (!matches(copied, expected)) throw changed(`${subject} snapshot source`)
      await handle.chmod(mode); await handle.utimes(expected.atimeMs / 1000, expected.mtimeMs / 1000); await handle.sync()
      const copiedNode = node(await handle.stat({ bigint: true }))
      if (!sameNode(copiedNode, await stat(target))) throw changed(`detached ${subject} snapshot`)
    } finally { await handle.close() }
    const actual = await readRecord(target)
    if (!matches(actual, expected)) throw changed(`detached ${subject} snapshot bytes`)
    return actual
  }
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
  return { syncDirectory, directory, writeNew, writeCommitPart, copyDetached, move }
}
module.exports = { createPublicationIO }
