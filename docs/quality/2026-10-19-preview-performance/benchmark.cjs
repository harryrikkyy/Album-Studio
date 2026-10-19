'use strict'
// Uses an owned runtime/project copy. Original photo/template folders are read-only inputs.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'benchmark-environment.json')))
const label = process.argv[2]
if (!['before', 'after'].includes(label)) throw Error('Choose before or after')
const base = path.join(config.root, label), runtime = path.join(base, 'runtime'), albumPath = path.join(base, 'Album')
process.env.ALBUM_STUDIO_CACHE_DIR = path.join(base, 'cache')
process.env.ALBUM_STUDIO_DATA_DIR = path.join(base, 'data')
const { openAlbum } = require(path.join(runtime, 'native/backend/lib/album'))
const { updateAlbum } = require(path.join(runtime, 'native/backend/lib/project'))
const { refreshProofs, proofsSettled } = require(path.join(runtime, 'native/backend/lib/proofs'))
const scope = label === 'after' ? require(path.join(runtime, 'native/backend/lib/proof_scope')).proofScope : () => null
function usage(folder) {
  let files = 0, bytes = 0
  if (fs.existsSync(folder)) for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name)
    if (entry.isDirectory()) { const value = usage(file); files += value.files; bytes += value.bytes }
    else { files++; bytes += fs.statSync(file).size }
  }
  return { files, bytes, stages: fs.existsSync(folder) ? fs.readdirSync(folder).length : 0 }
}
const history = () => usage(path.join(process.env.ALBUM_STUDIO_CACHE_DIR, '.album-studio-stage-history'))
const receipt = { label, node: process.version, phases: [], projectSourceSha256: config.sourceProjectSha256, started: new Date().toISOString() }
const save = () => fs.writeFileSync(path.join(__dirname, `benchmark-${label}.json`), JSON.stringify(receipt, null, 2))
async function refresh(name, options, extra = {}) {
  const events = [], start = performance.now(), initial = history()
  refreshProofs(albumPath, (event, data) => events.push({ event, n: data.n, ms: data.ms, error: data.error, skipped: data.skipped }), options)
  await proofsSettled(albumPath)
  const result = { name, ms: performance.now() - start, historyBefore: initial, historyAfter: history(), events, ...extra }
  receipt.phases.push(result); save()
  process.stdout.write(JSON.stringify({ name, ms: result.ms, updated: events.filter(e => e.event === 'proofs.updated').length, failed: events.filter(e => e.event === 'proofs.failed' || e.error).length, history: result.historyAfter }) + '\n')
  if (events.some(e => e.event === 'proofs.failed' || e.error)) throw Error('Preview failed; see receipt')
}
async function main() {
  const start = performance.now(), model = await openAlbum({ path: albumPath })
  receipt.openMs = performance.now() - start
  receipt.photos = Object.keys(model.photos).length; receipt.spreads = model.spreads.length
  save()
  await refresh('cold-all')
  await refresh('warm-no-change')
  const spread = model.spreads.find(s => s.template && s.photoIds.some(id => model.photos[id].usedOn.length === 1))
  const id = spread.photoIds.find(id => model.photos[id].usedOn.length === 1)
  receipt.target = { spread: spread.n, photoUses: model.photos[id].usedOn.length }
  for (let i = 0; i < 3; i++) {
    const ops = [{ op: 'placePhoto', id, scale: i % 2 ? 1.1 : 1.15, ox: 0.05, oy: 0 }], begin = performance.now()
    const updated = await updateAlbum({ album: albumPath, ops }), editMs = performance.now() - begin
    const spreads = scope(ops, updated.album || updated)
    await refresh(`photo-edit-${i + 1}`, spreads ? { spreads } : undefined, { editMs })
  }
  if (label === 'after') {
    const folder = path.join(process.env.ALBUM_STUDIO_CACHE_DIR, '.album-studio-stage-history', 'preserved-test-work')
    fs.mkdirSync(folder, { recursive: true })
    const file = path.join(folder, 'sparse-history.bin'), fd = fs.openSync(file, 'wx')
    try { fs.ftruncateSync(fd, 8 * 1024 ** 3) } finally { fs.closeSync(fd) }
    const before = fs.statSync(file), ops = [{ op: 'placePhoto', id, scale: 1.2, ox: 0, oy: 0 }]
    const updated = await updateAlbum({ album: albumPath, ops }), spreads = scope(ops, updated.album || updated)
    await refresh('photo-edit-with-full-history', { spreads })
    const after = fs.statSync(file)
    receipt.fullHistoryPreserved = before.ino === after.ino && before.size === after.size
  }
  receipt.maxRssKiB = process.resourceUsage().maxRSS
  receipt.proofs = []
  const sharp = require(path.join(runtime, 'src/sharp_config')).getSharp()
  for (const name of fs.readdirSync(path.join(albumPath, 'proofs/pages')).filter(name => name.endsWith('.jpg'))) {
    const file = path.join(albumPath, 'proofs/pages', name), bytes = fs.readFileSync(file)
    const meta = await sharp(bytes).metadata()
    await sharp(bytes).raw().toBuffer()
    receipt.proofs.push({ name, width: meta.width, height: meta.height, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
  }
  receipt.finished = new Date().toISOString(); save()
}
main().catch(error => { receipt.error = error.stack; save(); process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
