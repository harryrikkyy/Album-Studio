// deliver.js — files for the lab and the client, made from the rendered print sheets (no
// Photoshop), with the Electron app's folder layout and names (next to the sheets' folder):
//   JPEG-High-Res/Page_NNN.jpg   print JPEGs: the print height at the print resolution (12 in at
//                                300 ppi = 3600 px tall by default), best quality, sRGB, ppi set
//   JPEG-Low-Res/Page_NNN.jpg    the same pages as small files, for review
//   "<Album> - Low Res.pdf"      the low-res pages as one PDF, for the client
//
// A sheet's pixels come from the flattened image PhotoCraft (or Photoshop) stores in the PSD; a
// PSD without one is opened and exported by the PhotoCraft engine instead. JPEGs already made from
// the same sheet with the same settings are kept. One export runs at a time, between sheets it
// can be stopped; progress arrives as `export.*` events.

'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { migrateAlbum, withProjectLease } = require('./project')
const { fileStamp, fileDigest, readVerifiedBuffer } = require('./cache')
const { createPrivateStage, withPrivateStage } = require('./private_stage')
const exclusive = require('./exclusive_rename')
const { writeJpegPdf } = require('./pdf')
const { outputName } = require('./sheet')
const { psdPixels } = require('./color')
const { spreadHash, renderInputHash } = require('./render_inputs')
const { spreadInputs } = require('./inputs')
const { outputFolder, ownedSheetRecord, readRenderCache, verifiedSheetRecord } = require('./sheets')
const { reserveJob, identifyJob, releaseJob, spreadSelection } = require('./jobs')
const { withProjectOutputs } = require('./output_lock')
const { preflightAlbum } = require('./preflight')
const { printSettings, psdDimensions, validateSheetPrint } = require('./print_settings')
const { publishDelivery, recoverDeliveries, verifyOwnedArtifact } = require('./delivery_transaction')

const EXPORT_VERSION = 'export-3-frozen-and-scans'
const DEFAULTS = { heightInches: 12, ppi: 300, highQuality: 97, lowQuality: 25 }

const getSharp = () => require('../../../src/sharp_config').getSharp()

let current = null

/** Where everything goes, for an album whose sheets are in `outputFolder`. */
function deliverPaths(album, outputFolder) {
  const parent = path.dirname(outputFolder)
  return {
    sheets: outputFolder,
    high: path.join(parent, 'JPEG-High-Res'),
    low: path.join(parent, 'JPEG-Low-Res'),
    pdf: path.join(parent, `${album.name} - Low Res.pdf`),
    cache: path.join(outputFolder, '.album-studio', 'export-cache.json'),
  }
}

function settingsOf(p) {
  const s = { ...DEFAULTS, ...printSettings(p, 'print') }
  for (const k of ['highQuality', 'lowQuality'])
    if (p[k] !== undefined) {
      if (typeof p[k] !== 'number' || !Number.isFinite(p[k]) || p[k] <= 0 || p[k] > 100)
        throw new Error('JPEG quality must be a finite positive number up to 100.')
      s[k] = p[k]
    }
  return s
}

/**
 * The sheet's flattened pixels: the composite stored in the PSD, or, when it has none, the
 * engine's own export of it.
 * @returns {Promise<{ input: Buffer | string, raw?: { width: number, height: number, channels: 4 }, width: number, height: number, cleanup?: () => Promise<void> }>}
 */
async function sheetPixels(psdPath, options) {
  return psdPixels(psdPath, options)
}

