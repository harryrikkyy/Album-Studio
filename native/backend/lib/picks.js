// picks.js — Tools › Best picks: every photo of a shoot scored for sharpness, exposure and
// near-duplicates by the Electron app's curation engine (src/curation.js). It works at 32 × 32
// pixels, so the 400 px thumbnails give the same scores as the originals, quickly and for RAW
// files too; folders without thumbnails get them first. Scores are cached per folder until it
// changes. Choosing the picks (thresholds, duplicates) happens in the interface, live.

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { cacheRoot, fileDigest } = require('./cache')
const { ensureThumbnails, surveyFolder } = require('./thumbs')
const { readEvidence, publishExclusive, sourceIdentity } = require('./raw')

const VERSION = 3
const curation = () => require('../../../src/curation')
const sameIdentity = (a, b) =>
  a && b && ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key])
async function unchangedCopy(photo) {
  return (
    sameIdentity(photo.identity, await sourceIdentity(photo.file)) &&
    (await fileDigest(photo.file)) === photo.digest &&
    sameIdentity(photo.identity, await sourceIdentity(photo.file))
  )
}

async function thumbnailEvidence(folder) {
  const survey = await surveyFolder(folder, { includeEvidence: true })
  if (!survey.exists || survey.missing.length)
    throw new Error(
      `The photo previews in ${folder} changed or could not be verified. Refresh them and resolve any edited preview before scoring.`,
    )
  const photos = survey.evidence.sort((a, b) => a.thumb.localeCompare(b.thumb))
  const key = crypto
    .createHash('sha256')
    .update(JSON.stringify([path.resolve(folder), VERSION, photos]))
    .digest('hex')
  return { photos, key }
}
async function unchangedThumbnails(folder, expected) {
  if ((await thumbnailEvidence(folder)).key !== expected)
    throw new Error(`The originals or previews in ${folder} changed during scoring. Retry after they stop changing.`)
}
async function cachedScores(file, key) {
  const record = await readEvidence(`${file}.evidence`)
  const present = await fs.promises.lstat(file).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
  if (!present && !record) return null
  if (
    !present ||
    !record ||
    record.version !== VERSION ||
    record.key !== key ||
    !/^[a-f0-9]{64}$/.test(record.digest) ||
    (await fileDigest(file)) !== record.digest
  )
    throw new Error(
      `The photo-score cache ${file} was edited or cannot be verified. Its bytes have been preserved; rebuild in a new cache folder.`,
    )
  const scores = await readEvidence(file, 64 * 1024 * 1024)
  if (!Array.isArray(scores) || (await fileDigest(file)) !== record.digest)
    throw new Error(`The photo-score cache ${file} changed while it was read. Its bytes have been preserved.`)
  return scores
}
async function scoreThumbnails(folder, snapshot, cacheFile, progress) {
  await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true })
  const stage = await fs.promises.mkdtemp(path.join(path.dirname(cacheFile), '.score-'))
  const photoDir = path.join(stage, 'photos'),
    scoresFile = path.join(stage, 'scores.json'),
    metaFile = path.join(stage, 'evidence.json')
  const copied = []
  let preserveCopies = false
  await fs.promises.mkdir(photoDir)
  try {
    const originals = new Map()
    for (const photo of snapshot.photos) {
      const file = path.join(photoDir, path.basename(photo.thumb))
      await fs.promises.copyFile(photo.thumb, file, fs.constants.COPYFILE_EXCL)
      await fs.promises.chmod(file, 0o400)
      if ((await fs.promises.lstat(file)).mode & 0o222)
        throw new Error(
          'The scoring snapshot cannot be protected on this filesystem. Use a volume with file-permission support.',
        )
      const copy = { file, digest: photo.digest, identity: await sourceIdentity(file) }
      copied.push(copy)
      if ((await fileDigest(file)) !== photo.digest || (await fileDigest(photo.thumb)) !== photo.digest)
        throw new Error(`The preview ${photo.thumb} changed while its scoring snapshot was made.`)
      if (!(await unchangedCopy(copy)))
        throw new Error(
          `The scoring snapshot ${file} changed while it was verified. Its unexpected bytes have been preserved.`,
        )
      originals.set(file, photo.thumb)
    }
    await unchangedThumbnails(folder, snapshot.key)
    let features
    try {
      features = await curation().analyzeFolder(photoDir, (p) =>
        progress({ ...p, file: originals.get(p.file) || p.file }),
      )
    } catch (error) {
      preserveCopies = true
      throw new Error(
        `The scoring snapshot could not be analysed safely; its private files have been preserved. ${error.message}`,
        { cause: error },
      )
    }
    for (const photo of copied)
      if (!(await unchangedCopy(photo)))
        throw new Error(
          `The scoring snapshot ${photo.file} changed during analysis. Its unexpected bytes have been preserved.`,
        )
    const scores = features.map((f) => ({
      thumb: originals.get(f.filePath),
      base: f.baseName,
      folder,
      orient: f.orient === 'v' ? 'v' : 'h',
      sharpness: Math.round(f.sharpness * 10) / 10,
      exposure: Math.round(f.exposureScore * 1000) / 1000,
      blackPct: Math.round(f.blackPct * 1000) / 1000,
      whitePct: Math.round(f.whitePct * 1000) / 1000,
      hash: f.pHash,
      ...(f.error ? { error: f.error } : {}),
    }))
    await unchangedThumbnails(folder, snapshot.key)
    await fs.promises.writeFile(scoresFile, JSON.stringify(scores), { flag: 'wx' })
    const digest = await fileDigest(scoresFile)
    await fs.promises.writeFile(metaFile, JSON.stringify({ version: VERSION, key: snapshot.key, digest }), {
      flag: 'wx',
    })
    await unchangedThumbnails(folder, snapshot.key)
    try {
      await publishExclusive(scoresFile, cacheFile)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const concurrent = await cachedScores(cacheFile, snapshot.key)
      if (concurrent) return concurrent
      throw error
    }
    await publishExclusive(metaFile, `${cacheFile}.evidence`)
    return scores
  } finally {
    // Only delete this invocation's known, still-identical snapshot files. Unexpected edits
    // or additions in a private staging folder remain available for recovery.
    for (const photo of copied)
      if (!preserveCopies && (await unchangedCopy(photo).catch(() => false)))
        await fs.promises.unlink(photo.file).catch(() => {})
    await fs.promises.unlink(scoresFile).catch(() => {})
    await fs.promises.unlink(metaFile).catch(() => {})
    await fs.promises.rmdir(photoDir).catch(() => {})
    await fs.promises.rmdir(stage).catch(() => {})
  }
}

