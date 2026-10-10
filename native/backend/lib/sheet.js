// sheet.js — builds one album sheet with PhotoCraft, as scripts/build_pages_batch.jsx did with
// Photoshop: every frame layer (ToolkitHFrame_* / ToolkitVFrame_*, in name order) gets the next
// photo of its orientation, placed as a smart object directly above it, clipped to it, scaled to
// cover it, then zoomed, panned and rotated as the user set it in the spread editor.
//
// Differences from the Photoshop script, all measured on the Wedding album:
//   - headless PhotoCraft refuses File › Place (ambient paths), so the photo is opened as its own
//     document, made a smart object and copied in;
//   - photos are embedded at the resolution their frame needs (+25 % for re-cropping), not at full
//     size: full-size embeds made 1.6 GB sheets that the editor can't open;
//   - frames that are fill layers shaped by a mask take their area from the mask.

'use strict'

const { PhotoCraftSession } = require('./photocraft')

/** Pixels kept beyond what the frame needs, so the photo can be re-cropped later. */
const HEADROOM = 1.25

// ── pure geometry (tested) ──────────────────────────────────────────────────

/** Frame layers matching `pattern`, depth-first in document order, then sorted by name. */
function findFrames(layers, pattern) {
  const out = []
  const walk = (list) => {
    for (const l of list || []) {
      if (String(l.name || '').toLowerCase().includes(pattern)) out.push(l)
      walk(l.children || l.layers)
    }
  }
  walk(layers)
  // localeCompare, as the Photoshop script sorted (so "Frame_10" follows "Frame_1", as before).
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

/** Which photo goes in which frame: landscape photos fill H frames in order, portrait V frames. */
function pairFrames(layers, photos) {
  const h = findFrames(layers, 'toolkithframe')
  const v = findFrames(layers, 'toolkitvframe')
  const hp = photos.filter((p) => p.orient === 'h')
  const vp = photos.filter((p) => p.orient !== 'h')
  const pairs = []
  for (let i = 0; i < Math.min(h.length, hp.length); i++) pairs.push({ frame: h[i], photo: hp[i] })
  for (let i = 0; i < Math.min(v.length, vp.length); i++) pairs.push({ frame: v[i], photo: vp[i] })
  return { pairs, frames: { h: h.length, v: v.length }, unplaced: photos.length - pairs.length }
}

/**
 * Where the photo's corners go so that it covers the frame, after the user's rotation, zoom and
 * pan. Mirrors placeAndFit in build_pages_batch.jsx: rotate about the centre, scale so the
 * rotated bounds cover the frame (× zoom, never below 1), then pan by ox/oy ∈ [-1, 1] of the
 * overflow. Returns the four destination corners, clockwise from the source's top-left.
 *
 * @param {{x:number,y:number,w:number,h:number}} frame
 * @param {{w:number,h:number}} photo   the placed layer's size
 * @param {{rotation?:number, scale?:number, ox?:number, oy?:number}} [edit]
 */
function coverQuad(frame, photo, edit = {}) {
  const deg = Number(edit.rotation) || 0
  const t = (deg * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  // Bounds of the rotated photo.
  const rw = Math.abs(photo.w * cos) + Math.abs(photo.h * sin)
  const rh = Math.abs(photo.w * sin) + Math.abs(photo.h * cos)
  const zoom = Math.max(1, Number(edit.scale) || 1)
  const s = Math.max(frame.w / rw, frame.h / rh) * zoom
  const clamp = (v) => Math.max(-1, Math.min(1, Number(v) || 0))
  const ox = clamp(edit.ox)
  const oy = clamp(edit.oy)
  const cx = frame.x + frame.w / 2 + (-ox * (rw * s - frame.w)) / 2
  const cy = frame.y + frame.h / 2 + (-oy * (rh * s - frame.h)) / 2
  const hw = photo.w / 2
  const hh = photo.h / 2
  // y points down, so this is a clockwise rotation on screen, as in Photoshop.
  const corner = (x, y) => [cx + (x * cos - y * sin) * s, cy + (x * sin + y * cos) * s]
  return { quad: [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)], scale: s }
}

/** The factor to shrink a photo to before embedding (≤ 1): enough to cover its frame + headroom. */
function embedScale(frame, photo, edit = {}) {
  const rotated = [90, 270].includes((((Number(edit.rotation) || 0) % 360) + 360) % 360)
  const pw = rotated ? photo.h : photo.w
  const ph = rotated ? photo.w : photo.h
  const zoom = Math.max(1, Number(edit.scale) || 1)
  return Math.min(1, Math.max(frame.w / pw, frame.h / ph) * zoom * HEADROOM)
}

const box = (b) => (b ? { x: b[0], y: b[1], w: b[2], h: b[3] } : null)

// ── PhotoCraft steps ────────────────────────────────────────────────────────

/** A frame's area. Fill-layer frames have no pixel bounds; their shape is the layer mask. */
async function frameBox(pc, frame) {
  if (frame.bounds && !frame.hasMask) return box(frame.bounds)
  await pc.run('select.loadSelection', { channel: 'mask', layer: frame.id })
  const doc = await pc.call('doc.inspect', {})
  await pc.run('select.deselect', {})
  const b = box(frame.bounds)
  const m = box(doc.selectionBounds)
  if (!b || !m) return b || m
  const x0 = Math.max(b.x, m.x)
  const y0 = Math.max(b.y, m.y)
  return { x: x0, y: y0, w: Math.min(b.x + b.w, m.x + m.w) - x0, h: Math.min(b.y + b.h, m.y + m.h) - y0 }
}

function findLayer(layers, id) {
  for (const l of layers || []) {
    if (l.id === id) return l
    const hit = findLayer(l.children || l.layers, id)
    if (hit) return hit
  }
  return null
}

/**
 * Build one sheet.
 * @param {PhotoCraftSession} pc
 * @param {{
 *   template: string,
 *   photos: {file: string, orient: 'h'|'v', name: string, edit?: object}[],
 *   outPsd: string,
 *   outJpg?: string | null,
 * }} job   `file` must already be placeable (RAW developed).
 */
async function buildSheet(pc, job) {
  const warnings = []
  await pc.call('doc.open', { path: PhotoCraftSession.readPath(job.template) })
  const tplIdx = (await pc.call('session.list', {})).active
  try {
    const doc = await pc.call('doc.inspect', {})
    const { pairs, frames, unplaced } = pairFrames(doc.layers, job.photos)
    if (unplaced) warnings.push(`${unplaced} photo(s) had no matching frame (template has ${frames.h} H and ${frames.v} V frames)`)
    for (const { frame, photo } of pairs) {
      const area = await frameBox(pc, frame)
      if (!area || area.w <= 0 || area.h <= 0) {
        warnings.push(`frame ${frame.name} has no area; ${photo.name} skipped`)
        continue
      }
      const edit = photo.edit || {}
      await pc.call('doc.open', { path: PhotoCraftSession.readPath(photo.file) })
      const photoIdx = (await pc.call('session.list', {})).active
      const pdoc = await pc.call('doc.inspect', {})
      const k = embedScale(area, { w: pdoc.width, h: pdoc.height }, edit)
      if (k < 0.999) {
        await pc.run('image.imageSize', { width: Math.max(1, Math.round(pdoc.width * k)), height: Math.max(1, Math.round(pdoc.height * k)), resample: 'bicubic' })
      }
      await pc.run('layer.smartObjects.convertToSmartObject', {})
      const copied = await pc.run('layer.copyToDocument', { document: tplIdx })
      const id = copied.layers[0]
      await pc.call('doc.close', { index: photoIdx })
      await pc.call('doc.select', { index: tplIdx })
      await pc.run('layer.renameLayer', { layer: id, name: photo.name })
      await pc.run('layer.moveTo', { layer: id, target: frame.id, position: 'above' })
      await pc.run('layer.createClippingMask', { layer: id })
      const placed = findLayer((await pc.call('doc.inspect', {})).layers, id)
      const b = box(placed && placed.bounds)
      if (!b) { warnings.push(`${photo.name} has no bounds after placing`); continue }
      const { quad } = coverQuad(area, { w: b.w, h: b.h }, edit)
      await pc.run('edit.transform', { layer: id, rect: [b.x, b.y, b.x + b.w, b.y + b.h], quad })
    }
    await pc.call('doc.save', { path: pc.writePath(job.outPsd) })
    if (job.outJpg) await pc.call('doc.save', { path: pc.writePath(job.outJpg), quality: 92 })
    return { placed: pairs.length, frames, warnings }
  } finally {
    // Whatever happened, nothing stays open in the engine (no leaked photos between sheets).
    await closeAll(pc)
  }
}

/** Close every document in the session, last first (indices shift as documents close). */
async function closeAll(pc) {
  const list = await pc.call('session.list', {}).catch(() => null)
  const docs = (list && list.documents) || []
  for (let i = docs.length - 1; i >= 0; i--) await pc.call('doc.close', { index: docs[i].index }).catch(() => {})
}

/** `Page_005` for spread 5: the name the Electron app's renders used, so files line up. */
const outputName = (n) => `Page_${String(n).padStart(3, '0')}`

module.exports = { buildSheet, closeAll, pairFrames, coverQuad, embedScale, findFrames, outputName, HEADROOM }