/** Write the print and/or review JPEGs of one sheet. */
async function exportSheet(psdPath, targets, s, guard) {
  const sharp = getSharp()
  const buffer = guard ? await readVerifiedBuffer(psdPath, guard.expectedDigest) : undefined
  const px = await sheetPixels(psdPath, buffer ? { buffer } : undefined)
  let result, failure
  try {
    if (guard) validateSheetPrint(px, s, guard.spec, guard.n)
    const height = s.size === 'print' ? Math.round(s.heightInches * s.ppi) : px.height
    const width = Math.round((px.width * height) / px.height)
    // Resample once, then encode every target from the same pixels, side by side.
    let p = sharp(px.input, { ...(px.raw ? { raw: px.raw } : {}), failOn: 'warning' })
    // Convert while source ICC metadata is still attached, before extracting raw pixels.
    p = p.withIccProfile('srgb')
    p = p.flatten({ background: '#ffffff' })
    if (width !== px.width || height !== px.height) p = p.resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    const pixels = await p.removeAlpha().raw().toBuffer({ resolveWithObject: true })
    // Wait for every encoder before the caller may retire or hand off its stage.
    const encoded = await Promise.allSettled(
      targets.map(async (t) =>
        withPrivateStage(path.dirname(t.file), '.jpeg-encode-', async (stage) => {
          const tmp = path.join(stage.path, 'encoded.jpg')
          await stage.reserveBytes(pixels.data.length)
          await sharp(pixels.data, {
            raw: { width: pixels.info.width, height: pixels.info.height, channels: pixels.info.channels },
          })
            .withIccProfile('srgb')
            .withMetadata({ density: s.ppi })
            // Print files: full colour resolution, the standard encoder (12× faster than mozjpeg at
            // this size for 4% more bytes). Review files: mozjpeg, a third smaller for the PDF.
            .jpeg(
              t.quality >= 90
                ? { quality: t.quality, chromaSubsampling: '4:4:4', optimiseCoding: true }
                : { quality: t.quality, mozjpeg: true },
            )
            .toFile(tmp)
          await stage.register(tmp)
          await exclusive.renameExclusive(tmp, t.file)
          stage.forget(tmp)
        }),
      ),
    )
    const errors = encoded.filter((item) => item.status === 'rejected').map((item) => item.reason)
    if (errors.length) {
      const first = errors[0]
      first.encoderErrors = errors.slice(1)
      throw first
    }
    result = { width, height }
  } catch (error) {
    failure = error
  }
  try {
    if (px.cleanup) await px.cleanup()
  } catch (cleanup) {
    if (failure) {
      failure.cleanupError = cleanup
      failure.message += ` Colour decoder cleanup also failed: ${cleanup.message}`
    } else failure = cleanup
  }
  if (failure) throw failure
  return result
}

/**
 * What an export would do, per spread: `ready` (its JPEGs are made from the current sheet),
 * `todo` (to make), `stale` (the sheet changed since its JPEGs were made), or `nosheet`.
 */
async function exportPlan({ album: albumPath, ...p }) {
  if (!albumPath) throw new Error('missing `album`')
  return withProjectLease(
    albumPath,
    async ({ lease }) =>
      withProjectOutputs(lease, async () => (await prepareExport({ album: albumPath, ...p }, lease)).plan, {
        kind: 'export-plan',
        delivery: true,
      }),
    { kind: 'export-plan' },
  )
}

async function prepareExport(p, lease) {
  const album = await migrateAlbum({ album: p.album }, { lease })
  const projectText = await fs.promises.readFile(album.file, 'utf8')
  const data = JSON.parse(projectText),
    ws = data.workspace || data
  const paths = deliverPaths(album, outputFolder(ws, album.path))
  await lease.outputNamespace.assertFor(paths.sheets, true)
  const s = settingsOf(p)
  const sheetsExist = await fs.promises.lstat(paths.sheets).then(
    () => true,
    (e) => {
      if (e.code === 'ENOENT') return false
      throw e
    },
  )
  if (sheetsExist) await recoverDeliveries(paths, { albumFile: album.file })
  const old = await readJson(paths.cache)
  const cache =
    old.version === 2 && old.albumFile === album.file ? old : { version: 2, albumFile: album.file, spreads: {} }
  const rendered = await readRenderCache(paths.sheets, { albumFile: album.file })
  const expectedInputs = new Map()
  const spreads = await Promise.all(
    album.spreads.map(async (sp) => {
      const name = outputName(sp.n)
      const record = await ownedSheetRecord(ws, album.path, sp.id, rendered)
      const psd = record && record.path
      const stamp = psd ? await fileStamp(psd) : 'missing'
      const base = { n: sp.n, id: sp.id, psd, stamp }
      if (stamp === 'missing')
        return { ...base, state: 'nosheet', reason: `Spread ${sp.n} is not rendered. Render the album first.` }
      const inputValues = await spreadInputs(sp, album, ws)
      expectedInputs.set(sp.n, inputValues)
      const hash = renderInputHash(inputValues)
      if (!verifiedSheetRecord(record) || record.hash !== hash)
        return {
          ...base,
          hash,
          state: 'blocked',
          reason: `Spread ${sp.n} has changed or its sheet has no verified content history. Render this spread before delivery; preserve any manual edits first.`,
        }
      const sheetDigest = await fileDigest(psd)
      let dimensions
      try {
        dimensions = await psdDimensions(psd, sheetDigest)
      } catch (error) {
        return {
          ...base,
          hash,
          state: 'blocked',
          reason: `Spread ${sp.n}'s sheet dimensions could not be verified from its current revision: ${error.message}`,
        }
      }
      try {
        validateSheetPrint(dimensions, s, ws.printSpec, sp.n)
      } catch (error) {
        return { ...base, hash, state: 'blocked', reason: error.message }
      }
      const key = exportKey(sheetDigest, s)
      const high = path.join(paths.high, `${name}.jpg`),
        low = path.join(paths.low, `${name}.jpg`)
      const e = cache.spreads[sp.id]
      const fresh =
        e &&
        e.key === key &&
        e.hash === hash &&
        e.psd === psd &&
        e.n === sp.n &&
        e.high &&
        e.high.path === high &&
        (await verifyOwnedArtifact(high, e.high.stamp, e.high.digest)) &&
        e.low &&
        e.low.path === low &&
        (await verifyOwnedArtifact(low, e.low.stamp, e.low.digest))
      return { ...base, sheetDigest, hash, key, high, low, state: fresh ? 'ready' : e ? 'stale' : 'todo' }
    }),
  )
  const preflight = await preflightAlbum(album, ws, { ...s, phase: 'export' }, null, expectedInputs)
  for (const sp of spreads) {
    const failures = preflight.errors.filter((e) => e.n === undefined || e.n === sp.n)
    if (failures.length && sp.state !== 'nosheet') {
      sp.state = 'blocked'
      sp.reason = failures.map((e) => e.message).join(' ')
    }
  }
  const pdf = await fs.promises.stat(paths.pdf).catch(() => null)
  return {
    album,
    ws,
    projectText,
    cache,
    plan: {
      paths,
      settings: s,
      spreads,
      preflight,
      pdf: pdf ? { path: paths.pdf, bytes: pdf.size, at: pdf.mtime.toISOString() } : null,
      running: exportStatus(),
    },
  }
}

