// picks.js — Tools › Best picks: every photo of a shoot scored for sharpness, exposure and
// near-duplicates by the Electron app's curation engine (src/curation.js). It works at 32 × 32
// pixels, so the 400 px thumbnails give the same scores as the originals, quickly and for RAW
// files too; folders without thumbnails get them first. Scores are cached per folder until it
// changes. Choosing the picks (thresholds, duplicates) happens in the interface, live.

'use strict'

const fs = require('fs')
const path = require('path')
const { cacheRoot, fileKey, writeAtomic } = require('./cache')
const { ensureThumbnails, surveyFolder } = require('./thumbs')

const VERSION = 1
const curation = () => require('../../../src/curation')

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
      await ensureThumbnails(folder, (p) => emit('picks.progress', { stage: 'thumbs', folder: label, index: i + 1, folders: folders.length, ...p }))
    }
    const thumbDir = path.join(folder, '_Thumbnails')
    const st = await fs.promises.stat(thumbDir)
    const cacheFile = path.join(cacheRoot(), 'picks', `${fileKey(thumbDir, st)}-v${VERSION}.json`)
    let scored = null
    try { scored = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8')) } catch (_) { /* not scored yet */ }
    if (!scored) {
      const features = await curation().analyzeFolder(thumbDir, (p) => emit('picks.progress', { stage: 'score', folder: label, index: i + 1, folders: folders.length, done: p.done, total: p.total }))
      scored = features.map((f) => ({
        thumb: f.filePath,
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
      await writeAtomic(cacheFile, JSON.stringify(scored))
    }
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
      if (await fs.promises.access(target).then(() => true, () => false)) { skipped++; continue }
      await fs.promises.copyFile(path.join(folder, e.name), target, fs.constants.COPYFILE_FICLONE)
      copied++
    }
    result.push({ folder, dest, copied, skipped })
  }
  return { folders: result, copied: result.reduce((n, r) => n + r.copied, 0), skipped: result.reduce((n, r) => n + r.skipped, 0) }
}

module.exports = { analyzePhotos, copyPicks }
