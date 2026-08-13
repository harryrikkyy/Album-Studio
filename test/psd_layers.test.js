'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const {
  readPsdLayerTree,
  flattenDrawOrder,
  resolveClipping,
  frameLayers,
  isFrameName,
} = require('../src/psd_layers')

// ─── fixture ─────────────────────────────────────────────────────────────────
// A PSD written with ag-psd, shaped like a real album template: a background,
// a group holding two photo frames with a clipped colour wash over the first,
// a decorative rule ABOVE the frames (the case a flattened backdrop gets
// wrong), and a hidden layer.

function rgba(w, h, [r, g, b, a = 255]) {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a }
  return { width: w, height: h, data: d }
}

let FIXTURE = null
function fixturePath() {
  if (FIXTURE) return FIXTURE
  const agpsd = require('ag-psd')
  agpsd.initializeCanvas((w, h) => ({
    width: w, height: h,
    getContext: () => ({
      createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }),
    }),
  }))
  const psd = {
    width: 800,
    height: 600,
    children: [
      { name: 'Background', left: 0, top: 0, imageData: rgba(800, 600, [240, 235, 225]) },
      {
        name: 'Photos',
        opened: true,
        children: [
          { name: 'toolkithframe1', left: 50, top: 50, imageData: rgba(300, 200, [200, 200, 200]) },
          { name: 'colour wash', left: 50, top: 50, clipping: true, blendMode: 'multiply', opacity: 0.6, imageData: rgba(300, 200, [255, 0, 0]) },
          { name: 'toolkitvframe1', left: 420, top: 50, imageData: rgba(200, 300, [180, 180, 180]) },
        ],
      },
      { name: 'Gold rule', left: 100, top: 420, imageData: rgba(600, 6, [176, 141, 87]) },
      { name: 'Hidden flourish', left: 600, top: 400, hidden: true, imageData: rgba(120, 120, [0, 0, 255]) },
    ],
  }
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'psdfix-')), 'template.psd')
  fs.writeFileSync(p, Buffer.from(agpsd.writePsdBuffer(psd)))
  FIXTURE = p
  return p
}

let TREE = null
async function tree() {
  if (!TREE) TREE = await readPsdLayerTree(fixturePath(), { force: true })
  return TREE
}

// ─── name matching ───────────────────────────────────────────────────────────

test('isFrameName matches the toolkit frame convention, case-insensitively', () => {
  assert.equal(isFrameName('toolkithframe1'), true)
  assert.equal(isFrameName('ToolkitVFrame2'), true)
  assert.equal(isFrameName('Background'), false)
  assert.equal(isFrameName(undefined), false)
})

// ─── reading ─────────────────────────────────────────────────────────────────

test('reads the document size and the whole tree', async () => {
  const t = await tree()
  assert.equal(t.ok, true, t.error)
  assert.equal(t.width, 800)
  assert.equal(t.height, 600)
  assert.equal(t.layers.length, 4, 'four top-level entries')
})

test('a missing file is reported, not thrown', async () => {
  const r = await readPsdLayerTree('/nope/missing.psd')
  assert.equal(r.ok, false)
  assert.match(r.error, /not found/)
})

test('groups keep their children and carry no pixels', async () => {
  const t = await tree()
  const group = t.layers.find((l) => l.name === 'Photos')
  assert.equal(group.kind, 'group')
  assert.equal(group.children.length, 3)
  assert.equal(group.png, null)
})

test('layers are returned bottom-to-top (draw order)', async () => {
  const t = await tree()
  assert.deepEqual(t.layers.map((l) => l.name),
    ['Background', 'Photos', 'Gold rule', 'Hidden flourish'])
})

test('per-layer metadata survives the round trip', async () => {
  const t = await tree()
  const group = t.layers.find((l) => l.name === 'Photos')
  const wash = group.children.find((l) => l.name === 'colour wash')
  assert.equal(wash.clipped, true)
  assert.equal(wash.blendMode, 'multiply')
  assert.ok(Math.abs(wash.opacity - 0.6) < 0.01)
  assert.deepEqual([wash.x, wash.y, wash.w, wash.h], [50, 50, 300, 200])
})

test('hidden layers are listed, marked not visible', async () => {
  const t = await tree()
  const hidden = t.layers.find((l) => l.name === 'Hidden flourish')
  assert.equal(hidden.visible, false, 'a hidden layer must still appear in the panel')
})

test('frame layers are flagged', async () => {
  const t = await tree()
  const frames = frameLayers(t.layers)
  assert.deepEqual(frames.map((f) => f.name), ['toolkithframe1', 'toolkitvframe1'])
})

