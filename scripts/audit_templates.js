#!/usr/bin/env node
// @ts-check
// audit_templates.js — survey a PSD template library for the Photoshop
// features an in-app renderer would have to reproduce.
//
// WHY THIS EXISTS
// The app can already read, composite and re-export PSDs without Photoshop
// (see src/psd_layers.js and src/proof_renderer.js). What it cannot yet
// reproduce is the handful of Photoshop features that are *rendered* rather
// than stored as pixels — layer effects, adjustment layers, four blend modes
// libvips has no operator for, and smart objects.
//
// The app already renders without Photoshop; this survey counts how many
// templates in a real library use those features, so the ones that may not
// render exactly as Photoshop would are known, with counts instead of guesses.
//
// Reading is STRUCTURE-ONLY (no pixel decode), so a 60-template library is
// seconds, not minutes, and memory stays flat.
//
//   node scripts/audit_templates.js <folder> [more folders...]
//   node scripts/audit_templates.js <folder> --json report.json

const fs = require('fs')
const path = require('path')

// Blend modes libvips has no operator for. proof_renderer maps everything
// else; these silently fall back to normal, which is a visible difference.
const UNSUPPORTED_BLENDS = new Set(['hue', 'saturation', 'color', 'luminosity'])

// Layer effects ag-psd reports as data but nothing renders yet. Split by how
// hard each is to reproduce, because "uses effects" is too blunt to plan with.
const EFFECTS_TRACTABLE = new Set(['dropShadow', 'innerShadow', 'stroke', 'solidFill'])
const EFFECTS_HARD = new Set(['bevelEmboss', 'gradientOverlay', 'patternOverlay', 'satin', 'outerGlow', 'innerGlow'])

let _agpsd = null
function getAgPsd() {
  if (_agpsd) return _agpsd
  const agpsd = require('ag-psd')
  // Allocation-only shim; structure reads never touch pixels. Mirrors
  // src/psd_layers.js so both agree about what ag-psd needs.
  agpsd.initializeCanvas(/** @type {any} */((w, h) => ({
    width: w, height: h,
    getContext: () => ({
      createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }),
    }),
  })))
  _agpsd = agpsd
  return agpsd
}

const COLOUR_MODES = ['Bitmap', 'Greyscale', 'Indexed', 'RGB', 'CMYK', '?', '?', 'Multichannel', 'Duotone', 'Lab']

/** Read the file header directly — colour mode and depth aren't worth a parse. */
function readHeader(file) {
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(26)
  fs.readSync(fd, buf, 0, 26, 0)
  fs.closeSync(fd)
  if (buf.toString('ascii', 0, 4) !== '8BPS') return null
  return {
    width: buf.readUInt32BE(18),
    height: buf.readUInt32BE(14),
    depth: buf.readUInt16BE(22),
    mode: COLOUR_MODES[buf.readUInt16BE(24)] || String(buf.readUInt16BE(24)),
  }
}

/** @param {string} file */
function auditFile(file) {
  const header = readHeader(file)
  if (!header) return { file, ok: false, error: 'not a PSD (bad signature)' }

  /** @type {any} */
  const r = {
    file,
    ok: true,
    ...header,
    sizeMB: +(fs.statSync(file).size / 1e6).toFixed(1),
    layers: 0, groups: 0, frames: 0, textLayers: 0,
    clipped: 0, hiddenLayers: 0,
    effectsTractable: [], effectsHard: [],
    adjustmentLayers: [], unsupportedBlends: [], smartObjects: 0,
    fonts: new Set(),
  }

  try {
    const psd = getAgPsd().readPsd(fs.readFileSync(file), {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
    })
    const walk = (nodes) => {
      for (const n of nodes || []) {
        if (n.children) {
          r.groups++
          // A group's own blend still matters; 'pass through' is the default.
          if (n.blendMode && n.blendMode !== 'pass through' && UNSUPPORTED_BLENDS.has(n.blendMode)) {
            r.unsupportedBlends.push(`${n.name}:${n.blendMode}`)
          }
          walk(n.children)
          continue
        }
        r.layers++
        if (n.hidden) r.hiddenLayers++
        if (n.clipping) r.clipped++
        if (/toolkit[hv]frame/i.test(n.name || '')) r.frames++
        if (n.blendMode && UNSUPPORTED_BLENDS.has(n.blendMode)) {
          r.unsupportedBlends.push(`${n.name}:${n.blendMode}`)
        }
        if (n.text) {
          r.textLayers++
          const f = n.text.style && n.text.style.font && n.text.style.font.name
          if (f) r.fonts.add(f)
        }
        // `adjustment` is the parsed adjustment-layer payload; its presence
        // means the layer paints via maths we'd have to reimplement.
        if (n.adjustment) {
          r.adjustmentLayers.push(`${n.name}:${n.adjustment.type || 'unknown'}`)
        }
        if (n.placedLayer || n.smartObject) r.smartObjects++
        for (const key of Object.keys(n.effects || {})) {
          if (key === 'scale') continue          // not an effect, just metadata
          const list = n.effects[key]
          // ag-psd reports disabled effects too; only enabled ones render.
          const enabled = Array.isArray(list)
            ? list.some((e) => e && e.enabled !== false)
            : !!(list && list.enabled !== false)
          if (!enabled) continue
          if (EFFECTS_HARD.has(key)) r.effectsHard.push(`${n.name}:${key}`)
          else if (EFFECTS_TRACTABLE.has(key)) r.effectsTractable.push(`${n.name}:${key}`)
        }
      }
    }
    walk(psd.children)
    r.fonts = [...r.fonts]
  } catch (e) {
    return { file, ok: false, error: e instanceof Error ? e.message : String(e), ...header }
  }
  return r
}

