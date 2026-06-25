// renamer_renderer.js
//
// Renderer for the Renamer window (renamer.html). nodeIntegration is on, so
// we require Node + Electron modules directly. All file I/O goes through IPC
// to the main process (src/renamer.js); naming is the shared pure module.

const { ipcRenderer } = require('electron')
const naming = require('./renamer_naming')

// ── Configurable lists (edit to taste) ───────────────────────
const LAMINATIONS = ['Standard', 'Matte', 'Glossy', 'Velvet', 'Luster']
const SIZES = ['12x36', '12x30', '12x24', '10x30', '10x24', '8x24', '12x18', '10x20']
const EFFECTS = ['Glitter', 'Foil', 'Emboss', 'Spot UV', 'Metallic']

// ── State ─────────────────────────────────────────────────────
let folderPath = null
let folderName = ''
let tiles = []          // { path, fileName, baseName, ext, width, height, thumb, role, effect }
let coverPad = null     // { lamination, size }
let armedMode = null    // 'first' | 'last' | 'cover' | null
let dragIndex = -1

// ── Theme (shared with the main window via file:// localStorage) ──
;(function applySavedTheme() {
  let saved = 'nebula'
  try { saved = localStorage.getItem('adt_theme') || 'nebula' } catch (_) {}
  document.documentElement.setAttribute('data-theme', saved)
  // Native controls (select, radios, scrollbars) need color-scheme to render
  // legibly. Only the plain "glass" theme is light; everything else is dark.
  document.documentElement.style.colorScheme = saved === 'glass' ? 'light' : 'dark'
})()

// ── DOM refs ──────────────────────────────────────────────────
const el = (id) => document.getElementById(id)
const grid = el('rnGrid')
const emptyEl = el('rnEmpty')
const folderLabel = el('folderLabel')
const chkFolderMode = el('chkFolderMode')
const customNameInput = el('customName')
const btnRenameAll = el('btnRenameAll')
const menu = el('rnMenu')
const overlay = el('rnOverlay')
const covLam = el('covLam')
const covSize = el('covSize')
const covPreview = el('covPreview')
const toastEl = el('rnToast')
const treeEl = el('rnTree')
const treeEmptyEl = el('rnTreeEmpty')
const refreshBtn = el('rnRefresh')

// Folder tree state
let treeRoot = null               // { name, path }
const expanded = new Set()        // paths currently expanded
const childrenCache = new Map()   // path -> folders[] (empty array == leaf)

// ── Helpers ───────────────────────────────────────────────────
function toast(msg, kind) {
  toastEl.textContent = msg
  toastEl.classList.toggle('rn-toast--error', kind === 'error')
  toastEl.classList.add('show')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 3500)
}

function customName() {
  const v = customNameInput.value.trim()
  return chkFolderMode.checked ? null : (v || null)
}

function namingInput() {
  return {
    folderName,
    tiles: tiles.map((t) => ({ path: t.path, role: t.role, effect: t.effect })),
    coverPad,
    customPageName: customName(),
  }
}

