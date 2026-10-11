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
const os = require('os')
const path = require('path')
const { openAlbum } = require('./album')
const { fileStamp, writeAtomic } = require('./cache')
const { writeJpegPdf } = require('./pdf')
const { PhotoCraftSession } = require('./photocraft')
const { outputName } = require('./sheet')

const EXPORT_VERSION = 'export-1'
const DEFAULTS = { heightInches: 12, ppi: 300, highQuality: 97, lowQuality: 25 }

let agpsd = null
function getAgPsd() {
  if (agpsd) return agpsd
  agpsd = require('ag-psd')
  agpsd.initializeCanvas((w, h) => ({
    width: w,
    height: h,
    getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }) }),
  }))
  return agpsd
}
const getSharp = () => require('../../../src/sharp_config').getSharp()

let current = null

async function readProject(file) {
  return JSON.parse(await fs.promises.readFile(file, 'utf8'))
}

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
  const s = { ...DEFAULTS }
  for (const k of Object.keys(DEFAULTS)) if (Number.isFinite(Number(p[k])) && Number(p[k]) > 0) s[k] = Number(p[k])
  s.size = p.size === 'original' ? 'original' : 'print'
  return s
}

/**
 * The sheet's flattened pixels: the composite stored in the PSD, or, when it has none, the
 * engine's own export of it.
 * @returns {Promise<{ input: Buffer | string, raw?: { width: number, height: number, channels: 4 }, width: number, height: number, cleanup?: () => Promise<void> }>}
 */
async function sheetPixels(psdPath) {
  const buf = await fs.promises.readFile(psdPath)
  let psd = null
  try {
    psd = getAgPsd().readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: false, skipThumbnail: true, useImageData: true })
  } catch (_) { /* unreadable here: the engine tries */ }
  const img = psd && psd.imageData
  if (img && psd.bitsPerChannel === 8 && img.data.length === img.width * img.height * 4) {
    const input = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length)
    const stats = await getSharp()(input, { raw: { width: img.width, height: img.height, channels: 4 } }).resize(64).stats()
    if (stats.channels.slice(0, 3).some((c) => c.stdev > 0.5)) return { input, raw: { width: img.width, height: img.height, channels: 4 }, width: img.width, height: img.height }
  }
  // No usable composite (saved without one, or 16-bit): let PhotoCraft draw it.
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'as-export-'))
  const out = path.join(dir, 'sheet.jpg')
  const pc = new PhotoCraftSession({ writeRoot: dir })
  try {
    await pc.call('doc.open', { path: PhotoCraftSession.readPath(psdPath) })
    await pc.call('doc.save', { path: pc.writePath(out), quality: 100 })
  } finally {
    await pc.close()
  }
  const meta = await getSharp()(out).metadata()
  return { input: out, width: meta.width, height: meta.height, cleanup: () => fs.promises.rm(dir, { recursive: true, force: true }) }
}

/** Write the print and/or review JPEGs of one sheet. */
async function exportSheet(psdPath, targets, s) {
  const sharp = getSharp()
  const px = await sheetPixels(psdPath)
  try {
    const height = s.size === 'print' ? Math.round(s.heightInches * s.ppi) : px.height
    const width = Math.round((px.width * height) / px.height)
    // Resample once, then encode every target from the same pixels, side by side.
    let p = sharp(px.input, px.raw ? { raw: px.raw } : { failOn: 'none' })
    if (px.raw) p = p.flatten({ background: '#ffffff' })
    if (width !== px.width || height !== px.height) p = p.resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    const pixels = await p.removeAlpha().raw().toBuffer({ resolveWithObject: true })
    await Promise.all(targets.map(async (t) => {
      const tmp = `${t.file}.part.jpg`
      await fs.promises.mkdir(path.dirname(t.file), { recursive: true })
      await sharp(pixels.data, { raw: { width: pixels.info.width, height: pixels.info.height, channels: pixels.info.channels } })
        .withIccProfile('srgb')
        .withMetadata({ density: s.ppi })
        // Print files: full colour resolution, the standard encoder (12× faster than mozjpeg at
        // this size for 4% more bytes). Review files: mozjpeg, a third smaller for the PDF.
        .jpeg(t.quality >= 90 ? { quality: t.quality, chromaSubsampling: '4:4:4', optimiseCoding: true } : { quality: t.quality, mozjpeg: true })
        .toFile(tmp)
      await fs.promises.rename(tmp, t.file)
    }))
    return { width, height }
  } finally {
    if (px.cleanup) await px.cleanup()
  }
}

