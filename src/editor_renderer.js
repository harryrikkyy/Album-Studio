// editor_renderer.js — Page Editor window
//
// Renders the current spread as a DOM scene (backdrop + photo frames + overlay
// layers) using the SAME placement math as the libvips renderer / Photoshop
// build, so what you see is what you get.
//
// Photos: select, drag to pan, scroll to zoom, colour-grade, rotate, swap.
// Overlays: text and shapes drawn on top of the page — added, moved, resized,
// rotated, restyled and reordered here.
//
// The overlay preview is not a lookalike: `overlay_render.js` builds the SVG
// that this window injects into the stage AND the SVG the exporter composites
// into the final page. One generator, so the preview cannot drift from the
// output. See docs/ideas/spread-editor.md.

// Bridged IPC surface exposed by editor_preload.js (contextIsolation on).
const api = window.editorAPI
const OV = window.OverlayRender
// Pure geometry, shared with the exporter and unit-tested in
// test/editor_geometry.test.js.
const EG = window.EditorGeometry

// Theme (shared via file:// localStorage), opaque for this non-transparent window.
// Saved ids from the retired 5-theme system fall back to studio-dark.
;(function () {
  const KNOWN = ['studio-dark', 'studio-light']
  let t = 'studio-dark'
  try { t = localStorage.getItem('adt_theme') || 'studio-dark' } catch (_) {}
  if (!KNOWN.includes(t)) t = 'studio-dark'
  document.documentElement.setAttribute('data-theme', t)
  document.documentElement.style.colorScheme = t === 'studio-light' ? 'light' : 'dark'
})()

window.ADTIcons.hydrate(document)

const el = (id) => document.getElementById(id)
const stage = el('edStage')
const stageWrap = el('edStageWrap')
const emptyEl = el('edEmpty')
const toastEl = el('edToast')
const hintEl = el('edHint')

const HINTS = {
  select: 'Click to select · ⌘/Shift-click for multiple · drag to reposition · scroll to zoom · right-click for more.',
  text: 'Click the page to drop a text box, or drag to size one.',
  rect: 'Drag on the page to draw a rectangle.',
  ellipse: 'Drag on the page to draw an ellipse.',
  line: 'Drag on the page to draw a line.',
}

let spread = null          // { pageNum, canvasW, canvasH, backdropUrl, items[], spreads[], overlays[] }
let items = []             // photo working copies; each gets .placement, .adjust, ._nat, ._el, ._img
let overlays = []          // overlay layer working copies (see overlay_render.js)
let psd = null             // the template's real PSD layer tree (psd_layers.js)
let psdError = null        // why the tree is missing/partial, shown in the rail
let layerEdits = {}        // psdLayerId → { hidden?, opacity? }
let pageBackground = null
let selectedIds = []       // selected PHOTO ids (ordered by selection)
let selectedOverlayIds = []
let selectedLayerIds = []   // selected TEMPLATE (PSD) layers
let displayScale = 1
let tool = 'select'
let snapEnabled = true
let suppressNextClick = false   // see the draw-gesture pointerup handler

const CADJ = ['Exposure', 'Contrast', 'Saturation', 'Warmth', 'Tint', 'Fade', 'Clarity', 'Sharpen', 'Blur', 'Vignette']

// Fonts offered for text layers. Restricted to faces that ship with macOS so
// librsvg resolves the SAME family at export time — a font only present in
// Chrome's stack would preview correctly and then export as a fallback.
const FONTS = [
  'Helvetica Neue', 'Avenir Next', 'Futura', 'Gill Sans', 'Optima',
  'Georgia', 'Baskerville', 'Didot', 'Palatino', 'Times New Roman',
  'American Typewriter', 'Menlo', 'Snell Roundhand', 'Zapfino',
]

// One-click looks, expressed purely as the slider values they set — so a look
// is auditable, editable afterwards, and renders through the same maths as a
// hand-dialled edit rather than a special-cased filter.
const PRESETS = {
  'Original': {},
  'Punch': { contrast: 22, saturation: 18, clarity: 25 },
  'Soft': { contrast: -12, fade: 18, saturation: -6 },
  'Warm': { warmth: 28, exposure: 4, saturation: 8 },
  'Cool': { warmth: -26, tint: -6, contrast: 8 },
  'Film': { fade: 30, contrast: 12, saturation: -12, warmth: 10 },
  'Mono': { bw: true, contrast: 18, clarity: 15 },
  'Sepia': { bw: true, warmth: 45, fade: 12 },
  'Matte': { fade: 42, contrast: -8, saturation: -10 },
  'Vivid': { saturation: 32, contrast: 15, clarity: 20 },
  'Portrait': { exposure: 5, contrast: 8, saturation: 6, clarity: -0, warmth: 8 },
  'Drama': { contrast: 32, clarity: 45, saturation: -8, vignette: 35 },
}

function toast(msg) {
  toastEl.textContent = msg
  toastEl.classList.add('show')
  clearTimeout(toast._t); toast._t = setTimeout(() => toastEl.classList.remove('show'), 2200)
}

const uid = () => 'ov_' + Math.random().toString(36).slice(2, 9)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// ── Undo / redo ────────────────────────────────────────────────
// Snapshots only the serialisable edit state; DOM handles (_el/_img/_nat) are
// rebuilt from it. Coarse-grained by design — one entry per committed gesture,
// not per pointermove — so ⌘Z steps back the way a user expects.
let undoStack = []
let redoStack = []
const HISTORY_LIMIT = 60

function snapshot() {
  return JSON.stringify({
    overlays,
    pageBackground,
    layerEdits,
    photos: items.map((it) => ({ id: it.id, placement: it.placement, adjust: it.adjust, rotation: it.rotation })),
  })
}
function pushHistory() {
  _ctlHistTimer = null
  _zoomHistTimer = null
  const snap = snapshot()
  if (undoStack.length && undoStack[undoStack.length - 1] === snap) return
  undoStack.push(snap)
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift()
  redoStack.length = 0
  refreshHistoryUI()
}
function restore(snap) {
  const s = JSON.parse(snap)
  overlays = s.overlays || []
  pageBackground = s.pageBackground || null
  layerEdits = s.layerEdits || {}
  for (const p of s.photos || []) {
    const it = items.find((i) => i.id === p.id)
    if (!it) continue
    it.placement = p.placement
    it.adjust = p.adjust
    it.rotation = p.rotation
    refreshPhotoVisuals(it)
    layoutItem(it)
  }
  selectedOverlayIds = selectedOverlayIds.filter((id) => overlays.some((o) => o.id === id))
  buildScene(); buildLayerList(); updatePanel(); applyPageBackground(); scheduleApply()
}
// Sliders, nudges and wheel-zoom defer their history entry until the burst
// ends, so a drag or a held arrow is ONE undo step. The cost was that anything
// done inside that window saw a stack without the burst on it:
//   - ⌘Z right after a nudge undid the action BEFORE it, and the nudge was
//     silently lost when the timer later found nothing new to push;
//   - a click (hide, delete…) right after a nudge was snapshotted together
//     with it, so one ⌘Z reverted both.
// Committing the pending entry first — before undo/redo, and before any new
// discrete action starts — keeps a burst as one step without either failure.
function flushHistory() {
  let pending = false
  if (_ctlHistTimer) { clearTimeout(_ctlHistTimer); _ctlHistTimer = null; pending = true }
  if (_zoomHistTimer) { clearTimeout(_zoomHistTimer); _zoomHistTimer = null; pending = true }
  if (pending) pushHistory()
}

function undo() {
  flushHistory()
  if (undoStack.length < 2) return
  redoStack.push(undoStack.pop())
  restore(undoStack[undoStack.length - 1])
  refreshHistoryUI(); toast('Undo')
}
function redo() {
  flushHistory()
  const snap = redoStack.pop()
  if (!snap) return
  undoStack.push(snap)
  restore(snap)
  refreshHistoryUI(); toast('Redo')
}
function refreshHistoryUI() {
  el('edUndo').disabled = undoStack.length < 2
  el('edRedo').disabled = redoStack.length === 0
}

// ── Load ───────────────────────────────────────────────────────
async function load() {
  spread = await api.getSpread()
  // A page is worth opening if it has ANY of: photos, page layers, or a
  // template layer stack. Requiring photos or overlays meant a page with a
  // template but nothing placed on it yet showed "No spread loaded" — hiding
  // the very template layers the user opened the editor to work on.
  const hasItems = !!(spread && spread.items && spread.items.length)
  const hasOverlays = !!(spread && (spread.overlays || []).length)
  const hasPsd = !!(spread && spread.psd && spread.psd.ok && (spread.psd.layers || []).length)
  if (!spread || (!hasItems && !hasOverlays && !hasPsd)) {
    emptyEl.style.display = 'block'
    return
  }
  emptyEl.style.display = 'none'
  items = (spread.items || []).map((it) => ({
    ...it,
    placement: it.placement ? { scale: it.placement.scale || 1, ox: it.placement.ox || 0, oy: it.placement.oy || 0 } : { scale: 1, ox: 0, oy: 0 },
    adjust: it.adjust ? { ...it.adjust } : {},
  }))
  overlays = (spread.overlays || []).map((o) => ({ ...o }))
  psd = spread.psd && spread.psd.ok ? spread.psd : null
  psdError = spread.psdError || null
  layerEdits = JSON.parse(JSON.stringify(spread.layerEdits || {}))
  pageBackground = spread.pageBackground || null
  selectedIds = []; selectedOverlayIds = []; selectedLayerIds = []
  undoStack = []; redoStack = []
  buildScene()
  buildRail()
  buildLayerList()
  applyPageBackground()
  updatePanel()
  pushHistory()
}
api.onSpreadUpdated(() => load())

// ── Scene ──────────────────────────────────────────────────────
let ovlSurface = null   // the injected SVG (visual truth)
let hitSurface = null   // transparent boxes that take the pointer events

// ── PSD layer stack ────────────────────────────────────────────
// Flatten the tree the way psd_layers.flattenDrawOrder does, honouring group
// visibility/opacity inheritance. Duplicated here rather than imported because
// this window is context-isolated and cannot require() main-process modules;
// the shapes are asserted against each other in test/psd_layers.test.js.
function psdDrawOrder() {
  if (!psd) return []
  const out = []
  const walk = (nodes, depth, parentVisible, parentOpacity) => {
    for (const n of nodes) {
      const e = layerEdits[n.id] || {}
      const visible = (e.hidden === undefined ? n.visible : !e.hidden) && parentVisible
      const opacity = (e.opacity === undefined ? n.opacity : e.opacity) * parentOpacity
      // Only a genuine change counts: text typed back to the original leaves
      // the layer's own pixels in place, which render better than any stand-in.
      const replaced = e.text !== undefined && n.kind === 'text' && e.text !== n.text
      out.push({ ...n, depth, effectiveVisible: visible, effectiveOpacity: opacity,
        rasterVisible: visible && !replaced, children: undefined })
      if (n.children) walk(n.children, depth + 1, visible, opacity)
    }
  }
  walk(psd.layers || [], 0, true, 1)
  return out
}

// A clipped layer masks to the nearest non-clipped layer below it.
function withClipBases(drawOrder) {
  let base = null
  return drawOrder.map((n) => {
    if (n.kind === 'group') return { ...n, clipBase: null }
    if (!n.clipped) { base = n; return { ...n, clipBase: null } }
    return { ...n, clipBase: base }
  })
}

const fileUrl = (p) => 'file://' + String(p).split('/').map(encodeURIComponent).join('/')

// CSS blend keywords that map 1:1 onto Photoshop's names. Anything outside
// this set falls back to normal rather than guessing — a wrong blend reads as
// a rendering bug, a missing one reads as "not supported yet".
const BLEND_CSS = {
  normal: 'normal', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
  darken: 'darken', lighten: 'lighten', 'color dodge': 'color-dodge',
  'color burn': 'color-burn', 'hard light': 'hard-light', 'soft light': 'soft-light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue',
  saturation: 'saturation', color: 'color', luminosity: 'luminosity',
}

