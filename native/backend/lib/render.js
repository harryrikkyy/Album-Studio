// render.js — render jobs: an album's spreads built into print sheets by PhotoCraft.
//
// One job at a time (PhotoCraft sessions are heavy); spreads render one after another in a single
// session. Progress is pushed as events; the job can be cancelled between sheets. A sheet is
// skipped when nothing that goes into it changed since it was last rendered AND its file is still
// in the output folder (a deleted sheet always renders again).

'use strict'

const { execFile } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { fileStamp, fileDigest, contentKey, snapshotFile } = require('./cache')
const { inputsHash, spreadInputs, hashInputValues } = require('./inputs')
const { publishRender, fingerprintRenderFile } = require('./render_transaction')
const { revisionOf } = require('./project_transaction')
const { PhotoCraftSession } = require('./photocraft')
const { recordSheetProof, proofInputHash } = require('./proofs')
const { bakeAdjustmentsEvidence } = require('./parity')
const { placeableEvidence } = require('./raw')
const { buildSheet, closeAll, outputName, HEADROOM } = require('./sheet')
const { migrateAlbum, withProjectLease } = require('./project')
const { canonicalSheetPath, outputFolder: outputOf, ownedSheetRecord, readRenderCache, readRenderCacheSnapshot, verifiedSheetRecord } = require('./sheets')
const { reserveJob, identifyJob, releaseJob, spreadSelection } = require('./jobs')
const { withProjectOutputs } = require('./output_lock')
const { preflightAlbum } = require('./preflight')
const { printSettings, meetsPrintResolution } = require('./print_settings')

/** Bump when the way sheets are built changes, so old caches don't hide the change. */
const BUILDER_VERSION = 'photocraft-0.6.0/sheet-2-frozen'

let current = null // the running job

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
const editedSince = async (e, psd) => !!(e && typeof e === 'object' && (e.sheetDigest ? e.sheetDigest !== await fileDigest(psd) : e.sheet && e.sheet !== await fileStamp(psd)))

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
  if (!p.album) throw new Error('missing `album`')
  const settings = printSettings(p)
  const lease = await reserveJob('render', p.album)
  try {
    let album = await migrateAlbum({ album: p.album }, { lease: lease.project })
    const projectText = await fs.promises.readFile(album.file, 'utf8')
    const data = JSON.parse(projectText)
    album = await require('./album').openAlbum({ path: album.path }, { data })
    await identifyJob(lease, album)
    const ws = data.workspace || data
    const outputFolder = ws.outputToken || path.join(album.path, 'exports')
    await fs.promises.mkdir(outputFolder, { recursive: true })
    const wanted = spreadSelection(p.spreads, album.spreads)
    const spreads = album.spreads.filter((s) => (!wanted || wanted.has(s.n)))
    const job = { id: lease.id, total: spreads.length, done: 0, skipped: 0, failed: 0, cancelled: false, startedAt: Date.now(), outputFolder }
    current = job
    emit('render.started', { jobId: job.id, total: job.total, outputFolder, album: album.path })
    void (async () => {
      let results = [], error = null
      try { results = await runJob(job, { album, ws, projectText, spreads, settings, lease, force: !!p.force, overwriteEdited: !!p.overwriteEdited }, emit) }
      catch (e) { error = e.message; job.failed = Math.max(1, job.failed) }
      finally {
        if (current === job) current = null
        try { await releaseJob(lease) } catch (e) { error = [error, e.message].filter(Boolean).join(' '); job.failed = Math.max(1, job.failed) }
        emit('render.finished', { jobId: job.id, total: job.total, done: job.done, skipped: job.skipped, failed: job.failed, cancelled: job.cancelled, error, results, ms: Date.now() - job.startedAt, outputFolder })
      }
    })()
    return { jobId: job.id, total: job.total, outputFolder }
  } catch (e) {
    try { await releaseJob(lease) } catch (release) { e.message += ` ${release.message}` }
    throw e
  }
}

