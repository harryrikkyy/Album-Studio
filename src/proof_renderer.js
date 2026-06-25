// proof_renderer.js
//
// Fast page composite renderer. Runs in the Electron main process so we can
// use sharp / libvips (native binaries unavailable to the UXP renderer
// sandbox).
//
// Job model:
//   {
//     templatePath: '/abs/path/to/template.psd',  // used only for hash + frame cache key
//     templatePreviewPath: '/abs/path/to/template-preview.jpg',  // backdrop for the composite
//     frames: [                                    // pre-extracted from the PSD layer naming convention
//       { name: 'toolkithframe1', x, y, w, h },
//       { name: 'toolkitvframe2', x, y, w, h },
//     ],
//     canvasWidth, canvasHeight,                   // PSD doc dimensions in px
//     photos: [                                    // sorted by orient first (h then v), like build_page.jsx
//       { filePath, orient: 'h'|'v', rotation: 0|90|180|270 }
//     ],
//     outputPath,                                  // where to write the JPEG
//     maxEdge: 1500                                // proof edge size in px (longest side)
//   }
//
// Why frames come pre-extracted: parsing PSD layer bounds in Node would mean
// shipping a PSD reader. Instead the renderer reads them once via the existing
// JSX bridge (`extractTemplateFrames` IPC) and caches them. Subsequent proof
// renders are pure libvips ops — no Photoshop in the loop.
//
// Output: a JPEG at `outputPath`, plus a return payload describing what was
// rendered. Caller is responsible for invalidation; this module is stateless.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

let _sharp = null
function getSharp() {
  if (_sharp) return _sharp
  // Routed through the central sharp config so concurrency + libvips cache
  // are bounded identically across the proof renderer and curation engine.
  _sharp = require('./sharp_config').getSharp()
  return _sharp
}

// Hash key for the frame cache. Templates rarely change after authoring,
// so we key on (path, mtime, size) and never invalidate beyond that.
function templateKey(templatePath) {
  try {
    const st = fs.statSync(templatePath)
    return `${templatePath}|${st.size}|${st.mtimeMs}`
  } catch {
    return templatePath
  }
}

// Compute the output dimensions for a proof: longest edge = maxEdge,
// preserve aspect ratio.
function proofDims(canvasWidth, canvasHeight, maxEdge) {
  const longest = Math.max(canvasWidth, canvasHeight)
  if (longest <= maxEdge) return { width: canvasWidth, height: canvasHeight, scale: 1 }
  const scale = maxEdge / longest
  return {
    width: Math.round(canvasWidth * scale),
    height: Math.round(canvasHeight * scale),
    scale,
  }
}

// Sort frames by name like the JSX does, then split by orient. The h/v split
// matches build_page.jsx so the placement order is identical.
function partitionFrames(frames) {
  const h = []
  const v = []
  const sorted = [...frames].sort((a, b) => a.name.localeCompare(b.name))
  for (const f of sorted) {
    const n = f.name.toLowerCase()
    if (n.includes('toolkithframe')) h.push(f)
    else if (n.includes('toolkitvframe')) v.push(f)
  }
  return { h, v }
}

// Apply non-destructive per-photo adjustments to a sharp pipeline.
// adj fields are sliders in [-100, 100]; 0 / missing = no change.
//   exposure   → brightness, ±1 stop at ±100 (multiplicative, perceptual)
//   saturation → ×(1 + s/100)   (0 = greyscale at -100, 2× at +100)
//   contrast   → slope around mid-grey 128
//   warmth     → R up / B down (negative = cooler)
// Contrast + warmth fold into a single per-channel linear() pass; exposure +
// saturation into one modulate(). All resolution-independent, so the small
// preview and the full-size export match exactly.
function applyAdjust(sharp, pipeline, adj) {
  if (!adj) return pipeline
  const exposure = adj.exposure || 0
  const saturation = adj.saturation || 0
  const contrast = adj.contrast || 0
  const warmth = adj.warmth || 0
  if (!exposure && !saturation && !contrast && !warmth) return pipeline

  if (exposure || saturation) {
    pipeline = pipeline.modulate({
      brightness: Math.pow(2, exposure / 100), // ±1 stop at ±100
      saturation: Math.max(0, 1 + saturation / 100),
    })
  }
  if (contrast || warmth) {
    const s = Math.max(0, 1 + contrast / 100) // contrast slope
    const w = warmth / 200                     // ±0.5 channel gain at ±100
    const gains = [1 + w, 1, 1 - w]            // R, G, B
    // out = gain * (s*in + 128*(1-s)) = (gain*s)*in + gain*128*(1-s)
    const slopes = gains.map((g) => g * s)
    const inter = gains.map((g) => g * 128 * (1 - s))
    pipeline = pipeline.linear(slopes, inter)
  }
  return pipeline
}