/**
 * Scores for the photos of `folders`.
 * @returns {Promise<{ photos: { thumb: string, base: string, folder: string, orient: 'h'|'v', sharpness: number, exposure: number, blackPct: number, whitePct: number, hash: string, error?: string }[] }>}
 */
async function analyzePhotos({ folders }, { emit }) {
  if (!Array.isArray(folders) || !folders.length) throw new Error('Choose a folder of photos.')
  const out = []
  for (let i = 0; i < folders.length; i++) {
    const folder = folders[i]
    const label = path.basename(folder)
    const survey = await surveyFolder(folder)
    if (!survey.exists) throw new Error(`The folder ${folder} isn’t there. The drive may be disconnected.`)
    if (survey.missing.length) {
      const result = await ensureThumbnails(folder, (p) =>
        emit('picks.progress', { stage: 'thumbs', folder: label, index: i + 1, folders: folders.length, ...p }),
      )
      if (result.failed.length)
        throw new Error(
          `Photo previews could not be refreshed. Resolve these preserved thumbnails before scoring: ${result.failed.join('; ')}`,
        )
    }
    const snapshot = await thumbnailEvidence(folder)
    const cacheFile = path.join(cacheRoot(), 'picks', `contents-${snapshot.key}-v${VERSION}.json`)
    let scored = await cachedScores(cacheFile, snapshot.key)
    if (!scored) {
      scored = await scoreThumbnails(folder, snapshot, cacheFile, (p) =>
        emit('picks.progress', {
          stage: 'score',
          folder: label,
          index: i + 1,
          folders: folders.length,
          done: p.done,
          total: p.total,
        }),
      )
    }
    await unchangedThumbnails(folder, snapshot.key)
    out.push(...scored)
  }
  return { photos: out }
}

/**
 * Copy the picked photos' originals (every file with the photo's name: a RAW and its JPEG travel
 * together) into a `_Selected` folder inside each photo's own folder, as the Electron app did.
 */
async function copyPicks({ picks }) {
  if (!Array.isArray(picks) || !picks.length) throw new Error('No photos are picked.')
  const byFolder = new Map()
  for (const p of picks) {
    if (!byFolder.has(p.folder)) byFolder.set(p.folder, new Set())
    byFolder.get(p.folder).add(p.base.toLowerCase())
  }
  const result = []
  for (const [folder, bases] of byFolder) {
    const dest = path.join(folder, '_Selected')
    await fs.promises.mkdir(dest, { recursive: true })
    let copied = 0
    let skipped = 0
    for (const e of await fs.promises.readdir(folder, { withFileTypes: true })) {
      if (!e.isFile() || e.name.startsWith('.')) continue
      if (!bases.has(e.name.replace(/\.[^.]+$/, '').toLowerCase())) continue
      const target = path.join(dest, e.name)
      if (
        await fs.promises.access(target).then(
          () => true,
          () => false,
        )
      ) {
        skipped++
        continue
      }
      await fs.promises.copyFile(path.join(folder, e.name), target, fs.constants.COPYFILE_FICLONE)
      copied++
    }
    result.push({ folder, dest, copied, skipped })
  }
  return {
    folders: result,
    copied: result.reduce((n, r) => n + r.copied, 0),
    skipped: result.reduce((n, r) => n + r.skipped, 0),
  }
}

module.exports = { analyzePhotos, copyPicks }