function buildScene() {
  stage.innerHTML = ''
  _psdEls = []

  // With a parsed PSD we draw the real stack, so template art that sits ABOVE
  // the photo frames renders above the photos — exactly as in Photoshop. The
  // old flat-backdrop path drew every photo on top of one flattened image,
  // which put borders and flourishes underneath. Templates we can't parse
  // (generative ones have no PSD at all) still use the flat backdrop.
  const stack = psd ? withClipBases(psdDrawOrder()) : null
  if (stack && stack.length) {
    buildPsdStack(stack)
  } else {
    if (spread.backdropUrl) {
      const bd = document.createElement('img')
      bd.className = 'ed-stage__backdrop'
      bd.src = spread.backdropUrl
      bd.draggable = false
      bd.alt = ''   // decorative: the template's own artwork
      stage.appendChild(bd)
    }
    for (const item of items) buildPhotoFrame(item)
  }

  ovlSurface = document.createElement('div')
  ovlSurface.className = 'ed-ovl'
  stage.appendChild(ovlSurface)
  hitSurface = document.createElement('div')
  hitSurface.className = 'ed-hits'
  stage.appendChild(hitSurface)
  computeStageScale()
  renderOverlays()
}

// Draw the template's layers bottom-to-top, substituting each photo for the
// frame layer it occupies so photos land at the frame's z-position instead of
// on top of everything.
function buildPsdStack(stack) {
  const byFrameName = new Map()
  for (const it of items) if (it.frame && it.frame.name) byFrameName.set(it.frame.name, it)

  for (const node of stack) {
    if (node.kind === 'group') continue          // structure only, no pixels

    const photo = node.isFrame ? byFrameName.get(node.name) : null
    if (photo) {
      // The photo takes the frame's slot in the stack. Its box is the frame
      // layer's own bounds, so it lines up with the artwork around it.
      const fb = layerBox(node)
      photo.frame = { name: node.name, x: fb.x, y: fb.y, w: fb.w, h: fb.h }
      const f = buildPhotoFrame(photo)
      if (!node.effectiveVisible) f.style.display = 'none'
      f.style.opacity = String(node.effectiveOpacity)
      continue
    }

    if (!node.png) continue
    if (node.rasterVisible === false) continue
    const img = document.createElement('img')
    img.className = 'ed-psd-layer'
    img.src = fileUrl(node.png)
    img.alt = ''
    img.draggable = false
    img.dataset.layerId = node.id
    if (!node.effectiveVisible) img.style.display = 'none'
    if (node.effectiveOpacity !== 1) img.style.opacity = String(node.effectiveOpacity)
    const blend = BLEND_CSS[String(node.blendMode || 'normal').toLowerCase()]
    if (blend && blend !== 'normal') img.style.mixBlendMode = blend
    // A clipping mask shows the clipped layer only where the base below it has
    // pixels — CSS masks reproduce that from the base's own alpha.
    if (node.clipBase && node.clipBase.png) {
      const url = fileUrl(node.clipBase.png)
      img.style.webkitMaskImage = `url("${url}")`
      img.style.maskImage = `url("${url}")`
      img.style.webkitMaskSize = '100% 100%'
      img.style.maskSize = '100% 100%'
    }
    stage.appendChild(img)
    _psdEls.push({ node, el: img })
  }
}

/** @type {{node: any, el: HTMLElement}[]} */
let _psdEls = []

function layoutPsdLayers() {
  const D = displayScale
  for (const { node, el: e } of _psdEls) {
    // Position from the EDITED box so a moved/scaled template layer shows
    // where it will actually render.
    const b = layerBox(node)
    e.style.left = b.x * D + 'px'
    e.style.top = b.y * D + 'px'
    e.style.width = b.w * D + 'px'
    e.style.height = b.h * D + 'px'
    // The clip base is positioned independently, so its mask has to be offset
    // back into this layer's own box or it would slide out of alignment.
    if (node.clipBase && node.clipBase.png) {
      // Against the base's EDITED box: the base can have been moved or scaled,
      // and a mask left at the original bounds clips the wrong region.
      const cb = layerBox(node.clipBase)
      const dx = (cb.x - b.x) * D
      const dy = (cb.y - b.y) * D
      e.style.webkitMaskPosition = `${dx}px ${dy}px`
      e.style.maskPosition = `${dx}px ${dy}px`
      e.style.webkitMaskSize = `${cb.w * D}px ${cb.h * D}px`
      e.style.maskSize = `${cb.w * D}px ${cb.h * D}px`
      e.style.webkitMaskRepeat = 'no-repeat'
      e.style.maskRepeat = 'no-repeat'
    }
  }
}

function buildPhotoFrame(item) {
    const f = document.createElement('div')
    f.className = 'ed-frame'
    f.dataset.id = item.id
    const img = document.createElement('img')
    img.src = item.url
    img.draggable = false
    // Presentational: the photo is an object being manipulated, not content
    // to be read out. Its frame is named and reachable via the panel instead.
    img.alt = ''
    img.style.filter = cssFilter(item.adjust)
    f.appendChild(img)
    const vig = document.createElement('div')
    vig.className = 'ed-frame__vig'
    f.appendChild(vig)
    item._el = f
    item._img = img
    item._vig = vig
    applyVignettePreview(item)
    img.addEventListener('load', () => {
      item._nat = { w: img.naturalWidth, h: img.naturalHeight }
      layoutItem(item)
    })
    wireFrame(item)
    stage.appendChild(f)
    return f
}

function applyPageBackground() {
  stage.style.background = pageBackground || ''
  const picker = el('edPageBg')
  if (pageBackground) picker.value = pageBackground
}

// ── Zoom ───────────────────────────────────────────────────────
// `zoom` multiplies the fit-to-window scale, so 1 always means "whole page
// visible" regardless of window size — the level a designer returns to.
let zoom = 1
let fitScale = 1
const ZOOM_MIN = 0.25, ZOOM_MAX = 8

function setZoom(z, opts = {}) {
  const next = clamp(z, ZOOM_MIN, ZOOM_MAX)
  if (next === zoom) return
  zoom = next
  computeStageScale(opts)
  updateZoomUI()
}
function zoomToFit() { setZoom(1) }
function updateZoomUI() {
  const pct = Math.round(fitScale * zoom * 100)
  const lbl = el('edZoomLevel')
  if (lbl) lbl.textContent = pct + '%'
  stageWrap.classList.toggle('is-zoomed', zoom > 1)
}

function computeStageScale(opts = {}) {
  if (!spread) return
  // Keep whatever the viewport is centred on centred across a zoom change,
  // rather than snapping back to the top-left.
  const prevW = stage.offsetWidth || 1
  const prevH = stage.offsetHeight || 1
  const anchorX = (stageWrap.scrollLeft + stageWrap.clientWidth / 2) / prevW
  const anchorY = (stageWrap.scrollTop + stageWrap.clientHeight / 2) / prevH

  const padW = stageWrap.clientWidth - 24
  const padH = stageWrap.clientHeight - 24
  fitScale = Math.min(padW / spread.canvasW, padH / spread.canvasH)
  if (!isFinite(fitScale) || fitScale <= 0) fitScale = 0.1
  displayScale = fitScale * zoom
  stage.style.width = spread.canvasW * displayScale + 'px'
  stage.style.height = spread.canvasH * displayScale + 'px'
  layoutGuides()

  if (opts.keepCentre !== false && zoom > 1) {
    stageWrap.scrollLeft = anchorX * stage.offsetWidth - stageWrap.clientWidth / 2
    stageWrap.scrollTop = anchorY * stage.offsetHeight - stageWrap.clientHeight / 2
  }
  layoutPsdLayers()
  for (const item of items) layoutItem(item)
  renderOverlays()
  updateZoomUI()
}

// Position the frame box + the photo inside it, mirroring the libvips crop.
function layoutItem(item) {
  const f = item._el, img = item._img
  if (!f || !img) return
  const D = displayScale
  const boxW = item.frame.w * D, boxH = item.frame.h * D
  f.style.left = item.frame.x * D + 'px'
  f.style.top = item.frame.y * D + 'px'
  f.style.width = boxW + 'px'
  f.style.height = boxH + 'px'
  if (!item._nat) return

  const rot = ((item.rotation || 0) % 360 + 360) % 360
  const swapped = (rot === 90 || rot === 270)
  const eW = swapped ? item._nat.h : item._nat.w
  const eH = swapped ? item._nat.w : item._nat.h
  const cover = Math.max(boxW / eW, boxH / eH)
  const scale = Math.max(1, item.placement.scale || 1)
  const dispW = eW * cover * scale   // on-screen bounding box of the (rotated) photo
  const dispH = eH * cover * scale
  const overX = dispW - boxW, overY = dispH - boxH
  const ox = clamp(item.placement.ox || 0, -1, 1)
  const oy = clamp(item.placement.oy || 0, -1, 1)
  const left = (boxW - dispW) / 2 + (-ox * overX / 2)
  const top = (boxH - dispH) / 2 + (-oy * overY / 2)

  if (swapped) {
    // The element, pre-rotation, is dispH × dispW; after a 90/270 rotation its
    // bounding box becomes dispW × dispH, centered on the same point.
    img.style.width = dispH + 'px'
    img.style.height = dispW + 'px'
    img.style.left = left + (dispW - dispH) / 2 + 'px'
    img.style.top = top + (dispH - dispW) / 2 + 'px'
  } else {
    img.style.width = dispW + 'px'
    img.style.height = dispH + 'px'
    img.style.left = left + 'px'
    img.style.top = top + 'px'
  }
  img.style.transform = rot ? `rotate(${rot}deg)` : 'none'
  item._over = { overX, overY } // cache for pan math
}

// Mirror of proof_renderer's vignetteSvg, as a CSS radial gradient: same
// transparent-to-45% core and same peak alpha, so the preview reads at roughly
// the strength the export will produce.
function applyVignettePreview(item) {
  if (!item._vig) return
  const v = (item.adjust && item.adjust.vignette) || 0
  if (!v) { item._vig.style.background = 'none'; return }
  const rgb = v > 0 ? '0,0,0' : '255,255,255'
  const alpha = (Math.abs(v) / 100) * 0.85
  item._vig.style.background =
    `radial-gradient(ellipse at 50% 50%, rgba(${rgb},0) 45%, rgba(${rgb},${alpha.toFixed(3)}) 100%)`
}

// Every per-photo visual in one call, so adding another effect later can't
// end up wired at some call sites and forgotten at others.
function refreshPhotoVisuals(item) {
  if (item._img) item._img.style.filter = cssFilter(item.adjust)
  applyVignettePreview(item)
}

// ── CSS approximation of the libvips adjustments (warmth/tint/clarity are
// approximate; the authoritative colour is the rendered proof / export). ──
function cssFilter(adj) {
  if (!adj) return 'none'
  const b = Math.pow(2, (adj.exposure || 0) / 100)
  const c = Math.max(0, 1 + (adj.contrast || 0) / 100)
  const s = adj.bw ? 0 : Math.max(0, 1 + (adj.saturation || 0) / 100)
  const w = adj.warmth || 0
  let f = `brightness(${b.toFixed(3)}) contrast(${c.toFixed(3)}) saturate(${s.toFixed(3)})`
  if (adj.bw) f += ' grayscale(1)'
  if (w > 0) f += ` sepia(${Math.min(0.6, w / 200).toFixed(3)})`
  else if (w < 0) f += ` hue-rotate(${(w / 8).toFixed(1)}deg)`
  if (adj.blur) f += ` blur(${((adj.blur / 100) * 6).toFixed(2)}px)`
  if (adj.fade) f += ` opacity(${(1 - (adj.fade / 100) * 0.25).toFixed(3)})`
  return f
}

// ── Overlay rendering ──────────────────────────────────────────
// The SVG comes from the shared generator at the CURRENT display size, so the
// preview is the export scaled down rather than a separate DOM re-creation.
function renderOverlays() {
  if (!ovlSurface || !spread) return
  const W = spread.canvasW * displayScale
  const H = spread.canvasH * displayScale
  ovlSurface.innerHTML = OV.buildOverlaySvg(overlays.concat(textStandIns()), W, H) || ''
  buildHitBoxes(W, H)
}

