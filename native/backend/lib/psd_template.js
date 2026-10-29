// psd_template.js — what a template looks like without opening an editor: its canvas size, its
// photo frames in drawing order with their shapes, and its own flattened image, scaled down and
// cached. Read with ag-psd once per template (about 0.1–0.3 s); afterwards it comes from the cache.
//
// The PSD's stored composite is what Photoshop drew, layer styles included, so it is a far better
// backdrop than the collection's 600 px preview images. Declared missing RGB composites are
// rendered by the engine; unsupported source colour fails with an actionable recovery message.
//
// In the sheet, each photo is clipped to its frame layer. So a frame's mask here is the frame's
// own shape (its pixels and its layer mask), times the layer's opacity, minus the frame's inside
// stroke, which templates draw over the photo (the backdrop shows it through). Rectangular,
// opaque, unstroked frames need no mask.

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { cacheRoot, contentFileKey, contentKey, fileDigest, writeAtomic } = require('./cache')
const { psdPixels, readPsdBuffer } = require('./color')

const SCHEMA = 6
/** Above this, layer pixels aren't decoded: frames are drawn as rectangles. */
const DECODE_BUDGET = 900 * 1024 * 1024

let agpsd = null
function getAgPsd() {
  if (agpsd) return agpsd
  agpsd = require('ag-psd')
  // ag-psd allocates ImageData through a canvas; it never draws, so a stub that hands out
  // buffers is enough (the same approach as src/psd_layers.js).
  agpsd.initializeCanvas((w, h) => ({
    width: w,
    height: h,
    getContext: () => ({
      createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }),
    }),
  }))
  return agpsd
}

const getSharp = () => require('../../../src/sharp_config').getSharp()
const proofDims = (w, h, maxEdge) => require('../../../src/proof_renderer').proofDims(w, h, maxEdge)

function frameOrient(name) {
  const n = String(name || '').toLowerCase()
  if (n.includes('toolkithframe')) return 'h'
  if (n.includes('toolkitvframe')) return 'v'
  return null
}

const hex = (c) =>
  '#' +
  [c.r, c.g, c.b]
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v || 0)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')

/** A frame's stroke effect: the border templates draw over the photo clipped into the frame. */
function frameStroke(effects) {
  if (!effects || effects.disabled) return null
  const s = (Array.isArray(effects.stroke) ? effects.stroke : [effects.stroke]).find(
    (x) => x && x.enabled && x.fillType !== 'gradient' && x.fillType !== 'pattern',
  )
  if (!s || !s.size || !(s.size.value > 0)) return null
  return {
    size: s.size.value,
    position: s.position || 'outside',
    color: hex(s.color || {}),
    opacity: typeof s.opacity === 'number' ? s.opacity : 1,
  }
}

/** Frames in drawing order (PSD storage order is bottom to top), each with its layer node. */
function collectFrames(nodes, out = [], hiddenParent = false) {
  for (const n of nodes || []) {
    const hidden = hiddenParent || !!n.hidden
    const orient = frameOrient(n.name)
    if (orient) {
      // A fill layer has no pixels of its own: its area is its mask's.
      let x = n.left || 0,
        y = n.top || 0,
        r = n.right || 0,
        b = n.bottom || 0
      if ((r - x <= 0 || b - y <= 0) && n.mask) {
        x = n.mask.left || 0
        y = n.mask.top || 0
        r = n.mask.right || 0
        b = n.mask.bottom || 0
      }
      if (r - x > 0 && b - y > 0) {
        const f = {
          name: n.name,
          orient,
          x,
          y,
          w: r - x,
          h: b - y,
          z: out.length,
          // The photo is clipped to the frame, so it takes the frame's opacity and visibility.
          opacity: typeof n.opacity === 'number' ? n.opacity : 1,
          hidden,
          stroke: frameStroke(n.effects),
          mask: null,
        }
        Object.defineProperty(f, 'node', { value: n, enumerable: false })
        out.push(f)
      }
    }
    if (n.children) collectFrames(n.children, out, hidden)
  }
  return out
}

