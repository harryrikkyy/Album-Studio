// editor_renderer.js — Spread Editor window
//
// Renders the current spread as a DOM scene (backdrop + frames + photos) using
// the SAME placement math as the libvips renderer / Photoshop build, so what
// you see is what you get. Select a photo on the page, drag to pan, scroll to
// zoom, and colour-grade — edits are sent back to the main app to persist and
// re-render. See docs/ideas/spread-editor.md.

const { ipcRenderer } = require('electron')

// Theme (shared via file:// localStorage), opaque for this non-transparent window.
;(function () {
  let t = 'nebula'
  try { t = localStorage.getItem('adt_theme') || 'nebula' } catch (_) {}
  document.documentElement.setAttribute('data-theme', t)
  document.documentElement.style.colorScheme = t === 'glass' ? 'light' : 'dark'
})()

const el = (id) => document.getElementById(id)
const stage = el('edStage')
const stageWrap = el('edStageWrap')
const emptyEl = el('edEmpty')
const toastEl = el('edToast')
const hintEl = el('edHint')

const DEFAULT_HINT = 'Click a photo on the page · drag to reposition · scroll to zoom.'

let spread = null          // { pageNum, canvasW, canvasH, backdropUrl, items[], spreads[] }
let items = []             // working copy; each gets .placement, .adjust, ._nat, ._el, ._img
let selectedId = null
let displayScale = 1
let swapArmed = false      // arm-then-click-two-photos swap gesture
let swapFirstId = null

const CADJ = ['Exposure', 'Contrast', 'Saturation', 'Warmth']

function toast(msg) {
  toastEl.textContent = msg
  toastEl.classList.add('show')
  clearTimeout(toast._t); toast._t = setTimeout(() => toastEl.classList.remove('show'), 2200)
}

// ── Load ───────────────────────────────────────────────────────
async function load() {
  spread = await ipcRenderer.invoke('editor-get-spread')
  if (!spread || !spread.items || !spread.items.length) {
    emptyEl.style.display = 'block'
    return
  }
  emptyEl.style.display = 'none'
  items = spread.items.map((it) => ({
    ...it,
    placement: it.placement ? { scale: it.placement.scale || 1, ox: it.placement.ox || 0, oy: it.placement.oy || 0 } : { scale: 1, ox: 0, oy: 0 },
    adjust: it.adjust ? { ...it.adjust } : {},
  }))
  buildScene()
  buildRail()
}
ipcRenderer.on('editor-spread-updated', () => load())

// ── Scene ──────────────────────────────────────────────────────
function buildScene() {
  stage.innerHTML = ''
  // Backdrop
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
    item._el = f
    item._img = img
    img.addEventListener('load', () => {
      item._nat = { w: img.naturalWidth, h: img.naturalHeight }
      layoutItem(item)
    })
    wireFrame(item)
    stage.appendChild(f)
  }
  computeStageScale()
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
  const ox = Math.max(-1, Math.min(1, item.placement.ox || 0))
  const oy = Math.max(-1, Math.min(1, item.placement.oy || 0))
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

// ── CSS approximation of the libvips adjustments (warmth is approximate; the
// authoritative colour is the main-app preview / export). ──
function cssFilter(adj) {
  if (!adj) return 'none'
  const b = Math.pow(2, (adj.exposure || 0) / 100)
  const c = Math.max(0, 1 + (adj.contrast || 0) / 100)
  const s = Math.max(0, 1 + (adj.saturation || 0) / 100)
  const w = adj.warmth || 0
  let f = `brightness(${b.toFixed(3)}) contrast(${c.toFixed(3)}) saturate(${s.toFixed(3)})`
  if (w > 0) f += ` sepia(${Math.min(0.6, w / 200).toFixed(3)})`
  else if (w < 0) f += ` hue-rotate(${(w / 8).toFixed(1)}deg)`
  return f
}