function findPsds(root) {
  /** @type {string[]} */
  const out = []
  const walk = (dir, depth) => {
    if (depth > 6) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (/\.psd$/i.test(e.name)) out.push(p)
    }
  }
  const st = fs.statSync(root)
  if (st.isDirectory()) walk(root, 0); else out.push(root)
  return out
}

function main() {
  const args = process.argv.slice(2)
  const jsonAt = args.indexOf('--json')
  const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : null
  const roots = (jsonAt >= 0 ? args.slice(0, jsonAt) : args)
  if (!roots.length) {
    console.error('usage: node scripts/audit_templates.js <folder|file> [...] [--json out.json]')
    process.exit(1)
  }

  const files = roots.flatMap(findPsds)
  if (!files.length) { console.error('no .psd files found'); process.exit(1) }
  console.log(`Auditing ${files.length} template${files.length > 1 ? 's' : ''}…\n`)

  const results = []
  for (const f of files) {
    const r = auditFile(f)
    results.push(r)
    const name = path.basename(f)
    if (!r.ok) { console.log(`  ✗ ${name}  — ${r.error}`); continue }
    const flags = []
    if (r.mode !== 'RGB') flags.push(r.mode)
    if (r.depth !== 8) flags.push(r.depth + '-bit')
    if (r.effectsHard.length) flags.push(`${r.effectsHard.length} hard-effect`)
    if (r.effectsTractable.length) flags.push(`${r.effectsTractable.length} effect`)
    if (r.adjustmentLayers.length) flags.push(`${r.adjustmentLayers.length} adj-layer`)
    if (r.unsupportedBlends.length) flags.push(`${r.unsupportedBlends.length} blend`)
    if (r.smartObjects) flags.push(`${r.smartObjects} smart-obj`)
    console.log(`  ${flags.length ? '!' : '✓'} ${name.padEnd(34)} ${String(r.layers).padStart(3)}L `
      + `${String(r.frames).padStart(2)}F ${String(r.textLayers).padStart(2)}T`
      + (flags.length ? '   ⚠ ' + flags.join(', ') : ''))
  }

  const ok = results.filter((r) => r.ok)
  const any = (k) => ok.filter((r) => r[k] && r[k].length).length
  const pct = (n) => ok.length ? ` (${Math.round(n / ok.length * 100)}%)` : ''

  console.log(`\n${'═'.repeat(64)}\nBLOCKERS TO RUNNING WITHOUT PHOTOSHOP\n`)
  const rows = [
    ['Layer effects — hard (bevel, gradient, glow)', any('effectsHard')],
    ['Layer effects — tractable (shadow, stroke)', any('effectsTractable')],
    ['Adjustment layers (curves, levels, hue/sat)', any('adjustmentLayers')],
    ['Blend modes libvips lacks', any('unsupportedBlends')],
    ['Smart objects', ok.filter((r) => r.smartObjects).length],
    ['Not RGB (CMYK/Lab — colour management)', ok.filter((r) => r.mode !== 'RGB').length],
    ['Not 8-bit', ok.filter((r) => r.depth !== 8).length],
  ]
  for (const [label, n] of rows) {
    console.log(`  ${n ? '⚠' : '·'} ${label.padEnd(46)} ${String(n).padStart(3)}/${ok.length}${n ? pct(n) : ''}`)
  }

  const clean = ok.filter((r) => !r.effectsHard.length && !r.effectsTractable.length
    && !r.adjustmentLayers.length && !r.unsupportedBlends.length && !r.smartObjects
    && r.mode === 'RGB' && r.depth === 8)
  console.log(`\n  ${clean.length}/${ok.length}${pct(clean.length)} templates need NOTHING beyond what already works.`)

  const fonts = [...new Set(ok.flatMap((r) => r.fonts || []))].sort()
  if (fonts.length) {
    console.log(`\n  ${fonts.length} fonts referenced — each must be installed for text to render correctly:`)
    console.log('    ' + fonts.join(', '))
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2))
    console.log(`\n  Full per-template detail written to ${jsonOut}`)
  }
}

main()
