// @ts-check
// psd_layers.js — read a template PSD's real layer tree, and cache each layer
// as a PNG.
//
// Until now a template was a black box: `extract_frames.jsx` pulled out the
// `toolkit*frame` rectangles and everything else was a single flattened
// preview. That made the Page Editor's canvas a picture of the template rather
// than the template itself — you could not see the layer stack, could not tell
// what was clipped into what, and could not turn anything off.
//
// This reads the PSD directly in the main process (no Photoshop round-trip, so
// it is fast enough to run on template load) and produces:
//   • the layer TREE — groups, nesting, clipping, blend mode, opacity, bounds
//   • one PNG per raster layer, cached on disk next to the template's key
//
// Two deliberate choices:
//
// 1. No native canvas dependency. ag-psd wants a canvas implementation, but
//    with `useImageData` it only ever needs somewhere to ALLOCATE ImageData —
//    never to draw. A ten-line shim satisfies it and keeps `node-canvas` (a
//    heavy native build) out of the dependency tree.
//
// 2. Layer pixels are raw, so layer STYLES (drop shadows, strokes, glows),
//    adjustment layers and smart filters are NOT baked into the per-layer PNGs
//    — Photoshop applies those at composite time and ag-psd does not reproduce
//    them. That is why the flattened composite stays the default backdrop and
//    the stack is only composited when the user has actually changed a layer.
//    See `composite_mode` in proof_renderer.

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

// Budget for DECODED pixel data, not file size.
//
// File size is the wrong metric and measuring a real template proved it: a
// 62 MB, 10800×3600 spread decodes to ~550 MB of RGBA and spiked ~717 MB
// resident, while sailing under any sane file-size cap. What actually costs
// memory is canvas pixels × layers, so that is what is budgeted.
// Measured ratio of actual resident spike to this estimate is ~1.4× (551 MB
// estimated -> 757 MB resident on the reference template), so the budget is
// set where the worst case still lands near 1.2 GB rather than 2 GB.
const MAX_DECODE_BYTES = 900_000_000

// Bump whenever the shape of an extracted node changes. The cache key is
// path+mtime, so without this a manifest written by an OLDER build is served
// forever for an unchanged template — which is exactly how text layers came
// back missing their `textStyle` after that field was added.
const SCHEMA_VERSION = 2

/** @type {any} */
let _agpsd = null
function getAgPsd() {
  if (_agpsd) return _agpsd
  const agpsd = require('ag-psd')
  // See note 1 in the header: allocation only, never drawing.
  // Cast to any: this is a stub, not a real 2D context. ag-psd only reads
  // width/height/data off the ImageData it allocates here — it never draws.
  agpsd.initializeCanvas(/** @type {any} */ (
    (/** @type {number} */ w, /** @type {number} */ h) => ({
      width: w,
      height: h,
      getContext: () => ({
        createImageData: (/** @type {number} */ a, /** @type {number} */ b) => ({
          width: a, height: b, data: new Uint8ClampedArray(a * b * 4),
        }),
      }),
    })
  ))
  _agpsd = agpsd
  return agpsd
}

function getSharp() {
  return require('./sharp_config').getSharp()
}

/** A layer name that marks a photo slot, matching build_page.jsx's convention. */
function isFrameName(/** @type {string|undefined} */ name) {
  const n = String(name || '').toLowerCase()
  return n.includes('toolkithframe') || n.includes('toolkitvframe')
}

/**
 * Cache directory for one template's extracted layers. Keyed on path + size +
 * mtime so re-authoring a template invalidates it, matching how
 * proof_renderer.templateKey treats the frame cache.
 */
function layerCacheDir(/** @type {string} */ psdPath) {
  let stat = ''
  try {
    const st = fs.statSync(psdPath)
    stat = `${st.size}|${st.mtimeMs}`
  } catch (_) { /* missing file is reported by the caller */ }
  const key = crypto.createHash('sha1').update(`${psdPath}|${stat}`).digest('hex').slice(0, 16)
  return path.join(os.tmpdir(), 'albumstudio_psd_layers', key)
}