// ── Selection + interaction ────────────────────────────────────
function selectItem(id) {
  selectedId = id
  items.forEach((it) => it._el && it._el.classList.toggle('selected', it.id === id))
  updatePanel()
}

function wireFrame(item) {
  const f = item._el
  // Drag = pan within the frame.
  let dragging = false, sx = 0, sy = 0, startOx = 0, startOy = 0
  f.addEventListener('pointerdown', (e) => {
    if (swapArmed) { e.preventDefault(); handleSwapClick(item); return }
    selectItem(item.id)
    if (!item._over) return
    dragging = true
    f.classList.add('dragging')
    f.setPointerCapture(e.pointerId)
    sx = e.clientX; sy = e.clientY
    startOx = item.placement.ox || 0; startOy = item.placement.oy || 0
  })
  f.addEventListener('pointermove', (e) => {
    if (!dragging || !item._over) return
    const dx = e.clientX - sx, dy = e.clientY - sy
    // Moving the image right (+dx) reveals the left part → ox decreases.
    const dOx = item._over.overX > 0 ? (-2 * dx / item._over.overX) : 0
    const dOy = item._over.overY > 0 ? (-2 * dy / item._over.overY) : 0
    item.placement.ox = Math.max(-1, Math.min(1, startOx + dOx))
    item.placement.oy = Math.max(-1, Math.min(1, startOy + dOy))
    layoutItem(item)
  })
  const end = (e) => {
    if (!dragging) return
    dragging = false
    f.classList.remove('dragging')
    try { f.releasePointerCapture(e.pointerId) } catch (_) {}
    scheduleApply()
  }
  f.addEventListener('pointerup', end)
  f.addEventListener('pointercancel', end)
  // Wheel = zoom.
  f.addEventListener('wheel', (e) => {
    e.preventDefault()
    selectItem(item.id)
    const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08
    item.placement.scale = Math.max(1, Math.min(4, (item.placement.scale || 1) * factor))
    layoutItem(item)
    updatePanel()
    scheduleApply()
  }, { passive: false })
}

// ── Right panel ────────────────────────────────────────────────
function curItem() { return items.find((it) => it.id === selectedId) || null }

function updatePanel() {
  const it = curItem()
  el('edNoSel').style.display = it ? 'none' : 'block'
  el('edControls').style.display = it ? 'flex' : 'none'
  if (!it) return
  const z = Math.round((it.placement.scale || 1) * 100)
  el('edZoom').value = z
  el('edZoomVal').textContent = (z / 100).toFixed(1) + '×'
  CADJ.forEach((k) => {
    const v = it.adjust[k.toLowerCase()] || 0
    el('ed' + k).value = v
    el('ed' + k + 'Val').textContent = v
  })
}

