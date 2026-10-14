// parity.js — the Electron editor's page edits, applied to a sheet in the PhotoCraft engine, so a
// rendered sheet matches its proof and the Photoshop build:
//   - template layer overrides (shown/hidden, opacity, moved/resized, retyped or restyled text),
//     applied right after the template opens, before frames are measured (a moved frame takes its
//     photo along), exactly where the Photoshop script applied them;
//   - text and shapes added in the editor, on top of everything: text as live, editable type
//     layers; shapes as one transparent layer (one PNG for the whole page, as before).
// Every step is guarded on its own: an override that can't be applied is reported, never fatal.

'use strict'

const fs = require('fs')
const path = require('path')
const { PhotoCraftSession } = require('./photocraft')

let agpsd = null
function getAgPsd() {
  if (agpsd) return agpsd
  agpsd = require('ag-psd')
  agpsd.initializeCanvas((w, h) => ({
    width: w,
    height: h,
    getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }) }),
  }))
  return agpsd
}

const msg = (e) => (e && e.message ? e.message : String(e))

/**
 * The template's layers by the ids the Electron editor stored its overrides under: the index path
 * in the PSD's own (bottom-to-top) order, "0/2/1". The engine lists layers top to bottom, so each
 * level is reversed to line the two up; names are compared, and a mismatch (a re-authored
 * template) is skipped rather than applied to the wrong layer.
 */
function pairLayers(agNodes, pcLayers, prefix = '', out = new Map()) {
  const engine = [...(pcLayers || [])].reverse()
  agNodes.forEach((n, i) => {
    const id = prefix ? `${prefix}/${i}` : String(i)
    const l = engine[i]
    out.set(id, { ag: n, pc: l && l.name === n.name ? l : null })
    if (n.children) pairLayers(n.children, l && (l.children || l.layers), id, out)
  })
  return out
}

/** The template's layer records (no pixels), with a text layer's copy, style and transform. */
async function templateOutline(psdPath) {
  const buf = await fs.promises.readFile(psdPath)
  return getAgPsd().readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true })
}