// Build the per-photo composite layer: read photo, rotate by exif/explicit
// rotation, scale to cover the frame box, center-crop to frame box.
// Returns { input: Buffer, top, left }.
async function buildPhotoLayer(sharp, photo, frame, scale, smartCrop) {
  const fW = Math.max(1, Math.round(frame.w * scale))
  const fH = Math.max(1, Math.round(frame.h * scale))

  // Try the primary source first; if libvips rejects it (typically because
  // the HR folder contains a RAW or otherwise unsupported file extension),
  // fall back to the proxy. We do this inside the renderer rather than the
  // caller so a single bad file never wastes a whole page render.
  const sources = [photo.filePath]
  if (photo.fallbackPath && photo.fallbackPath !== photo.filePath) {
    sources.push(photo.fallbackPath)
  }

  let lastErr = null
  for (const src of sources) {
    try {
      // Some weddings have huge 6000×4000 RAW JPEGs. We don't need pixel
      // fidelity for proofs — pre-shrink with a fast resize before the
      // cover-fit step. sharp does this for free if we just pipe through
      // resize().
      // Auto-orient from EXIF FIRST, then apply any user rotation on top.
      // The old code did `.rotate(photo.rotation || 0)`, but sharp's
      // `.rotate(0)` does NOT auto-orient — so a portrait shot stored as
      // landscape pixels + an EXIF orientation tag (straight off most
      // cameras) rendered sideways and scaled to fit ("vertical image placed
      // horizontally" bug). The baked-upright proxy hid this; the proof pulls
      // the HR file, which still relies on its EXIF tag.
      let base = sharp(src, { failOn: 'none' }).autoOrient()
      if (photo.rotation) base = base.rotate(photo.rotation)

      let pipe
      // Explicit placement transform (on-canvas zoom/pan) takes precedence
      // over focal/cover. scale=1, ox=0, oy=0 reduces exactly to cover-fit +
      // centered, so this is a strict generalization.
      const pl = photo.placement
      const hasPlacement = pl && ((pl.scale && pl.scale !== 1) || pl.ox || pl.oy)
      if (hasPlacement) {
        const orientedBuf = await base.toBuffer()
        const meta = await sharp(orientedBuf).metadata()
        const sW = meta.width
        const sH = meta.height
        const coverScale = Math.max(fW / sW, fH / sH)
        const s = coverScale * Math.max(1, pl.scale || 1)
        let cropW = Math.min(sW, Math.max(1, Math.round(fW / s)))
        let cropH = Math.min(sH, Math.max(1, Math.round(fH / s)))
        const maxLeft = sW - cropW
        const maxTop = sH - cropH
        const ox = Math.max(-1, Math.min(1, pl.ox || 0))
        const oy = Math.max(-1, Math.min(1, pl.oy || 0))
        const left = Math.max(0, Math.min(maxLeft, Math.round(maxLeft / 2 + (ox * maxLeft) / 2)))
        const top = Math.max(0, Math.min(maxTop, Math.round(maxTop / 2 + (oy * maxTop) / 2)))
        pipe = sharp(orientedBuf)
          .extract({ left, top, width: cropW, height: cropH })
          .resize(fW, fH, { fit: 'fill' })
      } else if (smartCrop && photo.focal && photo.focal.confidence > 0.15) {
        // Materialise the oriented image so metadata() reports the TRUE
        // (post-orientation) dimensions — otherwise the crop window is
        // computed against the stored sideways dims and lands wrong.
        const orientedBuf = await base.toBuffer()
        const meta = await sharp(orientedBuf).metadata()
        const srcW = meta.width
        const srcH = meta.height
        const targetRatio = fW / fH
        let cropW, cropH
        if (srcW / srcH > targetRatio) {
          // Source is wider than target — crop horizontally.
          cropH = srcH
          cropW = Math.round(srcH * targetRatio)
        } else {
          cropW = srcW
          cropH = Math.round(srcW / targetRatio)
        }
        const fx = Math.round(photo.focal.x * srcW)
        const fy = Math.round(photo.focal.y * srcH)
        // Clamp the crop window so the focal point sits as close to the
        // center of the crop as possible without going off the edge.
        const left = Math.max(0, Math.min(srcW - cropW, fx - Math.round(cropW / 2)))
        const top = Math.max(0, Math.min(srcH - cropH, fy - Math.round(cropH / 2)))
        pipe = sharp(orientedBuf)
          .extract({ left, top, width: cropW, height: cropH })
          .resize(fW, fH, { fit: 'fill' })
      } else {
        pipe = base.resize({
          width: fW,
          height: fH,
          fit: 'cover',
          // 'attention' is sharp's saliency-based smart crop — falls back to
          // 'centre' if the user disables smart-crop in settings.
          position: smartCrop ? sharp.strategy.attention : 'centre',
          withoutEnlargement: false,
        })
      }

      // Non-destructive per-photo adjustments (exposure / contrast /
      // saturation / warmth). Resolution-independent per-pixel maths, so the
      // small live preview and the full-size final composite produce identical
      // colour. Applied here so EVERY libvips render path honours edits.
      pipe = applyAdjust(sharp, pipe, photo.adjust)

      const buf = await pipe.jpeg({ quality: 82, mozjpeg: true }).toBuffer()

      return {
        input: buf,
        top: Math.round(frame.y * scale),
        left: Math.round(frame.x * scale),
      }
    } catch (e) {
      lastErr = e
      // Loop falls through to the fallback source.
    }
  }

  // Every source failed — re-throw the last libvips error with extra context
  // so the page-level handler can surface a useful toast.
  const tried = sources.map((s) => s.split('/').pop()).join(' / ')
  const err = new Error(`unreadable source [${tried}]: ${lastErr?.message || 'unknown'}`)
  err.cause = lastErr
  throw err
}