// ── Render ────────────────────────────────────────────────────
function render() {
  const assigned = naming.computeAssignedNames(namingInput())
  const byPath = new Map(assigned.map((a) => [a.path, a]))

  grid.innerHTML = ''
  emptyEl.style.display = tiles.length ? 'none' : 'block'

  tiles.forEach((t, idx) => {
    const a = byPath.get(t.path)
    const card = document.createElement('div')
    card.className = 'rn-tile'
    card.draggable = true
    card.dataset.index = String(idx)
    if (armedMode) card.classList.add('armed-hover')

    // Thumb
    const thumb = document.createElement('div')
    thumb.className = 'rn-tile__thumb'
    if (t.thumb) {
      const img = document.createElement('img')
      img.src = t.thumb
      img.draggable = false
      thumb.appendChild(img)
    } else {
      const ph = document.createElement('div')
      ph.className = 'rn-tile__placeholder'
      ph.textContent = /\.psb?$|\.psd$/i.test(t.ext) ? 'PSD' : 'NO PREVIEW'
      thumb.appendChild(ph)
    }
    card.appendChild(thumb)

    // Badges
    const badges = document.createElement('div')
    badges.className = 'rn-tile__badges'
    if (t.role === 'first') badges.innerHTML = '<span class="rn-chip rn-chip--first">00</span>'
    else if (t.role === 'last') badges.innerHTML = '<span class="rn-chip rn-chip--last">zz</span>'
    else if (t.role === 'cover') badges.innerHTML = '<span class="rn-chip rn-chip--cover">COVER</span>'
    if (t.effect) badges.innerHTML += `<span class="rn-chip rn-chip--effect">${escapeHtml(t.effect)}</span>`
    card.appendChild(badges)

    // Dimensions
    if (t.width && t.height) {
      const dim = document.createElement('div')
      dim.className = 'rn-tile__dim'
      dim.textContent = `${t.width}×${t.height}`
      card.appendChild(dim)
    }

    // Body
    const body = document.createElement('div')
    body.className = 'rn-tile__body'
    const newName = document.createElement('div')
    if (a && a.baseName) {
      newName.className = 'rn-tile__newname'
      newName.textContent = a.baseName + t.ext
    } else {
      newName.className = 'rn-tile__newname rn-tile__newname--none'
      newName.textContent = t.role === 'cover' ? '(set cover options…)' : '(no name)'
    }
    const oldName = document.createElement('div')
    oldName.className = 'rn-tile__oldname'
    oldName.textContent = t.fileName
    body.appendChild(newName)
    body.appendChild(oldName)
    card.appendChild(body)

    wireTile(card, idx)
    grid.appendChild(card)
  })

  // Summary in subbar label
  const pageCount = naming.countPageSheets(tiles.map((t) => ({ role: t.role })))
  if (tiles.length && folderName) {
    folderLabel.textContent = `${folderName} · ${tiles.length} files · ${pageCount} page${pageCount === 1 ? '' : 's'}`
  }
  btnRenameAll.disabled = tiles.length === 0
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── Tile interactions: click-to-assign, drag reorder, right-click ──
function wireTile(card, idx) {
  card.addEventListener('click', () => {
    if (!armedMode) return
    assignRole(idx, armedMode)
    setArmed(null)
  })

  card.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (tiles[idx].role !== 'page') return // effects only on page sheets
    openEffectMenu(e.clientX, e.clientY, idx)
  })

  card.addEventListener('dragstart', (e) => {
    dragIndex = idx
    card.classList.add('dragging')
    try { e.dataTransfer.effectAllowed = 'move' } catch (_) {}
  })
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging')
    dragIndex = -1
    document.querySelectorAll('.rn-tile.drop-target').forEach((c) => c.classList.remove('drop-target'))
  })
  card.addEventListener('dragover', (e) => {
    e.preventDefault()
    if (dragIndex === -1 || dragIndex === idx) return
    card.classList.add('drop-target')
  })
  card.addEventListener('dragleave', () => card.classList.remove('drop-target'))
  card.addEventListener('drop', (e) => {
    e.preventDefault()
    card.classList.remove('drop-target')
    if (dragIndex === -1 || dragIndex === idx) return
    const moved = tiles.splice(dragIndex, 1)[0]
    tiles.splice(idx, 0, moved)
    dragIndex = -1
    render()
  })
}

function assignRole(idx, role) {
  // Roles 'first'/'last'/'cover' are unique — demote any current holder.
  if (role !== 'page') {
    tiles.forEach((t) => { if (t.role === role) { t.role = 'page'; t.effect = null } })
  }
  const tile = tiles[idx]
  tile.role = role
  if (role !== 'page') tile.effect = null // half-sheets/cover carry no effect

  if (role === 'cover') {
    openCoverDialog(tile)
  } else {
    render()
  }
}

function setArmed(mode) {
  armedMode = mode
  document.querySelectorAll('.rn-toolbar .btn[data-mode]').forEach((b) => {
    b.classList.toggle('btn--primary', b.dataset.mode === mode)
    b.classList.toggle('btn--ghost', b.dataset.mode !== mode)
  })
  render()
}

// ── Effect context menu ───────────────────────────────────────
let _menuIdx = -1
function openEffectMenu(x, y, idx) {
  _menuIdx = idx
  menu.innerHTML = ''
  EFFECTS.forEach((fx) => {
    const b = document.createElement('button')
    b.className = 'rn-menu__item'
    b.textContent = fx
    b.addEventListener('click', () => { tiles[_menuIdx].effect = fx; closeMenu(); render() })
    menu.appendChild(b)
  })
  const sep = document.createElement('div')
  sep.className = 'rn-menu__sep'
  menu.appendChild(sep)
  const clear = document.createElement('button')
  clear.className = 'rn-menu__item'
  clear.textContent = 'Clear effect'
  clear.addEventListener('click', () => { tiles[_menuIdx].effect = null; closeMenu(); render() })
  menu.appendChild(clear)

  menu.style.left = Math.min(x, window.innerWidth - 180) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - 220) + 'px'
  menu.classList.add('open')
}
function closeMenu() { menu.classList.remove('open'); _menuIdx = -1 }
document.addEventListener('click', (e) => { if (!e.target.closest('#rnMenu')) closeMenu() })