test('every raster layer gets a PNG on disk; groups do not', async () => {
  const t = await tree()
  const flat = flattenDrawOrder(t.layers)
  for (const n of flat) {
    if (n.kind === 'group') { assert.equal(n.png, null); continue }
    assert.ok(n.png, `${n.name} should have a PNG`)
    assert.ok(fs.existsSync(n.png), `${n.png} should exist`)
  }
})

test('the flattened composite is exported too', async () => {
  const t = await tree()
  assert.ok(t.compositePath && fs.existsSync(t.compositePath))
})

test('ids are unique and stable across reads', async () => {
  const a = await readPsdLayerTree(fixturePath(), { force: true })
  const b = await readPsdLayerTree(fixturePath(), { force: true })
  const ids = (t) => flattenDrawOrder(t.layers).map((n) => n.id)
  assert.deepEqual(ids(a), ids(b))
  assert.equal(new Set(ids(a)).size, ids(a).length, 'ids must be unique')
})

test('duplicate layer names do not collide (ids are index paths)', async () => {
  const t = await tree()
  const flat = flattenDrawOrder(t.layers)
  // The group and its first child would collide on any name-derived id.
  const group = flat.find((n) => n.name === 'Photos')
  const frame = flat.find((n) => n.name === 'toolkithframe1')
  assert.notEqual(group.id, frame.id)
  assert.ok(frame.id.startsWith(group.id + '/'), 'child id nests under its group')
})

test('the second read is served from cache', async () => {
  await readPsdLayerTree(fixturePath(), { force: true })
  const cached = await readPsdLayerTree(fixturePath())
  assert.equal(cached.cached, true)
  assert.equal(cached.ok, true)
})

// ─── draw order + group inheritance ──────────────────────────────────────────

test('flattenDrawOrder emits groups before their children, with depth', async () => {
  const t = await tree()
  const flat = flattenDrawOrder(t.layers)
  assert.deepEqual(flat.map((n) => n.name), [
    'Background', 'Photos', 'toolkithframe1', 'colour wash', 'toolkitvframe1',
    'Gold rule', 'Hidden flourish',
  ])
  assert.equal(flat.find((n) => n.name === 'Photos').depth, 0)
  assert.equal(flat.find((n) => n.name === 'colour wash').depth, 1)
})

test('hiding a group hides its whole subtree', async () => {
  const t = await tree()
  const groupId = t.layers.find((l) => l.name === 'Photos').id
  const flat = flattenDrawOrder(t.layers, { [groupId]: { hidden: true } })
  for (const name of ['toolkithframe1', 'colour wash', 'toolkitvframe1']) {
    assert.equal(flat.find((n) => n.name === name).effectiveVisible, false,
      `${name} must be hidden with its group`)
  }
  assert.equal(flat.find((n) => n.name === 'Gold rule').effectiveVisible, true,
    'layers outside the group are unaffected')
})

test('group opacity multiplies into its children', async () => {
  const t = await tree()
  const groupId = t.layers.find((l) => l.name === 'Photos').id
  const flat = flattenDrawOrder(t.layers, { [groupId]: { opacity: 0.5 } })
  const wash = flat.find((n) => n.name === 'colour wash')
  assert.ok(Math.abs(wash.effectiveOpacity - 0.3) < 0.01, 'own 0.6 × group 0.5')
})

test('an edit can re-show a layer the PSD ships hidden', async () => {
  const t = await tree()
  const id = t.layers.find((l) => l.name === 'Hidden flourish').id
  const flat = flattenDrawOrder(t.layers, { [id]: { hidden: false } })
  assert.equal(flat.find((n) => n.name === 'Hidden flourish').effectiveVisible, true)
})

// ─── clipping ────────────────────────────────────────────────────────────────

test('a clipped layer resolves to the non-clipped layer below it', async () => {
  const t = await tree()
  const resolved = resolveClipping(flattenDrawOrder(t.layers))
  const wash = resolved.find((n) => n.name === 'colour wash')
  const frame = resolved.find((n) => n.name === 'toolkithframe1')
  assert.equal(wash.clipBaseId, frame.id, 'wash clips into the frame beneath it')
})

test('non-clipped layers have no clip base', async () => {
  const t = await tree()
  const resolved = resolveClipping(flattenDrawOrder(t.layers))
  assert.equal(resolved.find((n) => n.name === 'Gold rule').clipBaseId, null)
  assert.equal(resolved.find((n) => n.name === 'Background').clipBaseId, null)
})