/**
 * Render a single page composite proof.
 *
 * @param {object} job - See header comment for shape.
 * @returns {Promise<{ ok: boolean, outputPath?: string, error?: string, ms: number, hash: string }>}
 */
async function renderPageProof(job) {
  const t0 = Date.now()
  const sharp = getSharp()

  const maxEdge = job.maxEdge || 1500
  const smartCrop = job.smartCrop !== false // default ON
  const dims = proofDims(job.canvasWidth, job.canvasHeight, maxEdge)
  const scale = dims.scale

  // Resolve focal points via the plugin dispatcher. Done lazily — only when
  // smart-crop is on and the photo doesn't already carry a precomputed focal
  // point from the caller. Cached inside the focal-point plugin so a 200-page
  // album with shared photos doesn't pay the cost twice.
  if (smartCrop && job.photos?.length) {
    let plugins = null
    try { plugins = require('./plugins') } catch (_) { /* plugin system optional */ }
    if (plugins) {
      for (const p of job.photos) {
        if (p.focal != null) continue
        try {
          const r = await plugins.dispatchFirst('focalPoint', p.filePath, { rotation: p.rotation || 0 })
          if (r?.value) p.focal = r.value
        } catch (_) { /* plugin failure already logged by dispatcher */ }
      }
    }
  }

  // Cheap hash of the inputs that affect output. Caller can use this to skip
  // work (matches the render queue's dirty-tracking approach). NOTE: frames
  // are NOT hashed — they are a deterministic function of the template file
  // (templateKey already captures path+size+mtime), so including them was
  // redundant work on every page of a batch.
  const hash = crypto.createHash('sha1').update(JSON.stringify({
    t: templateKey(job.templatePath),
    pv: job.templatePreviewPath,
    cw: job.canvasWidth,
    ch: job.canvasHeight,
    p: job.photos.map((p) => ({
      f: p.filePath,
      o: p.orient,
      r: p.rotation || 0,
      a: p.adjust || 0, // adjustments affect output → must invalidate the cache
      pl: p.placement || 0, // placement (zoom/pan) affects output too
    })),
    me: maxEdge,
    sc: smartCrop ? 1 : 0,
  })).digest('hex').slice(0, 16)

  try {
    fs.mkdirSync(path.dirname(job.outputPath), { recursive: true })

    // Backdrop: prefer the template's preview JPG if it exists, otherwise a
    // plain off-white canvas at the doc's aspect.
    let base
    if (job.templatePreviewPath && fs.existsSync(job.templatePreviewPath)) {
      base = sharp(job.templatePreviewPath, { failOn: 'none' })
        .resize(dims.width, dims.height, { fit: 'fill' })
    } else {
      base = sharp({
        create: {
          width: dims.width,
          height: dims.height,
          channels: 3,
          background: { r: 245, g: 244, b: 240 },
        },
      })
    }

    // Sort frames the same way JSX does: h frames first, then v frames.
    const { h: hFrames, v: vFrames } = partitionFrames(job.frames)

    // Match the JSX assignment: hPhotos to hFrames in order, vPhotos to vFrames
    // in order. Anything past the frame count gets dropped (same as JSX).
    const hPhotos = []
    const vPhotos = []
    for (const p of job.photos) {
      if (p.orient === 'h') hPhotos.push(p)
      else vPhotos.push(p)
    }

    const layerResults = []
    const skipped = []
    for (let i = 0; i < hPhotos.length && i < hFrames.length; i++) {
      layerResults.push(buildPhotoLayer(sharp, hPhotos[i], hFrames[i], scale, smartCrop)
        .catch((e) => { skipped.push({ frame: hFrames[i].name, error: e.message }); return null }))
    }
    for (let i = 0; i < vPhotos.length && i < vFrames.length; i++) {
      layerResults.push(buildPhotoLayer(sharp, vPhotos[i], vFrames[i], scale, smartCrop)
        .catch((e) => { skipped.push({ frame: vFrames[i].name, error: e.message }); return null }))
    }

    const layers = (await Promise.all(layerResults)).filter(Boolean)

    const finalQuality = job._hrMode ? 92 : 82
    await base
      .composite(layers)
      .jpeg({ quality: finalQuality, mozjpeg: true })
      .toFile(job.outputPath)

    return {
      ok: true,
      outputPath: job.outputPath,
      ms: Date.now() - t0,
      hash,
      skipped: skipped.length ? skipped : undefined,
    }
  } catch (err) {
    return { ok: false, error: err.message, ms: Date.now() - t0, hash }
  }
}