function exportKey(stamp, s) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify([EXPORT_VERSION, stamp, s.size, s.heightInches, s.ppi, s.highQuality, s.lowQuality]))
    .digest('hex')
    .slice(0, 16)
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'))
  } catch (_) {
    return {}
  }
}

/**
 * Export. Returns at once; progress comes as `export.progress`, the end as `export.finished`.
 * `jpegs`: make the print and review JPEGs (always together, so the PDF matches the print files);
 * `pdf`: the client PDF from the review JPEGs.
 * @param {{ album: string, spreads?: number[]|null, jpegs?: boolean, pdf?: boolean,
 *   force?: boolean, size?: 'print'|'original', heightInches?: number, ppi?: number }} p
 */
async function startExport(p, { emit }) {
  if (!p.album) throw new Error('missing `album`')
  const lease = await reserveJob('export', p.album)
  try {
    const want = { jpegs: p.jpegs !== false, pdf: p.pdf !== false }
    if (!want.jpegs && !want.pdf) throw new Error('Choose at least one kind of file to export.')
    const prepared = await prepareExport(p, lease.project)
    await identifyJob(lease, prepared.album)
    const { plan } = prepared,
      { paths, settings: s } = plan
    const wanted = spreadSelection(p.spreads, plan.spreads)
    const spreads = want.jpegs ? plan.spreads.filter((sp) => !wanted || wanted.has(sp.n)) : []
    const required = want.pdf ? plan.spreads : spreads
    if (!required.length) throw new Error('No spread has a rendered sheet yet. Render the album first.')
    for (const sp of required) {
      if (sp.state === 'nosheet' || sp.state === 'blocked') throw new Error(sp.reason)
      if (want.pdf && (!want.jpegs || (wanted && !wanted.has(sp.n))) && sp.state !== 'ready') {
        throw new Error(`Spread ${sp.n}'s review JPEG is stale or missing. Export its JPEGs before making the PDF.`)
      }
    }
    const missingSheets = plan.spreads.filter((sp) => sp.state === 'nosheet').map((sp) => sp.n)
    const job = {
      id: lease.id,
      total: spreads.length,
      done: 0,
      skipped: 0,
      failed: 0,
      cancelled: false,
      startedAt: Date.now(),
      finishingErrors: [],
    }
    current = job
    emit('export.started', { jobId: job.id, total: job.total, paths, missingSheets })
    // runExport catches failures and releases the lease before its completion event.
    void runExport(job, { ...prepared, p, spreads, want, s, paths, missingSheets, lease }, emit)
    return { jobId: job.id, total: job.total, paths, missingSheets }
  } catch (e) {
    try {
      await releaseJob(lease)
    } catch (release) {
      e.message += ` ${release.message}`
    }
    throw e
  }
}

