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
/** @typedef {import('../../contracts/runtime').RecoverableError} RecoverableError */
/** @param {string} file @returns {Promise<fs.BigIntStats | null>} */
const stat = (file) =>
  fs.promises.lstat(file, { bigint: true }).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
/** @param {fs.BigIntStats} st @returns {FileNode} */
const node = (st) => ({ dev: String(st.dev), ino: String(st.ino) })
/** @param {{ dev: unknown, ino: unknown } | null | undefined} a @param {{ dev: unknown, ino: unknown } | null | undefined} b */
const sameNode = (a, b) => !!a && !!b && String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino)
/** @param {fs.BigIntStats | null} a @param {fs.BigIntStats | null} b */
const sameRead = (a, b) =>
  !!a &&
  !!b &&
  sameNode(a, b) &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.mode === b.mode &&
  a.nlink === b.nlink
/**
 * Whether a close error can be listed on the failure itself: an extensible object whose
 * closeErrors, if it has one, is a writable data property.
 * @param {any} failure @param {PropertyDescriptor | false | undefined} previousClose
 */
function acceptsCloseErrors(failure, previousClose) {
  return (
    !!failure &&
    typeof failure === 'object' &&
    Object.isExtensible(failure) &&
    (!previousClose || (Object.hasOwn(previousClose, 'value') && !!previousClose.writable))
  )
}
/**
 * A new error for a failure that can't carry closeErrors: it keeps the failure's message and
 * code, cites it as its cause, and lists the close error.
 * @param {any} primary @param {Error} closeError @returns {RecoverableError}
 */
function replacingFailure(primary, closeError) {
  const descriptor = primary && typeof primary === 'object' && Object.getOwnPropertyDescriptor(primary, 'message')
  /** @type {RecoverableError} */
  const replacement = new Error(
    typeof primary === 'string'
      ? primary
      : descriptor && typeof descriptor.value === 'string'
        ? descriptor.value
        : 'The publication read failed.',
    { cause: primary },
  )
  const code = primary && typeof primary === 'object' && Object.getOwnPropertyDescriptor(primary, 'code')
  if (code && typeof code.value === 'string') replacement.code = code.value
  replacement.closeErrors = [closeError.message]
  return replacement
}
/**
 * What to throw once closing the handle has failed as well: the close error alone, the first
 * failure with the close message added to its closeErrors, or a replacing failure.
 * @param {any} failure whatever the read threw, if it failed
 * @param {boolean} failed whether the read failed
 * @param {Error} closeError
 * @returns {any}
 */
function withCloseError(failure, failed, closeError) {
  const previousClose =
    failure && typeof failure === 'object' && Object.getOwnPropertyDescriptor(failure, 'closeErrors')
  if (!failed) return closeError
  if (!acceptsCloseErrors(failure, previousClose)) return replacingFailure(failure, closeError)
  failure.closeErrors = [
    ...(previousClose && Array.isArray(previousClose.value) ? previousClose.value.slice(0, 63) : []),
    closeError.message,
  ]
  return failure
}
/**
 * The record of a completely read file, in the key order callers have always received.
 * @param {fs.BigIntStats} after @param {string} digest @param {boolean} retain
 * @param {Buffer[]} chunks @param {number} length @returns {FileRecord}
 */