// Retyped template text, drawn through the same overlay SVG generator as
// every other caption. The geometry lives in overlay_render.psdTextOverlay so
// this window and the main-process renderer cannot disagree about it.
function textStandIns() {
  if (!psd || !spread) return []
  const out = []
  for (const n of psdDrawOrder()) {
    const ov = OV.psdTextOverlay(n, layerEdits[n.id], spread.canvasW, spread.canvasH)
    if (ov && n.effectiveVisible) out.push(ov)
  }
  return out
}

function buildHitBoxes(W, H) {
  hitSurface.innerHTML = ''

  // A selected TEMPLATE layer gets the same move/resize affordance as a page
  // layer. Only when selected — an always-on hit box for every template layer
  // would swallow the clicks meant for photos underneath.
  if (spread) {
    for (const node of psdDrawOrder()) {
      if (!selectedLayerIds.includes(node.id) || node.kind === 'group') continue
      const b = layerBox(node)
      const box = document.createElement('div')
      box.className = 'ed-hit selected ed-hit--layer'
      box.style.left = (b.x / spread.canvasW * W) + 'px'
      box.style.top = (b.y / spread.canvasH * H) + 'px'
      box.style.width = (b.w / spread.canvasW * W) + 'px'
      box.style.height = (b.h / spread.canvasH * H) + 'px'
      for (const pos of ['nw', 'ne', 'sw', 'se']) {
        const h = document.createElement('div')
        h.className = 'ed-hnd ed-hnd--' + pos
        h.dataset.handle = pos
        box.appendChild(h)
      }
      wireLayerBox(box, node)
      hitSurface.appendChild(box)
    }
  }
  overlays.forEach((L) => {
    if (L.hidden) return
    const box = document.createElement('div')
    box.className = 'ed-hit'
    if (selectedOverlayIds.includes(L.id)) box.classList.add('selected')
    if (L.locked) box.classList.add('locked')
    box.dataset.id = L.id
    box.style.left = (L.x * W) + 'px'
    box.style.top = (L.y * H) + 'px'
    box.style.width = (L.w * W) + 'px'
    box.style.height = (L.h * H) + 'px'
    if (L.rot) box.style.transform = `rotate(${L.rot}deg)`
    if (selectedOverlayIds.includes(L.id) && !L.locked) {
      for (const pos of ['nw', 'ne', 'sw', 'se']) {
        const h = document.createElement('div')
        h.className = 'ed-hnd ed-hnd--' + pos
        h.dataset.handle = pos
        box.appendChild(h)
      }
      const rh = document.createElement('div')
      rh.className = 'ed-hnd ed-hnd--rot'
      rh.dataset.handle = 'rot'
      box.appendChild(rh)
    }
    wireOverlayBox(box, L)
    hitSurface.appendChild(box)
  })
}

// ── Print guides ───────────────────────────────────────────────
// Album pages are trimmed and, in a layflat book, partly swallowed by the
// gutter. Designers need to see those zones while placing text, not discover
// them at the bindery — so bleed, trim and safe are drawn as overlays.
let guidesOn = false
const GUIDE_INSETS = { bleed: 0.03, safe: 0.08 }  // fractions of the short edge

function layoutGuides() {
  stage.querySelectorAll('.ed-print-guide').forEach((g) => g.remove())
  if (!guidesOn || !spread) return
  const W = spread.canvasW * displayScale
  const H = spread.canvasH * displayScale
  const short = Math.min(W, H)
  const mk = (inset, cls, label) => {
    const g = document.createElement('div')
    g.className = 'ed-print-guide ' + cls
    g.style.left = (short * inset) + 'px'
    g.style.top = (short * inset) + 'px'
    g.style.width = (W - short * inset * 2) + 'px'
    g.style.height = (H - short * inset * 2) + 'px'
    g.title = label
    stage.appendChild(g)
  }
  mk(GUIDE_INSETS.bleed, 'ed-print-guide--trim', 'Trim edge — art outside this may be cut')
  mk(GUIDE_INSETS.safe, 'ed-print-guide--safe', 'Safe area — keep text inside this')
  // Gutter: the centre fold of a spread, where a layflat book loses content.
  const gut = document.createElement('div')
  gut.className = 'ed-print-guide ed-print-guide--gutter'
  gut.style.left = (W / 2) + 'px'
  gut.title = 'Gutter — the centre fold'
  stage.appendChild(gut)
}

// ── Align & distribute ─────────────────────────────────────────
// With one layer selected these align to the PAGE; with several, to the
// selection's own bounding box — which is what every design tool does, and
// what makes single-selection centring useful at all.
function alignSelection(edge) {
  const sel = selectedOverlays().filter((L) => !L.locked)
  if (!sel.length) return
  // One layer aligns to the PAGE; several to their own bounding box.
  const aligned = EG.alignBoxes(sel.map((L) => ({ x: L.x, y: L.y, w: L.w, h: L.h })),
    edge, { x: 0, y: 0, w: 1, h: 1 })
  sel.forEach((L, i) => { L.x = aligned[i].x; L.y = aligned[i].y })
  renderOverlays(); updatePanel(); pushHistory(); scheduleApply()
  toast(sel.length > 1 ? `Aligned ${sel.length} layers` : 'Aligned to page')
}

// Even gaps between three or more layers; the outermost two stay put.
function distributeSelection(axis) {
  const sel = selectedOverlays().filter((L) => !L.locked)
  if (sel.length < 3) { toast('Select 3 or more layers to distribute'); return }
  // Equal GAPS, not equal centres — see editor_geometry.distributeBoxes.
  const spread2 = EG.distributeBoxes(sel.map((L) => ({ x: L.x, y: L.y, w: L.w, h: L.h })), axis)
  sel.forEach((L, i) => { L.x = spread2[i].x; L.y = spread2[i].y })
  renderOverlays(); updatePanel(); pushHistory(); scheduleApply()
  toast(`Distributed ${sel.length} layers`)
}


// Which template layer a click means. The ordering and cycling rules live in
// editor_geometry.pickAtPoint, where they are unit-tested; this only converts
// screen coordinates into canvas ones.
let _cycleAt = null

function pickLayerAt(clientX, clientY) {
  const rect = stage.getBoundingClientRect()
  const cx = ((clientX - rect.left) / rect.width) * spread.canvasW
  const cy = ((clientY - rect.top) / rect.height) * spread.canvasH
  const candidates = psdDrawOrder()
    .filter((n) => n.kind !== 'group' && n.effectiveVisible && n.png)
    .map((n) => ({ ...layerBox(n), id: n.id, _node: n }))
  // Tolerance in CANVAS units, so "the same spot" means the same thing
  // whatever the zoom level.
  const r = EG.pickAtPoint(candidates, cx, cy, _cycleAt, spread.canvasW / 200)
  _cycleAt = r.hit ? { x: cx, y: cy, index: r.index } : null
  return r.hit ? r.hit._node : null
}

// Move/resize a template layer. Offsets are stored in CANVAS PIXELS rather
// than normalized units, because they map straight onto Photoshop's
// translate()/resize() in the export — no second conversion to get wrong.
function wireLayerBox(box, node) {
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const handle = e.target.dataset && e.target.dataset.handle
    // Once selected, this box covers the layer and swallows further clicks —
    // alt-click steps to whatever is underneath so a covered layer stays
    // reachable without hunting for it in the rail.
    if (!handle && e.altKey) {
      const next = pickLayerAt(e.clientX, e.clientY)
      if (next) { selectLayer(next.id, false); return }
    }
    const rect = stage.getBoundingClientRect()
    const pxPerCanvasX = rect.width / spread.canvasW
    const pxPerCanvasY = rect.height / spread.canvasH
    const startX = e.clientX, startY = e.clientY
    const e0 = { ...(layerEdits[node.id] || {}) }
    const sx0 = e0.sx == null ? 1 : e0.sx
    const sy0 = e0.sy == null ? 1 : e0.sy
    const dx0 = e0.dx || 0, dy0 = e0.dy || 0
    let moved = false
    box.setPointerCapture(e.pointerId)

    const onMove = (ev) => {
      const dx = (ev.clientX - startX) / pxPerCanvasX
      const dy = (ev.clientY - startY) / pxPerCanvasY
      if (Math.abs(ev.clientX - startX) > 2 || Math.abs(ev.clientY - startY) > 2) moved = true
      if (!moved) return
      const patch = {}
      if (!handle) {
        patch.dx = dx0 + dx
        patch.dy = dy0 + dy
      } else {
        // Corner resize: the opposite corner stays put, so scaling from the
        // north or west edges also shifts the origin. Same helper the overlay
        // handles use, so the two behave identically.
        const start = { x: node.x + dx0, y: node.y + dy0, w: node.w * sx0, h: node.h * sy0 }
        const nb = EG.resizeBox(start, handle, dx, dy, { keepAspect: ev.shiftKey, min: 8 })
        patch.sx = node.w ? nb.w / node.w : 1
        patch.sy = node.h ? nb.h / node.h : 1
        patch.dx = nb.x - node.x
        patch.dy = nb.y - node.y
      }
      layerEdits[node.id] = { ...(layerEdits[node.id] || {}), ...patch }
      layoutPsdLayers()
      for (const it of items) layoutItem(it)
      buildHitBoxes(spread.canvasW * displayScale, spread.canvasH * displayScale)
      updatePanel()
    }
    const onUp = (ev) => {
      box.removeEventListener('pointermove', onMove)
      box.removeEventListener('pointerup', onUp)
      try { box.releasePointerCapture(ev.pointerId) } catch (_) {}
      if (moved) { buildScene(); buildLayerList(); pushHistory(); scheduleApply() }
    }
    box.addEventListener('pointermove', onMove)
    box.addEventListener('pointerup', onUp)
  })
}

// ── Snapping ───────────────────────────────────────────────────
// Candidate lines: canvas edges + centre, photo frame edges, and other
// overlays' edges/centres. Snapping is in normalized space so it behaves the
// same at any window size.
const SNAP_TOL = 0.006

function snapTargets(excludeId) {
  const xs = [0, 0.5, 1]
  const ys = [0, 0.5, 1]
  for (const it of items) {
    xs.push(it.frame.x / spread.canvasW, (it.frame.x + it.frame.w) / spread.canvasW)
    ys.push(it.frame.y / spread.canvasH, (it.frame.y + it.frame.h) / spread.canvasH)
  }
  for (const L of overlays) {
    if (L.id === excludeId || L.hidden) continue
    xs.push(L.x, L.x + L.w / 2, L.x + L.w)
    ys.push(L.y, L.y + L.h / 2, L.y + L.h)
  }
  return { xs, ys }
}

function showGuides(vx, hy) {
  clearGuides()
  const W = spread.canvasW * displayScale
  const H = spread.canvasH * displayScale
  if (vx != null) {
    const g = document.createElement('div')
    g.className = 'ed-guide ed-guide--v'
    g.style.left = (vx * W) + 'px'
    stage.appendChild(g)
  }
  if (hy != null) {
    const g = document.createElement('div')
    g.className = 'ed-guide ed-guide--h'
    g.style.top = (hy * H) + 'px'
    stage.appendChild(g)
  }
}
function clearGuides() {
  stage.querySelectorAll('.ed-guide').forEach((g) => g.remove())
}

// Snap a moving box's edges/centre to nearby targets; returns adjusted x/y.
function applySnap(L, x, y) {
  if (!snapEnabled) { clearGuides(); return { x, y } }
  const r = EG.snapPosition(L, x, y, snapTargets(L.id), SNAP_TOL)
  showGuides(r.guideX, r.guideY)
  return { x: r.x, y: r.y }
}

