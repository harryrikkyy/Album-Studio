// proofs.js — live previews of spreads ("proofs"): the template's own flattened image with the
// spread's photos cropped into its frames, written where the Electron app keeps them
// (<album>/proofs/pages/live_page_NNN.jpg) so both apps show the same picture.
//
// Proofs refresh in the background after every edit. Only spreads whose look changed are redrawn
// (a manifest next to the files records what each one shows); a spread that only moved keeps its
// picture; a proof made from a rendered sheet is kept until its spread changes. Photos are drawn
// in the template's own layer order, so a small frame laid over a bigger one stays on top.
// Each finished proof is announced as a `proofs.updated` event.

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { openAlbum } = require('./album')
const { cacheRoot, fileDigest, readVerifiedBuffer, contentKey, writeAtomic } = require('./cache')
const { withPrivateStage } = require('./private_stage')
const { renameExclusive } = require('./exclusive_rename')
const { inputsHash, spreadInputs, hashInputValues } = require('./inputs')
const { templateArt, framesByName } = require('./psd_template')
const { isRaw, previewable, readEvidence } = require('./raw')

/** Bump when proofs are drawn differently, so every proof is redrawn once. */
const PROOF_VERSION = 'proof-4-buffered'
const MAX_EDGE = 2400
const MANIFEST = '.album-studio-proofs.json'
const SHARP_READS = /\.(jpe?g|png|tiff?|webp|avif|heic|heif)$/i

const proofRenderer = () => require('../../../src/proof_renderer')
const getSharp = () => require('../../../src/sharp_config').getSharp()

const proofDir = (albumDir) => path.join(albumDir, 'proofs', 'pages')
const proofPath = (albumDir, n) => path.join(proofDir(albumDir), `live_page_${String(n).padStart(3, '0')}.jpg`)

