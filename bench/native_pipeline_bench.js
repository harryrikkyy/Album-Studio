#!/usr/bin/env node
// Bounded, disposable native-backend benchmark. Synthetic textured images are not a
// camera corpus, and headless event-loop measurements do not certify the native UI.
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFile, execFileSync } = require('node:child_process')
const { promisify } = require('node:util')
const { performance, monitorEventLoopDelay } = require('node:perf_hooks')
const runFile = promisify(execFile)
const REPO = path.resolve(__dirname, '..'), GiB = 1024 ** 3
const PROFILES = { pilot: { photos: 24, spreads: 8 }, small: { photos: 30, spreads: 10 }, typical: { photos: 150, spreads: 50 }, large: { photos: 600, spreads: 200 } }
const SETTINGS = { size: 'print', heightInches: 6, ppi: 300 }
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
async function fileHash(file) {
  const hash = crypto.createHash('sha256')
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}
function bounded(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })]).finally(() => clearTimeout(timer))
}
function treeUsage(root) {
  let bytes = 0, allocated = 0, files = 0
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name), stat = fs.lstatSync(file)
      if (entry.isDirectory()) walk(file)
      else { assert.ok(entry.isFile(), `Unexpected non-regular benchmark entry: ${file}`); files++; bytes += stat.size; allocated += stat.blocks * 512 }
    }
  }
  walk(root)
  return { logicalBytes: bytes, allocatedBytes: allocated, files, allocationCaveat: 'APFS clones and shared extents can make summed allocated blocks differ from actual unique physical bytes.' }
}
async function sourceManifest() {
  const files = []
  for (const folder of ['native/backend/lib', 'src']) for (const name of fs.readdirSync(path.join(REPO, folder)).sort()) {
    if (name.endsWith('.js')) files.push(path.join(folder, name))
  }
  files.push('bench/native_pipeline_bench.js', 'package-lock.json')
  const hashes = {}
  for (const file of files) if (fs.existsSync(path.join(REPO, file))) hashes[file] = await fileHash(path.join(REPO, file))
  for (const [label, file] of [['engine', process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI], ['exclusiveRename', process.env.ALBUM_STUDIO_RENAME_CLI]]) {
    if (!file || !path.isAbsolute(file)) throw new Error(`Set the absolute ${label} executable path before benchmarking.`)
    hashes[`${label}:${file}`] = await fileHash(file)
  }
  return { gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(), sha256: hashes }
}
function parseOptions() {
  const options = { profile: 'pilot', diskGiB: 4, rssGiB: 5, timeoutSeconds: 900 }
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i], value = process.argv[i + 1]
    if (key === '--help') {
      console.log('node bench/native_pipeline_bench.js [--profile pilot|small|typical|large] [--disk-gib 4] [--rss-gib 5] [--timeout-seconds 900]\nSet ALBUM_STUDIO_PHOTOCRAFT_CLI and ALBUM_STUDIO_RENAME_CLI. Optional ALBUM_STUDIO_PDFTOPPM.\nCreates a fresh disposable bench/fixture/native-pipeline-* directory, retains its report and data, and never scans customer folders. Larger profiles require an explicit disk budget after pilot review. Defined profiles are synthetic workloads, not measured customer distributions.')
      process.exit(0)
    }
    if (key === '--profile' && Object.hasOwn(PROFILES, value)) options.profile = value
    else if (key === '--disk-gib' && Number(value) >= 1 && Number(value) <= 64) options.diskGiB = Number(value)
    else if (key === '--rss-gib' && Number(value) >= 1 && Number(value) <= 8) options.rssGiB = Number(value)
    else if (key === '--timeout-seconds' && Number.isSafeInteger(Number(value)) && Number(value) >= 30 && Number(value) <= 3600) options.timeoutSeconds = Number(value)
    else throw new Error(`Invalid benchmark option: ${key} ${value || ''}`)
  }
  return { ...options, ...PROFILES[options.profile], settings: SETTINGS }
}
async function coordinator() {
  const options = parseOptions(), before = await sourceManifest()
  const parent = path.join(REPO, 'bench', 'fixture')
  fs.mkdirSync(parent, { recursive: true })
  const free = fs.statfsSync(parent), freeBytes = free.bavail * free.bsize
  if (freeBytes < (options.diskGiB + 4) * GiB) throw new Error('The selected volume needs the disk budget plus a 4 GiB free-space reserve.')
  if (options.rssGiB * GiB > os.totalmem() * 0.7) throw new Error('The RSS safety ceiling must stay below 70% of installed RAM.')
  const estimatedLogicalBytes = options.photos * 6e6 + options.spreads * 180e6
  if (estimatedLogicalBytes > options.diskGiB * GiB) throw new Error(`The conservative workload estimate ${(estimatedLogicalBytes / GiB).toFixed(1)} GiB exceeds the explicit disk ceiling. Review the pilot before choosing a larger ceiling/profile.`)
  const root = fs.mkdtempSync(path.join(parent, 'native-pipeline-'))
  fs.writeFileSync(path.join(root, '.benchmark-owned'), 'Album Studio disposable synthetic benchmark v1\n')
  const report = {
    schemaVersion: 1, status: 'running', root, startedAt: new Date().toISOString(), options,
    machine: { platform: process.platform, release: os.release(), arch: process.arch, cpuModel: os.cpus()[0].model, logicalCpus: os.cpus().length, totalRamBytes: os.totalmem(), node: process.version, versions: process.versions, volumeFreeBytesAtStart: freeBytes },
    limitations: ['Synthetic independent textured JPEGs; no camera/RAW/HEIC corpus or photographic content certification.', 'Simple three-rectangle RGB PSD; no decorative, large layered, text, CMYK or spot-colour template corpus.', 'Headless backend only; WKWebView/native UI latency, accessibility and customer workflows remain unverified.', 'Cold means fresh application-owned caches in a new process; OS page caches are not flushed and source generation warms filesystem caches.', 'Sampled process-tree RSS can miss short peaks and does not include kernel/GPU/shared-memory accounting.', 'ps CPU percentages are sampled process-lifetime averages, not instantaneous CPU utilization or total energy.', 'Defined small/typical/large are harness workload labels, not established customer distributions.', 'Safety ceilings abort a benchmark; they are not production acceptance budgets.', 'Retained recovery histories are measured here; long-term growth and approved cleanup remain unresolved.'],
    sourceBefore: before, phases: [], samples: [],
  }
  const reportPath = path.join(root, 'report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ type: 'benchmark.start', root, options }))
  const child = spawn(process.execPath, ['--max-old-space-size=3072', __filename, '--worker', root, JSON.stringify(options)], {
    cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, UV_THREADPOOL_SIZE: '4', RAYON_NUM_THREADS: '2', ALBUM_STUDIO_CACHE_DIR: path.join(root, 'application-cache') },
  })
  let currentPhase = 'startup', fatal = null, stderr = '', sampling = false
  const stopGroup = (signal) => { try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  const abort = (message) => { if (!fatal) { fatal = message; stopGroup('SIGTERM') } }
  child.stdout.on('data', (data) => process.stdout.write(data))
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-32768); process.stderr.write(data) })
  child.on('message', (message) => {
    if (message.type === 'begin') currentPhase = message.name
    if (message.type === 'phase') report.phases.push(message.phase)
  })
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  const sample = async () => {
    if (sampling) return
    sampling = true
    try {
      const { stdout } = await runFile('/bin/ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,comm='], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 })
      const processes = stdout.trim().split('\n').map((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+)$/.exec(line)
        return match && { pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, lifetimeCpuPercent: Number(match[4]), binary: path.basename(match[5]) }
      }).filter(Boolean)
      const family = new Set([child.pid])
      for (let changed = true; changed;) { changed = false; for (const proc of processes) if (family.has(proc.ppid) && !family.has(proc.pid)) { family.add(proc.pid); changed = true } }
      const members = processes.filter((proc) => family.has(proc.pid))
      const item = { at: new Date().toISOString(), phase: currentPhase, aggregateRssBytes: members.reduce((sum, proc) => sum + proc.rssBytes, 0), aggregateLifetimeCpuPercent: members.reduce((sum, proc) => sum + proc.lifetimeCpuPercent, 0), members }
      report.samples.push(item)
      if (item.aggregateRssBytes > options.rssGiB * GiB) abort('Sampled process-tree RSS exceeded the explicit benchmark safety ceiling.')
    } catch (error) { abort(`Process-tree sampling failed: ${error.message}`) }
    finally { sampling = false }
  }
  const sampler = setInterval(() => { void sample() }, 250)
  const timer = setTimeout(() => abort('Benchmark exceeded its explicit wall-time safety ceiling.'), options.timeoutSeconds * 1000)
  const killer = setInterval(() => { if (fatal) stopGroup('SIGKILL') }, 3000)
  let terminal
  try { await sample(); terminal = await exited }
  finally { clearInterval(sampler); clearInterval(killer); clearTimeout(timer) }
  report.finishedAt = new Date().toISOString(); report.terminal = terminal; report.stderr = stderr
  report.sourceAfter = await sourceManifest()
  report.sourceUnchanged = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter)
  report.workingTreeProvisional = !report.sourceUnchanged
  report.disk = treeUsage(root)
  report.peakSampledAggregateRssBytes = Math.max(0, ...report.samples.map((s) => s.aggregateRssBytes))
  for (const phase of report.phases) {
    const samples = report.samples.filter((s) => s.phase === phase.name)
    phase.sampledResources = { count: samples.length, peakAggregateRssBytes: Math.max(0, ...samples.map((s) => s.aggregateRssBytes)), peakAggregateLifetimeCpuPercent: Math.max(0, ...samples.map((s) => s.aggregateLifetimeCpuPercent)) }
  }
  const workerReport = path.join(root, 'worker-result.json')
  if (fs.existsSync(workerReport)) report.result = JSON.parse(fs.readFileSync(workerReport, 'utf8'))
  report.status = !fatal && terminal.code === 0 ? 'completed' : 'failed'
  report.failure = fatal || (terminal.code !== 0 ? `Worker exited ${JSON.stringify(terminal)}` : null)
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ type: 'benchmark.finished', report: reportPath, status: report.status, sourceUnchanged: report.sourceUnchanged, peakSampledAggregateRssMiB: Math.round(report.peakSampledAggregateRssBytes / 1024 ** 2), logicalGiB: +(report.disk.logicalBytes / GiB).toFixed(3) }))
  if (report.status !== 'completed') process.exitCode = 1
}

