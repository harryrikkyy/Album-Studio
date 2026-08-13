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

// Ceiling on template size for layer extraction. See readPsdLayerTree for the
// measurement behind it. Deliberately generous — real album templates are
// typically well under this — and overridable per call for tests.
const MAX_PSD_BYTES = 400 * 1024 * 1024

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
    if (n.text && n.text.text) node.text = n.text.text

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
 * @param {{ force?: boolean, maxBytes?: number }} [opts]
 * @returns {Promise<{ ok: boolean, error?: string, tooLarge?: boolean, width?: number,
 *                     height?: number, layers?: any[], compositePath?: string|null,
 *                     cacheDir?: string, cached?: boolean }>}
 */
async function readPsdLayerTree(psdPath, opts = {}) {
  if (!psdPath || !fs.existsSync(psdPath)) {
    return { ok: false, error: `template not found: ${psdPath}` }
  }

  // Decoding every layer materialises the whole document as raw RGBA. Measured
  // on a 7200×3600 / 23-layer template that is a ~390 MB resident spike for a
  // 5 MB file, and the ratio is worse for photographic art than for the flat
  // fills that was measured with. Past the cap we decline rather than risk
  // taking the app out with an OOM: callers fall back to the flattened
  // backdrop, which is exactly the pre-existing behaviour.
  const st = fs.statSync(psdPath)
  const cap = opts.maxBytes || MAX_PSD_BYTES
  if (st.size > cap) {
    return {
      ok: false,
      tooLarge: true,
      error: `template is ${(st.size / 1e6).toFixed(0)} MB, over the ${(cap / 1e6).toFixed(0)} MB layer-reading limit — `
        + 'the page still renders from the flattened template, but its layers cannot be listed or toggled',
    }
  }
  const dir = layerCacheDir(psdPath)
  const manifestPath = path.join(dir, 'manifest.json')

  // A parsed tree is reusable until the PSD itself changes, and the cache key
  // already encodes mtime — so a hit means the tree is still accurate.
  if (!opts.force && fs.existsSync(manifestPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      return { ...cached, cached: true }
    } catch (_) { /* corrupt cache — fall through and rebuild */ }
  }

  try {
    const agpsd = getAgPsd()
    const buf = fs.readFileSync(psdPath)
    const psd = agpsd.readPsd(buf, {
      useImageData: true,
      // Layer effects/adjustments aren't reproducible from raw pixels anyway
      // (see header), so skip the extra parsing work.
      skipLayerImageData: false,
      skipCompositeImageData: false,
      skipThumbnail: true,
    })

    fs.mkdirSync(dir, { recursive: true })

    /** @type {any[]} */
    const layers = []
    await convertNodes(psd.children || [], dir, '', layers)

    // Photoshop's OWN flattened render of the document. Used as the default
    // backdrop because it includes layer styles and adjustments that a stack
    // composited from raw layer pixels cannot reproduce.
    let compositePath = null
    if (psd.imageData) {
      compositePath = path.join(dir, 'composite.png')
      await writeLayerPng({ imageData: psd.imageData }, compositePath)
    }

    const result = {
      ok: true,
      width: psd.width,
      height: psd.height,
      layers,
      compositePath,
      cacheDir: dir,
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
 * @param {Record<string, { hidden?: boolean, opacity?: number }>} [edits]
 */
function flattenDrawOrder(layers, edits = {}) {
  /** @type {any[]} */
  const out = []
  const walk = (/** @type {any[]} */ nodes, /** @type {number} */ depth,
    /** @type {boolean} */ parentVisible, /** @type {number} */ parentOpacity) => {
    for (const n of nodes) {
      const edit = edits[n.id] || {}
      const visible = (edit.hidden === undefined ? n.visible : !edit.hidden) && parentVisible
      const opacity = (edit.opacity === undefined ? n.opacity : edit.opacity) * parentOpacity
      const node = { ...n, depth, effectiveVisible: visible, effectiveOpacity: opacity }
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
 * @param {Record<string, { hidden?: boolean, opacity?: number }>} layerEdits
 * @returns {{ path: number[], name: string, hidden?: boolean, opacity?: number }[]}
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
        if ('hidden' in op || 'opacity' in op) ops.push(op)
      }
      if (node.children) walk(node.children, here)
    }
  }
  walk(layers || [], [])
  return ops
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
  frameLayers,
  layerCacheDir,
  isFrameName,
  MAX_PSD_BYTES,
}