function recordOf(after, digest, retain, chunks, length) {
  return {
    digest,
    size: String(after.size),
    stamp: `${after.size}:${Math.round(Number(after.mtimeNs) / 1e6)}`,
    node: node(after),
    mode: Number(after.mode) & 0o777,
    mtimeMs: Number(after.mtimeNs) / 1e6,
    atimeMs: Number(after.atimeNs) / 1e6,
    ...(retain ? { bytes: Buffer.concat(chunks, length) } : {}),
  }
}
/** @param {{ label: string, changed: (what: string) => Error }} options @returns {ReadRecord} */
function createVerifiedFileReader({ label, changed }) {
  if (typeof label !== 'string' || !label || typeof changed !== 'function')
    throw new Error('Verified publication reads require a label and conflict factory.')
  const subject = `${label.toLowerCase()} file`
  /** A regular, independent file within the size policy, and a buffered read within 64 MiB.
   * @param {string} file @param {fs.BigIntStats} before @param {number} maximum @param {boolean} retain */
  function assertReadable(file, before, maximum, retain) {
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size < 0n ||
      before.size > BigInt(maximum)
    )
      throw new Error(
        `${label} file ${file} must be a regular, independent file within the ${maximum}-byte policy. Preserve it before retrying.`,
      )
    if (retain && before.size > BigInt(MAX_RETAINED_BYTES))
      throw new Error(
        'Buffered publication metadata exceeds the 64 MiB limit. Use the streaming reader for document bytes.',
      )
  }
  /** The first pass hashes every declared byte, keeping a copy or streaming it to the sink as asked.
   * @param {import('fs/promises').FileHandle} handle @param {Buffer} buffer @param {number} length
   * @param {boolean} retain @param {ReadOptions['sink']} sink */
  async function hashPass(handle, buffer, length, retain, sink) {
    const hash = crypto.createHash('sha256'),
      /** @type {Buffer[]} */
      chunks = []
    let position = 0
    while (position < length) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - position), position)
      if (!bytesRead) throw changed(`${subject} length`)
      const bytes = buffer.subarray(0, bytesRead)
      hash.update(bytes)
      if (retain) chunks.push(Buffer.from(bytes))
      if (sink) await sink(bytes, position)
      position += bytesRead
    }
    return { digest: hash.digest('hex'), chunks }
  }
  /** The second pass hashes the same bytes again through the same handle.
   * @param {import('fs/promises').FileHandle} handle @param {Buffer} buffer @param {number} length */
  async function verifyPass(handle, buffer, length) {
    const check = crypto.createHash('sha256')
    let position = 0
    while (position < length) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, length - position), position)
      if (!bytesRead) throw changed(`${subject} verification length`)
      check.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    return check.digest('hex')
  }
  /**
   * Reads one byte past the end and the handle's identity again, and throws changed(what) unless
   * nothing grew, the digest held, and the handle and the path still name the same unchanged file.
   * The path is examined last, only when everything before it held.
   * @param {import('fs/promises').FileHandle} handle @param {Buffer} buffer @param {number} length
   * @param {fs.BigIntStats} opened @param {string} file @param {string} what
   * @param {() => boolean} [digestHeld]
   */
  async function settledRead(handle, buffer, length, opened, file, what, digestHeld = () => true) {
    const extra = await handle.read(buffer, 0, 1, length),
      after = await handle.stat({ bigint: true })
    if (extra.bytesRead || !digestHeld() || !sameRead(opened, after) || !sameRead(after, await stat(file)))
      throw changed(what)
    return after
  }
  /** Fixed allocation, declared-length reads, no-follow handle, identity/growth checks. @type {ReadRecord} */
  async function readRecord(file, maximum = MAX_FILE_BYTES, retain = false, { sink, expectedDigest } = {}) {
    const before = await stat(file)
    if (!before) return null
    assertReadable(file, before, maximum, retain)
    const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    /** @type {any} Whatever was thrown; inspected defensively when closing. */
    let failure
    /** @type {FileRecord | null} */
    let result = null
    let failed = false
    try {
      const opened = await handle.stat({ bigint: true })
      if (!sameRead(before, opened)) throw changed(subject)
      const buffer = Buffer.alloc(CHUNK),
        length = Number(opened.size)
      const { digest, chunks } = await hashPass(handle, buffer, length, retain, sink)
      let after = await settledRead(handle, buffer, length, opened, file, `${subject} identity or length`)
      // HFS timestamps can be coarse enough to miss an in-place A/B/A write. Verify all
      // bytes again through the same handle before accepting the first pass or its copy,
      // unless that pass hashed to the digest the caller requires: it then read exactly
      // those bytes, never a hybrid of two revisions.
      if (digest !== expectedDigest) {
        const check = await verifyPass(handle, buffer, length)
        after = await settledRead(
          handle,
          buffer,
          length,
          opened,
          file,
          `${subject} content or identity`,
          () => check === digest,
        )
      }
      result = recordOf(after, digest, retain, chunks, length)
    } catch (error) {
      failure = error
      failed = true
    }
    try {
      await handle.close()
    } catch (error) {
      failure = withCloseError(failure, failed, /** @type {Error} */ (error))
      failed = true
    }
    if (failed) throw failure
    return result
  }
  return readRecord
}
module.exports = { createVerifiedFileReader }