/**
 * Write one layer's RGBA to a PNG. Returns null for layers with no pixels
 * (groups, empty layers), which the caller renders as structure only.
 */
async function writeLayerPng(/** @type {any} */ layer, /** @type {string} */ outPath) {
  const img = layer.imageData
  if (!img || !img.width || !img.height) return null
  const sharp = getSharp()
  await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), {
    raw: { width: img.width, height: img.height, channels: 4 },
  }).png().toFile(outPath)
  return outPath
}

/**
 * Recursively convert ag-psd nodes into our tree, exporting PNGs as we go.
 *
 * `idPath` gives every layer a stable id derived from its position in the tree
 * ("0/2/1"). Names are not unique in Photoshop — two layers called "Layer 1"
 * are routine — so an index path is the only identifier that survives a reload
 * without collisions.
 */
async function convertNodes(/** @type {any[]} */ nodes, /** @type {string} */ dir,
  /** @type {string} */ idPrefix, /** @type {any[]} */ out) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    const id = idPrefix ? `${idPrefix}/${i}` : String(i)
    const isGroup = Array.isArray(n.children)
    /** @type {any} */
    const node = {
      id,
      name: n.name || (isGroup ? 'Group' : 'Layer'),
      kind: isGroup ? 'group' : (n.text ? 'text' : 'raster'),
      // ag-psd reports `hidden`; the UI thinks in terms of visibility.
      visible: !n.hidden,
      opacity: typeof n.opacity === 'number' ? n.opacity : 1,
      blendMode: n.blendMode || 'normal',
      // A clipped layer is masked by the nearest non-clipped layer BELOW it.
      clipped: !!n.clipping,
      x: n.left || 0,
      y: n.top || 0,
      w: (n.right || 0) - (n.left || 0),
      h: (n.bottom || 0) - (n.top || 0),
      isFrame: isFrameName(n.name),
      png: null,
    }
    // Text layers carry enough to (a) show the copy for editing and (b) draw
    // a stand-in when the user changes it. `transform` is PSD's 6-value affine
    // [a,b,c,d,tx,ty]; the scale in it multiplies the point size, and tx/ty is
    // the text's anchor on the canvas.
    if (n.text) {
      node.text = n.text.text || ''
      const st = n.text.style || {}
      const ps = n.text.paragraphStyle || {}
      const tr = Array.isArray(n.text.transform) ? n.text.transform : [1, 0, 0, 1, node.x, node.y]
      const scale = Math.abs(tr[0]) || 1
      const c = st.fillColor || { r: 0, g: 0, b: 0 }
      node.textStyle = {
        font: (st.font && st.font.name) || null,
        // Point size times the layer's own transform scale — a template that
        // was scaled after the type was set reports the ORIGINAL size, so
        // ignoring the transform renders it visibly too small.
        sizePx: (st.fontSize || 12) * scale,
        color: '#' + [c.r, c.g, c.b].map((v) =>
          Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join(''),
        // Photoshop tracking is 1/1000 em.
        tracking: (st.tracking || 0) / 1000,
        align: ps.justification === 'center' ? 'center'
          : ps.justification === 'right' ? 'right' : 'left',
        anchorX: tr[4],
        anchorY: tr[5],
      }
    }

    if (isGroup) {
      node.children = []
      await convertNodes(n.children, dir, id, node.children)
    } else {
      const png = path.join(dir, `${id.replace(/\//g, '_')}.png`)
      try {
        node.png = await writeLayerPng(n, png)
      } catch (e) {
        // One unreadable layer must not lose the whole tree — the panel still
        // lists it, it just has no thumbnail/pixels to draw.
        node.png = null
        node.error = e instanceof Error ? e.message : String(e)
      }
    }
    out.push(node)
  }
}