// ── Overlay interaction ────────────────────────────────────────
function wireOverlayBox(box, L) {
  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const handle = e.target.dataset && e.target.dataset.handle
    if (L.locked && !handle) { selectOverlay(L.id, e.shiftKey || e.metaKey); return }
    if (!selectedOverlayIds.includes(L.id)) selectOverlay(L.id, e.shiftKey || e.metaKey)

    const startX = e.clientX, startY = e.clientY
    const W = spread.canvasW * displayScale
    const H = spread.canvasH * displayScale
    const orig = { x: L.x, y: L.y, w: L.w, h: L.h, rot: L.rot || 0 }
    // Move/resize applies to every selected layer so a caption + its rule can
    // be nudged together.
    const group = selectedOverlayIds.map((id) => overlays.find((o) => o.id === id)).filter((o) => o && !o.locked)
    const groupOrig = group.map((o) => ({ id: o.id, x: o.x, y: o.y, w: o.w, h: o.h }))
    let moved = false
    box.setPointerCapture(e.pointerId)

    const onMove = (ev) => {
      const dx = (ev.clientX - startX) / W
      const dy = (ev.clientY - startY) / H
      if (Math.abs(ev.clientX - startX) > 2 || Math.abs(ev.clientY - startY) > 2) moved = true
      if (!moved) return

      if (handle === 'rot') {
        const r = box.getBoundingClientRect()
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2
        let deg = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15
        L.rot = Math.round(deg)
      } else if (handle) {
        // Corner resize. Shift keeps the aspect ratio.
        const nb = EG.resizeBox(orig, handle, dx, dy, { keepAspect: ev.shiftKey, min: 0.01 })
        const nh = nb.h
        L.x = nb.x; L.y = nb.y; L.w = nb.w; L.h = nb.h
        // Text scales its font with the box so resizing behaves like a text
        // frame rather than stretching glyphs.
        if (L.type === 'text' && orig.h > 0) L.size = Math.max(0.005, (L.size || 0.05) * (nh / orig.h))
      } else {
        const snapped = applySnap(L, orig.x + dx, orig.y + dy)
        const appliedDx = snapped.x - orig.x
        const appliedDy = snapped.y - orig.y
        for (let i = 0; i < group.length; i++) {
          group[i].x = groupOrig[i].x + appliedDx
          group[i].y = groupOrig[i].y + appliedDy
        }
      }
      renderOverlays()
      updatePanel()
    }
    const onUp = (ev) => {
      box.removeEventListener('pointermove', onMove)
      box.removeEventListener('pointerup', onUp)
      try { box.releasePointerCapture(ev.pointerId) } catch (_) {}
      clearGuides()
      if (moved) { pushHistory(); scheduleApply() }
    }
    box.addEventListener('pointermove', onMove)
    box.addEventListener('pointerup', onUp)
  })

  box.addEventListener('dblclick', (e) => {
    e.stopPropagation()
    if (L.type === 'text') { selectOverlay(L.id, false); el('edText').focus(); el('edText').select() }
  })

  box.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation()
    if (!selectedOverlayIds.includes(L.id)) selectOverlay(L.id, false)
    showOverlayContextMenu(e.clientX, e.clientY, L)
  })
}

function selectOverlay(id, additive) {
  selectedIds = []
  selectedLayerIds = []
  if (additive) {
    const i = selectedOverlayIds.indexOf(id)
    if (i === -1) selectedOverlayIds.push(id); else selectedOverlayIds.splice(i, 1)
  } else {
    selectedOverlayIds = id ? [id] : []
  }
  items.forEach((it) => it._el && it._el.classList.remove('selected'))
  renderOverlays(); buildLayerList(); updatePanel()
}

// ── Creating overlays with the tools ───────────────────────────
function defaultsFor(type) {
  if (type === 'text') {
    return {
      type: 'text', text: 'Your text', font: 'Helvetica Neue', size: 0.05, weight: 400,
      color: '#222222', align: 'center', valign: 'middle', lineHeight: 1.25, tracking: 0,
    }
  }
  if (type === 'line') return { type: 'line', stroke: '#222222', strokeWidth: 0.003 }
  return { type, fill: type === 'rect' ? '#222222' : 'none', stroke: '#222222', strokeWidth: type === 'ellipse' ? 0.003 : 0, radius: 0 }
}

function createOverlay(type, x, y, w, h) {
  const L = { id: uid(), x, y, w, h, rot: 0, opacity: 1, ...defaultsFor(type) }
  // Click (no drag) gets a sensible default box rather than a zero-size layer.
  if (w < 0.01 || h < 0.01) {
    L.w = type === 'text' ? 0.5 : 0.2
    L.h = type === 'text' ? 0.1 : (type === 'line' ? 0.02 : 0.2)
    L.x = clamp(x - L.w / 2, 0, 1 - L.w)
    L.y = clamp(y - L.h / 2, 0, 1 - L.h)
  }
  overlays.push(L)
  selectedIds = []
  selectedOverlayIds = [L.id]
  renderOverlays(); buildLayerList(); updatePanel(); pushHistory(); scheduleApply()
  setTool('select')
  if (type === 'text') { el('edText').focus(); el('edText').select() }
  return L
}

// ── Resizable rail ─────────────────────────────────────────────
// Two drag handles: one splitting Spreads from Layers, one setting how much
// width the whole rail takes from the stage. Both are also arrow-key operable,
// because a `role="separator"` that only responds to the mouse is a keyboard
// dead end.
const RAIL_MIN = 150, RAIL_MAX = 620
const SPREADS_MIN = 90

const railSizes = (() => {
  try { return JSON.parse(localStorage.getItem('ed.rail') || '{}') } catch (_) { return {} }
})()

function applyRailSizes() {
  const col = el('edRailCol')
  const spreads = el('edSpreadsPane')
  const total = clamp(railSizes.rail || 380, RAIL_MIN, RAIL_MAX)
  col.style.width = total + 'px'
  // The layers pane flexes, so only the spreads pane needs an explicit basis.
  // Cap it so dragging can never squeeze the layer list out of existence.
  const maxSpreads = Math.max(SPREADS_MIN, total - SPREADS_MIN - 10)
  const spreadsW = clamp(railSizes.spreads || 150, SPREADS_MIN, maxSpreads)
  spreads.style.flexBasis = spreadsW + 'px'

  // A focusable role="separator" is a widget, so it has to report its value —
  // otherwise a screen reader announces a draggable control with no indication
  // of where it currently sits (and axe fails the build on aria-required-attr).
  const railHandle = el('edSplitRail')
  railHandle.setAttribute('aria-valuenow', String(Math.round(total)))
  railHandle.setAttribute('aria-valuetext', `Side panel ${Math.round(total)} pixels wide`)
  const paneHandle = el('edSplitPanes')
  paneHandle.setAttribute('aria-valuenow', String(Math.round(spreadsW)))
  paneHandle.setAttribute('aria-valuemax', String(Math.round(maxSpreads)))
  paneHandle.setAttribute('aria-valuetext', `Spreads pane ${Math.round(spreadsW)} pixels wide`)
}

function saveRailSizes() {
  try { localStorage.setItem('ed.rail', JSON.stringify(railSizes)) } catch (_) { /* private mode */ }
}

/**
 * Wire one drag handle.
 * @param {string} id handle element id
 * @param {(deltaPx: number, startValue: number) => void} apply
 * @param {() => number} read current value in px
 */
function wireSplit(id, apply, read) {
  const handle = el(id)
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startX = e.clientX
    const startValue = read()
    handle.classList.add('is-dragging')
    document.body.classList.add('is-splitting')
    const onMove = (ev) => { apply(ev.clientX - startX, startValue); computeStageScale({ keepCentre: false }) }
    const onUp = () => {
      handle.classList.remove('is-dragging')
      document.body.classList.remove('is-splitting')
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      saveRailSizes()
    }
    document.addEventListener('pointermove', onMove)
    document.addEventListener('pointerup', onUp)
  })
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 40 : 10
    if (e.key === 'ArrowLeft') { e.preventDefault(); apply(-step, read()); computeStageScale({ keepCentre: false }); saveRailSizes() }
    else if (e.key === 'ArrowRight') { e.preventDefault(); apply(step, read()); computeStageScale({ keepCentre: false }); saveRailSizes() }
  })
}

applyRailSizes()
wireSplit('edSplitPanes',
  (d, start) => { railSizes.spreads = start + d; applyRailSizes() },
  () => el('edSpreadsPane').getBoundingClientRect().width)
wireSplit('edSplitRail',
  (d, start) => { railSizes.rail = start + d; applyRailSizes() },
  () => el('edRailCol').getBoundingClientRect().width)

// ── Space-drag panning ─────────────────────────────────────────
// Photoshop's hand tool: hold Space and drag with the left button to push the
// page around. The stage lives inside a scrolling viewport, so panning is just
// driving that viewport's scroll offsets.
//
// The pointerdown listener is registered in the CAPTURE phase on the wrapper
// so it runs before the stage's own draw/select handlers and can swallow the
// gesture — otherwise a space-drag would also marquee-draw a shape or start
// dragging whatever layer happened to be under the cursor.
let spaceHeld = false
let panning = false

function setSpaceHeld(on) {
  if (spaceHeld === on) return
  spaceHeld = on
  stageWrap.classList.toggle('is-panning-ready', on)
  if (!on) stageWrap.classList.remove('is-panning')
}

stageWrap.addEventListener('pointerdown', (e) => {
  if (!spaceHeld || e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  panning = true
  stageWrap.classList.add('is-panning')
  const startX = e.clientX, startY = e.clientY
  const startLeft = stageWrap.scrollLeft, startTop = stageWrap.scrollTop
  // Pointer capture keeps the gesture alive when the cursor leaves the
  // viewport mid-drag, which is common when shoving a zoomed page across.
  try { stageWrap.setPointerCapture(e.pointerId) } catch (_) { /* not fatal */ }

  const onMove = (ev) => {
    // Drag right → reveal content to the LEFT, so scroll decreases.
    stageWrap.scrollLeft = startLeft - (ev.clientX - startX)
    stageWrap.scrollTop = startTop - (ev.clientY - startY)
  }
  const onUp = () => {
    panning = false
    stageWrap.classList.remove('is-panning')
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    try { stageWrap.releasePointerCapture(e.pointerId) } catch (_) { /* already gone */ }
  }
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
}, true)

// A space-drag must not also register as a click on the stage, or releasing
// the mouse would clear the selection.
stageWrap.addEventListener('click', (e) => {
  if (spaceHeld || panning) { e.preventDefault(); e.stopPropagation() }
}, true)

// Drag-to-draw on the empty stage.
stage.addEventListener('pointerdown', (e) => {
  if (spaceHeld) return
  if (tool === 'select') return
  if (e.button !== 0) return
  e.preventDefault()
  const rect = stage.getBoundingClientRect()
  const x0 = (e.clientX - rect.left) / rect.width
  const y0 = (e.clientY - rect.top) / rect.height
  let x1 = x0, y1 = y0
  const ghost = document.createElement('div')
  ghost.className = 'ed-hit selected'
  ghost.style.pointerEvents = 'none'
  hitSurface.appendChild(ghost)
  const draw = () => {
    ghost.style.left = (Math.min(x0, x1) * rect.width) + 'px'
    ghost.style.top = (Math.min(y0, y1) * rect.height) + 'px'
    ghost.style.width = (Math.abs(x1 - x0) * rect.width) + 'px'
    ghost.style.height = (Math.abs(y1 - y0) * rect.height) + 'px'
  }
  draw()
  const onMove = (ev) => {
    x1 = (ev.clientX - rect.left) / rect.width
    y1 = (ev.clientY - rect.top) / rect.height
    draw()
  }
  const onUp = () => {
    document.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerup', onUp)
    ghost.remove()
    // The browser fires `click` on the stage right after this pointerup. By
    // then the tool has flipped back to Select, so the bare-click handler would
    // immediately deselect the layer we just created — swallow that one click.
    suppressNextClick = true
    createOverlay(tool, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
  }
  document.addEventListener('pointermove', onMove)
  document.addEventListener('pointerup', onUp)
})

// ── Tools ──────────────────────────────────────────────────────
function setTool(t) {
  tool = t
  document.querySelectorAll('.ed-tool[data-tool]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tool === t)
  })
  stage.className = 'ed-stage' + (t === 'select' ? '' : ' is-drawing tool-' + t)
  if (hintEl) hintEl.textContent = HINTS[t] || HINTS.select
}
document.querySelectorAll('.ed-tool[data-tool]').forEach((b) => {
  b.addEventListener('click', () => setTool(b.dataset.tool))
})

document.querySelectorAll('[data-align-edge]').forEach((b) => {
  b.addEventListener('click', () => alignSelection(b.dataset.alignEdge))
})
document.querySelectorAll('[data-distribute]').forEach((b) => {
  b.addEventListener('click', () => distributeSelection(b.dataset.distribute))
})

el('edGuides').addEventListener('click', () => {
  guidesOn = !guidesOn
  el('edGuides').classList.toggle('is-active', guidesOn)
  layoutGuides()
})
el('edZoomIn').addEventListener('click', () => setZoom(zoom * 1.25))
el('edZoomOut').addEventListener('click', () => setZoom(zoom / 1.25))
el('edZoomFit').addEventListener('click', zoomToFit)

// ⌘/Ctrl + wheel zooms the canvas; a bare wheel over a photo still zooms the
// PHOTO inside its frame, which is the older and more frequent gesture.
stageWrap.addEventListener('wheel', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return
  e.preventDefault()
  setZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12))
}, { passive: false })