async function worker(root, options) {
  assert.equal(fs.readFileSync(path.join(root, '.benchmark-owned'), 'utf8'), 'Album Studio disposable synthetic benchmark v1\n')
  const sharp = require('sharp'), ag = require('ag-psd')
  sharp.concurrency(2); sharp.cache({ memory: 128, files: 20, items: 100 })
  const { openAlbum } = require('../native/backend/lib/album')
  const { migrateAlbum, updateAlbum } = require('../native/backend/lib/project')
  const { refreshProofs, proofsSettled } = require('../native/backend/lib/proofs')
  const { renderPlan, startRender } = require('../native/backend/lib/render')
  const { exportPlan, startExport } = require('../native/backend/lib/deliver')
  const result = { fixture: {}, phases: [], correctness: {}, sharp: { versions: sharp.versions, concurrency: sharp.concurrency(), cache: sharp.cache() } }
  const writeResult = () => fs.writeFileSync(path.join(root, 'worker-result.json'), JSON.stringify(result, null, 2))
  const emit = (message) => { if (process.connected) process.send(message); console.log(JSON.stringify(message)) }
  async function phase(name, work) {
    emit({ type: 'begin', name })
    const started = performance.now(), cpu = process.cpuUsage(), delay = monitorEventLoopDelay({ resolution: 20 })
    delay.enable()
    let detail, failure
    try { detail = await work() } catch (error) { failure = error; detail = { error: error.stack } }
    delay.disable()
    const usage = process.cpuUsage(cpu), disk = treeUsage(root)
    const record = { name, ms: performance.now() - started, detail, workerCpuMs: { user: usage.user / 1000, system: usage.system / 1000 }, workerRssBytesAtEnd: process.memoryUsage().rss, workerLifetimeMaxRssKiB: process.resourceUsage().maxRSS, eventLoopMs: { p50: delay.percentile(50) / 1e6, p95: delay.percentile(95) / 1e6, max: delay.max / 1e6, samples: delay.count }, disk }
    result.phases.push(record); writeResult(); emit({ type: 'phase', phase: record })
    if (disk.logicalBytes > options.diskGiB * GiB) throw new Error('Logical benchmark files exceeded the explicit disk safety ceiling.')
    if (failure) throw failure
    return detail
  }
  const shoot = path.join(root, 'Shoot'), templates = path.join(root, 'Templates'), album = path.join(root, 'Album'), out = path.join(album, 'exports')
  for (const folder of [shoot, templates, out]) fs.mkdirSync(folder, { recursive: true })
  await phase('fixture.generate', async () => {
    const photos = []
    for (let n = 0; n < options.photos; n++) {
      const width = 4000, height = 3000, bytes = Buffer.alloc(width * height * 3)
      let state = ((n + 1) * 2654435761) >>> 0
      for (let y = 0, at = 0; y < height; y++) for (let x = 0; x < width; x++, at += 3) {
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5
        const noise = (state >>> 24) % 48
        bytes[at] = 24 + (n * 37 + Math.floor(x / 32) + noise) % 208
        bytes[at + 1] = 24 + (n * 71 + Math.floor(y / 24) + noise) % 208
        bytes[at + 2] = 24 + (n * 113 + Math.floor((x + y) / 40) + noise) % 208
      }
      const name = `photo_${String(n + 1).padStart(4, '0')}.jpg`, file = path.join(shoot, name), rawSha256 = sha(bytes)
      await sharp(bytes, { raw: { width, height, channels: 3 } }).withIccProfile('srgb').jpeg({ quality: 88, chromaSubsampling: '4:4:4' }).toFile(file)
      const meta = await sharp(file).metadata(), jpegSha256 = await fileHash(file)
      assert.deepEqual([meta.width, meta.height], [width, height])
      photos.push({ name, width, height, rawSha256, jpegSha256, bytes: fs.statSync(file).size, seed: ((n + 1) * 2654435761) >>> 0 })
    }
    assert.equal(new Set(photos.map((p) => p.rawSha256)).size, options.photos)
    assert.equal(new Set(photos.map((p) => p.jpegSha256)).size, options.photos)
    const box = (width, height, rgb) => { const data = new Uint8ClampedArray(width * height * 4); for (let at = 0; at < data.length; at += 4) data.set([...rgb, 255], at); return { width, height, data } }
    const imageData = box(2400, 800, [242, 238, 230])
    const children = [{ name: 'Background', left: 0, top: 0, right: 2400, bottom: 800, imageData }, ...[90, 840, 1590].map((left, i) => ({ name: `ToolkitHFrame_${String(i + 1).padStart(3, '0')}`, left, top: 130, right: left + 720, bottom: 670, imageData: box(720, 540, [100 + i * 20, 60, 80]) }))]
    fs.writeFileSync(path.join(templates, '3h0v.psd'), ag.writePsdBuffer({ width: 2400, height: 800, imageData, children }))
    const pages = {}
    for (let n = 1; n <= options.spreads; n++) pages[n] = { photos: [0, 1, 2].map((i) => ({ id: `img_Shoot_photo_${String((n - 1) * 3 + i + 1).padStart(4, '0')}_jpg`, orient: 'h' })), template: { id: 'tpl_Templates_3h0v_psd', name: '3h0v.psd', h: 3, v: 0 } }
    fs.writeFileSync(path.join(album, 'project.json'), JSON.stringify({ version: 1, workspace: { imageTokens: [shoot], templateTokens: [templates], outputToken: out }, totalActivePages: options.spreads, albumPages: pages }))
    result.fixture = { label: 'independently generated deterministic synthetic texture, not photographs', photos, template: { pixels: [2400, 800], sha256: await fileHash(path.join(templates, '3h0v.psd')), frames: 3, templateType: 'simple rectangular RGB raster layers' }, outputPixels: [5400, 1800] }
    return { photos: photos.length, uniqueRawDigests: new Set(photos.map((p) => p.rawSha256)).size, uniqueJpegDigests: new Set(photos.map((p) => p.jpegSha256)).size }
  })
  await phase('album.open-and-migrate.cold', async () => {
    const first = await migrateAlbum({ album })
    assert.equal(first.stats.photos, options.photos); assert.equal(first.spreads.length, options.spreads)
    assert.ok(first.spreads.every((s) => s.missingPhotos === 0 && s.template.file))
    return { stats: first.stats }
  })
  const refresh = async () => {
    const events = []
    refreshProofs(album, (event, data) => events.push({ event, ...data }))
    await bounded(proofsSettled(album), options.timeoutSeconds * 1000, 'Proof refresh timed out')
    const idle = events.filter((event) => event.event === 'proofs.idle').at(-1)
    assert.ok(idle && !idle.error && !idle.failed, JSON.stringify(events))
    return { idle, updates: events.filter((event) => event.event === 'proofs.updated').length }
  }
  const job = async (kind, extra = {}) => {
    let finish
    const done = new Promise((resolve) => { finish = resolve }), events = []
    const start = kind === 'render' ? startRender : startExport
    await start({ album, ...SETTINGS, ...extra }, { emit(event, data) { if (event === `${kind}.progress`) events.push(data); if (event === `${kind}.finished`) finish(data) } })
    const completed = await bounded(done, options.timeoutSeconds * 1000, `${kind} job timed out`)
    assert.equal(completed.failed, 0, JSON.stringify(completed)); assert.equal(completed.cancelled, false)
    return { ...completed, progressEvents: events.length }
  }
  const coldProof = await phase('proof.cold', refresh); assert.equal(coldProof.idle.rendered, options.spreads)
  const warmProof = await phase('proof.warm', refresh); assert.equal(warmProof.updates, 0)
  const firstRender = await phase('render.cold', () => job('render')); assert.equal(firstRender.done, options.spreads)
  const firstExport = await phase('export-jpeg-and-pdf.cold', () => job('export')); assert.equal(firstExport.done, options.spreads)
  const paths = firstExport.paths
  const snapshot = async () => {
    const opened = await openAlbum({ path: album }), records = []
    for (const spread of opened.spreads) {
      const high = path.join(paths.high, `Page_${String(spread.n).padStart(3, '0')}.jpg`), low = path.join(paths.low, `Page_${String(spread.n).padStart(3, '0')}.jpg`), meta = await sharp(high).metadata()
      assert.deepEqual([meta.width, meta.height, meta.density], [5400, 1800, 300])
      records.push({ id: spread.id, n: spread.n, sourcePhotoIds: spread.photoIds, sheet: spread.sheet, sheetSha256: await fileHash(spread.sheet), highSha256: await fileHash(high), lowSha256: await fileHash(low), highBytes: fs.statSync(high).size, lowBytes: fs.statSync(low).size })
    }
    return records
  }
  const original = await phase('correctness.snapshot', snapshot)
  for (let cycle = 1; cycle <= 3; cycle++) {
    const proof = await phase(`proof.warm-${cycle}`, refresh); assert.equal(proof.updates, 0)
    const render = await phase(`render.warm-${cycle}`, () => job('render')); assert.equal(render.skipped, options.spreads); assert.equal(render.done, 0)
    const exported = await phase(`export-jpeg-and-pdf.warm-${cycle}`, () => job('export')); assert.equal(exported.skipped, options.spreads); assert.equal(exported.done, 0)
  }
  assert.deepEqual(await snapshot(), original, 'warm operations must keep source ownership and exact JPEG/sheet bytes')
  await phase('source.preserved-stamp-invalidation', async () => {
    const file = path.join(shoot, result.fixture.photos[0].name), bytes = fs.readFileSync(file), stat = fs.statSync(file), changed = Buffer.from(bytes), marker = changed.indexOf(Buffer.from([255, 219]))
    assert.ok(marker >= 0); changed[marker + 5] = changed[marker + 5] === 1 ? 2 : 1
    try {
      fs.writeFileSync(file, changed); fs.utimesSync(file, stat.atime, stat.mtime)
      const render = await renderPlan({ album, ...SETTINGS }), exported = await exportPlan({ album, ...SETTINGS })
      assert.equal(render.spreads.filter((s) => s.state === 'stale').length, 1)
      assert.equal(exported.spreads.filter((s) => s.state === 'blocked').length, 1)
      return { sameSize: fs.statSync(file).size === stat.size, sameRoundedMtime: Math.round(fs.statSync(file).mtimeMs) === Math.round(stat.mtimeMs), staleRenderSpreads: 1, blockedExportSpreads: 1 }
    } finally { fs.writeFileSync(file, bytes); fs.utimesSync(file, stat.atime, stat.mtime) }
  })
  await phase('reorder.update', () => updateAlbum({ album, ops: [{ op: 'moveSpread', from: 1, to: options.spreads }] }).then((value) => ({ changed: value.changed })))
  await phase('reorder.proof', refresh)
  const movedRender = await phase('reorder.render', () => job('render')); assert.equal(movedRender.skipped, options.spreads)
  const movedExport = await phase('reorder.export-jpeg-and-pdf', () => job('export')); assert.equal(movedExport.failed, 0)
  const moved = await phase('reorder.verify-owner-and-bytes', snapshot), byId = new Map(original.map((entry) => [entry.id, entry]))
  for (const entry of moved) for (const key of ['sheet', 'sheetSha256', 'highSha256', 'lowSha256']) assert.equal(entry[key], byId.get(entry.id)[key], `${key} changed for the same spread owner after reorder`)
  assert.equal(moved.at(-1).id, original[0].id)
  const pdfCheck = await phase('pdf.independent-page-order-and-pixels', async () => {
    const prefix = path.join(root, 'pdf-oracle'), renderer = process.env.ALBUM_STUDIO_PDFTOPPM || 'pdftoppm'
    const version = await runFile(renderer, ['-v'], { timeout: 5000 })
    const mediaBoxes = [...fs.readFileSync(paths.pdf).toString('latin1').matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((match) => [Number(match[1]), Number(match[2])])
    assert.equal(mediaBoxes.length, options.spreads)
    for (const box of mediaBoxes) assert.deepEqual(box, [SETTINGS.heightInches * 3 * 72, SETTINGS.heightInches * 72], 'PDF page geometry must match the independently specified 3:1 physical print canvas')
    // Poppler's single-axis scale can ceil 400.00000000000006 to 401 rows. Verify physical
    // geometry above, then request both raster dimensions explicitly; keep pixel checks exact.
    await runFile(renderer, ['-scale-to-x', '1200', '-scale-to-y', '400', '-png', paths.pdf, prefix], { timeout: Math.min(300000, options.timeoutSeconds * 1000), maxBuffer: 1024 * 1024 })
    const pngs = fs.readdirSync(root).filter((file) => /^pdf-oracle-\d+\.png$/.test(file)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    assert.equal(pngs.length, options.spreads)
    const checks = []
    for (let i = 0; i < pngs.length; i++) {
      const actual = await sharp(path.join(root, pngs[i])).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const expected = await sharp(path.join(paths.low, `Page_${String(i + 1).padStart(3, '0')}.jpg`)).withIccProfile('srgb').resize(1200, 400).removeAlpha().raw().toBuffer()
      assert.deepEqual([actual.info.width, actual.info.height], [1200, 400])
      for (const x of [225, 600, 975]) {
        const average = (data, channels) => { const sum = [0, 0, 0]; for (let y = 195; y < 205; y++) for (let px = x - 5; px < x + 5; px++) for (let c = 0; c < 3; c++) sum[c] += data[(y * 1200 + px) * channels + c] / 100; return sum }
        const got = average(actual.data, actual.info.channels), want = average(expected, 3), delta = got.map((v, c) => Math.abs(v - want[c]))
        assert.ok(delta.every((v) => v <= 8), `PDF page ${i + 1} patch ${x} differs from its current review JPEG: ${delta}`)
        checks.push({ page: i + 1, x, actual: got, expected: want, delta })
      }
    }
    return { renderer: (version.stdout + version.stderr).trim(), pageCount: pngs.length, mediaBoxesPoints: mediaBoxes, rasterPixels: [1200, 400], patchTolerance: 8, checks }
  })
  result.correctness = { sourcesStillMatch: true, stableSpreadIdsAfterReorder: true, warmSheetsAndJpegsUnchanged: true, preservedStampInvalidation: true, pdfPageCount: pdfCheck.pageCount, original, reordered: moved }
  for (const photo of result.fixture.photos) assert.equal(await fileHash(path.join(shoot, photo.name)), photo.jpegSha256)
  result.finalDisk = treeUsage(root); writeResult()
}

if (process.argv[2] === '--worker') worker(process.argv[3], JSON.parse(process.argv[4])).catch((error) => { console.error(error.stack); process.exitCode = 1 })
else coordinator().catch((error) => { console.error(error.stack); process.exitCode = 1 })