async function optionalDigest(file) {
  if (!file) return null
  try {
    return await fileDigest(file)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

/** Retain the exact file removed from a mutable proof name, including unexpected edits. */
async function preserveProof(albumDir, file) {
  await require('./output_paths').validateProofPaths(albumDir)
  const history = path.join(albumDir, 'proofs', '.album-studio-history')
  await fs.promises.mkdir(history, { recursive: true, mode: 0o700 })
  for (const dir of [path.dirname(history), history]) {
    const st = await fs.promises.lstat(dir)
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new Error('Proof recovery folders must be real directories. Preserve existing files before retrying.')
  }
  const target = path.join(history, `${path.basename(file, '.jpg')}-${crypto.randomUUID()}.jpg`)
  try {
    await renameExclusive(file, target)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
}

function proofHash(spread, album, ws) {
  return inputsHash([PROOF_VERSION, MAX_EDGE], spread, album, ws)
}
const proofInputHash = (values) => hashInputValues([PROOF_VERSION, MAX_EDGE], values)

// ── manifest: what each proof file shows ────────────────────────────────────

const manifests = new Map() // album folder → Promise<{ file, data, chain }>

function manifestOf(albumDir) {
  if (!manifests.has(albumDir)) {
    manifests.set(
      albumDir,
      (async () => {
        const file = path.join(proofDir(albumDir), MANIFEST)
        let data = { version: 1, spreads: {} }
        try {
          const d = JSON.parse(await fs.promises.readFile(file, 'utf8'))
          if (d && d.spreads && typeof d.spreads === 'object') data = d
        } catch (_) {
          /* first proofs of this album */
        }
        return { file, data, albumDir, chain: Promise.resolve() }
      })(),
    )
  }
  return manifests.get(albumDir)
}

function saveManifest(m) {
  const text = JSON.stringify(m.data)
  const saved = m.chain.then(async () => {
    await require('./output_paths').validateProofPaths(m.albumDir)
    await writeAtomic(m.file, text)
  })
  m.chain = saved.catch(() => {})
  return saved
}

async function freshManifest(albumDir) {
  await require('./output_paths').validateProofPaths(albumDir)
  const m = await manifestOf(albumDir)
  await m.chain
  const data = await readEvidence(m.file, 64 * 1024 * 1024)
  if (data && (!data.spreads || typeof data.spreads !== 'object' || Array.isArray(data.spreads)))
    throw new Error(`The proof manifest ${m.file} is invalid. Preserve it before refreshing.`)
  m.data = data || { version: 1, spreads: {} }
  return m
}

/**
 * A rendered sheet's own image became spread n's proof: it is current until the spread changes,
 * or until the sheet is saved again from the editor (then the proof is redrawn from it).
 * @param {{ proof?: string, expectedHash?: string, projectText?: string,
 *   lease?: { assertOwned: () => unknown, outputNamespace?: { assertFor: (folder: string) => unknown } } }} [options]
 */
async function recordSheetProof(album, ws, spread, sheetPath, options = {}) {
  const { proof, expectedHash, projectText, lease } = options
  if (!lease)
    return require('./project').withProjectLease(
      album.file,
      ({ lease: held }) =>
        recordSheetProof(album, ws, spread, sheetPath, { proof, expectedHash, projectText, lease: held }),
      { kind: 'sheet-proof' },
    )
  if (!lease.outputNamespace)
    return require('./output_lock').withProjectOutputs(
      lease,
      () => recordSheetProof(album, ws, spread, sheetPath, { proof, expectedHash, projectText, lease }),
      { kind: 'sheet-proof' },
    )
  await lease.outputNamespace.assertFor(ws.outputToken || path.join(album.path, 'exports'))
  await lease.assertOwned()
  await require('./output_paths').validateProofPaths(album.path)
  const m = await freshManifest(album.path)
  const hash = await proofHash(spread, album, ws)
  if (
    (expectedHash && expectedHash !== hash) ||
    (projectText !== undefined && (await fs.promises.readFile(album.file, 'utf8')) !== projectText)
  )
    throw new Error('The project or proof sources changed before publication. Retry from the current revision.')
  const digest = await optionalDigest(proof || proofPath(album.path, spread.n))
  await lease.assertOwned()
  if (proof) {
    await preserveProof(album.path, proofPath(album.path, spread.n))
    await renameExclusive(proof, proofPath(album.path, spread.n))
    if ((await fileDigest(proofPath(album.path, spread.n))) !== digest)
      throw new Error('The sheet proof changed during publication; preserve it before retrying.')
  }
  m.data.spreads[spread.n] = {
    id: spread.id,
    hash: expectedHash || hash,
    source: 'sheet',
    sheetPath,
    sheetDigest: await optionalDigest(sheetPath),
    digest,
  }
  await saveManifest(m)
}

/** A verified sheet composite decoded without retaining another full-size source copy. */
async function bufferedSheetProof(sheetPath, digest) {
  const bytes = await readVerifiedBuffer(sheetPath, digest || (await fileDigest(sheetPath)))
  const px = await require('./color').psdPixels(sheetPath, { buffer: bytes, inMemory: true })
  try {
    const jpeg = await getSharp()(px.input, px.raw ? { raw: px.raw } : { failOn: 'warning' })
      .withIccProfile('srgb')
      .flatten({ background: '#ffffff' })
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside' })
      .jpeg({ quality: 85 })
      .toBuffer()
    return jpeg
  } finally {
    if (px.cleanup) await px.cleanup()
  }
}

// ── drawing ─────────────────────────────────────────────────────────────────

/** Fit a photo layer to the canvas: frames may run off the page edge. */
async function clipToCanvas(sharp, layer, W, H) {
  const meta = await sharp(layer.input).metadata()
  const x0 = Math.max(0, -layer.left)
  const y0 = Math.max(0, -layer.top)
  const x1 = Math.min(meta.width, W - layer.left)
  const y1 = Math.min(meta.height, H - layer.top)
  if (x1 <= x0 || y1 <= y0) return null
  if (x0 === 0 && y0 === 0 && x1 === meta.width && y1 === meta.height) return layer
  const input = await sharp(layer.input)
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .toBuffer()
  return { input, left: layer.left + x0, top: layer.top + y0 }
}

/**
 * A frame's stroke as a small SVG layer. Templates stroke the frame layer, and Photoshop draws a
 * clipping base's stroke over the photos clipped to it, so it goes right above the photo.
 */
function strokeLayer(frame, scale) {
  const s = frame.stroke
  if (!s || !(s.size > 0)) return null
  const sw = Math.max(1, s.size * scale)
  // How far the stroke's centre line sits outside the frame's edge.
  const off = s.position === 'inside' ? -sw / 2 : s.position === 'center' ? 0 : sw / 2
  const x = frame.x * scale
  const y = frame.y * scale
  const w = frame.w * scale + 2 * off
  const h = frame.h * scale + 2 * off
  if (w <= 0 || h <= 0) return null
  const pad = Math.ceil(Math.max(0, off) + sw / 2) + 1
  const left = Math.floor(x) - pad
  const top = Math.floor(y) - pad
  const width = Math.ceil(frame.w * scale) + 2 * pad + 1
  const height = Math.ceil(frame.h * scale) + 2 * pad + 1
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="${(x - left - off).toFixed(2)}" y="${(y - top - off).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"` +
    ` fill="none" stroke="${s.color}" stroke-opacity="${(s.opacity * frame.opacity).toFixed(3)}" stroke-width="${sw.toFixed(2)}"/></svg>`
  return { input: Buffer.from(svg), left, top }
}

/** The file a photo is drawn from, and the turn it needs on top of the user's rotation. */
async function photoSource(ph, dirs) {
  if (ph.original && isRaw(ph.original)) {
    const r = await previewable(ph.original, dirs)
    if (r) return r
  } else if (ph.original && SHARP_READS.test(ph.original)) {
    return { file: ph.original, rotation: 0 }
  }
  return { file: ph.thumb, rotation: 0 }
}

/**
 * Which photo goes in which frame, as in the sheet: by frame name, H and V apart, photos in the
 * spread's order. Returned in drawing order.
 * @template {{ orient: string }} P
 * @param {any[]} frames
 * @param {P[]} photos
 * @returns {{ frame: any, photo: P }[]}
 */
function pairFrames(frames, photos) {
  const pairs = []
  for (const orient of ['h', 'v']) {
    const list = photos.filter((p) => p.orient === orient)
    const fr = framesByName(frames, orient)
    for (let i = 0; i < Math.min(fr.length, list.length); i++) pairs.push({ frame: fr[i], photo: list[i] })
  }
  return pairs.sort((a, b) => a.frame.z - b.frame.z)
}

/**
 * Where spread n's frames are (as fractions of the page, so the interface can lay them over any
 * size of preview) and which photo each one shows.
 */
async function spreadLayout({ album: albumPath, n }) {
  if (!albumPath) throw new Error('missing `album`')
  const album = await openAlbum({ path: albumPath })
  const s = album.spreads[Number(n) - 1]
  if (!s) throw new Error(`There is no spread ${n}.`)
  if (!s.template || !s.template.file)
    return {
      n: s.n,
      template: s.template ? s.template.id : null,
      width: null,
      height: null,
      backdrop: null,
      frames: [],
      unplaced: s.photoIds,
    }
  const art = await templateArt(s.template.file, MAX_EDGE)
  /** @type {Array<{ id: string, orient: 'h' | 'v' }>} */
  const photos = s.photoIds
    .filter((id) => album.photos[id])
    .map((id) => ({ id, orient: album.photos[id].orient === 'v' ? 'v' : 'h' }))
  const byFrame = new Map(pairFrames(art.frames, photos).map((p) => [p.frame.z, p.photo.id]))
  const placed = new Set(byFrame.values())
  return {
    n: s.n,
    template: s.template.id,
    width: art.width,
    height: art.height,
    backdrop: art.backdrop,
    frames: art.frames
      .filter((f) => !f.hidden)
      .map((f) => ({
        name: f.name,
        orient: f.orient,
        x: f.x / art.width,
        y: f.y / art.height,
        w: f.w / art.width,
        h: f.h / art.height,
        z: f.z,
        photoId: byFrame.get(f.z) || null,
      })),
    unplaced: photos.filter((p) => !placed.has(p.id)).map((p) => p.id),
  }
}

/**
 * Draw spread `spread` to `out`.
 * @param {{ buffered?: boolean, inputs?: Awaited<ReturnType<typeof spreadInputs>> }} [options]
 * @returns {Promise<{ skipped: string[], jpeg?: Buffer }>}
 */
async function drawProof(spread, album, ws, out, options = {}) {
  const { buffered = false, inputs } = options
  // The legacy layer renderer consumes filesystem paths. Keep its exact snapshot policy;
  // ordinary interactive proofs need no persistent decoder copies or cleanup at all.
  const layerEdits = (ws.pageLayerEdits || {})[spread.n] || null
  if (buffered && layerEdits && Object.keys(layerEdits).length) return drawProof(spread, album, ws, out, { inputs })
  const draw = async (sourceStage) => {
    const inputValues = inputs || (await spreadInputs(spread, album, ws))
    const template = buffered ? null : await sourceStage.snapshot(spread.template.file, inputValues[1])
    const sharp = getSharp()
    const pr = proofRenderer()
    const n = spread.n
    const originalArt = await templateArt(
      spread.template.file,
      MAX_EDGE,
      buffered ? { sourceDigest: inputValues[1] } : undefined,
    )
    if (originalArt.sourceKey !== contentKey(spread.template.file, inputValues[1]))
      throw new Error('The template changed before its proof snapshot was made.')
    const art = { ...originalArt, frames: originalArt.frames.map((f) => ({ ...f })) }
    if (art.backdrop) art.backdrop = await sourceStage.snapshot(art.backdrop, originalArt.artifactDigests[art.backdrop])
    for (const f of art.frames)
      if (f.mask) f.mask = await sourceStage.snapshot(f.mask, originalArt.artifactDigests[f.mask])
    const dims = pr.proofDims(art.width, art.height, MAX_EDGE)
    const dirs = {
      developedDir: path.join(ws.outputToken || path.join(album.path, 'exports'), '.album-studio', 'raw'),
      previewDir: path.join(cacheRoot(), 'raw-previews'),
    }

    const photos = []
    for (const id of spread.photoIds) {
      const ph = album.photos[id]
      if (!ph) continue // gone from disk: its frame keeps the template's placeholder, as in the sheet
      const src = await photoSource(ph, dirs)
      const expected = inputValues[2].find((v) => v[0] === id)[2]
      if (src.sourceKey && src.sourceKey !== contentKey(ph.original || ph.thumb, expected))
        throw new Error('The photo changed before its proof snapshot was made.')
      const frozen = await sourceStage.snapshot(src.file, src.digest || expected)
      photos.push({
        filePath: frozen,
        fallbackPath: null,
        orient: ph.orient === 'v' ? 'v' : 'h',
        rotation: (src.rotation + (Number((ws.imageRotations || {})[id]) || 0)) % 360,
        placement: (ws.imagePlacements || {})[id] || null,
        adjust: (ws.imageAdjustments || {})[id] || null,
        fastEncode: buffered,
      })
    }
    const overlays = (ws.pageOverlays || {})[n] || []
    const background = (ws.pageBackgrounds || {})[n] || null

    // Template layers switched off or retyped: the shared proof renderer (src/proof_renderer.js)
    // rebuilds the page from the PSD's layer stack, so hand those spreads to it unchanged.
    if (layerEdits && Object.keys(layerEdits).length) {
      const tree = await require('../../../src/psd_layers').readPsdLayerTree(template)
      const r = await pr.renderPageProof({
        templatePath: template,
        templatePreviewPath: art.backdrop || spread.template.preview,
        frames: art.frames,
        canvasWidth: art.width,
        canvasHeight: art.height,
        photos,
        outputPath: path.join(sourceStage.path, 'proof.jpg'),
        maxEdge: MAX_EDGE,
        smartCrop: false,
        overlays,
        pageBackground: background,
        layerEdits,
        psdLayers: tree && tree.ok ? tree.layers : null,
      })
      if (!r.ok) throw new Error(r.error)
      const generated = path.join(sourceStage.path, 'proof.jpg')
      await sourceStage.register(generated)
      await renameExclusive(generated, out)
      sourceStage.forget(generated)
      return { skipped: (r.skipped || []).map((s) => s.error) }
    }

    const W = dims.width
    const H = dims.height
    const backdrop = art.backdrop || spread.template.preview
    let base = backdrop
      ? sharp(backdrop, { failOn: 'none' }).resize(W, H, { fit: 'fill' })
      : sharp({
          create: {
            width: W,
            height: H,
            channels: 3,
            background: pr.parseHexColor(background) || { r: 255, g: 255, b: 255 },
          },
        })

    const pairs = pairFrames(art.frames, photos)
    const skipped = []
    const renderFrame = async ({ frame, photo }) => {
      if (frame.hidden) return [] // clipped to a hidden layer: hidden in the sheet too
      try {
        const layer = await pr.buildPhotoLayer(sharp, photo, frame, dims.scale, false)
        if (frame.mask) {
          // The frame's shape, opacity and inside stroke, all in one alpha mask.
          layer.input = await sharp(layer.input)
            .ensureAlpha()
            .composite([{ input: frame.mask, blend: 'dest-in' }])
            .png()
            .toBuffer()
        } else if (frame.opacity < 1) {
          layer.input = await sharp(layer.input).ensureAlpha(frame.opacity).png().toBuffer()
        }
        const stroke = frame.stroke && !frame.stroke.revealed ? strokeLayer(frame, dims.scale) : null
        return [await clipToCanvas(sharp, layer, W, H), stroke && (await clipToCanvas(sharp, stroke, W, H))]
      } catch (e) {
        skipped.push(e.message)
        return []
      }
    }
    const drawn = []
    // A bounded number of decoders avoids multiplying full-resolution pixel allocations.
    for (let i = 0; i < pairs.length; i += 3) drawn.push(...(await Promise.all(pairs.slice(i, i + 3).map(renderFrame))))
    const layers = drawn.flat().filter(Boolean)

    const svg = require('../../../src/overlay_render').buildOverlaySvg(overlays, W, H)
    if (svg) layers.push({ input: Buffer.from(svg), top: 0, left: 0 })

    const tmp = buffered ? out : path.join(sourceStage.path, 'proof.jpg')
    if (!buffered) await fs.promises.mkdir(path.dirname(out), { recursive: true })
    if (layers.length) base = sharp(await base.toBuffer()).composite(layers)
    if (buffered) return { skipped, jpeg: await base.jpeg({ quality: 85 }).toBuffer() }
    else {
      await base.jpeg({ quality: 85, mozjpeg: true }).toFile(tmp)
      await sourceStage.register(tmp)
      await renameExclusive(tmp, out)
      sourceStage.forget(tmp)
    }
    return { skipped }
  }
  if (!buffered) return withPrivateStage(cacheRoot(), 'proof-sources-', draw)
  let total = 0
  return draw({
    snapshot: async (file, digest) => {
      const remaining = 256 * 1024 * 1024 - total
      if (remaining < 1)
        throw new Error('This preview exceeds its 256 MiB source-buffer budget. Use smaller photo proxies.')
      const bytes = await readVerifiedBuffer(file, digest, remaining)
      total += bytes.length
      return bytes
    },
  })
}

// ── refreshing ──────────────────────────────────────────────────────────────

const runners = new Map() // album folder → { running, again, emit }
let decoding = false
const decoderWaiters = []
async function previewDecoder(work) {
  if (decoding) await new Promise((resolve) => decoderWaiters.push(resolve))
  decoding = true
  try {
    return await work()
  } finally {
    const next = decoderWaiters.shift()
    if (next) next()
    else decoding = false
  }
}

/**
 * Bring every proof of an album up to date, in the background. Calls made while a refresh runs
 * fold into one more pass, so a burst of edits costs one refresh, not one each.
 * @param {string} albumPath
 * @param {(event: string, data: object) => void} emit
 * @param {{ spreads?: number[] }} [options]
 */
function refreshProofs(albumPath, emit, { spreads } = {}) {
  const key = path.resolve(albumPath)
  const targets = spreads ? new Set(spreads) : null
  let r = runners.get(key)
  if (!r) runners.set(key, (r = { running: null, again: false, emit, targets }))
  r.emit = emit
  if (r.running) {
    r.again = true
    r.targets = r.targets && targets ? new Set([...r.targets, ...targets]) : null
    return { queued: true }
  }
  r.targets = targets
  r.running = (async () => {
    try {
      do {
        r.again = false
        await refreshOnce(albumPath, r).catch((e) => r.emit('proofs.idle', { album: key, error: e.message }))
      } while (r.again)
    } finally {
      r.running = null
      if (runners.get(key) === r) runners.delete(key)
    }
  })()
  return { queued: true }
}

/** Resolves when the album has no refresh running (for tests and shutdown). */
async function proofsSettled(albumPath) {
  const r = runners.get(path.resolve(albumPath))
  while (r && r.running) await r.running
}

async function proofLease(albumPath, work) {
  return require('./project').withProjectLease(
    albumPath,
    ({ file, lease }) =>
      require('./output_lock').withProjectOutputs(lease, () => work(file, lease), { kind: 'proof-refresh' }),
    { kind: 'proof-refresh' },
  )
}

async function refreshOnce(albumPath, r) {
  // Capture the project quickly. Source verification and pixel decoding do not own the edit
  // queue; a newer project is detected before publication and rendered by the next pass.
  const captured = await proofLease(albumPath, async (file) => ({
    file,
    text: await fs.promises.readFile(file, 'utf8'),
  }))
  const plan = await prepareRefresh(captured.file, captured.text, r.targets)
  const { album, ws, projectText, todo, reuse, removed } = plan
  const stale = () => {
    r.again = true
    r.targets = null
  }
  let rendered = 0,
    failed = 0
  if (removed.length)
    await proofLease(album.file, async (_file, lease) => {
      if ((await fs.promises.readFile(album.file, 'utf8')) !== projectText) {
        stale()
        return
      }
      const m = await freshManifest(album.path)
      for (const n of removed) {
        await lease.assertOwned()
        await preserveProof(album.path, proofPath(album.path, n))
        delete m.data.spreads[n]
      }
      await saveManifest(m)
    })
  for (const t of todo) {
    if (r.again) break
    const n = t.s.n,
      out = proofPath(album.path, n),
      started = Date.now(),
      re = reuse.get(n)
    let skipped = [],
      jpeg,
      source
    try {
      const layers = (ws.pageLayerEdits || {})[n]
      const legacyLayers = layers && Object.keys(layers).length
      if (!t.remove && !legacyLayers) {
        await previewDecoder(async () => {
          if (r.again) return
          if (re) jpeg = re.buf
          else if (t.fromSheet) jpeg = await bufferedSheetProof(t.fromSheet, t.sheetDigest)
          else ({ skipped, jpeg } = await drawProof(t.s, album, ws, null, { buffered: true, inputs: t.inputs }))
        })
      }
      const published = await proofLease(album.file, async (_file, lease) => {
        if (r.again || (await fs.promises.readFile(album.file, 'utf8')) !== projectText) {
          stale()
          return false
        }
        const m = await freshManifest(album.path)
        // A native save or another producer may have replaced this proof while decoding.
        if (JSON.stringify(m.data.spreads[n]) !== t.previous) {
          stale()
          return false
        }
        if (t.remove) {
          await lease.assertOwned()
          await preserveProof(album.path, out)
          delete m.data.spreads[n]
          await saveManifest(m)
          return true
        }
        if (
          (await proofHash(t.s, album, ws)) !== t.hash ||
          (t.fromSheet && (await optionalDigest(t.fromSheet)) !== t.sheetDigest)
        ) {
          stale()
          return false
        }
        const ready = await withPrivateStage(path.dirname(out), '.proof-publication-', async (stage) => {
          const staging = path.join(stage.path, 'proof.jpg')
          if (jpeg) await fs.promises.writeFile(staging, jpeg, { flag: 'wx' })
          else ({ skipped } = await drawProof(t.s, album, ws, staging, { inputs: t.inputs }))
          await stage.register(staging)
          // The legacy layer path still consumes snapshots under this lease.
          if (
            (await fs.promises.readFile(album.file, 'utf8')) !== projectText ||
            (await proofHash(t.s, album, ws)) !== t.hash
          ) {
            stale()
            return
          }
          const digest = await fileDigest(staging)
          await lease.assertOwned()
          await preserveProof(album.path, out)
          await renameExclusive(staging, out)
          stage.forget(staging)
          m.data.spreads[n] = t.fromSheet
            ? { id: t.s.id, hash: t.hash, digest, source: 'sheet', sheetPath: t.fromSheet, sheetDigest: t.sheetDigest }
            : {
                id: t.s.id,
                hash: t.hash,
                digest,
                source: re ? re.source : 'live',
                ...(re && re.source === 'sheet' ? { sheetDigest: re.sheetDigest, sheetPath: re.sheetPath } : {}),
              }
          source = m.data.spreads[n].source
          return true
        })
        if (!ready) return false
        await saveManifest(m)
        return true
      })
      if (!published) break
      rendered++
      r.emit('proofs.updated', {
        album: album.path,
        n,
        proof: t.remove ? null : out,
        ...(source ? { source } : {}),
        ms: Date.now() - started,
        skipped,
      })
    } catch (error) {
      failed++
      r.emit('proofs.failed', { album: album.path, n, error: error.message || String(error) })
      if (error.code === 'PRIVATE_STAGE_BUDGET') break
    }
  }
  if (!r.again) r.emit('proofs.idle', { album: album.path, rendered, failed })
}

async function prepareRefresh(albumPath, projectText, targets) {
  await require('./output_paths').validateProofPaths(path.dirname(albumPath))
  const data = JSON.parse(projectText),
    album = await openAlbum({ path: albumPath }, { data }),
    ws = data.workspace || data
  const m = await freshManifest(album.path),
    known = m.data.spreads
  const selected = album.spreads.filter((s) => !targets || targets.has(s.n))
  const values = new Map(
    await Promise.all(selected.map(async (s) => /** @type {const} */ ([s.n, await spreadInputs(s, album, ws)]))),
  )
  const hashes = new Map([...values].map(([n, inputs]) => [n, proofInputHash(inputs)]))

  // Pictures already drawn, by what they show; read before anything is overwritten, so a spread
  // that moved takes its picture along instead of being drawn again.
  const byHash = new Map(),
    byId = new Map()
  for (const [n, e] of Object.entries(known)) {
    if (!e || !e.hash) continue
    if (e.id) byId.set(e.id, Number(n))
    if (e.source !== 'sheet' && !byHash.has(e.hash)) byHash.set(e.hash, Number(n))
  }

  /**
   * @type {Array<{ s: (typeof selected)[number], remove?: boolean, hash?: string, fromSheet?: string,
   *   sheetDigest?: string | null, inputs?: ReturnType<typeof values.get>, previous?: string }>}
   */
  const todo = []
  for (const s of selected) {
    const e = known[s.n]
    if (!s.template) {
      // An empty spread has no picture: an old one would show photos it no longer has.
      if (e || s.proof === proofPath(album.path, s.n)) todo.push({ s, remove: true })
    } else if (e && e.hash === hashes.get(s.n) && (e.id === s.id || (!e.id && e.source !== 'sheet'))) {
      if (!e.digest || (await optionalDigest(proofPath(album.path, s.n))) !== e.digest) {
        todo.push({
          s,
          hash: hashes.get(s.n),
          ...(e.source === 'sheet' && s.sheet
            ? { fromSheet: s.sheet, sheetDigest: await optionalDigest(s.sheet) }
            : {}),
        })
        continue
      }
      // A sheet saved from the editor since its proof was made: show what the sheet looks like now.
      if (e.source === 'sheet' && s.sheet) {
        const digest = await optionalDigest(s.sheet)
        if (digest !== e.sheetDigest || e.sheetPath !== s.sheet)
          todo.push({ s, hash: hashes.get(s.n), fromSheet: s.sheet, sheetDigest: digest })
      }
      continue
    } else if (s.template.file) {
      todo.push({ s, hash: hashes.get(s.n) })
    }
    // A template that isn't on disk (drive unplugged): keep whatever picture there is.
  }
  const reuse = new Map()
  for (const t of todo) {
    const identityFrom = byId.get(t.s.id)
    const source = identityFrom && known[identityFrom]
    const from = source && source.hash === t.hash ? identityFrom : t.hash && byHash.get(t.hash)
    if (from && from !== t.s.n) {
      // A hand-edited sheet is specific to this persistent spread, even when Plan inputs match.
      if (known[from].source === 'sheet') {
        const digest = await optionalDigest(t.s.sheet)
        if (known[from].sheetPath !== t.s.sheet || known[from].sheetDigest !== digest) {
          if (t.s.sheet) {
            t.fromSheet = t.s.sheet
            t.sheetDigest = digest
          }
          continue
        }
      }
      const buf = await fs.promises.readFile(proofPath(album.path, from)).catch(() => null)
      if (buf && known[from].digest === crypto.createHash('sha256').update(buf).digest('hex'))
        reuse.set(t.s.n, {
          buf,
          source: known[from].source,
          sheetDigest: known[from].sheetDigest,
          sheetPath: known[from].sheetPath,
        })
    } else if (t.s.sheet) {
      const record = await require('./sheets').ownedSheetRecord(ws, album.path, t.s.id)
      if (
        require('./sheets').verifiedSheetRecord(record) &&
        record.hash === (await require('./render_inputs').spreadHash(t.s, album, ws))
      ) {
        t.fromSheet = t.s.sheet
        t.sheetDigest = await optionalDigest(t.s.sheet)
      }
    }
  }
  const removed = Object.keys(known)
    .map(Number)
    .filter((n) => n > album.spreads.length)
  for (const t of todo) {
    t.inputs = values.get(t.s.n)
    t.previous = JSON.stringify(known[t.s.n])
  }
  return { album, ws, projectText, todo, reuse, removed }
}

module.exports = {
  refreshProofs,
  proofsSettled,
  recordSheetProof,
  drawProof,
  proofHash,
  proofInputHash,
  spreadLayout,
  pairFrames,
  PROOF_VERSION,
}