/** The frame's shape at full size, one byte per pixel; null when it is a plain rectangle. */
function shapeAlpha(f) {
  const n = f.node
  const out = new Uint8Array(f.w * f.h).fill(255)
  let shaped = false
  const img = n.imageData
  if (img && img.width && img.height) {
    const lx = n.left || 0
    const ly = n.top || 0
    for (let y = 0; y < f.h; y++) {
      const sy = f.y + y - ly
      for (let x = 0; x < f.w; x++) {
        const sx = f.x + x - lx
        const a = sx >= 0 && sy >= 0 && sx < img.width && sy < img.height ? img.data[(sy * img.width + sx) * 4 + 3] : 0
        if (a < 255) {
          out[y * f.w + x] = a
          shaped = true
        }
      }
    }
  }
  const m = n.mask
  if (m && !m.disabled && m.imageData && m.imageData.width) {
    const md = m.imageData
    const mx = (m.left || 0) + (m.positionRelativeToLayer ? n.left || 0 : 0)
    const my = (m.top || 0) + (m.positionRelativeToLayer ? n.top || 0 : 0)
    const def = typeof m.defaultColor === 'number' ? m.defaultColor : 0
    for (let y = 0; y < f.h; y++) {
      const sy = f.y + y - my
      for (let x = 0; x < f.w; x++) {
        const sx = f.x + x - mx
        const v = sx >= 0 && sy >= 0 && sx < md.width && sy < md.height ? md.data[(sy * md.width + sx) * 4] : def
        if (v < 255) {
          const i = y * f.w + x
          out[i] = (out[i] * v + 127) / 255
          shaped = true
        }
      }
    }
  }
  return shaped ? out : null
}

/** Shrink a mask by `r` pixels from its edges (and from the edges of its box). */
function erode(a, w, h, r) {
  if (r < 1) return a
  const tmp = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 255
      for (let k = x - r; k <= x + r && m; k++) m = k < 0 || k >= w ? 0 : Math.min(m, a[y * w + k])
      tmp[y * w + x] = m
    }
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 255
      for (let k = y - r; k <= y + r && m; k++) m = k < 0 || k >= h ? 0 : Math.min(m, tmp[k * w + x])
      out[y * w + x] = m
    }
  }
  return out
}

/**
 * The mask the photo in frame `f` is drawn through, at proof size, as a white PNG whose alpha is
 * the mask; null when the photo is drawn whole.
 */
async function frameMask(f, scale, file) {
  const sharp = getSharp()
  const fw = Math.max(1, Math.round(f.w * scale))
  const fh = Math.max(1, Math.round(f.h * scale))
  const full = f.node.imageData || f.node.mask ? shapeAlpha(f) : null
  const s = f.stroke
  const revealStroke = !!(s && s.position === 'inside' && s.opacity >= 0.99)
  if (!full && !revealStroke && f.opacity >= 0.999) return false
  let a = full
    ? new Uint8Array(
        await sharp(Buffer.from(full.buffer), { raw: { width: f.w, height: f.h, channels: 1 } })
          .resize(fw, fh, { fit: 'fill' })
          .extractChannel(0)
          .raw()
          .toBuffer(),
      )
    : new Uint8Array(fw * fh).fill(255)
  if (revealStroke) a = erode(a, fw, fh, Math.round(s.size * scale))
  if (f.opacity < 0.999) for (let i = 0; i < a.length; i++) a[i] = Math.round(a[i] * f.opacity)
  const rgba = Buffer.alloc(fw * fh * 4, 255)
  for (let i = 0; i < a.length; i++) rgba[i * 4 + 3] = a[i]
  await writeAtomic(
    file,
    await sharp(rgba, { raw: { width: fw, height: fh, channels: 4 } })
      .png()
      .toBuffer(),
  )
  return revealStroke ? 'stroke' : true
}

/** The collection's way of pairing photos with frames: by name, H frames and V frames apart. */
function framesByName(frames, orient) {
  return frames.filter((f) => f.orient === orient).sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

/** Bytes a full decode would allocate: composite plus every layer's pixels. */
function decodeEstimate(outline) {
  let bytes = (outline.width || 0) * (outline.height || 0) * 4
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.children) {
        walk(n.children)
        continue
      }
      bytes += Math.max(0, (n.right || 0) - (n.left || 0)) * Math.max(0, (n.bottom || 0) - (n.top || 0)) * 4
      if (n.mask)
        bytes +=
          Math.max(0, (n.mask.right || 0) - (n.mask.left || 0)) *
          Math.max(0, (n.mask.bottom || 0) - (n.mask.top || 0)) *
          4
    }
  }
  walk(outline.children)
  return bytes
}

const inflight = new Map()

/**
 * @param {string} psdPath
 * @param {number} [maxEdge]  the proof's longest side
 * @returns {Promise<TemplateArt>}
 * @typedef {{ schema: number, sourceKey: string, width: number, height: number, scale: number, frames: Frame[],
 *   backdrop: string|null, artifactDigests: Record<string, string> }} TemplateArt
 * @typedef {{ name: string, orient: 'h'|'v', x: number, y: number, w: number, h: number, z: number,
 *   opacity: number, hidden: boolean, mask: string|null,
 *   stroke: { size: number, position: string, color: string, opacity: number, revealed?: boolean } | null }} Frame
 */