/**
 * What an export would do, per spread: `ready` (its JPEGs are made from the current sheet),
 * `todo` (to make), `stale` (the sheet changed since its JPEGs were made), or `nosheet`.
 */
async function exportPlan({ album: albumPath, ...p }) {
  if (!albumPath) throw new Error('missing `album`')
  const album = await openAlbum({ path: albumPath })
  const ws = (await readProject(album.file)).workspace || {}
  const paths = deliverPaths(album, ws.outputToken || path.join(album.path, 'exports'))
  const s = settingsOf(p)
  const cache = await readJson(paths.cache)
  const spreads = await Promise.all(album.spreads.map(async (sp) => {
    const name = outputName(sp.n)
    const psd = path.join(paths.sheets, `${name}.psd`)
    const stamp = await fileStamp(psd)
    if (stamp === 'missing') return { n: sp.n, state: 'nosheet' }
    const key = exportKey(stamp, s)
    const have = await Promise.all([path.join(paths.high, `${name}.jpg`), path.join(paths.low, `${name}.jpg`)].map((f) => fs.promises.access(f).then(() => true, () => false)))
    const e = cache[name]
    if (e && e.key === key && have[0] && have[1]) return { n: sp.n, state: 'ready' }
    return { n: sp.n, state: e && have.some(Boolean) ? 'stale' : 'todo' }
  }))
  const pdf = await fs.promises.stat(paths.pdf).catch(() => null)
  return { paths, settings: s, spreads, pdf: pdf ? { path: paths.pdf, bytes: pdf.size, at: pdf.mtime.toISOString() } : null, running: exportStatus() }
}

function exportKey(stamp, s) {
  return crypto.createHash('sha1').update(JSON.stringify([EXPORT_VERSION, stamp, s.size, s.heightInches, s.ppi, s.highQuality, s.lowQuality])).digest('hex').slice(0, 16)
}

async function readJson(file) {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')) } catch (_) { return {} }
}

/**
 * Export. Returns at once; progress comes as `export.progress`, the end as `export.finished`.
 * `jpegs`: make the print and review JPEGs (always together, so the PDF matches the print files);
 * `pdf`: the client PDF from the review JPEGs.
 * @param {{ album: string, spreads?: number[]|null, jpegs?: boolean, pdf?: boolean,
 *   force?: boolean, size?: 'print'|'original', heightInches?: number, ppi?: number }} p
 */
async function startExport(p, { emit }) {
  if (current) throw new Error(`An export is already running (${current.done + current.skipped} of ${current.total}).`)
  if (!p.album) throw new Error('missing `album`')
  // A sheet being rendered may be half written: one heavy job at a time.
  if (require('./render').renderStatus().running) throw new Error('Sheets are rendering. Export when the render has finished.')
  const want = { jpegs: p.jpegs !== false, pdf: p.pdf !== false }
  if (!want.jpegs && !want.pdf) throw new Error('Choose at least one kind of file to export.')
  const plan = await exportPlan(p)
  const { paths, settings: s } = plan
  const wanted = Array.isArray(p.spreads) && p.spreads.length ? new Set(p.spreads.map(Number)) : null
  const withSheet = plan.spreads.filter((x) => x.state !== 'nosheet')
  const spreads = want.jpegs ? withSheet.filter((x) => !wanted || wanted.has(x.n)) : []
  if (want.jpegs && !spreads.length) throw new Error('No spread has a rendered sheet yet. Render the album first.')
  const missingSheets = plan.spreads.filter((x) => x.state === 'nosheet').map((x) => x.n)
  const job = { id: Date.now(), total: spreads.length, done: 0, skipped: 0, failed: 0, cancelled: false, startedAt: Date.now() }
  current = job
  emit('export.started', { jobId: job.id, total: job.total, paths, missingSheets })
  void runExport(job, { p, plan, spreads, want, s, paths, missingSheets }, emit).finally(() => { current = null })
  return { jobId: job.id, total: job.total, paths, missingSheets }
}