// ── Cover pad dialog ──────────────────────────────────────────
function buildCoverControls() {
  covLam.innerHTML = LAMINATIONS.map((l, i) =>
    `<label class="rn-radio"><input type="radio" name="covlam" value="${escapeHtml(l)}"${i === 0 ? ' checked' : ''}>${escapeHtml(l)}</label>`
  ).join('')
  covSize.innerHTML = SIZES.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')
  covLam.querySelectorAll('input').forEach((r) => r.addEventListener('change', updateCoverPreview))
  covSize.addEventListener('change', updateCoverPreview)
}
function selectedLam() {
  const r = covLam.querySelector('input:checked')
  return r ? r.value : LAMINATIONS[0]
}
function updateCoverPreview() {
  const pageCount = naming.countPageSheets(tiles.map((t) => ({ role: t.role })))
  covPreview.textContent = naming.coverPadBaseName(folderName, selectedLam(), covSize.value, pageCount)
}
function openCoverDialog(tile) {
  // Pre-select a size matching the image's WxH if it's a standard size.
  if (tile.width && tile.height) {
    const guess = matchStandardSize(tile.width, tile.height)
    if (guess) covSize.value = guess
  }
  updateCoverPreview()
  overlay.classList.add('open')
}
function matchStandardSize(w, h) {
  // Album sheets are wide; compare the WxH ratio loosely to "AxB" inches.
  const longSide = Math.max(w, h)
  const shortSide = Math.min(w, h)
  if (!shortSide) return null
  const ratio = longSide / shortSide
  let best = null
  let bestDelta = Infinity
  SIZES.forEach((s) => {
    const m = /^(\d+)x(\d+)$/.exec(s)
    if (!m) return
    const a = Math.max(+m[1], +m[2])
    const b = Math.min(+m[1], +m[2])
    const r = a / b
    const delta = Math.abs(r - ratio)
    if (delta < bestDelta) { bestDelta = delta; best = s }
  })
  return bestDelta <= 0.06 ? best : null
}
el('covCancel').addEventListener('click', () => {
  overlay.classList.remove('open')
  // Cancelling leaves the tile's role as 'cover' but unconfigured (its name
  // shows "(set cover options…)" and it's skipped on rename until set).
  render()
})
el('covApply').addEventListener('click', () => {
  coverPad = { lamination: selectedLam(), size: covSize.value }
  overlay.classList.remove('open')
  render()
})

// ── Toolbar wiring ────────────────────────────────────────────
el('btnPickFolder').addEventListener('click', pickFolder)
el('btnSelFirst').addEventListener('click', () => setArmed(armedMode === 'first' ? null : 'first'))
el('btnSelLast').addEventListener('click', () => setArmed(armedMode === 'last' ? null : 'last'))
el('btnSelCover').addEventListener('click', () => setArmed(armedMode === 'cover' ? null : 'cover'))
chkFolderMode.addEventListener('change', () => {
  customNameInput.disabled = chkFolderMode.checked
  const modeLabel = el('modeLabel')
  if (modeLabel) modeLabel.textContent = chkFolderMode.checked ? 'Folder name' : 'Custom prefix'
  render()
})
customNameInput.addEventListener('input', render)
btnRenameAll.addEventListener('click', renameAll)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { setArmed(null); closeMenu(); overlay.classList.remove('open') }
})

async function pickFolder() {
  const chosen = await ipcRenderer.invoke('renamer-pick-folder')
  if (!chosen) return
  // Chosen folder becomes the tree root. Auto-expand it and load its images
  // if it directly contains sheets.
  treeRoot = { name: chosen.split('/').pop() || chosen, path: chosen }
  expanded.clear()
  childrenCache.clear()
  expanded.add(chosen)
  await ensureChildren(chosen)
  renderTree()
  await loadFolder(chosen)
}

refreshBtn.addEventListener('click', async () => {
  if (!treeRoot) return
  childrenCache.clear()
  // Re-fetch every currently-expanded folder.
  for (const p of expanded) await ensureChildren(p)
  renderTree()
})

