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
async function fileDigest(file) {
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
      const pass = async () => {
        const hash = crypto.createHash('sha256')
        let position = 0
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
          if (!bytesRead) break
          hash.update(buffer.subarray(0, bytesRead)); position += bytesRead
        }
        if (BigInt(position) !== opened.size) throw changed()
        return hash.digest('hex')
      }
      const first = await pass(), second = await pass()
      const after = await handle.stat({ bigint: true }), named = await fs.promises.lstat(file, { bigint: true })
      if (first !== second || !same(opened, after) || !same(after, named)) throw changed()
      return first
    } finally { if (handle) await handle.close() }
  })
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
  const target = path.join(folder, `${crypto.randomUUID()}${path.extname(file)}`)
  try {
    await fs.promises.copyFile(file, target, fs.constants.COPYFILE_EXCL)
    if (await fileDigest(target) !== digest) throw new Error(`The image ${file} changed before its verified snapshot could be made. Its original bytes were preserved.`)
    await fs.promises.chmod(target, 0o400)
    if ((await fs.promises.lstat(target)).mode & 0o222) throw new Error('This filesystem cannot protect a private read-only source snapshot. Use a volume with file-permission support.')
    return target
  } catch (e) { await fs.promises.unlink(target).catch(() => {}); throw e }
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

module.exports = { cacheRoot, fileKey, fileStamp, writeAtomic, fileDigest, contentFileKey, contentKey, snapshotFile }