async function runJob(job, { album, ws, projectText, spreads, settings, lease, force, overwriteEdited }, emit) {
  await lease.project.assertOwned()
  const paths = cachePaths(job.outputFolder)
  const previous = await readRenderCacheSnapshot(job.outputFolder, { albumFile: album.file })
  let cacheRevision = previous.revision, cache = previous.data.version === 2 ? previous.data : { version: 2, spreads: {} }
  cache.albumFile = album.file
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
      const record = await ownedSheetRecord(ws, album.path, s.id, cache)
      const existingPath = record && record.path
      const outPsd = canonicalSheetPath(job.outputFolder, s.id)
      const report = (state, extra = {}) => emit('render.progress', { jobId: job.id, index: i + 1, total: job.total, n: s.n, state, ...extra })
      const t0 = Date.now()
      const stagedPsd = `${outPsd}.${crypto.randomUUID()}.part.psd`
      const preview = path.join(paths.previews, `${name}-${crypto.randomUUID()}.jpg`)
      const stagedProof = `${stagedPsd}.proof.jpg`
      let sourceStage = null, preserveSources = false, publication = null
      const privateFiles = new Map()
      try {
        await lease.project.assertOwned()
        if (!s.template || !s.template.file) throw new Error(s.template ? `the template ${s.template.name} isn't on disk` : 'the spread has no template')
        if (!s.photoIds.length) throw new Error('the spread has no photos')
        const exists = existingPath && await fs.promises.access(existingPath).then(() => true, () => false)
        if (exists && !overwriteEdited && (!verifiedSheetRecord(record) || await editedSince(record, existingPath))) {
          // Edited by hand in the editor: never replaced without being asked.
          job.skipped++
          report('skipped', { reason: 'edited' })
          results.push({ n: s.n, state: 'skipped', reason: 'edited' })
          continue
        }
        const inputValues = await spreadInputs(s, album, ws)
        const hash = hashInputValues([BUILDER_VERSION, HEADROOM], inputValues)
        if (!force && exists && entryHash(record) === hash && await meetsPrintResolution(existingPath, settings)) {
          job.skipped++
          report('skipped')
          results.push({ n: s.n, state: 'skipped' })
          continue
        }
        report('preparing')
        const preflight = await preflightAlbum(album, ws, { ...settings, phase: 'render' }, [s.n])
        if (preflight.errors.length) throw new Error(preflight.errors.map((e) => e.message).join(' '))
        const sheetBefore = await fingerprintRenderFile(outPsd)
        if (sheetBefore && existingPath !== outPsd) throw new Error(`An unowned sheet exists at ${outPsd}. Preserve it before rendering.`)
        await fs.promises.mkdir(path.dirname(outPsd), { recursive: true })
        sourceStage = await fs.promises.mkdtemp(path.join(paths.dir, 'render-sources-'))
        const template = await snapshotFile(s.template.file, sourceStage, inputValues[1])
        privateFiles.set(template, inputValues[1])
        const photos = []
        const warnings = unsupportedEdits(s, ws)
        for (const id of s.photoIds) {
          const ph = album.photos[id]
          if (!ph || !ph.original) throw new Error(`The original photo ${id} is missing; thumbnails cannot be rendered for print.`)
          const src = ph.original
          const expectedSource = inputValues[2].find((v) => v[0] === id)[2]
          const developed = await placeableEvidence(src, paths.raw)
          if (developed.sourceKey !== contentKey(src, expectedSource)) throw new Error('The original changed before its render snapshot was made.')
          const adjusted = await bakeAdjustmentsEvidence(developed.file, (ws.imageAdjustments || {})[id], paths.adjusted)
          if (adjusted.sourceKey !== contentKey(developed.file, developed.digest)) throw new Error('The developed image changed before its adjustment snapshot was made.')
          const frozen = await snapshotFile(adjusted.file, sourceStage, adjusted.digest)
          privateFiles.set(frozen, adjusted.digest)
          photos.push({
            file: frozen, digest: adjusted.digest,
            orient: ph.orient === 'v' ? 'v' : 'h',
            name: ph.base,
            edit: { rotation: (ws.imageRotations || {})[id] || 0, ...((ws.imagePlacements || {})[id] || {}) },
          })
        }
        report('building')
        if (!pc) pc = new PhotoCraftSession({ writeRoot: job.outputFolder })
        const built = await buildSheet(pc, {
          template,
          photos,
          layerEdits: (ws.pageLayerEdits || {})[s.n] || null,
          overlays: (ws.pageOverlays || {})[s.n] || null,
          outPsd: stagedPsd,
          outJpg: preview,
          printSettings: settings,
        })
        if (built.warnings.length) throw new Error(`Sheet construction left edits or photos unapplied: ${built.warnings.join('; ')}`)
        const stagedDigest = await fileDigest(stagedPsd)
        privateFiles.set(stagedPsd, stagedDigest)
        privateFiles.set(preview, await fileDigest(preview))
        const validateSnapshot = async () => {
          if (await fs.promises.readFile(album.file, 'utf8') !== projectText || await spreadHash(s, album, ws) !== hash) throw new Error('The project or source files changed during rendering. Retry from the current revision.')
          if ((await Promise.all([...privateFiles].filter(([file]) => file !== stagedPsd).map(async ([file, expected]) => await fileDigest(file) === expected))).some(ok => !ok)) {
            preserveSources = true
            throw new Error(`A private render source changed during construction. Preserve ${sourceStage} before retrying.`)
          }
        }
        const cacheNext = { ...cache, spreads: { ...cache.spreads, [s.id]: { path: outPsd, outputFolder: job.outputFolder, hash, settings, resolutionEvidence: preflight.info.filter(e => e.code === 'effective_ppi') } } }
        const committedWarnings = []
        try {
          publication = await publishRender({ albumFile: album.file, outputFolder: job.outputFolder, spreadId: s.id, source: stagedPsd, sourceDigest: stagedDigest,
            sheetBefore, cacheBefore: cacheRevision, cacheNext, expectedProjectRevision: revisionOf(projectText) }, {
            assertOwned: () => lease.project.assertOwned(), assertOutput: requested => lease.project.outputNamespace.assertFor(requested),
            isCancelled: () => job.cancelled, validateSnapshot,
          })
        } catch (error) {
          if (!error.renderCommitted || !error.cache || !error.cacheRevision || !error.sheetRecord || error.sheetRecord.path !== outPsd) throw error
          publication = error
          committedWarnings.push(`The print sheet and ownership record were committed. Recovery history needs review: ${error.message}`)
        }
        cache = publication.cache; cacheRevision = publication.cacheRevision
        // Proofs are derived. A failure after durable commit must report the saved sheet,
        // rather than claim that the render failed or that the old pair was restored.
        try {
          await sipsResize(preview, stagedProof, 2400)
          privateFiles.set(stagedProof, await fileDigest(stagedProof))
          await recordSheetProof(album, ws, s, outPsd, { proof: stagedProof, expectedHash: proofInputHash(inputValues), projectText, lease: lease.project })
          emit('proofs.updated', { album: album.path, n: s.n, proof: path.join(proofDir, `live_page_${String(s.n).padStart(3, '0')}.jpg`), source: 'sheet' })
        } catch (error) { committedWarnings.push(`The print sheet is saved, but its preview could not be refreshed: ${error.message} Refresh previews after resolving this problem.`) }
        job.done++
        const r = { n: s.n, state: 'done', committed: true, ms: Date.now() - t0, path: outPsd, warnings: [...warnings, ...built.warnings, ...committedWarnings] }
        results.push(r)
        report('done', { ms: r.ms, warnings: r.warnings })
      } catch (e) {
        if (e.recoveryStage || e.snapshotPath || e.retainedPath) preserveSources = true
        if (e.code === 'RENDER_CANCELLED') {
          results.push({ n: s.n, state: 'cancelled', reason: 'stopped before commit' })
          report('cancelled', { reason: 'stopped before commit' })
          break
        }
        job.failed++
        const error = e && e.message ? e.message : String(e)
        results.push({ n: s.n, state: 'failed', error })
        report('failed', { error })
        // A dead engine is replaced for the next sheet; a live one is cleaned up.
        if (pc && pc.proc.exitCode !== null) pc = null
        else if (pc) await closeAll(pc)
      } finally {
        // Remove only unchanged files recorded as ours. An unexpected private entry or
        // modified snapshot remains available for review, alongside transaction history.
        for (const [file, expected] of privateFiles) {
          try { if (!preserveSources && await fileDigest(file) === expected) await fs.promises.unlink(file) } catch (error) { if (error.code !== 'ENOENT') preserveSources = true }
        }
        if (sourceStage && !preserveSources) await fs.promises.rmdir(sourceStage).catch(() => {})
      }
    }
  } finally {
    if (pc) await pc.close()
  }
  return results
}