el('edToggleGuides').addEventListener('click', () => {
  snapEnabled = !snapEnabled
  el('edToggleGuides').classList.toggle('is-active', snapEnabled)
  toast(snapEnabled ? 'Snapping on' : 'Snapping off')
})
el('edToggleGuides').classList.add('is-active')

// ── Layer list ─────────────────────────────────────────────────
function layerLabel(L) {
  if (L.type === 'text') return (L.text || '').split('\n')[0].slice(0, 22) || 'Text'
  return { rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line' }[L.type] || L.type
}

// One row in the layers rail for a template (PSD) layer. These are the actual
// Photoshop layers — groups, clipped layers and all — so the page reads the
// same here as it does in Photoshop. They can be hidden and faded but not
// renamed or reordered: the template owns its own structure.
function buildPsdRow(node, wrap) {
  const edit = layerEdits[node.id] || {}
  const hidden = edit.hidden === undefined ? !node.visible : edit.hidden

  const row = document.createElement('div')
  row.className = 'ed-layer ed-layer--psd'
    + (node.kind === 'group' ? ' is-group' : '')
    + (hidden ? ' ed-layer--off' : '')
    + (selectedLayerIds.includes(node.id) ? ' selected' : '')
  row.style.paddingLeft = (6 + node.depth * 12) + 'px'

  // A clipping mask is invisible in a flat list, which is exactly the thing
  // that makes a template confusing to edit — mark it.
  if (node.clipped) {
    const clip = document.createElement('span')
    clip.className = 'ed-layer__clip'
    clip.textContent = '↳'
    clip.title = 'Clipped into the layer below'
    row.appendChild(clip)
  }

  const name = document.createElement('button')
  name.className = 'ed-layer__name'
  name.textContent = node.name
  name.title = node.kind === 'group' ? `Group: ${node.name}` : node.name
  // Selecting a template layer isn't meaningful (it isn't editable geometry),
  // so the button's job is purely to be a focusable, named target that reports
  // what the layer is.
  name.setAttribute('aria-pressed', String(selectedLayerIds.includes(node.id)))
  name.addEventListener('click', (e) => {
    // Groups have no geometry of their own, so selecting one would give a
    // transform box that means nothing — toggle its subtree's visibility
    // affordance instead by just reporting it.
    if (node.kind === 'group') { toast(`${node.name} · group of ${node.name ? '' : ''}layers`); return }
    selectLayer(node.id, e.shiftKey || e.metaKey)
  })
  row.appendChild(name)

  if (node.isFrame) {
    const tag = document.createElement('span')
    tag.className = 'ed-layer__frame'
    tag.textContent = 'photo'
    tag.title = 'This layer is a photo slot — a photo is placed into it'
    row.appendChild(tag)
  }

  const eye = document.createElement('button')
  eye.className = 'ed-layer__btn'
  eye.title = hidden ? 'Show layer' : 'Hide layer'
  eye.setAttribute('aria-label', `${hidden ? 'Show' : 'Hide'} template layer: ${node.name}`)
  eye.innerHTML = window.ADTIcons.icn(hidden ? 'eye-off' : 'eye')
  eye.addEventListener('click', (e) => {
    e.stopPropagation()
    setLayerEdit(node.id, { hidden: !hidden })
  })
  row.appendChild(eye)

  wrap.appendChild(row)
}

// Record a template-layer override, dropping it when it matches the PSD's own
// value so the project file only carries real deviations.
function setLayerEdit(id, patch) {
  const cur = layerEdits[id] || {}
  const next = { ...cur, ...patch }
  const node = psdNodeById(id)
  if (node) {
    if (next.hidden === !node.visible) delete next.hidden
    if (next.opacity === node.opacity) delete next.opacity
  }
  if (Object.keys(next).length) layerEdits[id] = next
  else delete layerEdits[id]
  buildScene(); buildLayerList(); pushHistory(); scheduleApply()
}

// Selecting a template layer clears the other two selections: the right-hand
// panel is contextual and can only show one kind at a time.
function selectLayer(id, additive) {
  selectedIds = []
  selectedOverlayIds = []
  if (additive) {
    const i = selectedLayerIds.indexOf(id)
    if (i === -1) selectedLayerIds.push(id); else selectedLayerIds.splice(i, 1)
  } else {
    selectedLayerIds = id ? [id] : []
  }
  items.forEach((it) => it._el && it._el.classList.remove('selected'))
  renderOverlays(); buildLayerList(); updatePanel()
}
function selectedLayers() {
  return psdDrawOrder().filter((n) => selectedLayerIds.includes(n.id))
}

// Where a template layer actually sits once its edits are applied. Kept in one
// place because the canvas box, the proof renderer and the Photoshop export
// must all agree on it.
function layerBox(node) {
  return EG.layerBox(node, layerEdits[node.id])
}

function psdNodeById(id) {
  return psdDrawOrder().find((n) => n.id === id) || null
}

function buildLayerList() {
  const wrap = el('edLayers')
  wrap.innerHTML = ''
  const stack = psd ? psdDrawOrder() : []
  el('edLayersEmpty').style.display = (overlays.length || stack.length) ? 'none' : 'block'
  // The pane header carries the count, including how many are hidden — a
  // hidden layer keeps its row, so the tally is the quickest way to notice
  // that something is switched off rather than missing.
  const hiddenCount = stack.filter((n) => {
    const e = layerEdits[n.id] || {}
    return (e.hidden === undefined ? !n.visible : e.hidden)
  }).length + overlays.filter((o) => o.hidden).length
  const total = stack.length + overlays.length
  el('edLayersCount').textContent = total
    ? (hiddenCount ? `${total} · ${hiddenCount} hidden` : String(total))
    : ''
  if (!stack.length && psdError) {
    const note = document.createElement('div')
    note.className = 'ed-rail__note'
    note.textContent = 'Template layers unavailable — ' + psdError
    wrap.appendChild(note)
  }
  // Topmost first — matches how the layers read on the page.
  for (let i = overlays.length - 1; i >= 0; i--) {
    const L = overlays[i]
    const row = document.createElement('div')
    row.className = 'ed-layer'
    if (selectedOverlayIds.includes(L.id)) row.classList.add('selected')
    if (L.hidden) row.classList.add('ed-layer--off')

    // A real button, not a clickable div: this is the keyboard route to
    // selecting a layer, since the drag handles on the stage are pointer-only.
    const name = document.createElement('button')
    name.className = 'ed-layer__name'
    name.textContent = layerLabel(L)
    name.setAttribute('aria-pressed', String(selectedOverlayIds.includes(L.id)))
    name.addEventListener('click', () => selectOverlay(L.id, false))
    row.appendChild(name)

    const mkBtn = (icon, title, fn) => {
      const b = document.createElement('button')
      b.className = 'ed-layer__btn'
      b.title = title
      // The glyph is aria-hidden, so `title` alone would leave the button with
      // no accessible name. Include the layer it acts on — a rail of six
      // identical "Hide layer" buttons is useless read aloud.
      b.setAttribute('aria-label', `${title}: ${layerLabel(L)}`)
      b.innerHTML = window.ADTIcons.icn(icon)
      b.addEventListener('click', (e) => { e.stopPropagation(); fn() })
      row.appendChild(b)
    }
    mkBtn(L.hidden ? 'eye-off' : 'eye', L.hidden ? 'Show layer' : 'Hide layer', () => {
      L.hidden = !L.hidden
      renderOverlays(); buildLayerList(); pushHistory(); scheduleApply()
    })
    mkBtn('lock', L.locked ? 'Unlock layer' : 'Lock layer', () => {
      L.locked = !L.locked
      renderOverlays(); buildLayerList(); pushHistory(); scheduleApply()
    })
    mkBtn('trash', 'Delete layer', () => {
      overlays = overlays.filter((o) => o.id !== L.id)
      selectedOverlayIds = selectedOverlayIds.filter((id) => id !== L.id)
      renderOverlays(); buildLayerList(); updatePanel(); pushHistory(); scheduleApply()
    })

    wrap.appendChild(row)
  }

  // Template layers sit UNDER the page layers in the stack, so they list below
  // them — the rail reads top-down exactly like the page does.
  if (stack.length) {
    const head = document.createElement('div')
    head.className = 'ed-rail__sub'
    head.textContent = `Template · ${stack.length} layers`
    wrap.appendChild(head)
    // A partial read (e.g. artwork skipped for size) still lists layers, but
    // the user needs to know why the page is drawn from the flat template.
    if (psdError) {
      const note = document.createElement('div')
      note.className = 'ed-rail__note'
      note.textContent = psdError
      wrap.appendChild(note)
    }
    // Reversed: the rail reads topmost-first, the draw order is bottom-first.
    for (let i = stack.length - 1; i >= 0; i--) buildPsdRow(stack[i], wrap)
  }
}

// ── Arrange / duplicate / delete ───────────────────────────────
function selectedOverlays() {
  return selectedOverlayIds.map((id) => overlays.find((o) => o.id === id)).filter(Boolean)
}
function bringToFront() {
  const sel = selectedOverlays(); if (!sel.length) return
  overlays = overlays.filter((o) => !selectedOverlayIds.includes(o.id)).concat(sel)
  renderOverlays(); buildLayerList(); pushHistory(); scheduleApply()
}
function sendToBack() {
  const sel = selectedOverlays(); if (!sel.length) return
  overlays = sel.concat(overlays.filter((o) => !selectedOverlayIds.includes(o.id)))
  renderOverlays(); buildLayerList(); pushHistory(); scheduleApply()
}
function duplicateSelection() {
  const sel = selectedOverlays(); if (!sel.length) return
  const copies = sel.map((L) => ({ ...L, id: uid(), x: clamp(L.x + 0.02, 0, 1), y: clamp(L.y + 0.02, 0, 1) }))
  overlays = overlays.concat(copies)
  selectedOverlayIds = copies.map((c) => c.id)
  renderOverlays(); buildLayerList(); updatePanel(); pushHistory(); scheduleApply()
}
function deleteSelection() {
  if (!selectedOverlayIds.length) return
  const doomed = selectedOverlays().filter((L) => !L.locked).map((L) => L.id)
  if (!doomed.length) { toast('Locked — unlock the layer first'); return }
  overlays = overlays.filter((o) => !doomed.includes(o.id))
  selectedOverlayIds = selectedOverlayIds.filter((id) => !doomed.includes(id))
  renderOverlays(); buildLayerList(); updatePanel(); pushHistory(); scheduleApply()
}
el('edBringFront').addEventListener('click', bringToFront)
el('edSendBack').addEventListener('click', sendToBack)
el('edDuplicate').addEventListener('click', duplicateSelection)
el('edDelete').addEventListener('click', deleteSelection)
el('edUndo').addEventListener('click', undo)
el('edRedo').addEventListener('click', redo)

// ── Photo selection + interaction ──────────────────────────────
function refreshSelectionUI() {
  items.forEach((it) => it._el && it._el.classList.toggle('selected', selectedIds.includes(it.id)))
  renderOverlays(); buildLayerList(); updatePanel()
}
function setSelection(id) { selectedOverlayIds = []; selectedLayerIds = []; selectedIds = id ? [id] : []; refreshSelectionUI() }
function toggleSelection(id) {
  selectedOverlayIds = []
  selectedLayerIds = []
  const i = selectedIds.indexOf(id)
  if (i === -1) selectedIds.push(id); else selectedIds.splice(i, 1)
  refreshSelectionUI()
}
function isSelected(id) { return selectedIds.includes(id) }
function selectedItems() { return selectedIds.map((id) => items.find((it) => it.id === id)).filter(Boolean) }

function wireFrame(item) {
  const f = item._el
  // Drag = pan within the frame.
  let dragging = false, sx = 0, sy = 0, startOx = 0, startOy = 0, moved = false
  f.addEventListener('pointerdown', (e) => {
    if (tool !== 'select') return   // drawing a shape starts on the stage instead
    if (e.button !== 0) return // left button only; right opens the context menu
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      e.preventDefault(); toggleSelection(item.id); return // additive select, no pan
    }
    if (!isSelected(item.id)) setSelection(item.id)
    if (!item._over) return
    dragging = true; moved = false
    f.classList.add('dragging')
    f.setPointerCapture(e.pointerId)
    sx = e.clientX; sy = e.clientY
    startOx = item.placement.ox || 0; startOy = item.placement.oy || 0
  })
  f.addEventListener('pointermove', (e) => {
    if (!dragging || !item._over) return
    const dx = e.clientX - sx, dy = e.clientY - sy
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true
    // Moving the image right (+dx) reveals the left part → ox decreases.
    const dOx = item._over.overX > 0 ? (-2 * dx / item._over.overX) : 0
    const dOy = item._over.overY > 0 ? (-2 * dy / item._over.overY) : 0
    item.placement.ox = clamp(startOx + dOx, -1, 1)
    item.placement.oy = clamp(startOy + dOy, -1, 1)
    layoutItem(item)
  })
  const end = (e) => {
    if (!dragging) return
    dragging = false
    f.classList.remove('dragging')
    try { f.releasePointerCapture(e.pointerId) } catch (_) {}
    if (moved) pushHistory()
    scheduleApply()
  }
  f.addEventListener('pointerup', end)
  f.addEventListener('pointercancel', end)
  f.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (!isSelected(item.id)) setSelection(item.id)
    showContextMenu(e.clientX, e.clientY, item)
  })
  // Wheel = zoom (applies to all selected if multiple).
  f.addEventListener('wheel', (e) => {
    e.preventDefault()
    if (!isSelected(item.id)) setSelection(item.id)
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08
    const targets = selectedItems().length ? selectedItems() : [item]
    targets.forEach((t) => {
      t.placement.scale = clamp((t.placement.scale || 1) * factor, 1, 4)
      layoutItem(t)
    })
    updatePanel()
    scheduleZoomHistory()
    scheduleApply()
  }, { passive: false })
}