el('edZoom').addEventListener('input', () => {
  const it = curItem(); if (!it) return
  it.placement.scale = Math.max(1, Math.min(4, (parseInt(el('edZoom').value, 10) || 100) / 100))
  el('edZoomVal').textContent = (it.placement.scale).toFixed(1) + '×'
  layoutItem(it); scheduleApply()
})
CADJ.forEach((k) => {
  el('ed' + k).addEventListener('input', () => {
    const it = curItem(); if (!it) return
    const v = parseInt(el('ed' + k).value, 10) || 0
    el('ed' + k + 'Val').textContent = v
    it.adjust[k.toLowerCase()] = v
    if (it._img) it._img.style.filter = cssFilter(it.adjust)
    scheduleApply()
  })
})
el('edResetPhoto').addEventListener('click', () => {
  const it = curItem(); if (!it) return
  it.placement = { scale: 1, ox: 0, oy: 0 }
  it.adjust = {}
  if (it._img) it._img.style.filter = 'none'
  layoutItem(it); updatePanel(); scheduleApply()
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
  if (swapArmed) setSwapArmed(false)
  // Flush any pending (debounced) edits before the payload is replaced.
  clearTimeout(_applyTimer)
  applyNow()
  selectedId = null
  // Main rebuilds the payload for this page and pushes it back via
  // `editor-spread-updated`, which re-runs load().
  ipcRenderer.invoke('editor-goto', { pageNum }).catch(() => {})
}

// ── Swap (arm-then-click two same-shape photos) ────────────────
function setSwapArmed(on) {
  swapArmed = on
  swapFirstId = null
  items.forEach((it) => it._el && it._el.classList.remove('swap-target'))
  el('edSwap').classList.toggle('armed', on)
  hintEl.textContent = on
    ? 'Swap mode: click two photos of the same shape to swap them (Esc to cancel).'
    : DEFAULT_HINT
}

function handleSwapClick(item) {
  if (!swapFirstId) {
    swapFirstId = item.id
    item._el.classList.add('swap-target')
    hintEl.textContent = 'Now click another ' + (item.orient === 'v' ? 'portrait' : 'landscape') + ' photo to swap with (Esc to cancel).'
    return
  }
  if (item.id === swapFirstId) { // clicked the same photo → unselect
    setSwapArmed(true) // re-arm cleanly (clears highlight + hint)
    return
  }
  const a = items.find((it) => it.id === swapFirstId)
  if (!a) { setSwapArmed(true); return }
  if ((a.orient || '') !== (item.orient || '')) {
    toast('Photos must be the same shape to swap')
    return
  }
  performSwap(a, item)
  setSwapArmed(false)
  toast('Swapped')
}

// Swap photo identity between two frames; the frame boxes (._el) stay put, so
// each frame keeps its slot while the photos (and their per-id placement +
// colour) trade places. Mirrors the main-app reorder of albumPages[].photos.
function performSwap(a, b) {
  const FIELDS = ['id', 'url', 'rotation', 'placement', 'adjust', '_nat']
  for (const k of FIELDS) { const t = a[k]; a[k] = b[k]; b[k] = t }
  a._el.dataset.id = a.id; b._el.dataset.id = b.id
  a._img.src = a.url; b._img.src = b.url
  a._img.style.filter = cssFilter(a.adjust); b._img.style.filter = cssFilter(b.adjust)
  layoutItem(a); layoutItem(b)
  selectItem(null)
  ipcRenderer.invoke('editor-swap', { pageNum: spread.pageNum, aId: a.id, bId: b.id }).catch(() => {})
}

el('edSwap').addEventListener('click', () => setSwapArmed(!swapArmed))
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && swapArmed) setSwapArmed(false) })

// ── Apply back ─────────────────────────────────────────────────
let _applyTimer = null
function scheduleApply() {
  clearTimeout(_applyTimer)
  _applyTimer = setTimeout(applyNow, 250)
}
function _nonDefaultPlacement(pl) {
  return pl && ((pl.scale && pl.scale !== 1) || pl.ox || pl.oy) ? { scale: pl.scale || 1, ox: pl.ox || 0, oy: pl.oy || 0 } : null
}
function _nonDefaultAdjust(adj) {
  if (!adj) return null
  const e = adj.exposure || 0, c = adj.contrast || 0, s = adj.saturation || 0, w = adj.warmth || 0
  if (!e && !c && !s && !w) return null
  return { exposure: e, contrast: c, saturation: s, warmth: w }
}
function applyNow() {
  const placements = {}, adjustments = {}
  for (const it of items) {
    placements[it.id] = _nonDefaultPlacement(it.placement)
    adjustments[it.id] = _nonDefaultAdjust(it.adjust)
  }
  ipcRenderer.invoke('editor-apply', { pageNum: spread.pageNum, placements, adjustments })
    .catch(() => {})
}

el('edDone').addEventListener('click', () => { applyNow(); toast('Saved'); setTimeout(() => window.close(), 250) })

window.addEventListener('resize', computeStageScale)
document.addEventListener('click', (e) => { if (e.target === stageWrap) selectItem(null) })

load()