/**
 * Each spread's render state without rendering anything: `current` (the sheet exists and nothing
 * changed since), `stale` (it exists but its photos, template or edits changed), `missing` (no
 * sheet yet), or `blocked` (it can't render: no template or no photos, with the reason).
 * `edited`: the sheet was saved from the editor after it was rendered (renders keep it).
 */
async function renderPlan({ album: albumPath, ...p }) {
  if (!albumPath) throw new Error('missing `album`')
  return withProjectLease(albumPath, async ({ lease }) => withProjectOutputs(lease, async () => {
  const album = await migrateAlbum({ album: albumPath }, { lease })
  const settings = printSettings(p)
  const data = await readProject(album.file)
  const ws = data.workspace || data
  const outputFolder = outputOf(ws, album.path)
  await lease.outputNamespace.assertFor(outputFolder)
  const cache = await readRenderCache(outputFolder, { albumFile: album.file })
  const spreads = await Promise.all(album.spreads.map(async (s) => {
    if (!s.template || !s.template.file) return { n: s.n, state: 'blocked', reason: s.template ? 'Template not on disk' : 'No template' }
    if (!s.photoIds.length) return { n: s.n, state: 'blocked', reason: 'No photos' }
    const record = await ownedSheetRecord(ws, album.path, s.id, cache)
    const out = record && record.path
    if (!out) return { n: s.n, id: s.id, state: 'missing' }
    const exists = await fs.promises.access(out).then(() => true, () => false)
    if (!exists) return { n: s.n, state: 'missing' }
    const hash = await spreadHash(s, album, ws)
    const resolutionReady = await meetsPrintResolution(out, settings)
    const verified = verifiedSheetRecord(record)
    return { n: s.n, id: s.id, state: verified && entryHash(record) === hash && resolutionReady ? 'current' : 'stale', reason: !verified ? 'This older sheet has no verified content history. Preserve manual work before explicitly rendering a replacement.' : resolutionReady ? undefined : 'Render at the configured print resolution', edited: !verified || await editedSince(record, out), unverified: !verified, unsupported: unsupportedEdits(s, ws) }
  }))
  return { outputFolder, spreads, running: renderStatus() }
  }, { kind: 'render-plan' }), { kind: 'render-plan' })
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