async function assertSnapshot({ album, ws, projectText }, required) {
  if ((await fs.promises.readFile(album.file, 'utf8')) !== projectText)
    throw new Error('The album changed during export. Export again from the current revision.')
  for (const sp of required) {
    const model = album.spreads.find((item) => item.id === sp.id)
    if (!model || (await spreadHash(model, album, ws)) !== sp.hash || (await fileDigest(sp.psd)) !== sp.sheetDigest) {
      throw new Error(`Spread ${sp.n} or its source files changed during export. Render or export again.`)
    }
  }
}

async function runExport(job, prepared, emit) {
  const { p, plan, cache, spreads, want, s, paths, missingSheets, lease } = prepared
  const next = JSON.parse(JSON.stringify(cache))
  const results = []
  let pdfResult = null,
    stage = null,
    stageCapability = null,
    transactionOwnsStage = false,
    error = null
  const files = [],
    review = new Map(plan.spreads.filter((sp) => sp.state === 'ready').map((sp) => [sp.id, sp.low]))
  try {
    await fs.promises.mkdir(path.join(paths.sheets, '.album-studio'), { recursive: true })
    stageCapability = await createPrivateStage(path.join(paths.sheets, '.album-studio'), 'delivery-')
    stage = stageCapability.path
    for (let i = 0; i < spreads.length; i++) {
      if (job.cancelled) break
      const sp = spreads[i],
        { n, id, psd, key, hash } = sp
      const name = outputName(n)
      const report = (state, extra = {}) =>
        emit('export.progress', { jobId: job.id, index: i + 1, total: job.total, n, state, ...extra })
      const t0 = Date.now()
      if (!p.force && sp.state === 'ready') {
        job.skipped++
        results.push({ n, state: 'skipped' })
        report('skipped')
        continue
      }
      report('exporting')
      const targets = [
        { file: path.join(stage, `${name}-high.jpg`), quality: s.highQuality },
        { file: path.join(stage, `${name}-low.jpg`), quality: s.lowQuality },
      ]
      const size = await withPrivateStage(path.dirname(stage), '.delivery-sources-', async (sourceStage) => {
        const frozen = await sourceStage.snapshot(psd, sp.sheetDigest)
        return exportSheet(frozen, targets, s, { expectedDigest: sp.sheetDigest, spec: prepared.ws.printSpec, n })
      })
      for (const target of targets) await stageCapability.register(target.file)
      files.push({ source: targets[0].file, target: sp.high }, { source: targets[1].file, target: sp.low })
      review.set(id, targets[1].file)
      next.spreads[id] = {
        n,
        key,
        hash,
        psd,
        at: new Date().toISOString(),
        ...size,
        high: { path: sp.high },
        low: { path: sp.low },
      }
      results.push({ n, state: 'prepared', ms: Date.now() - t0, ...size })
    }
    if (want.pdf && !job.cancelled) {
      const pages = plan.spreads.map((sp) => ({ path: review.get(sp.id), ppi: s.ppi }))
      if (pages.some((page) => !page.path))
        throw new Error('The review JPEGs are incomplete. Export the whole album first.')
      emit('export.progress', {
        jobId: job.id,
        index: job.total,
        total: job.total,
        n: null,
        state: 'pdf',
        pages: pages.length,
      })
      const source = path.join(stage, 'review.pdf')
      await writeJpegPdf(source, pages, { title: path.basename(paths.pdf, '.pdf') })
      await stageCapability.register(source)
      files.push({ source, target: paths.pdf })
      pdfResult = { path: paths.pdf, pages: pages.length, bytes: (await fs.promises.stat(source)).size }
    }
    if (job.cancelled) return
    const required = want.pdf ? plan.spreads : spreads
    await assertSnapshot(prepared, required)
    for (const sp of required.filter((sp) => sp.state === 'ready')) {
      const e = cache.spreads[sp.id]
      if (
        !(await verifyOwnedArtifact(e.high.path, e.high.stamp, e.high.digest)) ||
        !(await verifyOwnedArtifact(e.low.path, e.low.stamp, e.low.digest))
      )
        throw new Error(`Spread ${sp.n}'s JPEGs changed during export.`)
    }
    const written = new Set(files.map((item) => item.target))
    const generated = new Set(
      results.filter((item) => item.state === 'prepared').map((item) => plan.spreads.find((sp) => sp.n === item.n).id),
    )
    for (const [id, e] of Object.entries(next.spreads)) {
      if (!generated.has(id) && ['high', 'low'].some((k) => e[k] && written.has(e[k].path))) {
        delete next.spreads[id]
        continue
      }
    }
    next.ownedFiles = { ...(cache.ownedFiles || {}) }
    for (const e of Object.values(cache.spreads))
      for (const k of ['high', 'low']) if (e[k]) next.ownedFiles[e[k].path] = e[k].stamp
    if (pdfResult) next.pdf = { path: paths.pdf }
    // Cache bytes and ownership fingerprints are journaled together with the files. The
    // builder runs before publication, so it must use staged records rather than target stats.
    await stageCapability.transfer()
    transactionOwnsStage = true // The durable publication protocol owns all later cleanup/recovery.
    await publishDelivery(files, cache, stage, {
      paths,
      isCancelled: () => job.cancelled,
      validateSnapshot: async () => {
        await lease.project.assertOwned()
        await assertSnapshot(prepared, required)
        await stageCapability.assertFiles()
      },
      makeCache: async () => {
        await lease.project.assertOwned()
        await assertSnapshot(prepared, required)
        await stageCapability.assertFiles()
        return next
      },
    })
    job.cancelled = false // Stop requested after the committed marker cannot roll back a final set.
    for (const item of results)
      if (item.state === 'prepared') {
        item.state = 'done'
        job.done++
        emit('export.progress', { jobId: job.id, total: job.total, n: item.n, ...item })
      }
  } catch (e) {
    const requiresRecovery = !!(
      e.recoveryStage ||
      e.recoveryJournal ||
      e.recoveryLock ||
      e.snapshotPath ||
      e.retainedPath
    )
    if (
      transactionOwnsStage &&
      stage &&
      (await fs.promises.lstat(stage).then(
        () => true,
        () => true,
      ))
    )
      e.message += ` Inspect prepared delivery work at ${stage} and any reported recovery history before retrying; the caller did not remove it.`
    if (e.code === 'DELIVERY_CANCELLED' && !requiresRecovery) job.cancelled = true
    else {
      error = e.message || String(e)
      if (e.deliveryCommitted) {
        job.cancelled = false
        job.finishingErrors.push(error)
        // The complete new set is final; retain recovery evidence for cleanup on restart.
        for (const item of results)
          if (item.state === 'prepared') {
            item.state = 'done'
            job.done++
            emit('export.progress', { jobId: job.id, total: job.total, n: item.n, ...item })
          }
        emit('export.progress', { jobId: job.id, total: job.total, n: null, state: 'warning', error })
      } else {
        job.failed++
        pdfResult = want.pdf ? { error } : null
        emit('export.progress', { jobId: job.id, total: job.total, n: null, state: 'failed', error })
      }
    }
  } finally {
    if (stageCapability && !transactionOwnsStage) {
      try {
        const retirement = await stageCapability.cleanup()
        if (retirement.retainedPath)
          job.finishingErrors.push(`Prepared delivery work was retained at ${retirement.retainedPath}.`)
      } catch (cleanup) {
        job.finishingErrors.push(cleanup.message)
      }
    }
    if (current === job) current = null
    try {
      await releaseJob(lease)
    } catch (release) {
      job.finishingErrors.push(
        `Delivery completed its file work, but its lease could not finish releasing: ${release.message}`,
      )
    }
    const finishingError = job.finishingErrors.join(' ') || null
    error = [error, finishingError].filter(Boolean).join(' ') || null
    emit('export.finished', {
      jobId: job.id,
      total: job.total,
      done: job.done,
      skipped: job.skipped,
      failed: job.failed,
      cancelled: job.cancelled,
      ms: Date.now() - job.startedAt,
      paths,
      results,
      pdf: pdfResult,
      missingSheets,
      error,
      finishingError,
      warnings: [...job.finishingErrors],
    })
  }
}

/** @param {{ jobId?: string }} [options] */
function cancelExport({ jobId } = {}) {
  if (!current || (jobId && current.id !== jobId)) return { cancelled: false }
  current.cancelled = true
  return { cancelled: true }
}

function exportStatus() {
  return current
    ? {
        running: true,
        jobId: current.id,
        total: current.total,
        done: current.done,
        skipped: current.skipped,
        failed: current.failed,
      }
    : { running: false }
}

module.exports = {
  exportPlan,
  startExport,
  cancelExport,
  exportStatus,
  deliverPaths,
  exportSheet,
  sheetPixels,
  DEFAULTS,
}