async function runExport(job, { p, plan, spreads, want, s, paths, missingSheets }, emit) {
  const cache = await readJson(paths.cache)
  const results = []
  let pdfResult = null
  try {
    for (let i = 0; i < spreads.length; i++) {
      if (job.cancelled) break
      const { n } = spreads[i]
      const name = outputName(n)
      const psd = path.join(paths.sheets, `${name}.psd`)
      const report = (state, extra = {}) => emit('export.progress', { jobId: job.id, index: i + 1, total: job.total, n, state, ...extra })
      const t0 = Date.now()
      try {
        const key = exportKey(await fileStamp(psd), s)
        const targets = [
          { file: path.join(paths.high, `${name}.jpg`), quality: s.highQuality },
          { file: path.join(paths.low, `${name}.jpg`), quality: s.lowQuality },
        ]
        const fresh = !p.force && cache[name] && cache[name].key === key && plan.spreads.find((x) => x.n === n).state === 'ready'
        if (fresh) {
          job.skipped++
          results.push({ n, state: 'skipped' })
          report('skipped')
          continue
        }
        report('exporting')
        const size = await exportSheet(psd, targets, s)
        cache[name] = { key, at: new Date().toISOString(), ...size }
        await writeAtomic(paths.cache, JSON.stringify(cache, null, 1))
        job.done++
        results.push({ n, state: 'done', ms: Date.now() - t0, ...size })
        report('done', { ms: Date.now() - t0, ...size })
      } catch (e) {
        job.failed++
        const error = e && e.message ? e.message : String(e)
        results.push({ n, state: 'failed', error })
        report('failed', { error })
      }
    }
    if (want.pdf && !job.cancelled) {
      // The PDF is the whole album, in order, from the review JPEGs that exist.
      const pages = []
      for (const sp of plan.spreads) {
        const f = path.join(paths.low, `${outputName(sp.n)}.jpg`)
        if (await fs.promises.access(f).then(() => true, () => false)) pages.push({ path: f, ppi: s.ppi })
      }
      emit('export.progress', { jobId: job.id, index: job.total, total: job.total, n: null, state: 'pdf', pages: pages.length })
      try {
        await writeJpegPdf(paths.pdf, pages, { title: path.basename(paths.pdf, '.pdf') })
        const st = await fs.promises.stat(paths.pdf)
        pdfResult = { path: paths.pdf, pages: pages.length, bytes: st.size }
      } catch (e) {
        pdfResult = { error: e && e.message ? e.message : String(e) }
      }
    }
  } finally {
    emit('export.finished', {
      jobId: job.id, total: job.total, done: job.done, skipped: job.skipped, failed: job.failed, cancelled: job.cancelled,
      ms: Date.now() - job.startedAt, paths, results, pdf: pdfResult, missingSheets,
    })
  }
}

function cancelExport({ jobId } = {}) {
  if (!current || (jobId && current.id !== jobId)) return { cancelled: false }
  current.cancelled = true
  return { cancelled: true }
}

function exportStatus() {
  return current ? { running: true, jobId: current.id, total: current.total, done: current.done, skipped: current.skipped, failed: current.failed } : { running: false }
}

module.exports = { exportPlan, startExport, cancelExport, exportStatus, deliverPaths, exportSheet, sheetPixels, DEFAULTS }
