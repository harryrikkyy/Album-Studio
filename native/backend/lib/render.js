// render.js — render jobs: an album's spreads built into print sheets by PhotoCraft.
//
// One job at a time (PhotoCraft sessions are heavy); spreads render one after another in a single
// session. Progress is pushed as events; the job can be cancelled between sheets. A sheet is
// skipped when nothing that goes into it changed since it was last rendered AND its file is still
// in the output folder (a deleted sheet always renders again).

'use strict'

const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')
const { openAlbum } = require('./album')
const { fileStamp } = require('./cache')
const { inputsHash } = require('./inputs')
const { PhotoCraftSession } = require('./photocraft')
const { recordSheetProof } = require('./proofs')
const { bakeAdjustments } = require('./parity')
const { placeable } = require('./raw')
const { buildSheet, closeAll, outputName, HEADROOM } = require('./sheet')

/** Bump when the way sheets are built changes, so old caches don't hide the change. */
const BUILDER_VERSION = 'photocraft-0.6.0/sheet-1'

let current = null // the running job
let jobSeq = 1

async function readProject(file) {
  return JSON.parse(await fs.promises.readFile(file, 'utf8'))
}

/** Everything that decides how spread `n` looks, as one hash. */
function spreadHash(spread, album, ws) {
  return inputsHash([BUILDER_VERSION, HEADROOM], spread, album, ws)
}

function cachePaths(outputFolder) {
  const dir = path.join(outputFolder, '.album-studio')
  return { dir, file: path.join(dir, 'render-cache.json'), raw: path.join(dir, 'raw'), adjusted: path.join(dir, 'adjusted'), previews: path.join(dir, 'previews') }
}

/**
 * A cache entry: the spread's hash when its sheet was rendered, and the sheet file's size and time
 * then (`sheet`), which tells a sheet saved later from the editor. Older entries are the hash alone.
 */
const entryHash = (e) => (typeof e === 'string' ? e : e && e.hash)
const editedSince = async (e, psd) => !!(e && typeof e === 'object' && e.sheet && e.sheet !== (await fileStamp(psd)))

async function readCache(file) {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')) } catch (_) { return {} }
}

async function writeCache(file, cache) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file + '.tmp', JSON.stringify(cache, null, 1))
  await fs.promises.rename(file + '.tmp', file)
}

function sipsResize(src, dst, maxSide) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sips', ['-Z', String(maxSide), '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', src, '--out', dst],
      (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()))
  })
}

/**
 * What a spread can't carry over, said plainly in the job's report. Template overrides, text,
 * shapes and colour adjustments all reach the sheet; a vignette shows in the preview only, as it
 * did with Photoshop.
 */
function unsupportedEdits(spread, ws) {
  const out = []
  if (spread.photoIds.some((id) => ((ws.imageAdjustments || {})[id] || {}).vignette)) out.push('a vignette shows in the preview only, not in the sheet')
  return out
}

/**
 * Start rendering. Returns at once with the job id; progress arrives as `render.progress`
 * events and the end as `render.finished`.
 * Sheets saved from the editor since they were rendered are kept, unless `overwriteEdited` (the
 * user chose those spreads knowing it replaces their edits).
 * @param {{ album: string, spreads?: number[]|null, force?: boolean, overwriteEdited?: boolean }} p
 * @param {{ emit: (event: string, data: object) => void }} ctx
 */
async function startRender(p, { emit }) {
  if (current) throw new Error(`A render is already running (${current.done + current.skipped + current.failed} of ${current.total} done). Wait for it, or cancel it.`)
  if (!p.album) throw new Error('missing `album`')
  if (require('./deliver').exportStatus().running) throw new Error('Files are being exported. Render when the export has finished.')
  const album = await openAlbum({ path: p.album })
  const data = await readProject(album.file)
  const ws = data.workspace || data
  const outputFolder = ws.outputToken || path.join(album.path, 'exports')
  await fs.promises.mkdir(outputFolder, { recursive: true })
  const wanted = Array.isArray(p.spreads) && p.spreads.length ? new Set(p.spreads.map(Number)) : null
  const spreads = album.spreads.filter((s) => (!wanted || wanted.has(s.n)))
  const job = { id: jobSeq++, total: spreads.length, done: 0, skipped: 0, failed: 0, cancelled: false, startedAt: Date.now(), outputFolder }
  current = job
  emit('render.started', { jobId: job.id, total: job.total, outputFolder, album: album.path })
  void runJob(job, { album, ws, spreads, force: !!p.force, overwriteEdited: !!p.overwriteEdited }, emit).finally(() => { current = null })
  return { jobId: job.id, total: job.total, outputFolder }
}

