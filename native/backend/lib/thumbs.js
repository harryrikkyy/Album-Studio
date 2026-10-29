// thumbs.js — the small photo proxies Album Studio works from: `<photo folder>/_Thumbnails/
// <name>.jpg`, longest side 400 px, upright (the Electron app's contract, so both apps share
// them). Ordinary images are resized by sharp; RAW files use the JPEG the camera embedded in them
// (milliseconds) and are developed by macOS (`sips`) only when there is none. Photoshop is never
// involved. Only missing or outdated thumbnails are made, so running it again is cheap.

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const {
  embeddedJpeg,
  isRaw,
  readEvidence,
  sourceIdentity,
  unchangedSource,
  publishExclusive,
  consumeSnapshot,
} = require('./raw')
const { contentFileKey, fileDigest, snapshotFile } = require('./cache')
const exclusiveRename = require('./exclusive_rename')

const THUMB_DIR = '_Thumbnails'
const MAX_EDGE = 400
const QUALITY = 70
const SHARP_READS = /\.(jpe?g|png|tiff?|webp|heic|heif|avif)$/i
const POOL = 6
const RECIPE = 'upright-sharp400-jpeg70-v2-frozen'
const jobs = new Map()

const getSharp = () => require('../../../src/sharp_config').getSharp()

/** Which files of a folder are photos (the folder's own files only, not subfolders). */
function isPhoto(name) {
  return !name.startsWith('.') && (SHARP_READS.test(name) || isRaw(name))
}

const evidenceRoot = (dest) => path.join(path.dirname(dest), '.album-studio-thumbs')
const evidencePath = (dest) =>
  path.join(evidenceRoot(dest), crypto.createHash('sha256').update(path.resolve(dest)).digest('hex') + '.json')
