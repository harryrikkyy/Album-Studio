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
let pageBackground = null
let selectedIds = []       // selected PHOTO ids (ordered by selection)
let selectedOverlayIds = []
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
    photos: items.map((it) => ({ id: it.id, placement: it.placement, adjust: it.adjust, rotation: it.rotation })),
  })
}
function pushHistory() {
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
  renderOverlays(); buildLayerList(); updatePanel(); applyPageBackground(); scheduleApply()
}
function undo() {
  if (undoStack.length < 2) return
  redoStack.push(undoStack.pop())
  restore(undoStack[undoStack.length - 1])
  refreshHistoryUI(); toast('Undo')
}
function redo() {
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
  if (!spread || ((!spread.items || !spread.items.length) && !(spread.overlays || []).length)) {
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
  pageBackground = spread.pageBackground || null
  selectedIds = []; selectedOverlayIds = []
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

function buildScene() {
  stage.innerHTML = ''
  if (spread.backdropUrl) {
    const bd = document.createElement('img')
    bd.className = 'ed-stage__backdrop'
    bd.src = spread.backdropUrl
    bd.draggable = false
    stage.appendChild(bd)
  }
  for (const item of items) {
    const f = document.createElement('div')
    f.className = 'ed-frame'
    f.dataset.id = item.id
    const img = document.createElement('img')
    img.src = item.url
    img.draggable = false
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

function applyPageBackground() {
  stage.style.background = pageBackground || ''
  const picker = el('edPageBg')
  if (pageBackground) picker.value = pageBackground
}

function computeStageScale() {
  if (!spread) return
  const padW = stageWrap.clientWidth - 24
  const padH = stageWrap.clientHeight - 24
  displayScale = Math.min(padW / spread.canvasW, padH / spread.canvasH)
  if (!isFinite(displayScale) || displayScale <= 0) displayScale = 0.1
  stage.style.width = spread.canvasW * displayScale + 'px'
  stage.style.height = spread.canvasH * displayScale + 'px'
  for (const item of items) layoutItem(item)
  renderOverlays()
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
  ovlSurface.innerHTML = OV.buildOverlaySvg(overlays, W, H) || ''
  buildHitBoxes(W, H)
}

function buildHitBoxes(W, H) {
  hitSurface.innerHTML = ''
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
  if (!snapEnabled) return { x, y, vx: null, hy: null }
  const { xs, ys } = snapTargets(L.id)
  let bestX = null, bestXd = SNAP_TOL, guideX = null
  for (const edge of [[x, 0], [x + L.w / 2, L.w / 2], [x + L.w, L.w]]) {
    for (const t of xs) {
      const d = Math.abs(edge[0] - t)
      if (d < bestXd) { bestXd = d; bestX = t - edge[1]; guideX = t }
    }
  }
  let bestY = null, bestYd = SNAP_TOL, guideY = null
  for (const edge of [[y, 0], [y + L.h / 2, L.h / 2], [y + L.h, L.h]]) {
    for (const t of ys) {
      const d = Math.abs(edge[0] - t)
      if (d < bestYd) { bestYd = d; bestY = t - edge[1]; guideY = t }
    }
  }
  showGuides(guideX, guideY)
  return { x: bestX != null ? bestX : x, y: bestY != null ? bestY : y }
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
        let nx = orig.x, ny = orig.y, nw = orig.w, nh = orig.h
        if (handle.includes('e')) nw = Math.max(0.01, orig.w + dx)
        if (handle.includes('s')) nh = Math.max(0.01, orig.h + dy)
        if (handle.includes('w')) { nw = Math.max(0.01, orig.w - dx); nx = orig.x + (orig.w - nw) }
        if (handle.includes('n')) { nh = Math.max(0.01, orig.h - dy); ny = orig.y + (orig.h - nh) }
        if (ev.shiftKey && orig.w > 0) {
          const ratio = orig.h / orig.w
          nh = nw * ratio
          if (handle.includes('n')) ny = orig.y + (orig.h - nh)
        }
        L.x = nx; L.y = ny; L.w = nw; L.h = nh
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

// Drag-to-draw on the empty stage.
stage.addEventListener('pointerdown', (e) => {
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

function buildLayerList() {
  const wrap = el('edLayers')
  wrap.innerHTML = ''
  el('edLayersEmpty').style.display = overlays.length ? 'none' : 'block'
  // Topmost first — matches how the layers read on the page.
  for (let i = overlays.length - 1; i >= 0; i--) {
    const L = overlays[i]
    const row = document.createElement('div')
    row.className = 'ed-layer'
    if (selectedOverlayIds.includes(L.id)) row.classList.add('selected')
    if (L.hidden) row.classList.add('is-hidden')

    const name = document.createElement('span')
    name.className = 'ed-layer__name'
    name.textContent = layerLabel(L)
    row.appendChild(name)

    const mkBtn = (icon, title, fn) => {
      const b = document.createElement('button')
      b.className = 'ed-layer__btn'
      b.title = title
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

    row.addEventListener('click', () => selectOverlay(L.id, false))
    wrap.appendChild(row)
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
  overlays = overlays.filter((o) => !selectedOverlayIds.includes(o.id))
  selectedOverlayIds = []
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
function setSelection(id) { selectedOverlayIds = []; selectedIds = id ? [id] : []; refreshSelectionUI() }
function toggleSelection(id) {
  selectedOverlayIds = []
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

  el('edPagePanel').style.display = (!photoSel.length && !ovSel.length) ? 'block' : 'none'
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

  if (photoSel.length) updatePhotoPanel(photoSel[0])
  if (isText) updateTextPanel(ovSel[0])
  if (isShape) updateShapePanel(ovSel[0])
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
  const sel = selectedOverlays()
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
  for (const sp of list) {
    const isCurrent = sp.pageNum === spread.pageNum
    const t = document.createElement('div')
    t.className = 'ed-thumb' + (isCurrent ? ' active' : '')
    if (sp.backdropUrl) {
      const im = document.createElement('img'); im.src = sp.backdropUrl; im.draggable = false
      t.appendChild(im)
    }
    const cap = document.createElement('div'); cap.className = 'ed-thumb__cap'
    cap.textContent = 'Page ' + String(sp.pageNum).padStart(3, '0')
    t.appendChild(cap)
    if (!isCurrent) {
      t.style.cursor = 'pointer'
      t.addEventListener('click', () => gotoSpread(sp.pageNum))
    }
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
function isTyping(e) {
  const t = e.target
  return t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable)
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideContextMenu()
    if (tool !== 'select') { setTool('select'); return }
    setSelection(null); selectOverlay(null, false)
    return
  }
  if (isTyping(e)) return

  const meta = e.metaKey || e.ctrlKey
  if (meta && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo(); else undo()
    return
  }
  if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelection(); return }
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
    if (selectedOverlayIds.length) { e.preventDefault(); deleteSelection() }
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
  }).catch(() => {})
}

el('edDone').addEventListener('click', () => { applyNow(); toast('Saved'); setTimeout(() => window.close(), 250) })

window.addEventListener('resize', computeStageScale)
// Clicking bare page or the surrounding mat clears the selection (but not
// while a draw tool is active — there a click is the start of a new shape).
const clearOnBareClick = (e) => {
  if (suppressNextClick) { suppressNextClick = false; return }
  if (tool !== 'select') return
  if (e.target === stageWrap || e.target === stage || e.target === hitSurface) {
    setSelection(null); selectOverlay(null, false)
  }
}
// Bound ONCE, on the outer wrap: clicks bubble up from the stage, so a second
// listener on `stage` would run the handler twice per click — the first call
// eating the suppression flag and the second clearing the fresh selection.
stageWrap.addEventListener('click', clearOnBareClick)

setTool('select')
load()