async function runJob(job, { album, ws, spreads, force, overwriteEdited }, emit) {
  const paths = cachePaths(job.outputFolder)
  const cache = await readCache(paths.file)
  const proofDir = path.join(album.path, 'proofs', 'pages')
  await fs.promises.mkdir(proofDir, { recursive: true })
  await fs.promises.mkdir(paths.previews, { recursive: true })
  let pc = null
  const results = []
  try {
    for (let i = 0; i < spreads.length; i++) {
      if (job.cancelled) break
      const s = spreads[i]
      const name = outputName(s.n)
      const outPsd = path.join(job.outputFolder, `${name}.psd`)
      const report = (state, extra = {}) => emit('render.progress', { jobId: job.id, index: i + 1, total: job.total, n: s.n, state, ...extra })
      const t0 = Date.now()
      try {
        if (!s.template || !s.template.file) throw new Error(s.template ? `the template ${s.template.name} isn't on disk` : 'the spread has no template')
        if (!s.photoIds.length) throw new Error('the spread has no photos')
        const hash = await spreadHash(s, album, ws)
        const exists = await fs.promises.access(outPsd).then(() => true, () => false)
        if (exists && !overwriteEdited && (await editedSince(cache[s.n], outPsd))) {
          // Edited by hand in the editor: never replaced without being asked.
          job.skipped++
          report('skipped', { reason: 'edited' })
          results.push({ n: s.n, state: 'skipped', reason: 'edited' })
          continue
        }
        if (!force && exists && entryHash(cache[s.n]) === hash) {
          job.skipped++
          report('skipped')
          results.push({ n: s.n, state: 'skipped' })
          continue
        }
        report('preparing')
        const photos = []
        const warnings = unsupportedEdits(s, ws)
        for (const id of s.photoIds) {
          const ph = album.photos[id]
          if (!ph) { warnings.push(`a photo of this spread is missing from disk (${id})`); continue }
          if (!ph.original) warnings.push(`${ph.base}: the original isn't in the photo folder; the thumbnail was used`)
          const src = ph.original || ph.thumb
          photos.push({
            file: await bakeAdjustments(await placeable(src, paths.raw), (ws.imageAdjustments || {})[id], paths.adjusted),
            orient: ph.orient === 'v' ? 'v' : 'h',
            name: ph.base,
            edit: { rotation: (ws.imageRotations || {})[id] || 0, ...((ws.imagePlacements || {})[id] || {}) },
          })
        }
        report('building')
        if (!pc) pc = new PhotoCraftSession({ writeRoot: job.outputFolder })
        const preview = path.join(paths.previews, `${name}.jpg`)
        const built = await buildSheet(pc, {
          template: s.template.file,
          photos,
          layerEdits: (ws.pageLayerEdits || {})[s.n] || null,
          overlays: (ws.pageOverlays || {})[s.n] || null,
          outPsd,
          outJpg: preview,
        })
        // The sheet's own render becomes the spread's preview in Plan and Review.
        await sipsResize(preview, path.join(proofDir, `live_page_${String(s.n).padStart(3, '0')}.jpg`), 2400)
        await fs.promises.unlink(preview).catch(() => {})
        await recordSheetProof(album, ws, s, outPsd)
        emit('proofs.updated', { album: album.path, n: s.n, proof: path.join(proofDir, `live_page_${String(s.n).padStart(3, '0')}.jpg`), source: 'sheet' })
        cache[s.n] = { hash, sheet: await fileStamp(outPsd) }
        await writeCache(paths.file, cache)
        job.done++
        const r = { n: s.n, state: 'done', ms: Date.now() - t0, path: outPsd, warnings: [...warnings, ...built.warnings] }
        results.push(r)
        report('done', { ms: r.ms, warnings: r.warnings })
      } catch (e) {
        job.failed++
        const error = e && e.message ? e.message : String(e)
        results.push({ n: s.n, state: 'failed', error })
        report('failed', { error })
        // A dead engine is replaced for the next sheet; a live one is cleaned up.
        if (pc && pc.proc.exitCode !== null) pc = null
        else if (pc) await closeAll(pc)
      }
    }
  } finally {
    if (pc) await pc.close()
    emit('render.finished', {
      jobId: job.id, total: job.total, done: job.done, skipped: job.skipped, failed: job.failed,
      cancelled: job.cancelled, ms: Date.now() - job.startedAt, outputFolder: job.outputFolder, results,
    })
  }
}

/**
 * Each spread's render state without rendering anything: `current` (the sheet exists and nothing
 * changed since), `stale` (it exists but its photos, template or edits changed), `missing` (no
 * sheet yet), or `blocked` (it can't render: no template or no photos, with the reason).
 * `edited`: the sheet was saved from the editor after it was rendered (renders keep it).
 */
async function renderPlan({ album: albumPath }) {
  if (!albumPath) throw new Error('missing `album`')
  const album = await openAlbum({ path: albumPath })
  const data = await readProject(album.file)
  const ws = data.workspace || data
  const outputFolder = ws.outputToken || path.join(album.path, 'exports')
  const cache = await readCache(cachePaths(outputFolder).file)
  const spreads = await Promise.all(album.spreads.map(async (s) => {
    if (!s.template || !s.template.file) return { n: s.n, state: 'blocked', reason: s.template ? 'Template not on disk' : 'No template' }
    if (!s.photoIds.length) return { n: s.n, state: 'blocked', reason: 'No photos' }
    const out = path.join(outputFolder, `${outputName(s.n)}.psd`)
    const exists = await fs.promises.access(out).then(() => true, () => false)
    if (!exists) return { n: s.n, state: 'missing' }
    const hash = await spreadHash(s, album, ws)
    return { n: s.n, state: entryHash(cache[s.n]) === hash ? 'current' : 'stale', edited: await editedSince(cache[s.n], out), unsupported: unsupportedEdits(s, ws) }
  }))
  return { outputFolder, spreads, running: renderStatus() }
}

function cancelRender({ jobId } = {}) {
  if (!current || (jobId && current.id !== jobId)) return { cancelled: false }
  current.cancelled = true
  return { cancelled: true }
}

function renderStatus() {
  return current ? { running: true, jobId: current.id, total: current.total, done: current.done, skipped: current.skipped, failed: current.failed } : { running: false }
}

module.exports = { startRender, cancelRender, renderStatus, renderPlan, spreadHash, unsupportedEdits }