// Wheel-zoom fires continuously; coalesce it into one history entry.
let _zoomHistTimer = null
function scheduleZoomHistory() {
  clearTimeout(_zoomHistTimer)
  _zoomHistTimer = setTimeout(pushHistory, 400)
}

// ── Right panel ────────────────────────────────────────────────
function updatePanel() {
  const photoSel = selectedItems()
  const ovSel = selectedOverlays()
  const isText = ovSel.length > 0 && ovSel.every((L) => L.type === 'text')
  const isShape = ovSel.length > 0 && ovSel.every((L) => L.type !== 'text')

  const layerSel = selectedLayers()
  el('edLayerPanel').style.display = layerSel.length ? 'flex' : 'none'
  el('edPagePanel').style.display = (!photoSel.length && !ovSel.length && !layerSel.length) ? 'block' : 'none'
  el('edPhotoPanel').style.display = photoSel.length ? 'flex' : 'none'
  el('edTextPanel').style.display = isText ? 'flex' : 'none'
  el('edShapePanel').style.display = isShape ? 'flex' : 'none'

  const anyOverlay = ovSel.length > 0
  el('edDelete').disabled = !anyOverlay
  el('edDuplicate').disabled = !anyOverlay
  el('edBringFront').disabled = !anyOverlay
  el('edSendBack').disabled = !anyOverlay

  if (hintEl && tool === 'select') {
    if (photoSel.length > 1) hintEl.textContent = `${photoSel.length} photos selected — edits apply to all.`
    else if (ovSel.length > 1) hintEl.textContent = `${ovSel.length} layers selected.`
    else hintEl.textContent = HINTS.select
  }

  if (layerSel.length) updateLayerPanel(layerSel[0])
  if (photoSel.length) updatePhotoPanel(photoSel[0])
  if (isText) updateTextPanel(ovSel[0])
  if (isShape) updateShapePanel(ovSel[0])
}

function updateLayerPanel(node) {
  const e = layerEdits[node.id] || {}
  const b = layerBox(node)
  el('edLayerName').textContent = node.name + (node.isFrame ? '  (photo slot)' : '')
  const isText = node.kind === 'text'
  el('edLayerTextWrap').style.display = isText ? 'flex' : 'none'
  if (isText) {
    el('edLayerText').value = e.text === undefined ? (node.text || '') : e.text
    updateLayerTextStyle(node, e)
  }
  el('edLayerVisible').checked = e.hidden === undefined ? node.visible : !e.hidden
  const op = Math.round((e.opacity == null ? node.opacity : e.opacity) * 100)
  el('edLayerOpacity').value = op
  el('edLayerOpacityVal').textContent = op
  el('edLayerX').value = Math.round(b.x)
  el('edLayerY').value = Math.round(b.y)
  el('edLayerW').value = Math.round(b.w)
  el('edLayerH').value = Math.round(b.h)
}

// ── Template text styling ──────────────────────────────────────
// A template text layer carries the PSD's own run style. The editor writes
// overrides into layerEdits[id].textStyle, and overlay_render.psdTextStyle
// merges the two — so the preview, the proof renderer and the Photoshop text
// builder all read one resolved style.

// The template's own face goes at the top of the list: it is the one the
// exported PSD will use unless the user deliberately changes it, and it is
// usually NOT among the app's bundled families.
function layerFontOptions(templateFont) {
  const list = FONTS.slice()
  if (templateFont && !list.includes(templateFont)) list.unshift(templateFont)
  return list
}

function updateLayerTextStyle(node, e) {
  const st = OV.psdTextStyle(node, e)
  const sel = el('edLayerFont')
  const want = st.font || ''
  const opts = layerFontOptions(node.textStyle && node.textStyle.font)
  if (sel.dataset.builtFor !== opts.join('|')) {
    sel.innerHTML = ''
    for (const f of opts) {
      const o = document.createElement('option')
      o.value = f; o.textContent = f; o.style.fontFamily = f
      sel.appendChild(o)
    }
    sel.dataset.builtFor = opts.join('|')
  }
  sel.value = want

  const sizePx = Math.round(st.sizePx || 0)
  el('edLayerFontSize').value = sizePx || ''
  el('edLayerWeight').value = String(st.weight || 400)
  el('edLayerColor').value = /^#[0-9a-f]{6}$/i.test(st.color || '') ? st.color : '#000000'
  el('edLayerItalic').classList.toggle('is-active', !!st.italic)
  el('edLayerItalic').setAttribute('aria-pressed', String(!!st.italic))
  for (const b of el('edLayerAlign').querySelectorAll('button')) {
    b.classList.toggle('is-active', b.dataset.align === (st.align || 'left'))
  }
  const lh = Math.round((st.lineHeight || 1.25) * 100)
  el('edLayerLineHeight').value = lh
  el('edLayerLineHeightVal').textContent = (lh / 100).toFixed(2)
  const tr = Math.round((st.tracking || 0) * 10)
  el('edLayerTracking').value = tr
  el('edLayerTrackingVal').textContent = tr

  // Small type on a big canvas draws at a couple of screen pixels when the
  // page is fitted to the window — which reads as "my edit vanished". Say so
  // in numbers rather than leaving the user to guess.
  const onScreen = sizePx * displayScale
  el('edLayerSizeHint').textContent = onScreen && onScreen < 7
    ? `${sizePx}px on a ${spread.canvasW}px page — about ${onScreen.toFixed(1)}px at this zoom. Zoom in to read it.`
    : ''
}

// Every control writes through here so one code path owns the merge, the
// drop-back-to-template behaviour, and the redraw.
function setLayerTextStyle(patch) {
  const node = selectedLayers()[0]
  if (!node) return
  const cur = layerEdits[node.id] || {}
  const nextStyle = { ...(cur.textStyle || {}), ...patch }
  // Drop overrides that match the template's own value, so the project file
  // only carries real deviations and "Reset" is a true reset.
  const base = node.textStyle || {}
  for (const k of Object.keys(nextStyle)) {
    if (nextStyle[k] === base[k]) delete nextStyle[k]
  }
  const next = { ...cur }
  if (Object.keys(nextStyle).length) next.textStyle = nextStyle
  else delete next.textStyle
  if (Object.keys(next).length) layerEdits[node.id] = next
  else delete layerEdits[node.id]
  buildScene(); buildLayerList(); scheduleApply()
  clearTimeout(_ctlHistTimer); _ctlHistTimer = setTimeout(pushHistory, 500)
}

el('edLayerFont').addEventListener('change', () => setLayerTextStyle({ font: el('edLayerFont').value }))
el('edLayerFontSize').addEventListener('change', () => {
  const v = Number(el('edLayerFontSize').value)
  if (Number.isFinite(v) && v > 0) setLayerTextStyle({ sizePx: v })
})
el('edLayerWeight').addEventListener('change', () => setLayerTextStyle({ weight: Number(el('edLayerWeight').value) }))
el('edLayerColor').addEventListener('input', () => setLayerTextStyle({ color: el('edLayerColor').value }))
el('edLayerItalic').addEventListener('click', () => {
  const node = selectedLayers()[0]; if (!node) return
  const st = OV.psdTextStyle(node, layerEdits[node.id] || {})
  setLayerTextStyle({ italic: !st.italic })
  updateLayerPanel(node)
})
el('edLayerAlign').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-align]'); if (!b) return
  setLayerTextStyle({ align: b.dataset.align })
  const node = selectedLayers()[0]; if (node) updateLayerPanel(node)
})
el('edLayerLineHeight').addEventListener('input', () => {
  const v = Number(el('edLayerLineHeight').value) / 100
  el('edLayerLineHeightVal').textContent = v.toFixed(2)
  setLayerTextStyle({ lineHeight: v })
})
el('edLayerTracking').addEventListener('input', () => {
  const v = Number(el('edLayerTracking').value)
  el('edLayerTrackingVal').textContent = String(v)
  setLayerTextStyle({ tracking: v / 10 })
})
el('edLayerTextReset').addEventListener('click', () => {
  const node = selectedLayers()[0]; if (!node) return
  const cur = { ...(layerEdits[node.id] || {}) }
  delete cur.textStyle
  if (Object.keys(cur).length) layerEdits[node.id] = cur
  else delete layerEdits[node.id]
  buildScene(); buildLayerList(); updatePanel(); pushHistory(); scheduleApply()
  toast('Text style reset')
})

// Numeric fields write the same edit shape the drag handles do.
function commitLayerFields() {
  const node = selectedLayers()[0]
  if (!node) return
  const nx = Number(el('edLayerX').value)
  const ny = Number(el('edLayerY').value)
  const nw = Math.max(1, Number(el('edLayerW').value))
  const nh = Math.max(1, Number(el('edLayerH').value))
  layerEdits[node.id] = {
    ...(layerEdits[node.id] || {}),
    dx: nx - node.x, dy: ny - node.y,
    sx: node.w ? nw / node.w : 1, sy: node.h ? nh / node.h : 1,
  }
  buildScene(); buildLayerList(); updatePanel(); pushHistory(); scheduleApply()
}

function updatePhotoPanel(it) {
  const z = Math.round((it.placement.scale || 1) * 100)
  el('edZoom').value = z
  el('edZoomVal').textContent = (z / 100).toFixed(1) + '×'
  CADJ.forEach((k) => {
    const v = it.adjust[k.toLowerCase()] || 0
    el('ed' + k).value = v
    el('ed' + k + 'Val').textContent = v
  })
  el('edBw').checked = !!it.adjust.bw
}

