// raw.js — RAW photos for rendering. PhotoCraft 0.6.0 develops Sony/Canon/Nikon RAW with a
// neutral profile (measured: about 45 levels darker than Camera Raw on the Wedding album);
// macOS's own RAW engine (`sips`) lands within ~6 levels. Developed files are cached by source
// verified source contents, so preserved file timestamps cannot reuse an older development.

'use strict'

const childProcess = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { contentFileKey, fileDigest, contentKey, snapshotFile } = require('./cache')
const exclusiveRename = require('./exclusive_rename')

const RAW_EXT = /\.(arw|cr2|cr3|nef|dng|raf|orf|rw2|srw|pef)$/i
const SRGB = '/System/Library/ColorSync/Profiles/sRGB Profile.icc'

function isRaw(file) {
  return RAW_EXT.test(file)
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(cmd, args, { maxBuffer: 1 << 20, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)} failed: ${(stderr || err.message).toString().trim()}`))
      else resolve(stdout)
    })
  })
}

const derivations = new Map()
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key])
const changed = (file) => new Error(`The source ${file} changed while its derived image was made. Retry from a stable original.`)
async function sourceIdentity(file) {
  const identity = await fs.promises.lstat(file, { bigint: true })
  if (!identity.isFile()) throw new Error(`The source ${file} is not a regular file. Resolve its symlink before continuing.`)
  return identity
}
async function unchangedSource(file, key, identity = null) {
  if (await contentFileKey(file) !== key) throw changed(file)
  if (identity && !sameFile(identity, await sourceIdentity(file))) throw changed(file)
}

/** Decoders consume a private read-only copy, not a mutable original with coarse timestamps. */
async function consumeSnapshot(file, key, parent, consume) {
  await fs.promises.mkdir(parent, { recursive: true })
  const stage = await fs.promises.mkdtemp(path.join(parent, '.source-'))
  let frozen = null, digest = null, preserve = false
  try {
    const identity = await sourceIdentity(file)
    digest = await fileDigest(file)
    if (contentKey(file, digest) !== key) throw changed(file)
    frozen = await snapshotFile(file, stage, digest)
    const result = await consume(frozen, stage)
    if (await fileDigest(frozen) !== digest || (await fs.promises.lstat(frozen)).mode & 0o222) { preserve = true; throw changed(frozen) }
    await unchangedSource(file, key, identity)
    return result
  } catch (error) { if (error.snapshotPath || error.retainedPath) preserve = true; throw error }
  finally {
    if (frozen && !preserve) {
      try { preserve = await fileDigest(frozen) !== digest || !!((await fs.promises.lstat(frozen)).mode & 0o222) } catch (_) { preserve = true }
    }
    if (!preserve) await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => {})
  }
}

/** Small evidence files are read without following links or accepting an in-flight rewrite. */
async function readEvidence(file, maxBytes = 65536) {
  let handle
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error(`The cache evidence ${file} is invalid. Preserve it and rebuild in a new cache folder.`)
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true }), named = await fs.promises.lstat(file, { bigint: true })
    if (!sameFile(before, after) || !sameFile(after, named)) throw new Error(`The cache evidence ${file} changed while it was read.`)
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' && !handle) return null
    throw error
  } finally { if (handle) await handle.close() }
}

async function publishExclusive(from, to) {
  try { await fs.promises.link(from, to) } catch (error) {
    if (!['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'EMLINK'].includes(error.code)) throw error
    // exFAT/SMB may disallow hard links. The same-filesystem OS move still refuses replacement
    // atomically, without exposing a partial exclusive-copy destination.
    await exclusiveRename.renameExclusive(from, to)
  }
}

async function verifiedDerived(file, out, sourceKey, recipe) {
  const record = await readEvidence(`${out}.json`)
  const present = await fs.promises.lstat(out).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error })
  if (!present && !record) return null
  if (!present || !record || record.version !== 1 || record.sourceKey !== sourceKey || record.recipe !== recipe || !/^[a-f0-9]{64}$/.test(record.digest) || (record.rotation !== undefined && ![0, 90, 180, 270].includes(record.rotation))) {
    throw new Error(`The derived cache ${out} has unverified or incomplete evidence. Its existing bytes have been preserved; use a new cache folder to rebuild.`)
  }
  if (await fileDigest(out) !== record.digest) throw new Error(`The derived cache ${out} was edited or changed. Its bytes have been preserved; use a new cache folder to rebuild.`)
  await unchangedSource(file, sourceKey)
  return { file: out, rotation: record.rotation || 0, digest: record.digest, sourceKey }
}

/** Content-addressed derivatives publish exclusively: old or edited cache bytes are never replaced. */
async function deriveCached(file, out, sourceKey, recipe, generate, extra = {}) {
  const identity = path.resolve(out)
  if (derivations.has(identity)) {
    await derivations.get(identity)
    return verifiedDerived(file, out, sourceKey, recipe)
  }
  const work = (async () => {
    const identity = await sourceIdentity(file)
    const reused = await verifiedDerived(file, out, sourceKey, recipe)
    if (reused) { await unchangedSource(file, sourceKey, identity); return reused }
    await fs.promises.mkdir(path.dirname(out), { recursive: true })
    const stage = await fs.promises.mkdtemp(path.join(path.dirname(out), '.album-studio-derived-'))
    const tmp = path.join(stage, 'image.jpg'), evidence = path.join(stage, 'evidence.json')
    try {
      await consumeSnapshot(file, sourceKey, stage, (frozen) => generate(tmp, frozen))
      const digest = await fileDigest(tmp)
      await unchangedSource(file, sourceKey, identity)
      await fs.promises.writeFile(evidence, JSON.stringify({ ...extra, version: 1, sourceKey, recipe, digest }), { flag: 'wx' })
      try { await publishExclusive(tmp, out) } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const concurrent = await verifiedDerived(file, out, sourceKey, recipe)
        if (concurrent) return concurrent
        throw error
      }
      // A second writer cannot replace either the image or its evidence.
      await publishExclusive(evidence, `${out}.json`)
      const result = await verifiedDerived(file, out, sourceKey, recipe)
      await unchangedSource(file, sourceKey, identity)
      return result
    } finally {
      await fs.promises.unlink(tmp).catch(() => {})
      await fs.promises.unlink(evidence).catch(() => {})
      await fs.promises.rmdir(stage).catch(() => {})
    }
  })()
  derivations.set(identity, work)
  try { return await work } finally { derivations.delete(identity) }
}

function derivedKey(sourceKey, recipe) {
  return crypto.createHash('sha256').update(JSON.stringify([sourceKey, recipe])).digest('hex')
}
function sourceBase(file) {
  let base = ''
  for (const char of path.basename(file).replace(/\.[^.]+$/, '')) {
    if (Buffer.byteLength(base + char) > 96) break
    base += char
  }
  return base
}

/**
 * The file to place for `file`: itself, or for a RAW its developed sRGB JPEG in `cacheDir`.
 * @param {string} file
 * @param {string} cacheDir
 */
async function placeable(file, cacheDir) {
  return (await placeableEvidence(file, cacheDir)).file
}
async function placeableEvidence(file, cacheDir) {
  if (!isRaw(file)) { const digest = await fileDigest(file); return { file, digest, sourceKey: require('./cache').contentKey(file, digest), rotation: 0 } }
  const sourceKey = await contentFileKey(file), recipe = 'sips-srgb-jpeg95-v2-frozen'
  const key = derivedKey(sourceKey, recipe)
  const out = path.join(cacheDir, `${sourceBase(file)}-${key}.jpg`)
  return deriveCached(file, out, sourceKey, recipe, (tmp, frozen) =>
    run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '95', '-m', SRGB, frozen, '--out', tmp]))
}

/** Degrees to turn an image upright, from a TIFF/EXIF orientation value. */
const ORIENT_DEG = { 1: 0, 3: 180, 6: 90, 8: 270 }

/**
 * The largest JPEG a TIFF-based RAW (ARW, NEF, CR2, DNG, …) carries for previews, and the
 * orientation the camera recorded. Reads only the first megabyte to find it. Null when the file
 * has no embedded JPEG (CR3, RAF and some DNGs aren't TIFF-based).
 */
async function readEmbedded(fh, opened) {
    const head = Buffer.alloc(1 << 20)
    const { bytesRead } = await fh.read(head, 0, head.length, 0)
    const order = head.toString('latin1', 0, 2)
    if (bytesRead < 16 || (order !== 'II' && order !== 'MM')) return null
    const le = order === 'II'
    const u16 = (o) => (o + 2 <= bytesRead ? (le ? head.readUInt16LE(o) : head.readUInt16BE(o)) : 0)
    const u32 = (o) => (o + 4 <= bytesRead ? (le ? head.readUInt32LE(o) : head.readUInt32BE(o)) : 0)
    const found = []
    let orientation = 1
    const seen = new Set()
    const walk = (off, depth) => {
      if (!off || off + 2 > bytesRead || seen.has(off) || depth > 4 || seen.size > 32) return
      seen.add(off)
      const count = u16(off)
      let at = 0
      let len = 0
      const subs = []
      for (let i = 0; i < count; i++) {
        const e = off + 2 + i * 12
        if (e + 12 > bytesRead) break
        const tag = u16(e)
        const n = u32(e + 4)
        const val = u32(e + 8)
        if (tag === 0x0201) at = val
        else if (tag === 0x0202) len = val
        else if (tag === 0x0112 && depth === 0) orientation = u16(e + 8)
        else if (tag === 0x014a) {
          if (n === 1) subs.push(val)
          else for (let k = 0; k < Math.min(n, 8); k++) subs.push(u32(val + k * 4))
        }
      }
      if (at && len) found.push({ at, len })
      for (const s of subs) walk(s, depth + 1)
      walk(u32(off + 2 + count * 12), depth)
    }
    walk(u32(4), 0)
    const best = found.sort((a, b) => b.len - a.len)[0]
    // A malformed offset must not cause a huge allocation or a truncated preview to be cached.
    if (!best || best.len < 1024 || best.len > 64 * 1024 * 1024 || BigInt(best.at) + BigInt(best.len) > opened.size) return null
    const jpeg = Buffer.alloc(best.len)
    let read = 0
    while (read < best.len) {
      const { bytesRead } = await fh.read(jpeg, read, best.len - read, best.at + read)
      if (!bytesRead) return null
      read += bytesRead
    }
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null
    return { jpeg, rotation: ORIENT_DEG[orientation] || 0 }
}

async function embeddedJpeg(file) {
  const before = await fs.promises.lstat(file, { bigint: true })
  if (!before.isFile()) throw new Error(`The source ${file} is not a regular file. Resolve its symlink before continuing.`)
  const fh = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let opened, result, failure
  try {
    opened = await fh.stat({ bigint: true })
    if (!sameFile(before, opened)) throw changed(file)
    result = await readEmbedded(fh, opened)
  } catch (error) { failure = error }
  try {
    if (opened) {
      const after = await fh.stat({ bigint: true }), named = await fs.promises.lstat(file, { bigint: true })
      if (!sameFile(opened, after) || !sameFile(after, named)) throw changed(file)
    }
  } catch (error) { if (!failure) failure = error }
  try { await fh.close() } catch (error) { if (!failure) failure = error }
  if (failure) throw failure
  return result
}

/**
 * A quick stand-in for a RAW in previews: its developed JPEG when rendering already made one,
 * else the camera's embedded preview (milliseconds, versus about 1.5 s to develop), else a fresh
 * develop. `rotation` is what the file needs to be upright (embedded previews carry no EXIF).
 * @returns {Promise<{ file: string, rotation: number }>}
 */
async function previewable(file, { developedDir, previewDir, minEdge = 1000 }) {
  if (!isRaw(file)) return { file, rotation: 0 }
  const sourceKey = await contentFileKey(file)
  const identity = await sourceIdentity(file)
  const base = sourceBase(file)
  const developedRecipe = 'sips-srgb-jpeg95-v2-frozen'
  const developed = path.join(developedDir, `${base}-${derivedKey(sourceKey, developedRecipe)}.jpg`)
  const reused = await verifiedDerived(file, developed, sourceKey, developedRecipe)
  if (reused) return reused
  const recipe = `embedded-jpeg-v2-frozen:minEdge=${minEdge}`, key = derivedKey(sourceKey, recipe)
  const out = path.join(previewDir, `${base}-${key}.preview.jpg`)
  const prior = await verifiedDerived(file, out, sourceKey, recipe)
  if (prior) return prior
  const emb = await consumeSnapshot(file, sourceKey, previewDir, (frozen) => embeddedJpeg(frozen))
  await unchangedSource(file, sourceKey, identity)
  const size = emb ? require('./jpeg_size').jpegSizeFromBuffer(emb.jpeg) : null
  if (emb && size && Math.max(size.width, size.height) >= minEdge) {
    return deriveCached(file, out, sourceKey, recipe, (tmp) => fs.promises.writeFile(tmp, emb.jpeg, { flag: 'wx' }), { rotation: emb.rotation })
  }
  return placeableEvidence(file, developedDir)
}

module.exports = { isRaw, placeable, placeableEvidence, previewable, embeddedJpeg, deriveCached, derivedKey, sourceBase, readEvidence, sourceIdentity, unchangedSource, publishExclusive, consumeSnapshot }
