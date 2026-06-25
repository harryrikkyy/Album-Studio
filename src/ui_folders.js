/* ============================================================
   ui_folders.js — Collapsible folder-structure panels (G1)
   ------------------------------------------------------------
   Every tab that shows a folder list (Source, Templates, Wallpapers,
   PNG, Masked, Photos) uses the same `.folder-rail > .folder-rail__panel
   > .folder-rail__header` structure. This injects a collapse chevron into
   each header (no per-panel HTML edits) that collapses the folder list to
   a thin strip — reclaiming space for the grid — and persists the state
   per panel.

   Collapse target:
   - .folder-rail--boxed : shrink the .folder-rail__panel (keep the grid)
   - .folder-rail--side  : shrink the whole side rail
   (both handled by the `.is-folders-collapsed` CSS in style.css).
   ============================================================ */

(function () {
  'use strict'

  const KEY_PREFIX = 'adt_folders_collapsed_'

  function keyFor(rail) {
    return KEY_PREFIX + (rail.id || rail.querySelector('.folder-rail__panel')?.id || 'rail')
  }

  function setCollapsed(rail, btn, collapsed) {
    rail.classList.toggle('is-folders-collapsed', collapsed)
    btn.textContent = collapsed ? '›' : '‹'
    btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false')
    btn.title = collapsed ? 'Show folders' : 'Hide folders'
    try { localStorage.setItem(keyFor(rail), collapsed ? '1' : '0') } catch (_) {}
  }

  function wireRail(rail) {
    const header = rail.querySelector('.folder-rail__header')
    if (!header || header.querySelector('.folder-rail__collapse')) return

    const btn = document.createElement('button')
    btn.className = 'folder-rail__collapse'
    btn.type = 'button'
    btn.setAttribute('aria-label', 'Toggle folder list')
    btn.textContent = '‹'
    header.insertBefore(btn, header.firstChild)

    let collapsed = false
    try { collapsed = localStorage.getItem(keyFor(rail)) === '1' } catch (_) {}
    setCollapsed(rail, btn, collapsed)

    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      setCollapsed(rail, btn, !rail.classList.contains('is-folders-collapsed'))
      window.dispatchEvent(new Event('resize'))
    })
  }

  function init() {
    document.querySelectorAll('.folder-rail').forEach(wireRail)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