function updateTextPanel(L) {
  el('edText').value = L.text || ''
  el('edFont').value = L.font || 'Helvetica Neue'
  const size = Math.round((L.size || 0.05) * 1000)
  el('edFontSize').value = size
  el('edFontSizeVal').textContent = size
  el('edWeight').value = String(L.weight || 400)
  el('edTextColor').value = /^#[0-9a-f]{6}$/i.test(L.color || '') ? L.color : '#222222'
  el('edItalic').classList.toggle('is-active', !!L.italic)
  el('edUnderline').classList.toggle('is-active', !!L.underline)
  document.querySelectorAll('#edAlign button').forEach((b) => b.classList.toggle('is-active', b.dataset.align === (L.align || 'left')))
  document.querySelectorAll('#edValign button').forEach((b) => b.classList.toggle('is-active', b.dataset.valign === (L.valign || 'top')))
  const lh = Math.round((L.lineHeight || 1.25) * 100)
  el('edLineHeight').value = lh
  el('edLineHeightVal').textContent = (lh / 100).toFixed(1)
  const tr = Math.round((L.tracking || 0) * 100)
  el('edTracking').value = tr
  el('edTrackingVal').textContent = tr
  el('edTextRot').value = Math.round(L.rot || 0)
  el('edTextRotVal').textContent = Math.round(L.rot || 0)
  const op = Math.round((L.opacity == null ? 1 : L.opacity) * 100)
  el('edTextOpacity').value = op
  el('edTextOpacityVal').textContent = op
  el('edTextShadow').checked = !!L.shadow
}

function updateShapePanel(L) {
  el('edShapeFill').value = /^#[0-9a-f]{6}$/i.test(L.fill || '') ? L.fill : '#000000'
  el('edShapeStroke').value = /^#[0-9a-f]{6}$/i.test(L.stroke || '') ? L.stroke : '#000000'
  const sw = Math.round((L.strokeWidth || 0) * 1000)
  el('edShapeStrokeW').value = sw
  el('edShapeStrokeWVal').textContent = sw
  const rad = Math.round((L.radius || 0) * 1000)
  el('edShapeRadius').value = rad
  el('edShapeRadiusVal').textContent = rad
  el('edRadiusCtl').style.display = L.type === 'rect' ? 'flex' : 'none'
  el('edShapeRot').value = Math.round(L.rot || 0)
  el('edShapeRotVal').textContent = Math.round(L.rot || 0)
  const op = Math.round((L.opacity == null ? 1 : L.opacity) * 100)
  el('edShapeOpacity').value = op
  el('edShapeOpacityVal').textContent = op
  el('edShapeShadow').checked = !!L.shadow
}

// Mutate every selected overlay, re-render, and commit history once the user
// stops moving the control.
let _ctlHistTimer = null
function editOverlays(fn, { immediate = false } = {}) {
  // Locked layers are skipped here too, not just on drag — otherwise the lock
  // only holds against the mouse and every panel control walks straight past it.
  const sel = selectedOverlays().filter((L) => !L.locked)
  if (!sel.length) return
  sel.forEach(fn)
  renderOverlays(); buildLayerList()
  clearTimeout(_ctlHistTimer)
  if (immediate) pushHistory()
  else _ctlHistTimer = setTimeout(pushHistory, 500)
  scheduleApply()
}

// ── Photo controls ─────────────────────────────────────────────
el('edZoom').addEventListener('input', () => {
  const sel = selectedItems(); if (!sel.length) return
  const scale = clamp((parseInt(el('edZoom').value, 10) || 100) / 100, 1, 4)
  el('edZoomVal').textContent = scale.toFixed(1) + '×'
  sel.forEach((it) => { it.placement.scale = scale; layoutItem(it) })
  scheduleZoomHistory(); scheduleApply()
})
CADJ.forEach((k) => {
  el('ed' + k).addEventListener('input', () => {
    const sel = selectedItems(); if (!sel.length) return
    const v = parseInt(el('ed' + k).value, 10) || 0
    el('ed' + k + 'Val').textContent = v
    sel.forEach((it) => {
      it.adjust[k.toLowerCase()] = v
      refreshPhotoVisuals(it)
    })
    scheduleZoomHistory(); scheduleApply()
  })
})
el('edBw').addEventListener('change', () => {
  const sel = selectedItems(); if (!sel.length) return
  sel.forEach((it) => {
    it.adjust.bw = el('edBw').checked
    refreshPhotoVisuals(it)
  })
  pushHistory(); scheduleApply()
})
const rotate = (deg) => {
  const sel = selectedItems(); if (!sel.length) return
  sel.forEach((it) => { it.rotation = (((it.rotation || 0) + deg) % 360 + 360) % 360; layoutItem(it) })
  pushHistory(); scheduleApply()
  toast('Rotated — the page proof will re-render')
}
el('edRotL').addEventListener('click', () => rotate(-90))
el('edRotR').addEventListener('click', () => rotate(90))

el('edResetPhoto').addEventListener('click', () => {
  const sel = selectedItems(); if (!sel.length) return
  sel.forEach((it) => {
    it.placement = { scale: 1, ox: 0, oy: 0 }
    it.adjust = {}
    refreshPhotoVisuals(it)
    layoutItem(it)
  })
  updatePanel(); pushHistory(); scheduleApply()
})

// Preset chips
;(function buildPresets() {
  const wrap = el('edPresets')
  for (const [name, values] of Object.entries(PRESETS)) {
    const b = document.createElement('button')
    b.className = 'ed-preset'
    b.textContent = name
    b.addEventListener('click', () => {
      const sel = selectedItems(); if (!sel.length) return
      sel.forEach((it) => {
        it.adjust = { ...values }
        refreshPhotoVisuals(it)
      })
      updatePanel(); pushHistory(); scheduleApply()
      toast(name)
    })
    wrap.appendChild(b)
  }
})()

el('edLayerText').addEventListener('input', () => {
  const node = selectedLayers()[0]; if (!node) return
  layerEdits[node.id] = { ...(layerEdits[node.id] || {}), text: el('edLayerText').value }
  buildScene(); buildLayerList(); scheduleApply()
  clearTimeout(_ctlHistTimer); _ctlHistTimer = setTimeout(pushHistory, 600)
})

;['edLayerX', 'edLayerY', 'edLayerW', 'edLayerH'].forEach((id) => {
  el(id).addEventListener('change', commitLayerFields)
})
el('edLayerVisible').addEventListener('change', () => {
  const node = selectedLayers()[0]; if (!node) return
  setLayerEdit(node.id, { hidden: !el('edLayerVisible').checked })
})
el('edLayerOpacity').addEventListener('input', () => {
  const node = selectedLayers()[0]; if (!node) return
  const v = parseInt(el('edLayerOpacity').value, 10)
  el('edLayerOpacityVal').textContent = v
  layerEdits[node.id] = { ...(layerEdits[node.id] || {}), opacity: v / 100 }
  buildScene(); scheduleApply()
  clearTimeout(_ctlHistTimer); _ctlHistTimer = setTimeout(pushHistory, 500)
})
el('edLayerReset').addEventListener('click', () => {
  const node = selectedLayers()[0]; if (!node) return
  delete layerEdits[node.id]
  buildScene(); buildLayerList(); updatePanel(); pushHistory(); scheduleApply()
  toast('Layer reset')
})

// ── Text controls ──────────────────────────────────────────────
;(function buildFontList() {
  const sel = el('edFont')
  for (const f of FONTS) {
    const o = document.createElement('option')
    o.value = f; o.textContent = f; o.style.fontFamily = f
    sel.appendChild(o)
  }
})()

el('edText').addEventListener('input', () => editOverlays((L) => { L.text = el('edText').value }))
el('edFont').addEventListener('change', () => editOverlays((L) => { L.font = el('edFont').value }, { immediate: true }))
el('edFontSize').addEventListener('input', () => {
  const v = parseInt(el('edFontSize').value, 10) || 50
  el('edFontSizeVal').textContent = v
  editOverlays((L) => { L.size = v / 1000 })
})
el('edWeight').addEventListener('change', () => editOverlays((L) => { L.weight = parseInt(el('edWeight').value, 10) }, { immediate: true }))
el('edTextColor').addEventListener('input', () => editOverlays((L) => { L.color = el('edTextColor').value }))
el('edItalic').addEventListener('click', () => {
  const on = !el('edItalic').classList.contains('is-active')
  el('edItalic').classList.toggle('is-active', on)
  editOverlays((L) => { L.italic = on }, { immediate: true })
})
el('edUnderline').addEventListener('click', () => {
  const on = !el('edUnderline').classList.contains('is-active')
  el('edUnderline').classList.toggle('is-active', on)
  editOverlays((L) => { L.underline = on }, { immediate: true })
})
document.querySelectorAll('#edAlign button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#edAlign button').forEach((x) => x.classList.toggle('is-active', x === b))
    editOverlays((L) => { L.align = b.dataset.align }, { immediate: true })
  })
})
document.querySelectorAll('#edValign button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#edValign button').forEach((x) => x.classList.toggle('is-active', x === b))
    editOverlays((L) => { L.valign = b.dataset.valign }, { immediate: true })
  })
})
el('edLineHeight').addEventListener('input', () => {
  const v = parseInt(el('edLineHeight').value, 10) || 125
  el('edLineHeightVal').textContent = (v / 100).toFixed(1)
  editOverlays((L) => { L.lineHeight = v / 100 })
})
el('edTracking').addEventListener('input', () => {
  const v = parseInt(el('edTracking').value, 10) || 0
  el('edTrackingVal').textContent = v
  editOverlays((L) => { L.tracking = v / 100 })
})
el('edTextRot').addEventListener('input', () => {
  const v = parseInt(el('edTextRot').value, 10) || 0
  el('edTextRotVal').textContent = v
  editOverlays((L) => { L.rot = v })
})
el('edTextOpacity').addEventListener('input', () => {
  const v = parseInt(el('edTextOpacity').value, 10)
  el('edTextOpacityVal').textContent = v
  editOverlays((L) => { L.opacity = v / 100 })
})
el('edTextShadow').addEventListener('change', () => editOverlays((L) => { L.shadow = el('edTextShadow').checked ? 1 : 0 }, { immediate: true }))

// ── Shape controls ─────────────────────────────────────────────
el('edShapeFill').addEventListener('input', () => editOverlays((L) => { L.fill = el('edShapeFill').value }))
el('edShapeFillNone').addEventListener('click', () => editOverlays((L) => { L.fill = 'none' }, { immediate: true }))
el('edShapeStroke').addEventListener('input', () => editOverlays((L) => { L.stroke = el('edShapeStroke').value }))
el('edShapeStrokeW').addEventListener('input', () => {
  const v = parseInt(el('edShapeStrokeW').value, 10) || 0
  el('edShapeStrokeWVal').textContent = v
  editOverlays((L) => { L.strokeWidth = v / 1000 })
})
el('edShapeRadius').addEventListener('input', () => {
  const v = parseInt(el('edShapeRadius').value, 10) || 0
  el('edShapeRadiusVal').textContent = v
  editOverlays((L) => { L.radius = v / 1000 })
})
el('edShapeRot').addEventListener('input', () => {
  const v = parseInt(el('edShapeRot').value, 10) || 0
  el('edShapeRotVal').textContent = v
  editOverlays((L) => { L.rot = v })
})
el('edShapeOpacity').addEventListener('input', () => {
  const v = parseInt(el('edShapeOpacity').value, 10)
  el('edShapeOpacityVal').textContent = v
  editOverlays((L) => { L.opacity = v / 100 })
})
el('edShapeShadow').addEventListener('change', () => editOverlays((L) => { L.shadow = el('edShapeShadow').checked ? 1 : 0 }, { immediate: true }))

// ── Page controls ──────────────────────────────────────────────
el('edPageBg').addEventListener('input', () => {
  pageBackground = el('edPageBg').value
  applyPageBackground(); scheduleApply()
  clearTimeout(_ctlHistTimer); _ctlHistTimer = setTimeout(pushHistory, 500)
})
el('edPageBgClear').addEventListener('click', () => {
  pageBackground = null
  applyPageBackground(); pushHistory(); scheduleApply()
})