async function templateArt(psdPath, maxEdge = 2400, { sourceDigest } = {}) {
  const st = await fs.promises.stat(psdPath).catch(() => null)
  if (!st) throw new Error(`The template ${path.basename(psdPath)} isn't on disk.`)
  // A preview already captured the expected source revision and verifies it again before
  // publishing. Reuse that evidence instead of hashing the same PSD repeatedly here.
  const key = sourceDigest ? contentKey(psdPath, sourceDigest) : await contentFileKey(psdPath)
  const dir = path.join(cacheRoot(), 'templates', key)
  const infoFile = path.join(dir, `art-${maxEdge}.json`)
  if (inflight.has(infoFile)) return inflight.get(infoFile)
  const job = (async () => {
    try {
      const cached = JSON.parse(await fs.promises.readFile(infoFile, 'utf8'))
      const files = [cached.backdrop, ...cached.frames.map((f) => f.mask)].filter(Boolean)
      const allowed = (p) =>
        p === path.join(dir, `backdrop-${maxEdge}.jpg`) ||
        (path.dirname(p) === dir && /^mask-[0-9]+-[0-9]+\.png$/.test(path.basename(p)))
      if (
        cached.schema === SCHEMA &&
        cached.sourceKey === key &&
        files.every(allowed) &&
        cached.artifactDigests &&
        (await Promise.all(files.map(async (p) => cached.artifactDigests[p] === (await fileDigest(p))))).every(Boolean)
      ) {
        if (!sourceDigest && (await contentFileKey(psdPath)) !== key)
          throw new Error('The template changed while its cached backdrop was checked. Retry from a stable source.')
        return cached
      }
    } catch (_) {
      /* not cached yet */
    }
    const ag = getAgPsd()
    const buf = await readPsdBuffer(psdPath)
    const decodedDigest = crypto.createHash('sha256').update(buf).digest('hex')
    if (contentKey(psdPath, decodedDigest) !== key)
      throw new Error('The template changed before its verified bytes were read. Retry from a stable original.')
    const cmyk = buf.length >= 26 && buf.readUInt16BE(24) === 4
    // ag-psd refuses CMYK at its header before metadata parsing. Only the colour-mode
    // header in this private metadata copy is substituted; no colour samples are read here.
    const metadata = cmyk ? Buffer.from(buf) : buf
    if (cmyk) metadata.writeUInt16BE(3, 24)
    const outline = ag.readPsd(metadata, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
    })
    const withPixels =
      !cmyk && outline.bitsPerChannel === 8 && !!outline.children?.length && decodeEstimate(outline) <= DECODE_BUDGET
    const psd = withPixels
      ? ag.readPsd(metadata, {
          skipLayerImageData: false,
          skipCompositeImageData: true,
          skipThumbnail: true,
          useImageData: true,
        })
      : outline
    const { scale } = proofDims(psd.width, psd.height, maxEdge)
    const frames = collectFrames(psd.children)
    if (cmyk && frames.length)
      throw new Error(
        'CMYK template frame masks cannot yet be verified. Convert and save the template as RGB before using it for album proofs.',
      )
    if (outline.bitsPerChannel !== 8 && frames.length)
      throw new Error(
        'High-depth template frame masks cannot yet be verified. Convert and save the template as 8-bit RGB before using it for album proofs.',
      )
    for (const f of frames) {
      if (f.hidden) continue
      const file = path.join(dir, `mask-${maxEdge}-${f.z}.png`)
      const made = withPixels ? await frameMask(f, scale, file) : false
      if (made) f.mask = file
      if (made === 'stroke') f.stroke.revealed = true
    }
    /** @type {TemplateArt} */
    const art = {
      schema: SCHEMA,
      sourceKey: key,
      width: psd.width,
      height: psd.height,
      scale,
      frames,
      backdrop: null,
      artifactDigests: {}, // set once the backdrop and masks exist
    }
    const source = await psdPixels(psdPath, { buffer: buf, inMemory: true })
    {
      const sharp = getSharp()
      try {
        const jpeg = await sharp(source.input, { ...(source.raw ? { raw: source.raw } : {}), failOn: 'warning' })
          .withIccProfile('srgb')
          .resize(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)), {
            fit: 'fill',
          })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality: 90, mozjpeg: true })
          .toBuffer()
        art.backdrop = path.join(dir, `backdrop-${maxEdge}.jpg`)
        await writeAtomic(art.backdrop, jpeg)
      } finally {
        if (source.cleanup) await source.cleanup()
      }
    }
    if ((await contentFileKey(psdPath)) !== key)
      throw new Error('The template changed while its backdrop was made. Retry from a stable source.')
    art.artifactDigests = Object.fromEntries(
      await Promise.all(
        [art.backdrop, ...art.frames.map((f) => f.mask)].filter(Boolean).map(async (p) => [p, await fileDigest(p)]),
      ),
    )
    await writeAtomic(infoFile, JSON.stringify(art))
    return art
  })()
  inflight.set(infoFile, job)
  try {
    return await job
  } finally {
    inflight.delete(infoFile)
  }
}

module.exports = { templateArt, framesByName, collectFrames, erode }