async function optionalDigest(file) {
  try {
    return await fileDigest(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
async function thumbState(src, dest, sourceKey) {
  const record = await readEvidence(evidencePath(dest)),
    digest = await optionalDigest(dest)
  if (record && (record.version !== 1 || !/^[a-f0-9]{64}$/.test(record.digest)))
    throw new Error(`The thumbnail evidence for ${dest} is invalid. Its existing bytes have been preserved.`)
  if (record && digest && record.digest !== digest)
    throw new Error(
      `The thumbnail ${dest} was edited or changed. Its bytes have been preserved; resolve this preview before refreshing it.`,
    )
  return {
    record,
    digest,
    fresh: !!(
      record &&
      digest &&
      record.source === path.resolve(src) &&
      record.sourceKey === sourceKey &&
      record.recipe === RECIPE
    ),
  }
}
const sameState = (a, b) => a.digest === b.digest && JSON.stringify(a.record) === JSON.stringify(b.record)
async function restoreExclusive(saved, target) {
  if (!saved) return
  // A direct hard link would let a later edit of the restored target mutate its history too.
  const stage = await fs.promises.mkdtemp(path.join(path.dirname(saved), '.restore-'))
  const copy = path.join(stage, 'copy')
  try {
    const digest = await fileDigest(saved)
    await fs.promises.copyFile(saved, copy, fs.constants.COPYFILE_EXCL)
    if ((await fileDigest(copy)) !== digest || (await fileDigest(saved)) !== digest)
      throw new Error(
        `The recovery copy ${saved} changed. It remains preserved; restore it after the editing process stops.`,
      )
    try {
      await publishExclusive(copy, target)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  } finally {
    await fs.promises.unlink(copy).catch(() => {})
    await fs.promises.rmdir(stage).catch(() => {})
  }
}

/**
 * Photos of a folder and how many still need a thumbnail.
 * @returns {Promise<{ path: string, name: string, exists: boolean, photos: number, raws: number,
 *   thumbs: number, missing: string[], samples: string[],
 *   evidence?: Array<{ source: string, sourceKey: string, thumb: string, digest: string }> }>}
 */
async function surveyFolder(folder, { includeEvidence = false } = {}) {
  const out = {
    path: folder,
    name: path.basename(folder),
    exists: false,
    photos: 0,
    raws: 0,
    thumbs: 0,
    missing: /** @type {string[]} */ ([]),
    samples: /** @type {string[]} */ ([]),
  }
  if (includeEvidence) out.evidence = []
  let entries
  try {
    entries = await fs.promises.readdir(folder, { withFileTypes: true })
    out.exists = true
  } catch (_) {
    return out
  }
  const thumbDir = path.join(folder, THUMB_DIR)
  const have = new Map()
  for (const e of await fs.promises.readdir(thumbDir, { withFileTypes: true }).catch(() => [])) {
    if (e.isFile() && /\.jpe?g$/i.test(e.name))
      have.set(e.name.replace(/\.[^.]+$/, '').toLowerCase(), path.join(thumbDir, e.name))
  }
  // One thumbnail per base name: a RAW and its same-named JPEG are one photo.
  const bases = new Map()
  for (const e of entries) {
    if (!e.isFile() || !isPhoto(e.name)) continue
    const base = e.name.replace(/\.[^.]+$/, '')
    const prev = bases.get(base.toLowerCase())
    // Prefer a JPEG/TIFF as the source (faster, already developed), as the thumbnailer did.
    if (!prev || (isRaw(prev) && !isRaw(e.name))) bases.set(base.toLowerCase(), e.name)
  }
  for (const [key, name] of bases) {
    out.photos++
    if (isRaw(name)) out.raws++
    const thumb = have.get(key)
    const fresh =
      thumb &&
      (await (async () => {
        try {
          const src = path.join(folder, name),
            key = await contentFileKey(src)
          const state = await thumbState(src, thumb, key)
          await unchangedSource(src, key)
          if (state.fresh && includeEvidence)
            out.evidence.push({
              source: path.resolve(src),
              sourceKey: key,
              thumb: path.resolve(thumb),
              digest: state.digest,
            })
          return state.fresh
        } catch (_) {
          return false
        } // ensureThumbnails reports the recoverable error for this photo.
      })())
    if (!fresh) out.missing.push(name)
    else {
      out.thumbs++
      if (out.samples.length < 8) out.samples.push(thumb)
    }
  }
  out.missing.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return out
}

/** One thumbnail. */
async function makeThumb(src, dest) {
  const identity = path.resolve(dest)
  // Stable names serialize, rather than returning another source's in-flight proxy.
  const work = (jobs.get(identity) || Promise.resolve()).catch(() => {}).then(() => refreshThumb(src, dest))
  jobs.set(identity, work)
  try {
    return await work
  } finally {
    if (jobs.get(identity) === work) jobs.delete(identity)
  }
}

async function refreshThumb(src, dest) {
  const sourceKey = await contentFileKey(src)
  const identity = await sourceIdentity(src)
  const before = await thumbState(src, dest, sourceKey)
  if (before.fresh) {
    await unchangedSource(src, sourceKey, identity)
    return
  }
  return consumeSnapshot(src, sourceKey, evidenceRoot(dest), async (frozen, sources) => {
    const sharp = getSharp()
    let input = frozen
    let rotate = null // null: follow EXIF
    if (isRaw(src)) {
      const emb = await embeddedJpeg(frozen)
      if (emb) {
        input = emb.jpeg
        rotate = emb.rotation
      } else {
        const developed = await require('./raw').placeableEvidence(src, path.join(path.dirname(dest), '.develop'))
        if (developed.sourceKey !== sourceKey)
          throw new Error('The original changed before its thumbnail could be made.')
        input = await snapshotFile(developed.file, sources, developed.digest)
      }
    }
    const pipe = sharp(input, { failOn: 'error' })
    const upright = rotate === null ? pipe.rotate() : pipe.rotate(rotate)
    await fs.promises.mkdir(evidenceRoot(dest), { recursive: true })
    const stage = await fs.promises.mkdtemp(path.join(evidenceRoot(dest), '.stage-'))
    const tmp = path.join(stage, 'image.jpg'),
      recordTmp = path.join(stage, 'evidence.json')
    let savedThumb = null,
      savedRecord = null,
      published = false
    try {
      await upright
        .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: QUALITY, mozjpeg: true })
        .toFile(tmp)
      const digest = await fileDigest(tmp)
      await unchangedSource(src, sourceKey, identity)
      if (!sameState(before, await thumbState(src, dest, sourceKey)))
        throw new Error(`The thumbnail ${dest} changed during refresh. Its bytes have been preserved.`)
      // Capture the exact current proxy in a new private history folder, then verify it again.
      // Exclusive publication/restore never overwrites a target that appears during this move.
      if (before.digest || before.record) {
        const historyRoot = path.join(evidenceRoot(dest), 'history')
        await fs.promises.mkdir(historyRoot, { recursive: true })
        const history = await fs.promises.mkdtemp(path.join(historyRoot, 'proxy-'))
        if (before.digest) {
          savedThumb = path.join(history, 'image.jpg')
          await exclusiveRename.renameExclusive(dest, savedThumb)
          if ((await fileDigest(savedThumb)) !== before.digest)
            throw new Error(
              `The thumbnail ${dest} changed during capture. Its bytes have been preserved in ${history}.`,
            )
        }
        if (before.record) {
          savedRecord = path.join(history, 'evidence.json')
          await exclusiveRename.renameExclusive(evidencePath(dest), savedRecord)
          if (JSON.stringify(await readEvidence(savedRecord)) !== JSON.stringify(before.record))
            throw new Error(
              `The thumbnail evidence changed during refresh. Previous files are preserved in ${history}.`,
            )
        }
      }
      await unchangedSource(src, sourceKey, identity)
      await fs.promises.writeFile(
        recordTmp,
        JSON.stringify({ version: 1, source: path.resolve(src), sourceKey, recipe: RECIPE, digest }),
        { flag: 'wx' },
      )
      await publishExclusive(tmp, dest)
      published = true
      await publishExclusive(recordTmp, evidencePath(dest))
      const final = await thumbState(src, dest, sourceKey)
      if (!final.fresh)
        throw new Error(`The thumbnail ${dest} changed during publication. Existing files have been preserved.`)
      await unchangedSource(src, sourceKey, identity)
    } catch (error) {
      if (!published) {
        await restoreExclusive(savedThumb, dest)
        await restoreExclusive(savedRecord, evidencePath(dest))
      }
      throw error
    } finally {
      await fs.promises.unlink(tmp).catch(() => {})
      await fs.promises.unlink(recordTmp).catch(() => {})
      await fs.promises.rmdir(stage).catch(() => {})
    }
  })
}

/**
 * Make the folder's missing thumbnails.
 * @param {string} folder
 * @param {(p: { done: number, total: number, current: string }) => void} [onProgress]
 * @param {{ cancelled?: boolean }} [signal]
 * @returns {Promise<{ made: number, failed: string[] }>}
 */
async function ensureThumbnails(folder, onProgress, signal = {}) {
  const survey = await surveyFolder(folder)
  if (!survey.exists) throw new Error(`The photo folder ${folder} isn't there. The drive may be disconnected.`)
  const todo = survey.missing
  const thumbDir = path.join(folder, THUMB_DIR)
  if (todo.length) await fs.promises.mkdir(thumbDir, { recursive: true })
  let next = 0
  let done = 0
  let made = 0
  const failed = []
  let last = 0
  const report = (current) => {
    const now = Date.now()
    if (onProgress && (now - last > 150 || done === todo.length)) {
      last = now
      onProgress({ done, total: todo.length, current })
    }
  }
  const worker = async () => {
    while (next < todo.length && !signal.cancelled) {
      const name = todo[next++]
      try {
        await makeThumb(path.join(folder, name), path.join(thumbDir, name.replace(/\.[^.]+$/, '') + '.jpg'))
        made++
      } catch (e) {
        failed.push(`${name}: ${e && e.message ? e.message : e}`)
      }
      done++
      report(name)
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, todo.length) }, worker))
  return { made, failed }
}

module.exports = { surveyFolder, ensureThumbnails, makeThumb, THUMB_DIR, MAX_EDGE }
