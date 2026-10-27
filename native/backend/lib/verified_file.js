// @ts-check
// Verified file records shared by publication adapters. Streaming keeps large payloads
// out of JSON buffers; callers provide their domain-specific conflict messages.
'use strict'
const fs = require('fs')
const crypto = require('crypto')
const MAX_FILE_BYTES = Number.MAX_SAFE_INTEGER
const CHUNK = 1024 * 1024
const MAX_RETAINED_BYTES = 64 * 1024 * 1024
/**
 * @typedef {{ dev: string, ino: string }} FileNode
 * @typedef {{ digest: string, size: string, stamp: string, node: FileNode, mode: number, mtimeMs: number, atimeMs: number, bytes?: Buffer }} FileRecord
 * @typedef {{ sink?: (bytes: Buffer, position: number) => Promise<void>, expectedDigest?: string | null }} ReadOptions
 * @typedef {(file: string, maximum?: number, retain?: boolean, options?: ReadOptions) => Promise<FileRecord | null>} ReadRecord
 */
/** @param {string} file @returns {Promise<fs.BigIntStats | null>} */
const stat = file => fs.promises.lstat(file, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error })
/** @param {fs.BigIntStats} st @returns {FileNode} */
const node = st => ({ dev: String(st.dev), ino: String(st.ino) })
/** @param {{ dev: unknown, ino: unknown } | null | undefined} a @param {{ dev: unknown, ino: unknown } | null | undefined} b */
const sameNode = (a, b) => !!a && !!b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
/** @param {fs.BigIntStats | null} a @param {fs.BigIntStats | null} b */
const sameRead = (a, b) => !!a && !!b && sameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && a.nlink === b.nlink
/** @param {{ label: string, changed: (what: string) => Error }} options @returns {ReadRecord} */
function createVerifiedFileReader({ label, changed }) {
  if (typeof label !== 'string' || !label || typeof changed !== 'function') throw new Error('Verified publication reads require a label and conflict factory.')
  const subject = `${label.toLowerCase()} file`
  /** Fixed allocation, declared-length reads, no-follow handle, identity/growth checks. @type {ReadRecord} */
  async function readRecord(file, maximum = MAX_FILE_BYTES, retain = false, { sink, expectedDigest } = {}) {
    const before = await stat(file)
    if (!before) return null
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 0n || before.size > BigInt(maximum)) throw new Error(`${label} file ${file} must be a regular, independent file within the ${maximum}-byte policy. Preserve it before retrying.`)
    if (retain && before.size > BigInt(MAX_RETAINED_BYTES)) throw new Error('Buffered publication metadata exceeds the 64 MiB limit. Use the streaming reader for document bytes.')
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    /** @type {any} Whatever was thrown; inspected defensively below. */
    let failure
    /** @type {FileRecord | null} */
    let result = null
    let failed = false
    try {
      const opened = await handle.stat({ bigint: true })
      if (!sameRead(before, opened)) throw changed(subject)
      const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(CHUNK), chunks = []
      let position = 0
      const length = Number(opened.size)
      while (position < length) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - position), position)
        if (!bytesRead) throw changed(`${subject} length`)
        const bytes = buffer.subarray(0, bytesRead)
        hash.update(bytes)
        if (retain) chunks.push(Buffer.from(bytes))
        if (sink) await sink(bytes, position)
        position += bytesRead
      }
      const extra = await handle.read(buffer, 0, 1, length)
      let after = await handle.stat({ bigint: true })
      if (extra.bytesRead || !sameRead(opened, after) || !sameRead(after, await stat(file))) throw changed(`${subject} identity or length`)
      const firstDigest = hash.digest('hex')
      // HFS timestamps can be coarse enough to miss an in-place A/B/A write. Verify all
      // bytes again through the same handle before accepting the first pass or its copy,
      // unless that pass hashed to the digest the caller requires: it then read exactly
      // those bytes, never a hybrid of two revisions.
      if (firstDigest !== expectedDigest) {
        const check = crypto.createHash('sha256')
        position = 0
        while (position < length) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - position), position)
          if (!bytesRead) throw changed(`${subject} verification length`)
          check.update(buffer.subarray(0, bytesRead)); position += bytesRead
        }
        const verificationExtra = await handle.read(buffer, 0, 1, length)
        after = await handle.stat({ bigint: true })
        if (verificationExtra.bytesRead || check.digest('hex') !== firstDigest || !sameRead(opened, after) || !sameRead(after, await stat(file))) throw changed(`${subject} content or identity`)
      }
      result = { digest: firstDigest, size: String(after.size), stamp: `${after.size}:${Math.round(Number(after.mtimeNs) / 1e6)}`, node: node(after), mode: Number(after.mode) & 0o777, mtimeMs: Number(after.mtimeNs) / 1e6, atimeMs: Number(after.atimeNs) / 1e6, ...(retain ? { bytes: Buffer.concat(chunks, length) } : {}) }
    } catch (error) { failure = error; failed = true }
    try { await handle.close() } catch (error) {
      const closeError = /** @type {Error} */ (error)
      const previousClose = failure && typeof failure === 'object' && Object.getOwnPropertyDescriptor(failure, 'closeErrors')
      if (!failed) { failure = closeError; failed = true }
      else if (failure && typeof failure === 'object' && Object.isExtensible(failure) && (!previousClose || Object.hasOwn(previousClose, 'value') && previousClose.writable)) {
        failure.closeErrors = [...(previousClose && Array.isArray(previousClose.value) ? previousClose.value.slice(0, 63) : []), closeError.message]
      } else {
        const primary = failure, descriptor = primary && typeof primary === 'object' && Object.getOwnPropertyDescriptor(primary, 'message')
        failure = new Error(typeof primary === 'string' ? primary : descriptor && typeof descriptor.value === 'string' ? descriptor.value : 'The publication read failed.', { cause: primary })
        const code = primary && typeof primary === 'object' && Object.getOwnPropertyDescriptor(primary, 'code')
        if (code && typeof code.value === 'string') failure.code = code.value
        failure.closeErrors = [closeError.message]
      }
    }
    if (failed) throw failure
    return result
  }
  return readRecord
}
module.exports = { createVerifiedFileReader }
