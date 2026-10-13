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

// Text/shape overlays. The Spread Editor renders the SAME SVG into its stage,
// so the preview and this composite cannot drift apart.
const { buildOverlaySvg, overlayCacheKey } = require('./overlay_render')
// Layer move/scale geometry, shared with the Page Editor and unit-tested
// in test/editor_geometry.test.js.
const { layerBox } = require('./editor_geometry')

// '#rrggbb' → sharp's background object. Returns null for anything else so
// callers fall back to their own default.
function parseHexColor(hex) {
  if (typeof hex !== 'string') return null
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

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
// adj fields are sliders in [-100, 100] (except `bw`, a flag); 0 / missing =
// no change.
//
//   exposure   → brightness, ±1 stop at ±100 (multiplicative, perceptual)
//   saturation → ×(1 + s/100)   (0 = greyscale at -100, 2× at +100)
//   contrast   → slope around mid-grey 128
//   warmth     → R up / B down (negative = cooler)
//   tint       → green ↔ magenta, the axis perpendicular to warmth
//   fade       → lifts the black point for a matte/film look
//   bw         → true greyscale (applied before the colour ops so warmth/tint
//                can then tone the mono image, e.g. selenium/sepia splits)
//   clarity    → local contrast via CLAHE (a real midtone-detail op, not a
//                second global contrast slider)
//   sharpen    → unsharp mask
//   blur       → gaussian
//   vignette   → radial darkening; needs the output box, so it composites in
//                buildPhotoLayer rather than here
//
// Every op is resolution-independent EXCEPT sharpen/blur/vignette, whose radii
// scale with the output box — see the `dims` argument. That keeps the 1500px
// proof and the full-size export visually matched instead of the proof looking
// over-sharpened.
//
// Ordering is deliberate: greyscale → tone/colour → local contrast → detail.
// Sharpening before a big contrast push would amplify halos.
function applyAdjust(sharp, pipeline, adj, dims) {
  if (!adj) return pipeline
  const exposure = adj.exposure || 0
  const saturation = adj.saturation || 0
  const contrast = adj.contrast || 0
  const warmth = adj.warmth || 0
  const tint = adj.tint || 0
  const fade = adj.fade || 0
  const clarity = adj.clarity || 0
  const sharpenAmt = adj.sharpen || 0
  const blurAmt = adj.blur || 0
  const bw = !!adj.bw
  if (!exposure && !saturation && !contrast && !warmth && !tint && !fade
    && !clarity && !sharpenAmt && !blurAmt && !bw) return pipeline

  // Greyscale first so the colour ops below tone the mono result.
  if (bw) pipeline = pipeline.greyscale()

  if (exposure || (saturation && !bw)) {
    pipeline = pipeline.modulate({
      brightness: Math.pow(2, exposure / 100), // ±1 stop at ±100
      saturation: bw ? 1 : Math.max(0, 1 + saturation / 100),
    })
  }
  if (contrast || warmth || tint || fade) {
    const s = Math.max(0, 1 + contrast / 100) // contrast slope
    const w = warmth / 200                     // ±0.5 channel gain at ±100
    const t = tint / 200                       // + = magenta, - = green
    const gains = [1 + w + t, 1 - t, 1 - w + t] // R, G, B
    // out = gain * (s*in + 128*(1-s)) = (gain*s)*in + gain*128*(1-s)
    const slopes = gains.map((g) => g * s)
    // Fade lifts the black point: a positive intercept added on top of the
    // contrast pivot, up to ~1/4 of the range at +100.
    const lift = (fade / 100) * 64
    const inter = gains.map((g) => g * 128 * (1 - s) + lift)
    pipeline = pipeline.linear(slopes, inter)
  }

  // Local contrast. CLAHE's window is a fraction of the output box so the
  // effect covers the same real-world area at proof and export size.
  if (clarity > 0 && dims && dims.width && dims.height) {
    const win = Math.max(3, Math.round(Math.min(dims.width, dims.height) / 8))
    pipeline = pipeline.clahe({
      width: win,
      height: win,
      maxSlope: Math.max(1, Math.round(1 + (clarity / 100) * 5)),
    })
  }

  // Detail ops last. Radii scale with the box so proof and export match.
  const detailScale = dims && dims.height ? dims.height / 1000 : 1
  if (sharpenAmt > 0) {
    pipeline = pipeline.sharpen({
      sigma: Math.max(0.3, (0.5 + (sharpenAmt / 100) * 1.5) * Math.max(0.35, detailScale)),
    })
  }
  if (blurAmt > 0) {
    pipeline = pipeline.blur(Math.max(0.3, (blurAmt / 100) * 12 * Math.max(0.35, detailScale)))
  }
  return pipeline
}

// Radial vignette as an SVG overlay, composited over the finished photo layer.
// Reuses the SVG path already in the pipeline for overlays, so there is no
// second imaging dependency. Strength is [-100, 100]: positive darkens the
// corners, negative lightens them.
function vignetteSvg(width, height, strength) {
  const s = Math.max(-100, Math.min(100, strength))
  if (!s) return null
  const color = s > 0 ? '0,0,0' : '255,255,255'
  const alpha = (Math.abs(s) / 100) * 0.85
  // Transparent through the middle ~45%, ramping to `alpha` at the corners.
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<defs><radialGradient id="v" cx="50%" cy="50%" r="75%">`
    + `<stop offset="45%" stop-color="rgba(${color},0)"/>`
    + `<stop offset="100%" stop-color="rgba(${color},${alpha.toFixed(3)})"/>`
    + `</radialGradient></defs>`
    + `<rect width="${width}" height="${height}" fill="url(#v)"/></svg>`
  )
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
        const cropW = Math.min(sW, Math.max(1, Math.round(fW / s)))
        const cropH = Math.min(sH, Math.max(1, Math.round(fH / s)))
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

      // Non-destructive per-photo adjustments. Resolution-independent colour
      // maths, so the small live preview and the full-size final composite
      // produce identical colour. Applied here so EVERY libvips render path
      // honours edits. `dims` lets the detail ops (sharpen/blur/clarity) scale
      // their radii with the output box.
      pipe = applyAdjust(sharp, pipe, photo.adjust, { width: fW, height: fH })

      // Vignette composites over the finished frame, so it must come after the
      // photo has been cropped to the frame box — it darkens the FRAME's
      // corners, not the source photo's.
      const vig = photo.adjust && photo.adjust.vignette
        ? vignetteSvg(fW, fH, photo.adjust.vignette)
        : null
      if (vig) pipe = sharp(await pipe.png().toBuffer()).composite([{ input: vig, top: 0, left: 0 }])

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
    // Overlay text/shapes are baked into the output, so editing a caption has
    // to invalidate the cached page exactly like a photo edit does.
    ov: overlayCacheKey(job.overlays),
    bg: job.pageBackground || 0,
    // Hiding a template layer changes the page without touching any photo,
    // so it has to invalidate the cached render like any other edit.
    le: job.layerEdits ? JSON.stringify(job.layerEdits) : 0,
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
          background: parseHexColor(job.pageBackground) || { r: 245, g: 244, b: 240 },
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

    let layers = (await Promise.all(layerResults)).filter(Boolean)

    // If the user turned template layers off (or faded them) in the Page
    // Editor, the flattened backdrop no longer represents the page — rebuild
    // it from the layer stack, with the photos interleaved at their frames'
    // z-positions so template art above a frame stays above the photo.
    const hasLayerEdits = job.layerEdits && Object.keys(job.layerEdits).length > 0
    if (hasLayerEdits && job.psdLayers && job.psdLayers.length) {
      const { ops, frameOrder } = buildPsdStackOps(job.psdLayers, job.layerEdits, scale)

      // The photo layers were built in h-then-v order; map them back to the
      // frame they occupy so each can be slotted into the stack.
      const placed = []
      let li = 0
      for (let i = 0; i < hPhotos.length && i < hFrames.length; i++) placed.push({ frame: hFrames[i], layer: layers[li++] })
      for (let i = 0; i < vPhotos.length && i < vFrames.length; i++) placed.push({ frame: vFrames[i], layer: layers[li++] })

      for (const { frame, layer } of placed) {
        if (!layer) continue
        const at = frameOrder.get(frame.name)
        if (at === undefined) ops.push(layer)   // frame not in the parsed stack
        else ops[at] = layer
      }

      const realised = []
      for (const op of ops) {
        if (!op) continue                        // an empty photo slot
        realised.push(op._layer ? await realisePsdOp(sharp, op, scale) : op)
      }
      layers = realised
      // The stack draws the whole page, so the flattened backdrop underneath
      // it would show through anywhere a layer was switched off.
      base = sharp({
        create: {
          width: dims.width, height: dims.height, channels: 4,
          background: parseHexColor(job.pageBackground) || { r: 255, g: 255, b: 255, alpha: 0 },
        },
      })
    }

    // Overlay layers (text, shapes) sit ON TOP of every photo — appended last
    // so they win the z-order. One SVG for the whole page: librsvg rasterises
    // it at output resolution, so text stays crisp at export size instead of
    // being upscaled from the proof.
    // Retyped template text draws through the same overlay pipeline as any
    // other caption, so there is only ever one text renderer in this file.
    let pageOverlays = job.overlays || []
    if (job.layerEdits && job.psdLayers) {
      try {
        const { textReplacementOverlays } = require('./psd_layers')
        const subs = textReplacementOverlays(job.psdLayers, job.layerEdits, job.canvasWidth, job.canvasHeight)
        if (subs.length) pageOverlays = pageOverlays.concat(subs)
      } catch (_) { /* stand-ins are best-effort; the page still renders */ }
    }
    const overlaySvg = buildOverlaySvg(pageOverlays, dims.width, dims.height)
    if (overlaySvg) {
      layers.push({ input: Buffer.from(overlaySvg), top: 0, left: 0 })
    }

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


/**
 * Build the composite operations for a template's own PSD layers.
 *
 * Used when the user has hidden or faded template layers in the Page Editor —
 * the flattened preview can't express that, so the page is rebuilt from the
 * layer stack instead. Photo slots are skipped here: the caller interleaves
 * the photos at their frame's position so template art above a frame still
 * renders above the photo, as it does in Photoshop.
 *
 * Fidelity caveat, and the reason this is NOT the default path: per-layer
 * pixels are raw, so layer styles, adjustment layers and smart filters — which
 * Photoshop applies at composite time — are absent. Unedited pages keep using
 * Photoshop's own flattened render.
 *
 * @returns {{ ops: any[], frameOrder: Map<string, number> }} ops in draw order,
 *   plus where each frame name falls within them
 */
function buildPsdStackOps(psdLayers, layerEdits, scale) {
  const { flattenDrawOrder, resolveClipping } = require('./psd_layers')
  const stack = resolveClipping(flattenDrawOrder(psdLayers || [], layerEdits || {}))
  const ops = []
  const frameOrder = new Map()
  const byId = new Map(stack.map((n) => [n.id, n]))

  for (const node of stack) {
    if (node.kind === 'group') continue
    if (node.isFrame) {
      // Reserve this slot; the caller drops the photo in at this index.
      frameOrder.set(node.name, ops.length)
      ops.push(null)
      continue
    }
    const shown = node.rasterVisible === undefined ? node.effectiveVisible : node.rasterVisible
    if (!shown || !node.png || !fs.existsSync(node.png)) continue
    const edit = (layerEdits && layerEdits[node.id]) || {}
    ops.push({
      _layer: node,
      _clipBase: node.clipBaseId ? byId.get(node.clipBaseId) : null,
      _clipBaseBox: (() => {
        const base = node.clipBaseId ? byId.get(node.clipBaseId) : null
        if (!base) return null
        const be = (layerEdits && layerEdits[base.id]) || {}
        return { png: base.png, ...layerBox(base, be) }
      })(),
      // Move/scale from the Page Editor. Stored in canvas pixels, so they
      // scale with the output like every other coordinate here.
      // Same helper the editor's canvas and hit-test use, so a moved layer
      // renders exactly where it was dragged. This was a second copy of the
      // arithmetic until editor_geometry existed.
      _box: layerBox(node, edit),
      top: Math.round((node.y + (edit.dy || 0)) * scale),
      left: Math.round((node.x + (edit.dx || 0)) * scale),
      blend: PS_BLEND_TO_SHARP[String(node.blendMode || 'normal').toLowerCase()] || 'over',
    })
  }
  return { ops, frameOrder }
}

// Photoshop blend-mode names → the libvips operators sharp exposes. Modes with
// no libvips equivalent (hue/saturation/colour/luminosity) fall back to normal
// rather than to a wrong-but-similar operator.
const PS_BLEND_TO_SHARP = {
  normal: 'over', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
  darken: 'darken', lighten: 'lighten', 'color dodge': 'colour-dodge',
  'color burn': 'colour-burn', 'hard light': 'hard-light',
  'soft light': 'soft-light', difference: 'difference', exclusion: 'exclusion',
}

/**
 * Materialise one PSD layer op into a sharp composite entry: resize to the
 * output scale, apply layer opacity, and mask to its clip base if it is a
 * clipping mask.
 */
async function realisePsdOp(sharp, op, scale) {
  const node = op._layer
  const box = op._box || node
  const w = Math.max(1, Math.round(box.w * scale))
  const h = Math.max(1, Math.round(box.h * scale))
  let pipe = sharp(node.png).resize(w, h, { fit: 'fill' })

  // Layer opacity: scale the alpha channel rather than flattening onto a
  // background, so the layer stays translucent over whatever is beneath it.
  if (node.effectiveOpacity < 1) {
    pipe = pipe.ensureAlpha().composite([{
      input: Buffer.from([255, 255, 255, Math.round(node.effectiveOpacity * 255)]),
      raw: { width: 1, height: 1, channels: 4 },
      tile: true,
      blend: 'dest-in',
    }])
  }

  // A clipping mask shows this layer only where its base has pixels. Render
  // the base's alpha into this layer's box, then keep only that intersection.
  if (op._clipBase && op._clipBase.png && fs.existsSync(op._clipBase.png)) {
    // The base's EDITED box, for the same reason as the editor: a moved or
    // scaled base must carry its clipping mask with it.
    const b = op._clipBaseBox || op._clipBase
    const baseW = Math.max(1, Math.round(b.w * scale))
    const baseH = Math.max(1, Math.round(b.h * scale))
    const baseBuf = await sharp(b.png).resize(baseW, baseH, { fit: 'fill' })
      .ensureAlpha().png().toBuffer()
    const maskCanvas = await sharp({
      create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{
      input: baseBuf,
      left: Math.round((b.x - box.x) * scale),
      top: Math.round((b.y - box.y) * scale),
    }]).png().toBuffer()
    pipe = sharp(await pipe.png().toBuffer())
      .composite([{ input: maskCanvas, blend: 'dest-in' }])
  }

  return { input: await pipe.png().toBuffer(), top: op.top, left: op.left, blend: op.blend }
}

/**
 * Rasterize a page's overlay layers to a transparent PNG.
 *
 * This is how SHAPES reach the Photoshop export path — Photoshop cannot be
 * handed the SVG. Text is excluded by default and rebuilt as native, editable
 * Photoshop text layers instead (see overlay_ps.js); including it here too
 * would draw every caption twice.
 *
 * @param {any[]} overlays
 * @param {number} width
 * @param {number} height
 * @param {{ includeText?: boolean }} [opts] pass includeText to bake captions
 *        into the raster as well — used by callers that have no native-text
 *        path of their own.
 * @returns {Promise<string|null>} temp PNG path, or null if nothing to draw
 */
async function rasterizeOverlays(overlays, width, height, opts = {}) {
  const layers = opts.includeText
    ? overlays
    : (Array.isArray(overlays) ? overlays.filter((L) => L && L.type !== 'text') : overlays)
  const svg = buildOverlaySvg(layers, width, height)
  if (!svg) return null
  const sharp = getSharp()
  const out = path.join(
    require('os').tmpdir(),
    `albumstudio_overlay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`
  )
  await sharp(Buffer.from(svg)).png().toFile(out)
  return out
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
  rasterizeOverlays,
  templateKey,
  applyAdjust,
  // The native app's proofs draw photos with this, so both apps crop and colour them alike.
  buildPhotoLayer,
  // Exposed for unit tests — pure geometry helpers that must stay identical
  // between the preview and the final export.
  proofDims,
  partitionFrames,
  parseHexColor,
  vignetteSvg,
}