function agBox(n) {
  let x0 = n.left || 0, y0 = n.top || 0, x1 = n.right || 0, y1 = n.bottom || 0
  if ((x1 - x0 <= 0 || y1 - y0 <= 0) && n.mask) { x0 = n.mask.left || 0; y0 = n.mask.top || 0; x1 = n.mask.right || 0; y1 = n.mask.bottom || 0 }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Apply `layerEdits` (the editor's overrides for this page) to the open template.
 * @returns {Promise<string[]>} warnings
 */
async function applyLayerEdits(pc, templatePath, layerEdits) {
  const warnings = []
  if (!layerEdits || !Object.keys(layerEdits).length) return warnings
  const outline = await templateOutline(templatePath)
  const doc = await pc.call('doc.inspect', {})
  const ppi = Number(doc.resolution) || 72
  const pairs = pairLayers(outline.children || [], doc.layers)
  for (const [agId, edit] of Object.entries(layerEdits)) {
    const pair = pairs.get(agId)
    if (!pair || !pair.pc) {
      warnings.push(`a template layer edited in the spread editor (${pair ? `“${pair.ag.name}”` : agId}) wasn't found in the template; that edit was left out`)
      continue
    }
    const { ag, pc: layer } = pair
    const id = layer.id
    const isText = !!ag.text
    const step = async (what, fn) => {
      try { await fn() } catch (e) { warnings.push(`“${ag.name}”: couldn't ${what} (${msg(e)})`) }
    }
    if (edit.hidden !== undefined && edit.hidden === !!ag.hidden) { /* already so in the template */ } else if (edit.hidden !== undefined) {
      await step('show or hide it', () => pc.run('layer.setProps', { layer: id, visible: !edit.hidden }))
    }
    if (edit.opacity !== undefined && Math.abs(edit.opacity - (typeof ag.opacity === 'number' ? ag.opacity : 1)) > 0.001) {
      await step('change its opacity', () => pc.run('layer.setProps', { layer: id, opacity: edit.opacity }))
    }
    if (isText && typeof edit.text === 'string' && edit.text !== ag.text.text) {
      // The engine keeps the layer's own styles when the copy is replaced.
      await step('retype it', () => pc.run('type.edit', { layer: id, text: edit.text.replace(/\r\n?/g, '\n') }))
    }
    if (isText && edit.textStyle) {
      const st = edit.textStyle
      const style = {}
      if (st.sizePx > 0) style.size = +(st.sizePx * 72 / ppi).toFixed(3)
      if (typeof st.color === 'string' && /^#[0-9a-f]{6}$/i.test(st.color)) style.color = st.color
      if (Object.keys(style).length) await step('restyle it', () => pc.run('type.setStyle', { layer: id, ...style }))
      if (st.font) warnings.push(`“${ag.name}”: the font chosen in the spread editor isn't applied yet; the template's own font was kept`)
    }
    const sx = typeof edit.sx === 'number' ? edit.sx : 1
    const sy = typeof edit.sy === 'number' ? edit.sy : 1
    const dx = Number(edit.dx) || 0
    const dy = Number(edit.dy) || 0
    if (sx === 1 && sy === 1 && !dx && !dy) continue
    // The editor's box keeps its top-left at the original top-left plus (dx, dy), at w·sx × h·sy.
    const b = layer.bounds ? { x: layer.bounds[0], y: layer.bounds[1], w: layer.bounds[2], h: layer.bounds[3] } : agBox(ag)
    if (isText) {
      await step('move or resize it', async () => {
        const info = await pc.run('type.info', { layer: id })
        const [a, bb, c, d, e, f] = info.transform || [1, 0, 0, 1, 0, 0]
        await pc.run('type.edit', { layer: id, transform: [a * sx, bb * sy, c * sx, d * sy, sx * (e - b.x) + b.x + dx, sy * (f - b.y) + b.y + dy] })
      })
    } else if (sx === 1 && sy === 1) {
      await step('move it', () => pc.run('layer.translate', { layer: id, dx: Math.round(dx), dy: Math.round(dy) }))
    } else {
      const x0 = b.x + dx
      const y0 = b.y + dy
      const x1 = x0 + b.w * sx
      const y1 = y0 + b.h * sy
      await step('move or resize it', () => pc.run('edit.transform', { layer: id, rect: [b.x, b.y, b.x + b.w, b.y + b.h], quad: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] }))
    }
  }
  return warnings
}

/** The id of the layer at the top of the stack. */
async function topLayerId(pc) {
  const doc = await pc.call('doc.inspect', {})
  return doc.layers && doc.layers[0] ? doc.layers[0].id : null
}

/**
 * Add the page's text and shapes on top of the sheet.
 * @param {PhotoCraftSession} pc
 * @param {any[]} overlays   the page's overlays as the editor stores them
 * @param {{ width: number, height: number, tplIdx: number }} doc
 * @returns {Promise<string[]>} warnings
 */
async function addOverlays(pc, overlays, { width, height, tplIdx }) {
  const warnings = []
  if (!Array.isArray(overlays) || !overlays.some((o) => o && !o.hidden)) return warnings
  const { resolveTextLayout } = require('../../../src/overlay_render')
  const { hasShapeOverlays } = require('../../../src/overlay_ps')
  const { rasterizeOverlays } = require('../../../src/proof_renderer')
  const ppi = Number((await pc.call('doc.inspect', {})).resolution) || 72

  // Shapes first, as one layer (text sits above it, as in the Photoshop build).
  if (hasShapeOverlays(overlays)) {
    let png = null
    try {
      png = await rasterizeOverlays(overlays, width, height)
      if (png) {
        await pc.call('doc.open', { path: PhotoCraftSession.readPath(png) })
        const idx = (await pc.call('session.list', {})).active
        const copied = await pc.run('layer.copyToDocument', { document: tplIdx })
        await pc.call('doc.close', { index: idx })
        await pc.call('doc.select', { index: tplIdx })
        const id = copied.layers[0]
        await pc.run('layer.renameLayer', { layer: id, name: 'Album Studio — text & shapes' })
        const top = await topLayerId(pc)
        if (top !== null && top !== id) await pc.run('layer.moveTo', { layer: id, target: top, position: 'above' })
      }
    } catch (e) {
      warnings.push(`the shapes added in the spread editor couldn't be placed (${msg(e)})`)
    } finally {
      if (png) await fs.promises.unlink(png).catch(() => {})
    }
  }

  // Text as live type, bottom to top in the editor's order.
  for (const L of overlays) {
    if (!L || L.hidden || L.type !== 'text') continue
    const t = resolveTextLayout(L, width, height)
    if (!t) continue
    const name = (t.lines[0] || 'Text').slice(0, 40)
    try {
      const params = {
        x: t.anchorX,
        y: t.firstBaseline,
        text: t.lines.join('\n'),
        name,
        align: t.align === 'center' || t.align === 'right' ? t.align : 'left',
        font: t.font,
        weight: t.weight,
        italic: !!t.italic,
        size: +(t.fontSize * 72 / ppi).toFixed(3),
        leading: +(t.lineStep * 72 / ppi).toFixed(3),
        tracking: Math.round((t.trackingEm || 0) * 1000),
        color: /^#[0-9a-f]{6}/i.test(String(t.color)) ? String(t.color).slice(0, 7) : '#111111',
        underline: !!t.underline,
      }
      const made = await pc.run('type.create', params)
      const id = made.layer
      if (t.opacity < 1) await pc.run('layer.setProps', { layer: id, opacity: t.opacity })
      if (t.rot) {
        // Turn about the editor's box centre, as the preview does: the anchor moves round the
        // pivot and the type turns with it.
        const r = (t.rot * Math.PI) / 180
        const cos = Math.cos(r)
        const sin = Math.sin(r)
        const ax = t.anchorX - t.cx
        const ay = t.firstBaseline - t.cy
        await pc.run('type.edit', { layer: id, transform: [cos, sin, -sin, cos, t.cx + ax * cos - ay * sin, t.cy + ax * sin + ay * cos] })
      }
      const top = await topLayerId(pc)
      if (top !== null && top !== id) await pc.run('layer.moveTo', { layer: id, target: top, position: 'above' })
    } catch (e) {
      warnings.push(`the text “${name}” couldn't be added (${msg(e)})`)
    }
  }
  return warnings
}

/**
 * A copy of a photo with the editor's colour adjustments applied (exposure, saturation, …), made
 * by the same code as the previews, so the sheet matches the proof. Orientation and colour
 * profile are kept, so the copy places exactly like the original. Cached by source and settings.
 */
async function bakeAdjustments(file, adjust, cacheDir) {
  return (await bakeAdjustmentsEvidence(file, adjust, cacheDir)).file
}
async function bakeAdjustmentsEvidence(file, adjust, cacheDir) {
  if (!adjust || !Object.keys(adjust).some((k) => k !== 'vignette' && adjust[k])) {
    const { fileDigest, contentKey } = require('./cache'), digest = await fileDigest(file)
    return { file, digest, sourceKey: contentKey(file, digest) }
  }
  const { contentFileKey } = require('./cache')
  const { deriveCached, derivedKey, sourceBase } = require('./raw')
  const sourceKey = await contentFileKey(file)
  const recipe = `adjustments-jpeg95-v2-frozen:${JSON.stringify(adjust)}`
  const key = derivedKey(sourceKey, recipe)
  const out = path.join(cacheDir, `${sourceBase(file)}-adj-${key}.jpg`)
  const sharp = require('../../../src/sharp_config').getSharp()
  const { applyAdjust } = require('../../../src/proof_renderer')
  return deriveCached(file, out, sourceKey, recipe, async (tmp, frozen) => {
    const meta = await sharp(frozen, { failOn: 'error' }).metadata()
    await applyAdjust(sharp, sharp(frozen, { failOn: 'error' }), adjust, { width: meta.width, height: meta.height })
      .withMetadata()
      .jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
      .toFile(tmp)
  })
}

module.exports = { applyLayerEdits, addOverlays, bakeAdjustments, bakeAdjustmentsEvidence, pairLayers }
