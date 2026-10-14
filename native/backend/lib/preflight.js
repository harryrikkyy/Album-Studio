'use strict'

const fs = require('fs')
const path = require('path')
const { collectFrames } = require('./psd_template')
const { coverQuad, embedScale } = require('./sheet')
const { placeable } = require('./raw')
const { printCanvas } = require('./print_settings')
const { readPsdBuffer } = require('./color')
const sharp = () => require('../../../src/sharp_config').getSharp()
let ag
function decoder() {
  if (!ag) {
    ag = require('ag-psd')
    ag.initializeCanvas((w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }) }) }))
  }
  return ag
}
const finiteTree = (value) => typeof value === 'number' ? Number.isFinite(value) : !value || typeof value !== 'object' || Object.values(value).every(finiteTree)
const exists = async (file) => !!file && await fs.promises.stat(file).then((s) => s.isFile(), () => false)

/** Full original decode and real PSD geometry. No lab compliance is inferred from defaults. */
async function preflightAlbum(album, ws, settings, requestedSpreads = null) {
  const report = { errors: [], warnings: [], info: [] }
  const add = (kind, code, message, sp = {}, extra = {}) => report[kind].push({ code, n: sp.n, id: sp.id, message, ...extra })
  const fail = (code, message, sp, extra) => add('errors', code, message, sp, extra)
  const minimum = settings.minEffectivePpi === undefined ? settings.ppi : settings.minEffectivePpi
  if (!['print', 'original'].includes(settings.size) || ![settings.ppi, settings.heightInches, minimum, settings.embeddingScale === undefined ? 1 : settings.embeddingScale].every((v) => Number.isFinite(v) && v > 0)) {
    fail('print_settings_invalid', 'Print size, resolution and minimum effective PPI must be finite positive numbers.'); return report
  }
  add('info', 'effective_ppi_policy', settings.minEffectivePpi === undefined ? `Minimum effective PPI uses the configured output resolution (${settings.ppi} PPI).` : `Minimum effective PPI explicitly set to ${minimum}.`)
  let selected = album.spreads
  if (requestedSpreads !== null) {
    if (!Array.isArray(requestedSpreads) || !requestedSpreads.length || new Set(requestedSpreads).size !== requestedSpreads.length || requestedSpreads.some((n) => !Number.isInteger(n) || !album.spreads.some((sp) => sp.n === n))) {
      fail('spread_selection_invalid', 'Select existing spreads once each.'); return report
    }
    selected = selected.filter((sp) => requestedSpreads.includes(sp.n))
  }
  const spec = ws.printSpec
  if (!spec) add('warnings', 'lab_spec_unverified', 'No print-lab specification is configured. Bleed, safe area, gutter and lab approval remain unverified.')
  else {
    if (!finiteTree(spec) || ['widthInches', 'heightInches'].some((k) => !(spec[k] > 0)) || ['bleedInches', 'safeInches', 'gutterInches'].some((k) => spec[k] !== undefined && spec[k] < 0)) fail('lab_spec_invalid', 'The configured lab specification contains invalid dimensions.')
    add('warnings', 'lab_layout_unverified', 'The lab dimensions are checked; actual bleed, safe-area, gutter and printer colour compliance still require verification.')
    if (spec.profile && !/^s-?rgb$/i.test(spec.profile)) fail('lab_profile_unsupported', 'Delivery currently converts to sRGB. The configured lab profile needs a verified conversion workflow.')
  }
  const photoCache = new Map(), templateCache = new Map()
  for (const sp of selected) {
    const ids = new Set(sp.photoIds)
    for (const c of album.identityConflicts || []) {
      const relevant = c.n ? c.n === sp.n : ids.has(c.id) || (c.candidates || []).some((id) => ids.has(id)) || sp.template && (c.id === sp.template.id || (c.candidates || []).includes(sp.template.id))
      if (relevant) fail('identity_conflict', `Spread ${sp.n} has an ambiguous asset or adjustment. Resolve it before production.`, sp)
    }
    if (!sp.template || !(await exists(sp.template.file))) { fail('template_missing', `Spread ${sp.n}'s template is missing.`, sp); continue }
    let psd
    try {
      if (!templateCache.has(sp.template.file)) {
        const bytes = await readPsdBuffer(sp.template.file), outline = decoder().readPsd(bytes, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true })
        let budget = outline.width * outline.height * 4
        const measure = (nodes) => { for (const n of nodes || []) { budget += Math.max(0, (n.right - n.left) * (n.bottom - n.top)) * 8; measure(n.children) } }
        measure(outline.children)
        if (!Number.isFinite(budget) || budget > 900 * 1024 * 1024) throw new Error('Template exceeds the full geometry-decode budget; its masks cannot be verified.')
        templateCache.set(sp.template.file, decoder().readPsd(bytes, { skipCompositeImageData: true, skipThumbnail: true, useImageData: true }))
      }
      psd = templateCache.get(sp.template.file)
      if (![psd.width, psd.height].every((v) => Number.isFinite(v) && v > 0)) throw new Error('Invalid template dimensions.')
    } catch (e) { fail('template_corrupt', `Spread ${sp.n}: ${e.message}`, sp); continue }
    const inches = settings.size === 'original' ? psd.height / settings.ppi : settings.heightInches
    let canvas
    try { canvas = printCanvas(psd.width, psd.height, settings) } catch (e) { fail('print_settings_invalid', e.message, sp); continue }
    if (spec && [spec.widthInches, spec.heightInches].every((v) => v > 0) && (Math.abs(inches - spec.heightInches) > 0.001 || Math.abs(inches * psd.width / psd.height - spec.widthInches) > 0.001)) fail('lab_dimensions_mismatch', `Spread ${sp.n}'s delivered dimensions differ from the configured lab dimensions.`, sp)
    const frames = collectFrames(psd.children).map((f) => ({ ...f, node: f.node }))
    const nodes = new Map(), nodeIds = new Map()
    const layerEdits = (ws.pageLayerEdits || {})[sp.n] || {}
    const index = (list, prefix = '') => (list || []).forEach((node, i) => { const id = prefix ? `${prefix}/${i}` : String(i); nodes.set(id, node); nodeIds.set(node, id); index(node.children, id) })
    index(psd.children)
    for (const [id, edit] of Object.entries(layerEdits)) {
      if (!edit || typeof edit !== 'object' || !finiteTree(edit) || ['sx', 'sy'].some((k) => edit[k] !== undefined && !(edit[k] > 0)) || edit.opacity !== undefined && !(edit.opacity >= 0 && edit.opacity <= 1) || edit.hidden !== undefined && typeof edit.hidden !== 'boolean') { fail('layer_edit_invalid', `Spread ${sp.n} has an invalid layer edit.`, sp); continue }
      const node = nodes.get(id), f = frames.find((item) => item.node === node)
      if (!node) { fail('layer_geometry_unverified', `Spread ${sp.n} references a missing template layer.`, sp); continue }
      if (node.children && ['dx', 'dy', 'sx', 'sy'].some((k) => edit[k] !== undefined && edit[k] !== (k[0] === 's' ? 1 : 0))) fail('layer_geometry_unverified', `Spread ${sp.n}'s group transform needs verified mask geometry.`, sp)
      if (edit.textStyle && edit.textStyle.font) fail('unsupported_edit', `Spread ${sp.n}'s font override is not implemented in print sheets.`, sp)
      if (f) { f.x += edit.dx || 0; f.y += edit.dy || 0; f.w *= edit.sx === undefined ? 1 : edit.sx; f.h *= edit.sy === undefined ? 1 : edit.sy; if (edit.hidden !== undefined) f.hidden = edit.hidden; if (edit.opacity !== undefined) f.opacity = edit.opacity }
    }
    // Active alpha/mask bounds determine the real clipping area, including fill-layer frames.
    for (const f of frames) {
      // Recompute inherited visibility after overrides; showing a frame cannot reveal its hidden group.
      f.hidden = false; f.opacity = 1
      const ids = nodeIds.get(f.node).split('/')
      for (let depth = 1; depth <= ids.length; depth++) {
        const id = ids.slice(0, depth).join('/'), node = nodes.get(id), edit = layerEdits[id] || {}
        f.hidden ||= edit.hidden === undefined ? !!node.hidden : !!edit.hidden
        f.opacity *= edit.opacity === undefined ? node.opacity === undefined ? 1 : node.opacity : edit.opacity
      }
      if (f.hidden || f.opacity <= 0) fail('frame_hidden', `Spread ${sp.n} has a hidden photo frame.`, sp)
      const node = f.node, img = node.imageData, mask = node.mask && !node.mask.disabled ? node.mask : null
      const left = node.left || 0, top = node.top || 0, w = node.right - left, h = node.bottom - top
      if (!img && !(mask && mask.imageData)) { fail('frame_geometry_unverified', `Spread ${sp.n}'s frame pixels and mask cannot be verified.`, sp); continue }
      const x0 = w > 0 ? left : mask.left, y0 = h > 0 ? top : mask.top, W = w > 0 ? w : mask.right - mask.left, H = h > 0 ? h : mask.bottom - mask.top
      let ax = W, ay = H, bx = -1, by = -1
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let alpha = img ? img.data[(y * img.width + x) * 4 + 3] : 255
        if (mask && mask.imageData) {
          const mx = x + x0 - (mask.left || 0) - (mask.positionRelativeToLayer ? left : 0), my = y + y0 - (mask.top || 0) - (mask.positionRelativeToLayer ? top : 0), md = mask.imageData
          alpha *= mx >= 0 && my >= 0 && mx < md.width && my < md.height ? md.data[(my * md.width + mx) * 4] / 255 : (mask.defaultColor || 0) / 255
        }
        if (alpha > 0) { ax = Math.min(ax, x); ay = Math.min(ay, y); bx = Math.max(bx, x); by = Math.max(by, y) }
      }
      if (bx < ax || by < ay) { fail('frame_empty', `Spread ${sp.n} contains an empty photo frame.`, sp); continue }
      const sx = f.w / W, sy = f.h / H
      f.x += ax * sx; f.y += ay * sy; f.w = (bx - ax + 1) * sx; f.h = (by - ay + 1) * sy
    }
    for (const orient of ['h', 'v']) {
      const photos = sp.photoIds.filter((id) => album.photos[id] && (album.photos[id].orient === 'v' ? 'v' : 'h') === orient)
      const matching = frames.filter((f) => f.orient === orient).sort((a, b) => a.name.localeCompare(b.name))
      if (photos.length > matching.length) fail('photo_unplaced', `Spread ${sp.n} has photos without matching frames.`, sp)
      if (photos.length < matching.length) fail('frame_unfilled', `Spread ${sp.n} has photo frames without photos.`, sp)
      for (let i = 0; i < Math.min(photos.length, matching.length); i++) {
        const id = photos[i], photo = album.photos[id], f = matching[i]
        if (!(await exists(photo.original))) { fail('missing_original', `Spread ${sp.n}: original for ${photo.base || id} is missing; thumbnails cannot be printed.`, sp); continue }
        const rotation = (ws.imageRotations || {})[id] === undefined ? 0 : ws.imageRotations[id], placement = (ws.imagePlacements || {})[id] || {}, adjust = (ws.imageAdjustments || {})[id] || {}
        const numericAdjust = ['exposure', 'contrast', 'saturation', 'warmth', 'tint', 'fade', 'clarity', 'sharpen', 'blur', 'vignette']
        if (!finiteTree({ rotation, placement, adjust }) || typeof rotation !== 'number' || ['scale', 'ox', 'oy'].some((k) => placement[k] !== undefined && typeof placement[k] !== 'number') || numericAdjust.some((k) => adjust[k] !== undefined && (typeof adjust[k] !== 'number' || Math.abs(adjust[k]) > 100)) || adjust.bw !== undefined && typeof adjust.bw !== 'boolean' || placement.scale !== undefined && !(placement.scale >= 1) || ['ox', 'oy'].some((k) => placement[k] !== undefined && Math.abs(placement[k]) > 1)) { fail('photo_edit_invalid', `Spread ${sp.n} has an invalid photo edit.`, sp); continue }
        if (Object.keys(adjust).some((k) => ![...numericAdjust, 'bw'].includes(k) && adjust[k])) fail('unsupported_edit', `Spread ${sp.n} has a colour adjustment that the print renderer does not support.`, sp)
        if (adjust.vignette) fail('unsupported_edit', `Spread ${sp.n}'s vignette is preview-only and must be removed before printing.`, sp)
        let meta
        try {
          if (!photoCache.has(photo.original)) {
            const input = await placeable(photo.original, path.join(ws.outputToken || path.join(album.path, 'exports'), '.album-studio', 'raw'))
            const pipeline = sharp()(input, { failOn: 'warning' })
            const m = await pipeline.metadata(); await pipeline.stats()
            const turn = [5, 6, 7, 8].includes(m.orientation)
            photoCache.set(photo.original, { w: turn ? m.height : m.width, h: turn ? m.width : m.height })
          }
          meta = photoCache.get(photo.original)
          if (![meta.w, meta.h].every((v) => Number.isFinite(v) && v > 0)) throw new Error('Invalid source dimensions.')
        } catch (e) { fail('photo_corrupt', `Spread ${sp.n}: ${photo.base || id} cannot be fully decoded (${e.message}).`, sp); continue }
        const edit = { rotation, ...placement }, transform = coverQuad(f, meta, edit)
        const sourcePpi = psd.height / inches / transform.scale
        const embeddingScale = settings.embeddingScale === undefined ? canvas.scale : settings.embeddingScale
        const embeddedPpi = settings.phase === 'export' ? null : sourcePpi * embedScale({ w: f.w * embeddingScale, h: f.h * embeddingScale }, meta, edit)
        const effectivePpi = embeddedPpi === null ? sourcePpi : Math.min(sourcePpi, embeddedPpi)
        add('info', 'effective_ppi', `${photo.base || id}: ${effectivePpi.toFixed(1)} effective PPI.`, sp, { photoId: id, sourcePpi, embeddedPpi, effectivePpi })
        if (effectivePpi + 1e-7 < minimum) fail('low_effective_ppi', `Spread ${sp.n}: ${photo.base || id} is below the ${minimum} PPI policy (${effectivePpi.toFixed(1)}).`, sp)
        const angle = rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle), q = transform.quad
        const cx = (q[0][0] + q[2][0]) / 2, cy = (q[0][1] + q[2][1]) / 2
        const uncovered = [[f.x, f.y], [f.x + f.w, f.y], [f.x + f.w, f.y + f.h], [f.x, f.y + f.h]].some(([x, y]) => Math.abs((x - cx) * cos + (y - cy) * sin) > meta.w * transform.scale / 2 + 0.01 || Math.abs(-(x - cx) * sin + (y - cy) * cos) > meta.h * transform.scale / 2 + 0.01)
        if (uncovered) fail('frame_coverage', `Spread ${sp.n}'s rotated photo does not cover all frame corners.`, sp)
      }
    }
    for (const id of sp.photoIds) if (!album.photos[id]) fail('photo_missing', `Spread ${sp.n} references a missing photo (${id}).`, sp)
  }
  if (settings.phase === 'export') add('warnings', 'embedded_resolution_unverified', 'Original photo resolution is checked. Detail inside edited sheets still needs a visual check before printing.')
  return report
}

module.exports = { preflightAlbum }