test('a run of clipped layers all share one base', () => {
  // Synthetic: base, then three consecutive clipped layers on top of it.
  const flat = [
    { id: 'a', kind: 'raster', clipped: false },
    { id: 'b', kind: 'raster', clipped: true },
    { id: 'c', kind: 'raster', clipped: true },
    { id: 'd', kind: 'raster', clipped: true },
    { id: 'e', kind: 'raster', clipped: false },
  ]
  const r = resolveClipping(flat)
  assert.deepEqual(r.map((n) => n.clipBaseId), [null, 'a', 'a', 'a', null])
})

// ─── Photoshop index translation ─────────────────────────────────────────────
// ag-psd lists a container's children bottom-to-top; ExtendScript's
// doc.layers[0] is the TOPMOST layer. Getting this backwards doesn't throw —
// it hides the wrong layer in the delivered PSD — so it is pinned here.

const { toPhotoshopLayerOps } = require('../src/psd_layers')

test('layer indices are inverted for ExtendScript', async () => {
  const t = await tree()
  // Top level, bottom-to-top: Background(0) Photos(1) Gold rule(2) Hidden(3).
  // ExtendScript sees the reverse: Hidden(0) Gold rule(1) Photos(2) Background(3).
  const id = (n) => t.layers.find((l) => l.name === n).id
  const ops = toPhotoshopLayerOps(t.layers, {
    [id('Background')]: { hidden: true },
    [id('Gold rule')]: { hidden: true },
  })
  const byName = Object.fromEntries(ops.map((o) => [o.name, o.path]))
  assert.deepEqual(byName['Background'], [3], 'bottom layer is last in ExtendScript')
  assert.deepEqual(byName['Gold rule'], [1])
})

test('nested layers get a full inverted path', async () => {
  const t = await tree()
  const group = t.layers.find((l) => l.name === 'Photos')
  const wash = group.children.find((l) => l.name === 'colour wash')
  const ops = toPhotoshopLayerOps(t.layers, { [wash.id]: { hidden: true } })
  // Group is index 1 of 4 bottom-up -> 2 top-down. Wash is index 1 of 3 -> 1.
  assert.deepEqual(ops[0].path, [2, 1])
  assert.equal(ops[0].name, 'colour wash')
})

test('only real deviations are emitted', async () => {
  const t = await tree()
  const id = (n) => t.layers.find((l) => l.name === n).id
  // Hiding an already-hidden layer, and setting opacity to its current value,
  // are both no-ops — the export must leave the template untouched.
  assert.deepEqual(toPhotoshopLayerOps(t.layers, { [id('Hidden flourish')]: { hidden: true } }), [])
  assert.deepEqual(toPhotoshopLayerOps(t.layers, { [id('Gold rule')]: { opacity: 1 } }), [])
  assert.deepEqual(toPhotoshopLayerOps(t.layers, {}), [])
})

test('re-showing a layer the PSD ships hidden IS emitted', async () => {
  const t = await tree()
  const id = t.layers.find((l) => l.name === 'Hidden flourish').id
  const ops = toPhotoshopLayerOps(t.layers, { [id]: { hidden: false } })
  assert.equal(ops.length, 1)
  assert.equal(ops[0].hidden, false)
})

test('opacity overrides carry through', async () => {
  const t = await tree()
  const id = t.layers.find((l) => l.name === 'Gold rule').id
  const ops = toPhotoshopLayerOps(t.layers, { [id]: { opacity: 0.4 } })
  assert.equal(ops[0].opacity, 0.4)
})

test('over the decode budget, the TREE still comes back — only pixels are skipped', async () => {
  // The layers panel is most of the value, so a template too big to decode
  // must still list its layers rather than failing outright.
  const r = await readPsdLayerTree(fixturePath(), { force: true, maxDecodeBytes: 1 })
  assert.equal(r.ok, true, 'still a successful read')
  assert.equal(r.pixelsSkipped, true)
  assert.equal(r.layers.length, 4, 'every layer is still listed')
  const flat = flattenDrawOrder(r.layers)
  assert.equal(flat.find((n) => n.name === 'Gold rule').png, null, 'no pixels extracted')
  assert.equal(r.compositePath, null)
})

test('under budget, pixels are extracted as normal', async () => {
  const r = await readPsdLayerTree(fixturePath(), { force: true })
  assert.equal(r.pixelsSkipped, false)
  assert.ok(r.estimatedDecodeBytes > 0)
})