/**
 * Render a high-resolution final composite (no Photoshop). Used for
 * generative templates which have no PSD to drive the JSX pipeline.
 *
 * Difference from renderPageProof:
 *   - Uses the full canvas dimensions (no maxEdge cap)
 *   - JPEG quality 92 instead of 82
 *   - Smart-crop is opt-in (default off) so HR exports stay deterministic
 *
 * @param {object} job - same shape as renderPageProof, plus `outputPath` is
 *                       expected to be the final per-page path the renderer
 *                       would have produced (e.g. .../Page_001.jpg).
 */
async function renderFinalComposite(job) {
  return renderPageProof({
    ...job,
    maxEdge: Math.max(job.canvasWidth, job.canvasHeight), // no shrink
    smartCrop: job.smartCrop === true, // opt-in
    _hrMode: true,
  })
}


async function renderProofBatch(jobs, onProgress) {
  const results = []
  for (let i = 0; i < jobs.length; i++) {
    const r = await renderPageProof(jobs[i])
    results.push(r)
    if (onProgress) {
      try { onProgress(r, i + 1, jobs.length) } catch { /* progress is best-effort */ }
    }
  }
  return results
}

module.exports = {
  renderPageProof,
  renderProofBatch,
  renderFinalComposite,
  templateKey,
  applyAdjust,
}