/**
 * Read a template PSD's layer tree, caching per-layer PNGs on disk.
 *
 * Layers come back in PSD storage order, which is BOTTOM-TO-TOP — the order
 * they should be drawn in. The UI reverses it for display, because a layers
 * panel reads top-down.
 *
 * @param {string} psdPath
 * @param {{ force?: boolean, maxDecodeBytes?: number }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, pixelsSkipped?: boolean, width?: number,
 *                     height?: number, layers?: any[], compositePath?: string|null,
 *                     cacheDir?: string, cached?: boolean }>}
 */
async function readPsdLayerTree(psdPath, opts = {}) {
  if (!psdPath || !fs.existsSync(psdPath)) {
    return { ok: false, error: `template not found: ${psdPath}` }
  }

  const dir = layerCacheDir(psdPath)
  const manifestPath = path.join(dir, 'manifest.json')

  // A parsed tree is reusable until the PSD itself changes, and the cache key
  // already encodes mtime — so a hit means the tree is still accurate.
  if (!opts.force && fs.existsSync(manifestPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (cached.schema === SCHEMA_VERSION) return { ...cached, cached: true }
      // Written by an older build — fall through and re-extract.
    } catch (_) { /* corrupt cache — fall through and rebuild */ }
  }

  try {
    const agpsd = getAgPsd()
    const buf = fs.readFileSync(psdPath)

    // Pass 1 — structure only. Measured at ~60 ms / ~40 MB on a 62 MB
    // template, versus ~1 s / ~700 MB for a full decode. Cheap enough to do
    // unconditionally, and it tells us what a full decode would cost BEFORE
    // committing to one.
    const outline = agpsd.readPsd(buf, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
    })

    let estimate = (outline.width || 0) * (outline.height || 0) * 4  // composite
    const measure = (/** @type {any[]} */ nodes) => {
      for (const n of nodes || []) {
        if (n.children) { measure(n.children); continue }
        estimate += Math.max(0, (n.right || 0) - (n.left || 0))
          * Math.max(0, (n.bottom || 0) - (n.top || 0)) * 4
      }
    }
    measure(outline.children)

    const budget = opts.maxDecodeBytes || MAX_DECODE_BYTES
    // Over budget: keep the TREE (so the layers panel still lists everything,
    // which is most of the value) and skip the pixels. Callers fall back to
    // the flattened backdrop for drawing, exactly as they do for a template
    // that can't be parsed at all.
    const pixelsSkipped = estimate > budget

    fs.mkdirSync(dir, { recursive: true })

    const psd = pixelsSkipped ? outline : agpsd.readPsd(buf, {
      useImageData: true,
      // Layer effects/adjustments aren't reproducible from raw pixels anyway
      // (see header), so skip the extra parsing work.
      skipLayerImageData: false,
      skipCompositeImageData: false,
      skipThumbnail: true,
    })

    /** @type {any[]} */
    const layers = []
    await convertNodes(psd.children || [], dir, '', layers)

    // Photoshop's OWN flattened render of the document. Used as the default
    // backdrop because it includes layer styles and adjustments that a stack
    // composited from raw layer pixels cannot reproduce.
    let compositePath = null
    if (!pixelsSkipped && psd.imageData) {
      compositePath = path.join(dir, 'composite.png')
      await writeLayerPng({ imageData: psd.imageData }, compositePath)
    }

    const result = {
      ok: true,
      schema: SCHEMA_VERSION,
      width: psd.width,
      height: psd.height,
      layers,
      compositePath,
      cacheDir: dir,
      pixelsSkipped,
      estimatedDecodeBytes: estimate,
    }
    try {
      fs.writeFileSync(manifestPath, JSON.stringify(result))
    } catch (_) { /* cache write is best-effort; the tree is already built */ }
    return result
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Flatten the tree into draw order (bottom-to-top), skipping nothing.
 *
 * Groups are emitted before their children and carry `depth`, so a consumer
 * can honour group visibility/opacity without re-walking the tree. A group
 * that is hidden hides its whole subtree — Photoshop's behaviour, and the
 * reason `effectiveVisible` is computed here rather than per-consumer.
 *
 * @param {any[]} layers
 * @param {Record<string, any>} [edits]
 */
function flattenDrawOrder(layers, edits = {}) {
  /** @type {any[]} */
  const out = []
  const walk = (/** @type {any[]} */ nodes, /** @type {number} */ depth,
    /** @type {boolean} */ parentVisible, /** @type {number} */ parentOpacity) => {
    for (const n of nodes) {
      const edit = edits[n.id] || {}
      // Retyped text hides its own baked pixels — the stand-in draws instead.
      const replaced = edit.text !== undefined && n.kind === 'text'
      const visible = (edit.hidden === undefined ? n.visible : !edit.hidden) && parentVisible
      const rasterVisible = visible && !replaced
      const opacity = (edit.opacity === undefined ? n.opacity : edit.opacity) * parentOpacity
      const node = { ...n, depth, effectiveVisible: visible, effectiveOpacity: opacity, rasterVisible }
      delete node.children
      out.push(node)
      if (n.children) walk(n.children, depth + 1, visible, opacity)
    }
  }
  walk(layers, 0, true, 1)
  return out
}

/**
 * Resolve which layers clip into which.
 *
 * In Photoshop a run of consecutive clipped layers masks to the nearest
 * non-clipped layer BELOW the run — its "base". Returns the draw-order list
 * with `clipBaseId` set on every clipped layer, so renderers don't each have
 * to re-derive the rule (and get it subtly wrong).
 *
 * @param {any[]} drawOrder from flattenDrawOrder
 */
function resolveClipping(/** @type {any[]} */ drawOrder) {
  /** @type {string|null} */
  let baseId = null
  return drawOrder.map((n) => {
    if (n.kind === 'group') return { ...n, clipBaseId: null }
    if (!n.clipped) {
      baseId = n.id
      return { ...n, clipBaseId: null }
    }
    return { ...n, clipBaseId: baseId }
  })
}

/**
 * Translate layer overrides into instructions the build JSX can apply.
 *
 * The two worlds index layers in OPPOSITE directions: ag-psd lists a
 * container's children bottom-to-top (PSD storage order), while ExtendScript's
 * `doc.layers[0]` is the TOPMOST layer. Ignoring that doesn't fail loudly — it
 * silently hides the wrong layer — so the inversion happens once, here, with
 * tests, rather than being re-derived in ExtendScript.
 *
 * Only layers with an actual override are emitted, and only when the override
 * differs from what the PSD already says: the export should leave a template
 * it was never asked to change completely untouched.
 *
 * @param {any[]} layers the tree from readPsdLayerTree
 * @param {Record<string, any>} layerEdits
 * @returns {any[]}
 */
function toPhotoshopLayerOps(layers, layerEdits) {
  /** @type {any[]} */
  const ops = []
  if (!layerEdits || !Object.keys(layerEdits).length) return ops

  const walk = (/** @type {any[]} */ nodes, /** @type {number[]} */ psPath) => {
    const n = nodes.length
    for (let i = 0; i < n; i++) {
      const node = nodes[i]
      // Same child, counted from the other end.
      const psIndex = n - 1 - i
      const here = psPath.concat(psIndex)
      const edit = layerEdits[node.id]
      if (edit) {
        /** @type {any} */
        const op = { path: here, name: node.name }
        if (edit.hidden !== undefined && edit.hidden === !node.visible) {
          // Matches the PSD already — nothing to do.
        } else if (edit.hidden !== undefined) {
          op.hidden = edit.hidden
        }
        if (edit.opacity !== undefined && edit.opacity !== node.opacity) {
          op.opacity = edit.opacity
        }
        // Move/scale, in canvas pixels. Photoshop resizes about the layer's
        // centre, so the translate is pre-compensated for the drift that
        // introduces — see the JSX for the arithmetic.
        if (edit.dx) op.dx = edit.dx
        if (edit.dy) op.dy = edit.dy
        if (edit.sx != null && edit.sx !== 1) op.sx = edit.sx
        if (edit.sy != null && edit.sy !== 1) op.sy = edit.sy
        if (op.sx || op.sy) { op.w = node.w; op.h = node.h }
        // Retyped copy goes in as LIVE type: Photoshop re-renders it in the
        // template's own font, so the delivered PSD is exact — the editor's
        // stand-in was only ever a preview.
        if (edit.text !== undefined && node.kind === 'text' && edit.text !== node.text) {
          op.text = edit.text
        }
        if (['hidden', 'opacity', 'dx', 'dy', 'sx', 'sy', 'text'].some((k) => k in op)) ops.push(op)
      }
      if (node.children) walk(node.children, here)
    }
  }
  walk(layers || [], [])
  return ops
}

/**
 * Turn edited template TEXT layers into overlay layers.
 *
 * When the user retypes a template's copy, the layer's baked raster is wrong,
 * so it is hidden and a stand-in is drawn instead. Expressing the stand-in as
 * an ordinary overlay means the editor preview and the proof renderer draw it
 * through the SAME SVG path as every other caption — no third text renderer.
 *
 * The Photoshop export does NOT use these: there the real text layer's
 * contents are set directly, so the delivered PSD keeps live, correctly
 * rendered type in the template's own font.
 *
 * @param {any[]} layers
 * @param {Record<string, any>} layerEdits
 * @param {number} W canvas width  @param {number} H canvas height
 */
function textReplacementOverlays(layers, layerEdits, W, H) {
  /** @type {any[]} */
  const out = []
  if (!layerEdits) return out
  for (const n of flattenDrawOrder(layers, layerEdits)) {
    const edit = layerEdits[n.id]
    if (!edit || edit.text === undefined || n.kind !== 'text') continue
    if (!n.effectiveVisible) continue
    const st = n.textStyle || {}
    // ag-psd doesn't always report a size; fall back to the layer's own height,
    // which for a single line is close enough to keep the stand-in legible.
    const sizePx = st.sizePx && st.sizePx > 4 ? st.sizePx : Math.max(12, n.h * 0.8)
    const anchorX = (st.anchorX == null ? n.x : st.anchorX) + (edit.dx || 0)
    const anchorY = (st.anchorY == null ? n.y + n.h : st.anchorY) + (edit.dy || 0)
    const align = st.align || 'left'
    // Give the box generous width and place it so the engine's anchor for this
    // alignment lands on the PSD's own anchor point.
    const boxW = Math.max(n.w * 2, W * 0.5)
    const x = align === 'center' ? anchorX - boxW / 2 : align === 'right' ? anchorX - boxW : anchorX
    // The engine puts the first baseline at 0.78em below the box top for a
    // top-aligned box; PSD's anchorY IS the baseline, so back that out.
    const y = anchorY - sizePx * 0.78
    out.push({
      id: 'psdtext_' + n.id,
      type: 'text',
      x: x / W, y: y / H, w: boxW / W, h: (sizePx * 1.6) / H,
      text: edit.text,
      font: st.font || undefined,
      size: sizePx / H,
      color: st.color || '#000000',
      align,
      valign: 'top',
      tracking: st.tracking || 0,
      opacity: n.effectiveOpacity,
    })
  }
  return out
}

/** Frame layers only, in draw order — the photo slots. */
function frameLayers(/** @type {any[]} */ layers) {
  return flattenDrawOrder(layers).filter((n) => n.isFrame)
}

module.exports = {
  readPsdLayerTree,
  flattenDrawOrder,
  resolveClipping,
  toPhotoshopLayerOps,
  textReplacementOverlays,
  frameLayers,
  layerCacheDir,
  isFrameName,
  MAX_DECODE_BYTES,
}