// ── Folder tree ───────────────────────────────────────────────
async function ensureChildren(dirPath) {
  if (childrenCache.has(dirPath)) return
  const res = await ipcRenderer.invoke('renamer-list-dir', dirPath)
  childrenCache.set(dirPath, res && res.ok ? res.folders : [])
}

async function toggleNode(dirPath) {
  if (expanded.has(dirPath)) {
    expanded.delete(dirPath)
  } else {
    expanded.add(dirPath)
    await ensureChildren(dirPath)
  }
  renderTree()
}

function renderTree() {
  treeEl.innerHTML = ''
  if (!treeRoot) {
    treeEmptyEl.style.display = 'block'
    return
  }
  treeEmptyEl.style.display = 'none'
  treeEl.appendChild(buildNode(treeRoot, 0))
}

function buildNode(node, depth) {
  const wrap = document.createElement('div')
  const row = document.createElement('div')
  row.className = 'rn-node__row'
  if (folderPath === node.path) row.classList.add('active')
  row.style.paddingLeft = 6 + depth * 14 + 'px'

  const kids = childrenCache.get(node.path)
  const isOpen = expanded.has(node.path)
  const isLeaf = Array.isArray(kids) && kids.length === 0

  const arrow = document.createElement('span')
  arrow.className = 'rn-node__arrow' + (isOpen ? ' open' : '') + (isLeaf ? ' leaf' : '')
  arrow.textContent = '▶'
  arrow.addEventListener('click', (e) => { e.stopPropagation(); toggleNode(node.path) })
  row.appendChild(arrow)

  const icon = document.createElement('span')
  icon.className = 'rn-node__icon'
  icon.textContent = isOpen ? '📂' : '📁'
  row.appendChild(icon)

  const name = document.createElement('span')
  name.className = 'rn-node__name'
  name.textContent = node.name
  row.appendChild(name)

  if (folderPath === node.path) {
    const chk = document.createElement('span')
    chk.className = 'rn-node__check'
    chk.textContent = '✓'
    row.appendChild(chk)
  }

  // Clicking the row loads the folder's images AND expands it to reveal
  // any subfolders.
  row.addEventListener('click', async () => {
    if (!expanded.has(node.path)) { expanded.add(node.path); await ensureChildren(node.path) }
    await loadFolder(node.path)
    renderTree()
  })

  wrap.appendChild(row)

  if (isOpen && Array.isArray(kids) && kids.length) {
    const childBox = document.createElement('div')
    childBox.className = 'rn-node__children'
    kids.forEach((c) => childBox.appendChild(buildNode(c, depth + 1)))
    wrap.appendChild(childBox)
  }
  return wrap
}

async function loadFolder(p) {
  folderLabel.textContent = 'Loading…'
  const res = await ipcRenderer.invoke('renamer-list-images', p)
  if (!res || !res.ok) {
    toast('Could not read folder: ' + ((res && res.error) || 'unknown'), 'error')
    folderLabel.textContent = 'No folder selected'
    return
  }
  folderPath = p
  folderName = res.folderName || p.split('/').pop()
  coverPad = null
  tiles = res.images.map((im) => ({ ...im, role: 'page', effect: null }))
  setArmed(null)
  renderTree() // refresh active highlight + checkmark
  if (tiles.length === 0) {
    folderLabel.textContent = folderName + ' · no images'
    toast('No JPEG/PNG/PSD files found in that folder', 'error')
  }
  render()
}

async function renameAll() {
  if (!folderPath) return
  // Warn if a cover sheet is assigned but its options were never set — it
  // would be silently skipped otherwise.
  const coverUnset = tiles.some((t) => t.role === 'cover') && !coverPad
  if (coverUnset) {
    toast('Cover sheet has no options set — click the cover tile to configure it (it will be skipped otherwise).', 'error')
  }
  const ops = naming.computeRenames(namingInput())
  if (ops.length === 0) { toast('Nothing to rename'); return }
  btnRenameAll.disabled = true
  const res = await ipcRenderer.invoke('renamer-apply-renames', { folderPath, ops })
  if (!res || !res.ok) {
    toast('Rename failed: ' + ((res && res.error) || 'unknown'), 'error')
    btnRenameAll.disabled = false
    return
  }
  toast(`✓ Renamed ${res.renamed} file${res.renamed === 1 ? '' : 's'}`)
  // Reload so tiles reflect the new on-disk names.
  await loadFolder(folderPath)
}

// ── Init ──────────────────────────────────────────────────────
buildCoverControls()
render()