// ── Left rail: spread thumbnails + navigation ──────────────────
function buildRail() {
  const wrap = el('edThumbs'); wrap.innerHTML = ''
  const list = (spread.spreads && spread.spreads.length)
    ? spread.spreads
    : [{ pageNum: spread.pageNum, backdropUrl: spread.backdropUrl }]
  const idx = list.findIndex((sp) => sp.pageNum === spread.pageNum)
  el('edSpreadsCount').textContent = list.length > 1
    ? `${idx < 0 ? '?' : idx + 1}/${list.length}`
    : ''
  for (const sp of list) {
    const isCurrent = sp.pageNum === spread.pageNum
    const label = 'Page ' + String(sp.pageNum).padStart(3, '0')
    // Button rather than a clickable div so page navigation is reachable by
    // keyboard and announced with its page number.
    const t = document.createElement('button')
    t.className = 'ed-thumb' + (isCurrent ? ' active' : '')
    t.setAttribute('aria-label', isCurrent ? `${label} (current)` : `Go to ${label}`)
    if (isCurrent) t.setAttribute('aria-current', 'true')
    if (sp.backdropUrl) {
      const im = document.createElement('img')
      im.src = sp.backdropUrl; im.draggable = false; im.alt = ''
      t.appendChild(im)
    }
    const cap = document.createElement('span'); cap.className = 'ed-thumb__cap'
    cap.textContent = label
    t.appendChild(cap)
    t.disabled = isCurrent
    if (!isCurrent) t.addEventListener('click', () => gotoSpread(sp.pageNum))
    wrap.appendChild(t)
  }
}

function gotoSpread(pageNum) {
  if (pageNum === spread.pageNum) return
  hideContextMenu()
  // Flush any pending (debounced) edits before the payload is replaced.
  clearTimeout(_applyTimer)
  applyNow()
  selectedIds = []; selectedOverlayIds = []
  // Main rebuilds the payload for this page and pushes it back via
  // `editor-spread-updated`, which re-runs load().
  api.goto({ pageNum }).catch(() => {})
}

// ── Context menus ──────────────────────────────────────────────
let _ctxEl = null
function hideContextMenu() { if (_ctxEl) { _ctxEl.remove(); _ctxEl = null } }
function buildMenu(x, y, entries) {
  hideContextMenu()
  const menu = document.createElement('div')
  menu.className = 'ed-ctx'
  for (const [label, enabled, fn] of entries) {
    const b = document.createElement('button')
    b.className = 'ed-ctx__item'
    b.textContent = label
    b.disabled = !enabled
    if (enabled) b.addEventListener('click', () => { hideContextMenu(); fn() })
    menu.appendChild(b)
  }
  document.body.appendChild(menu)
  const r = menu.getBoundingClientRect()
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px'
  _ctxEl = menu
}

function showContextMenu(x, y, item) {
  const canSwap = selectedIds.length === 2
  buildMenu(x, y, [
    [canSwap ? 'Swap the 2 selected photos' : 'Swap (select 2 photos first)', canSwap, () => {
      const [a, b] = selectedItems()
      if (a && b) { performSwap(a, b); toast('Swapped') }
    }],
    ['Rotate 90° left', true, () => rotate(-90)],
    ['Rotate 90° right', true, () => rotate(90)],
    ['Reset this photo', true, () => {
      item.placement = { scale: 1, ox: 0, oy: 0 }; item.adjust = {}
      refreshPhotoVisuals(item)
      layoutItem(item); updatePanel(); pushHistory(); scheduleApply()
    }],
  ])
}

function showOverlayContextMenu(x, y, L) {
  buildMenu(x, y, [
    ['Duplicate', true, duplicateSelection],
    ['Bring to front', true, bringToFront],
    ['Send to back', true, sendToBack],
    [L.locked ? 'Unlock' : 'Lock', true, () => {
      L.locked = !L.locked; renderOverlays(); buildLayerList(); pushHistory(); scheduleApply()
    }],
    ['Delete', true, deleteSelection],
  ])
}
document.addEventListener('click', hideContextMenu)

// Swap photo identity (incl. orientation) between two frames. The frame boxes
// (._el) stay put; the photos — with their per-id placement + colour — trade
// places and cover-fit into the new frame, so cross-shape swaps "scale to fit".
// Orientation travels with the photo so main.js can re-derive frame assignment.
function performSwap(a, b) {
  const FIELDS = ['id', 'url', 'orient', 'rotation', 'placement', 'adjust', '_nat']
  for (const k of FIELDS) { const t = a[k]; a[k] = b[k]; b[k] = t }
  a._el.dataset.id = a.id; b._el.dataset.id = b.id
  a._img.src = a.url; b._img.src = b.url
  refreshPhotoVisuals(a); refreshPhotoVisuals(b)
  layoutItem(a); layoutItem(b)
  setSelection(null)
  pushHistory()
  api.swap({ pageNum: spread.pageNum, aId: a.id, bId: b.id }).catch(() => {})
}

// ── Keyboard ───────────────────────────────────────────────────
// Which keys a focused control keeps for itself lives in shortcut_target.js,
// shared with the main window. The local test this replaced counted every
// <input> as typing — so after clicking the Opacity slider or the Visible
// checkbox (both of which stay focused) every shortcut in the editor, the
// Space hand tool included, went dead until you clicked the canvas.
const ST = window.ShortcutTarget

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideContextMenu()
    if (tool !== 'select') { setTool('select'); return }
    setSelection(null); selectOverlay(null, false); selectLayer(null, false)
    return
  }
  if (ST.controlOwnsKey(e.target, e)) return

  // Space arms the hand tool. Swallow the default so it neither scrolls the
  // viewport nor "clicks" whatever button currently has focus — both of which
  // would fire on every pan.
  if (e.code === 'Space') {
    e.preventDefault()
    setSpaceHeld(true)
    return
  }

  const meta = e.metaKey || e.ctrlKey
  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo(); else undo()
    return
  }
  if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return }
  if (meta && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(zoom * 1.25); return }
  if (meta && e.key === '-') { e.preventDefault(); setZoom(zoom / 1.25); return }
  if (meta && e.key === '0') { e.preventDefault(); zoomToFit(); return }
  if (meta && e.shiftKey && e.key === ']') { e.preventDefault(); bringToFront(); return }
  if (meta && e.shiftKey && e.key === '[') { e.preventDefault(); sendToBack(); return }
  if (meta && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    selectedIds = []
    selectedOverlayIds = overlays.filter((L) => !L.hidden && !L.locked).map((L) => L.id)
    renderOverlays(); buildLayerList(); updatePanel()
    return
  }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    if (selectedOverlayIds.length) { e.preventDefault(); deleteSelection(); return }
    // Template layers belong to the PSD, so they can't be removed from the
    // project — the non-destructive equivalent is hiding, which also keeps
    // the row in the Layers pane so it can be brought straight back.
    const layers = selectedLayers().filter((n) => n.kind !== 'group')
    if (layers.length) {
      e.preventDefault()
      for (const n of layers) setLayerEdit(n.id, { hidden: true })
      updatePanel()
      toast(layers.length === 1 ? 'Layer hidden — click its eye to show it again' : `${layers.length} layers hidden`)
    }
    return
  }
  // Arrow keys nudge the selected overlays; Shift = 10× step.
  const NUDGE = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  if (NUDGE[e.key] && selectedOverlayIds.length) {
    e.preventDefault()
    const step = (e.shiftKey ? 0.01 : 0.001)
    const [dx, dy] = NUDGE[e.key]
    editOverlays((L) => { L.x += dx * step; L.y += dy * step })
    return
  }
  // Template layers are movable too, so they nudge too. Their edits are in
  // canvas pixels; the step is the same fraction of the page as the overlay
  // nudge, taken from the LONG edge so left/right and up/down move the same
  // distance on a 3:1 spread.
  if (NUDGE[e.key] && selectedLayerIds.length && spread) {
    const layers = selectedLayers().filter((n) => n.kind !== 'group')
    if (!layers.length) return
    e.preventDefault()
    const step = Math.max(spread.canvasW, spread.canvasH) * (e.shiftKey ? 0.01 : 0.001)
    const [ux, uy] = NUDGE[e.key]
    for (const n of layers) {
      const cur = layerEdits[n.id] || {}
      layerEdits[n.id] = { ...cur, dx: (cur.dx || 0) + ux * step, dy: (cur.dy || 0) + uy * step }
    }
    layoutPsdLayers()
    for (const it of items) layoutItem(it)
    renderOverlays()
    updatePanel(); scheduleApply()
    // A held arrow auto-repeats; one undo step per burst, not per repeat.
    clearTimeout(_ctlHistTimer); _ctlHistTimer = setTimeout(pushHistory, 500)
    return
  }
  // Tool shortcuts.
  const TOOLKEYS = { v: 'select', t: 'text', r: 'rect', e: 'ellipse', l: 'line' }
  if (!meta && TOOLKEYS[e.key.toLowerCase()]) { setTool(TOOLKEYS[e.key.toLowerCase()]) }
})

// ── Apply back ─────────────────────────────────────────────────
let _applyTimer = null
function scheduleApply() {
  clearTimeout(_applyTimer)
  _applyTimer = setTimeout(applyNow, 250)
}
function _nonDefaultPlacement(pl) {
  return pl && ((pl.scale && pl.scale !== 1) || pl.ox || pl.oy) ? { scale: pl.scale || 1, ox: pl.ox || 0, oy: pl.oy || 0 } : null
}
// Keep only the fields the renderer acts on, and drop the layer entirely when
// every slider is at rest — an empty object would otherwise churn the render
// cache on every save.
function _nonDefaultAdjust(adj) {
  if (!adj) return null
  const out = {}
  for (const k of ['exposure', 'contrast', 'saturation', 'warmth', 'tint', 'fade', 'clarity', 'sharpen', 'blur', 'vignette']) {
    if (adj[k]) out[k] = adj[k]
  }
  if (adj.bw) out.bw = true
  return Object.keys(out).length ? out : null
}
function applyNow() {
  if (!spread) return
  const placements = {}, adjustments = {}
  for (const it of items) {
    placements[it.id] = _nonDefaultPlacement(it.placement)
    adjustments[it.id] = _nonDefaultAdjust(it.adjust)
  }
  api.apply({
    pageNum: spread.pageNum,
    placements,
    adjustments,
    rotations: Object.fromEntries(items.map((it) => [it.id, it.rotation || 0])),
    overlays,
    pageBackground,
    layerEdits,
  }).catch(() => {})
}

el('edDone').addEventListener('click', () => { applyNow(); toast('Saved'); setTimeout(() => window.close(), 250) })

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') setSpaceHeld(false)
})

document.addEventListener('pointerdown', flushHistory, true)
document.addEventListener('keydown', (e) => {
  // Keys that CONTINUE a burst must not split it: held/alternating arrows
  // (nudging), bare modifiers (Shift for the 10× nudge), and typing — each
  // character in a caption field is not its own undo step.
  if (e.key.startsWith('Arrow')) return
  if (['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) return
  if (ST.isTextEntry(e.target)) return
  flushHistory()
}, true)
// Losing focus mid-pan (Cmd-Tab away while holding Space) never delivers the
// keyup, which would leave the hand tool stuck on. Reset on the way out.
window.addEventListener('blur', () => setSpaceHeld(false))

window.addEventListener('resize', computeStageScale)
// Clicking bare page or the surrounding mat clears the selection (but not
// while a draw tool is active — there a click is the start of a new shape).
const clearOnBareClick = (e) => {
  if (suppressNextClick) { suppressNextClick = false; return }
  if (tool !== 'select') return
  if (e.target !== stageWrap && e.target !== stage && e.target !== hitSurface) return
  // Clicking the page itself selects the template layer under the pointer;
  // only the surrounding mat clears the selection.
  if (e.target !== stageWrap && psd) {
    const hit = pickLayerAt(e.clientX, e.clientY)
    if (hit) { selectLayer(hit.id, e.shiftKey || e.metaKey); return }
  }
  setSelection(null); selectOverlay(null, false); selectLayer(null, false)
}
// Bound ONCE, on the outer wrap: clicks bubble up from the stage, so a second
// listener on `stage` would run the handler twice per click — the first call
// eating the suppression flag and the second clearing the fresh selection.
stageWrap.addEventListener('click', clearOnBareClick)

setTool('select')
load()
