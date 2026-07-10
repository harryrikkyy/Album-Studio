// @ts-check
// ipc_guards.js — input validation for the IPC boundary (Phase 3).
//
// Every ipcMain.handle callback receives renderer-controlled data. With the
// windows now isolated the renderer is far harder to compromise, but the
// boundary still validates defensively: type checks, NUL-byte rejection,
// path normalization, and basename-only checks where a joined path would
// otherwise allow traversal. Guards THROW — ipcMain.handle turns that into
// a rejected promise in the renderer, which is what callers already handle.
//
// Note the app legitimately operates on arbitrary user-chosen absolute
// paths (photos live anywhere on disk), so absolute paths are normalized
// and type-checked rather than rooted.

const path = require('path')

/**
 * @param {string} channel
 * @param {string} msg
 * @returns {never}
 */
function fail(channel, msg) {
  throw new Error(`[ipc:${channel}] ${msg}`)
}

/**
 * Required non-empty string (NUL-free, bounded).
 * @param {unknown} v @param {string} name @param {string} channel
 * @param {{ max?: number, allowEmpty?: boolean }} [opts]
 * @returns {string}
 */
function reqString(v, name, channel, opts = {}) {
  const max = opts.max || 65536
  if (typeof v !== 'string') fail(channel, `${name} must be a string`)
  if (!opts.allowEmpty && v.length === 0) fail(channel, `${name} must not be empty`)
  if (v.length > max) fail(channel, `${name} exceeds ${max} chars`)
  if (v.includes('\0')) fail(channel, `${name} contains a NUL byte`)
  return v
}

/**
 * Required absolute filesystem path → normalized form.
 * @param {unknown} v @param {string} name @param {string} channel
 * @returns {string}
 */
function reqAbsPath(v, name, channel) {
  const s = reqString(v, name, channel, { max: 4096 })
  const norm = path.normalize(s)
  if (!path.isAbsolute(norm)) fail(channel, `${name} must be an absolute path`)
  return norm
}

/**
 * A bare file name (no directory separators, no traversal) — for values that
 * get joined onto a folder the renderer also names.
 * @param {unknown} v @param {string} name @param {string} channel
 * @returns {string}
 */
function reqBaseName(v, name, channel) {
  const s = reqString(v, name, channel, { max: 512 })
  if (s === '.' || s === '..' || path.basename(s) !== s) {
    fail(channel, `${name} must be a bare file name`)
  }
  return s
}

/**
 * Required finite number within [min, max].
 * @param {unknown} v @param {string} name @param {string} channel
 * @param {{ min?: number, max?: number }} [opts]
 * @returns {number}
 */
function reqNumber(v, name, channel, opts = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(channel, `${name} must be a finite number`)
  if (opts.min !== undefined && v < opts.min) fail(channel, `${name} must be ≥ ${opts.min}`)
  if (opts.max !== undefined && v > opts.max) fail(channel, `${name} must be ≤ ${opts.max}`)
  return v
}

/**
 * Required plain object (not an array / null).
 * @param {unknown} v @param {string} name @param {string} channel
 * @returns {Record<string, any>}
 */
function reqObject(v, name, channel) {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fail(channel, `${name} must be an object`)
  }
  return /** @type {Record<string, any>} */ (v)
}

/**
 * Required array (bounded).
 * @param {unknown} v @param {string} name @param {string} channel
 * @param {{ max?: number }} [opts]
 * @returns {any[]}
 */
function reqArray(v, name, channel, opts = {}) {
  if (!Array.isArray(v)) fail(channel, `${name} must be an array`)
  const max = opts.max || 100000
  if (v.length > max) fail(channel, `${name} exceeds ${max} items`)
  return v
}

/**
 * One of a fixed set of allowed values.
 * @template T
 * @param {unknown} v @param {string} name @param {string} channel
 * @param {readonly T[]} allowed
 * @returns {T}
 */
function reqEnum(v, name, channel, allowed) {
  if (!allowed.includes(/** @type {T} */ (v))) {
    fail(channel, `${name} must be one of ${allowed.join(', ')}`)
  }
  return /** @type {T} */ (v)
}

module.exports = { reqString, reqAbsPath, reqBaseName, reqNumber, reqObject, reqArray, reqEnum }
