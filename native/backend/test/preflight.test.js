'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ag = require('ag-psd')
const sharp = require('../../../src/sharp_config').getSharp()
const { preflightAlbum } = require('../lib/preflight')

ag.initializeCanvas((w, h) => ({
  width: w,
  height: h,
  getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }) }),
}))

function pixels(w, h, alpha = 255) {
  const data = new Uint8ClampedArray(w * h * 4).fill(180)
  for (let i = 3; i < data.length; i += 4) data[i] = alpha
  return { width: w, height: h, data }
}

function frame(name = 'ToolkitHFrame_001', { x = 100, y = 50, w = 400, h = 300, ...extra } = {}) {
  return { name, left: x, top: y, right: x + w, bottom: y + h, imageData: pixels(w, h), ...extra }
}

async function fixture(t, { width = 800, height = 600, frames = [frame()], canvasW = 800, canvasH = 400 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-preflight-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const original = path.join(root, 'original.jpg')
  const thumb = path.join(root, 'thumbnail.jpg')
  await sharp({ create: { width, height, channels: 3, background: '#986543' } })
    .jpeg()
    .toFile(original)
  await sharp(original).resize(80, 60, { fit: 'inside' }).jpeg().toFile(thumb)
  const template = path.join(root, 'template.psd')
  fs.writeFileSync(
    template,
    ag.writePsdBuffer({ width: canvasW, height: canvasH, imageData: pixels(canvasW, canvasH), children: frames }),
  )
  const album = {
    path: root,
    photos: { photoA: { id: 'photoA', base: 'Original', original, thumb, width: 80, height: 60, orient: 'h' } },
    spreads: [
      { n: 1, id: 'spread_1', photoIds: ['photoA'], template: { id: 'templateA', name: 'Template', file: template } },
    ],
    identityConflicts: [],
  }
  const workspace = {
    outputToken: path.join(root, 'output'),
    imageRotations: {},
    imagePlacements: {},
    imageAdjustments: {},
    pageLayerEdits: {},
  }
  return {
    root,
    original,
    thumb,
    template,
    album,
    workspace,
    settings: { size: 'print', heightInches: 1, ppi: 300, phase: 'render' },
  }
}

const codes = (report) => report.errors.map((e) => e.code)
const run = (f, settings = {}, selected = null) =>
  preflightAlbum(f.album, f.workspace, { ...f.settings, ...settings }, selected)

test('real original pixels and PSD geometry pass with an explicit fallback policy and unverified lab warning', async (t) => {
  const f = await fixture(t)
  const before = JSON.stringify([f.album, f.workspace])
  const bytes = fs.readFileSync(f.original)
  const report = await run(f)
  assert.deepEqual(report.errors, [])
  assert.ok(report.warnings.some((e) => e.code === 'lab_spec_unverified'))
  assert.match(
    report.info.find((e) => e.code === 'effective_ppi_policy').message,
    /configured output.*300|300.*configured output/i,
  )
  const measured = report.info.find((e) => e.code === 'effective_ppi')
  assert.equal(measured.sourcePpi, 800, 'thumbnail dimensions must never drive print resolution')
  assert.equal(
    measured.embeddedPpi,
    375,
    'the print canvas preserves 25 percent recrop headroom above its 300 PPI target',
  )
  assert.equal(measured.effectivePpi, 375)
  assert.equal(JSON.stringify([f.album, f.workspace]), before)
  assert.deepEqual(fs.readFileSync(f.original), bytes)
})

test('a missing original cannot use an intact thumbnail', async (t) => {
  const f = await fixture(t)
  f.album.photos.photoA.original = null
  assert.ok(codes(await run(f)).includes('missing_original'))
  f.album.photos.photoA.original = path.join(f.root, 'gone.jpg')
  assert.ok(codes(await run(f)).includes('missing_original'))
})

test('corrupt photo entropy is rejected even when its JPEG header remains readable', async (t) => {
  const f = await fixture(t)
  const data = fs.readFileSync(f.original)
  fs.writeFileSync(f.original, data.subarray(0, Math.floor(data.length * 0.7)))
  assert.ok(codes(await run(f)).includes('photo_corrupt'))
})

test('missing references, missing templates and corrupt PSDs block production', async (t) => {
  const f = await fixture(t)
  f.album.spreads[0].photoIds.push('missingPhoto')
  assert.ok(codes(await run(f)).includes('photo_missing'))
  f.album.spreads[0].template.file = path.join(f.root, 'missing.psd')
  assert.ok(codes(await run(f)).includes('template_missing'))
  f.album.spreads[0].template.file = f.template
  fs.writeFileSync(f.template, 'corrupt PSD')
  assert.ok(codes(await run(f)).includes('template_corrupt'))
})

test('only requested spreads and their ambiguous adjustments are gated', async (t) => {
  const f = await fixture(t)
  f.album.spreads.push({ n: 2, id: 'spread_2', photoIds: ['missing'], template: null })
  f.album.identityConflicts.push({
    n: 2,
    kind: 'photo',
    id: 'missing',
    reason: 'ambiguous-reference',
    candidates: ['missing'],
  })
  assert.deepEqual((await run(f, {}, [1])).errors, [])
  f.album.identityConflicts.push({
    kind: 'photo',
    id: 'legacy',
    reason: 'ambiguous-adjustment',
    field: 'imagePlacements',
    candidates: ['photoA', 'photoB'],
  })
  assert.ok(codes(await run(f, {}, [1])).includes('identity_conflict'))
})

test('unknown, duplicate and nonfinite spread selections cannot bypass preflight', async (t) => {
  const f = await fixture(t)
  for (const selected of [[99], [1, 1], [Infinity], []])
    assert.ok(codes(await run(f, {}, selected)).includes('spread_selection_invalid'))
})

test('mismatched orientation counts cannot silently omit photos or leave placeholder frames', async (t) => {
  const f = await fixture(t)
  f.album.photos.photoA.orient = 'v'
  let report = await run(f)
  assert.ok(codes(report).includes('photo_unplaced'))
  assert.ok(codes(report).includes('frame_unfilled'))
  f.album.photos.photoA.orient = 'h'
  f.album.spreads[0].photoIds.push('photoA')
  report = await run(f)
  assert.ok(codes(report).includes('photo_unplaced'))
})

test('hidden frame layers, hidden parent groups and zero alpha frames are rejected', async (t) => {
  for (const frames of [
    [frame(undefined, { hidden: true })],
    [{ name: 'Hidden group', hidden: true, children: [frame()] }],
    [frame(undefined, { imageData: pixels(400, 300, 0) })],
  ]) {
    const f = await fixture(t, { frames })
    const report = await run(f)
    assert.ok(codes(report).includes('frame_hidden') || codes(report).includes('frame_empty'))
  }
})

test('group visibility overrides apply to descendant frames and cannot be bypassed by showing a child', async (t) => {
  const f = await fixture(t, { frames: [{ name: 'Group', children: [frame()] }] })
  f.workspace.pageLayerEdits[1] = { 0: { hidden: true }, '0/0': { hidden: false } }
  assert.ok(codes(await run(f)).includes('frame_hidden'))
  f.workspace.pageLayerEdits[1] = { 0: { opacity: 0 } }
  assert.ok(codes(await run(f)).includes('frame_hidden'))
  const hidden = await fixture(t, { frames: [{ name: 'Group', hidden: true, children: [frame()] }] })
  hidden.workspace.pageLayerEdits[1] = { 0: { hidden: false } }
  assert.deepEqual((await run(hidden)).errors, [], 'a supported group visibility change may reveal its frames')
})

test('effective PPI decreases with actual physical size and user zoom', async (t) => {
  const f = await fixture(t)
  let report = await run(f, { heightInches: 3 })
  assert.ok(codes(report).includes('low_effective_ppi'))
  f.workspace.imagePlacements.photoA = { scale: 4, ox: 1, oy: -1 }
  report = await run(f)
  assert.equal(report.info.find((e) => e.code === 'effective_ppi').sourcePpi, 200)
  assert.ok(codes(report).includes('low_effective_ppi'))
})

test('an explicit minimum PPI threshold passes exactly at its boundary and blocks below it', async (t) => {
  const f = await fixture(t, { width: 300, height: 225 })
  assert.deepEqual((await run(f, { minEffectivePpi: 300 })).errors, [])
  assert.ok(codes(await run(f, { minEffectivePpi: 300.001 })).includes('low_effective_ppi'))
})

test('quarter-turn rotation uses the rotated source dimensions', async (t) => {
  const f = await fixture(t, { frames: [frame('ToolkitVFrame_001', { x: 50, y: 0, w: 300, h: 400 })] })
  f.album.photos.photoA.orient = 'v'
  f.workspace.imageRotations.photoA = 90
  const report = await run(f)
  assert.deepEqual(report.errors, [])
  assert.equal(report.info.find((e) => e.code === 'effective_ppi').sourcePpi, 800)
})

test('bounding-box fit after arbitrary rotation must cover all four frame corners', async (t) => {
  const f = await fixture(t)
  f.workspace.imageRotations.photoA = 45
  assert.ok(codes(await run(f)).includes('frame_coverage'))
})

test('nonfinite settings, rotations, placements, adjustments and overrides fail closed', async (t) => {
  const f = await fixture(t)
  for (const settings of [
    { ppi: NaN },
    { ppi: 0 },
    { heightInches: Infinity },
    { minEffectivePpi: -1 },
    { size: 'unknown' },
  ]) {
    assert.ok(codes(await run(f, settings)).includes('print_settings_invalid'))
  }
  f.workspace.imageRotations.photoA = Infinity
  assert.ok(codes(await run(f)).includes('photo_edit_invalid'))
  delete f.workspace.imageRotations.photoA
  for (const placement of [{ scale: NaN }, { scale: 0 }, { ox: 2 }, { oy: -Infinity }]) {
    f.workspace.imagePlacements.photoA = placement
    assert.ok(codes(await run(f)).includes('photo_edit_invalid'))
  }
  delete f.workspace.imagePlacements.photoA
  f.workspace.imageAdjustments.photoA = { brightness: NaN }
  assert.ok(codes(await run(f)).includes('photo_edit_invalid'))
  delete f.workspace.imageAdjustments.photoA
  f.workspace.imagePlacements.photoA = { ox: 'invalid' }
  assert.ok(codes(await run(f)).includes('photo_edit_invalid'))
  delete f.workspace.imagePlacements.photoA
  f.workspace.imageAdjustments.photoA = { exposure: 'bright' }
  assert.ok(codes(await run(f)).includes('photo_edit_invalid'))
  f.workspace.imageAdjustments.photoA = { unsupportedTone: 20 }
  assert.ok(codes(await run(f)).includes('unsupported_edit'))
  delete f.workspace.imageAdjustments.photoA
  f.workspace.pageLayerEdits[1] = { 0: { sx: Infinity } }
  assert.ok(codes(await run(f)).includes('layer_edit_invalid'))
})

test('a preview-only vignette blocks print delivery until removed or implemented', async (t) => {
  const f = await fixture(t)
  f.workspace.imageAdjustments.photoA = { vignette: 20 }
  assert.ok(codes(await run(f)).includes('unsupported_edit'))
})

test('plain frame overrides affect coverage and PPI, while unverified group transforms block', async (t) => {
  const f = await fixture(t)
  f.workspace.pageLayerEdits[1] = { 0: { hidden: true } }
  assert.ok(codes(await run(f)).includes('frame_hidden'))
  // Doubling width still supplies 400 PPI here; tripling drops below the 300 PPI policy.
  f.workspace.pageLayerEdits[1] = { 0: { sx: 3, sy: 1 } }
  assert.ok(codes(await run(f)).includes('low_effective_ppi'))
  const grouped = await fixture(t, { frames: [{ name: 'Group', children: [frame()] }] })
  grouped.workspace.pageLayerEdits[1] = { 0: { dx: 20, sx: 1.5 } }
  assert.ok(codes(await run(grouped)).includes('layer_geometry_unverified'))
})

test('masked frames measure their real active mask bounds and detect fully masked placeholders', async (t) => {
  const f = await fixture(t, {
    frames: [
      frame(undefined, {
        mask: { left: 150, top: 100, right: 350, bottom: 250, defaultColor: 0, imageData: pixels(200, 150) },
      }),
    ],
  })
  assert.deepEqual((await run(f)).errors, [])
  const empty = await fixture(t, {
    frames: [
      frame(undefined, {
        mask: { left: 100, top: 50, right: 500, bottom: 350, defaultColor: 0, imageData: pixels(400, 300, 0) },
      }),
    ],
  })
  // PSD masks store their first channel as coverage, rather than RGBA alpha.
  const mask = pixels(400, 300)
  mask.data.fill(0)
  fs.writeFileSync(
    empty.template,
    ag.writePsdBuffer({
      width: 800,
      height: 400,
      imageData: pixels(800, 400),
      children: [
        frame(undefined, { mask: { left: 100, top: 50, right: 500, bottom: 350, defaultColor: 0, imageData: mask } }),
      ],
    }),
  )
  assert.ok(codes(await run(empty)).includes('frame_empty'))
})

test('a declared lab size is checked, while bleed, safe-area and gutter compliance remain unverified', async (t) => {
  const f = await fixture(t)
  f.workspace.printSpec = {
    widthInches: 2,
    heightInches: 1,
    bleedInches: 0.125,
    safeInches: 0.25,
    gutterInches: 0.5,
    profile: 'srgb',
  }
  let report = await run(f)
  assert.deepEqual(report.errors, [])
  assert.ok(report.warnings.some((e) => e.code === 'lab_layout_unverified'))
  f.workspace.printSpec.heightInches = 2
  assert.ok(codes(await run(f)).includes('lab_dimensions_mismatch'))
  f.workspace.printSpec.heightInches = 1
  f.workspace.printSpec.bleedInches = NaN
  report = await run(f)
  assert.ok(codes(report).includes('lab_spec_invalid'))
})

test('export phase does not claim a seeded or edited sheet followed the current embedding recipe', async (t) => {
  const f = await fixture(t)
  const report = await run(f, { phase: 'export' })
  assert.deepEqual(report.errors, [])
  assert.ok(report.warnings.some((e) => e.code === 'embedded_resolution_unverified'))
  assert.equal(report.info.find((e) => e.code === 'effective_ppi').embeddedPpi, null)
})

test('a renderer embedding scale raises its sample budget without inventing source detail', async (t) => {
  const f = await fixture(t)
  const report = await run(f, { heightInches: 2, embeddingScale: 2 })
  assert.deepEqual(report.errors, [])
  assert.equal(report.info.find((e) => e.code === 'effective_ppi').effectivePpi, 400)
})
