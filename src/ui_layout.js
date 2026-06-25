/* ============================================================
   ui_layout.js — Tab-1 "Stage + Rails" layout (E.1) + resizers (E.2)
   ------------------------------------------------------------
   Opt-in relayout of the Album tab into Lightroom/Figma-style rails:
   Source (left) and Templates (right) as full-height rails with the
   page Compose + the hero Preview stacked in the centre stage.

   Implemented purely as a CSS class on #tab-album (see the
   `.layout-stage` block in style.css, which uses `display:contents`
   to reflow the existing panels into a grid). No DOM is restructured,
   so the classic 2×2 layout remains the default and the toggle is a
   safe, reversible switch.

   The three stage dividers (#stageResizerLeft/Right/Split) drag the
   grid track sizes via CSS vars (--stage-left / --stage-right /
   --stage-compose). All sizes + the layout choice are persisted.
   ============================================================ */

(function () {
  'use strict'

  const KEY = 'adt_layout_stage'
  const TAB = 'tab-album'

  function tabEl() { return document.getElementById(TAB) }
  function isOn() {
    const t = tabEl()
    return !!(t && t.classList.contains('layout-stage'))
  }

  function apply(on) {
    const tab = tabEl()
    if (tab) tab.classList.toggle('layout-stage', on)

    const btn = document.getElementById('btnLayoutToggle')
    if (btn) {
      btn.classList.toggle('is-active', on)
      btn.setAttribute('aria-pressed', on ? 'true' : 'false')
      const lbl = btn.querySelector('.lt-label')
      if (lbl) lbl.textContent = on ? '2×2 view' : 'Stage view'
    }

    try { localStorage.setItem(KEY, on ? '1' : '0') } catch (_) {}
    // Let the virtualized grids / live preview recompute on the next frame.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
  }

  // ── Resizable stage tracks ─────────────────────────────────
  // Each divider drags one CSS var on #tab-album. `sign` maps pointer
  // direction to size change; `max` may be a function (dynamic clamp).
  const RESIZERS = [
    { id: 'stageResizerLeft',  varName: '--stage-left',    key: 'adt_stage_left',    axis: 'x', sign: +1, fallback: 200, min: 130, max: 460 },
    { id: 'stageResizerRight', varName: '--stage-right',   key: 'adt_stage_right',   axis: 'x', sign: -1, fallback: 220, min: 130, max: 480 },
    { id: 'stageResizerSplit', varName: '--stage-compose', key: 'adt_stage_compose', axis: 'y', sign: +1, fallback: 230, min: 90,
      max: () => Math.max(160, (tabEl() ? tabEl().clientHeight : 800) - 260) },
  ]

  function maxOf(o) { return typeof o.max === 'function' ? o.max() : o.max }

  function readVal(o) {
    const tab = tabEl()
    if (!tab) return o.fallback
    const v = parseInt(getComputedStyle(tab).getPropertyValue(o.varName), 10)
    return isNaN(v) ? o.fallback : v
  }

  function setVal(o, px) {
    const tab = tabEl()
    if (!tab) return
    const v = Math.round(Math.max(o.min, Math.min(maxOf(o), px)))
    tab.style.setProperty(o.varName, v + 'px')
    return v
  }

  function persist(o, v) { try { localStorage.setItem(o.key, String(v)) } catch (_) {} }

  function restoreSizes() {
    const tab = tabEl()
    if (!tab) return
    for (const o of RESIZERS) {
      let saved
      try { saved = localStorage.getItem(o.key) } catch (_) {}
      const v = parseInt(saved, 10)
      if (!isNaN(v)) tab.style.setProperty(o.varName, Math.max(o.min, v) + 'px')
    }
  }

  function wireResizer(o) {
    const h = document.getElementById(o.id)
    if (!h) return
    let start = 0
    let startVal = 0

    const onMove = (e) => {
      const d = (o.axis === 'x' ? e.clientX - start : e.clientY - start) * o.sign
      setVal(o, startVal + d)
    }
    const onUp = (e) => {
      h.classList.remove('is-dragging')
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerup', onUp)
      persist(o, readVal(o))
      window.dispatchEvent(new Event('resize'))
      try { h.releasePointerCapture(e.pointerId) } catch (_) {}
    }
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      start = o.axis === 'x' ? e.clientX : e.clientY
      startVal = readVal(o)
      h.classList.add('is-dragging')
      try { h.setPointerCapture(e.pointerId) } catch (_) {}
      document.addEventListener('pointermove', onMove)
      document.addEventListener('pointerup', onUp)
    })

    // Keyboard nudge (role="separator", focusable). Arrows move the divider
    // in its drag direction; persisted like a drag.
    h.addEventListener('keydown', (e) => {
      const STEP = 12
      let dir = 0
      if (o.axis === 'x') { if (e.key === 'ArrowRight') dir = 1; else if (e.key === 'ArrowLeft') dir = -1 }
      else { if (e.key === 'ArrowDown') dir = 1; else if (e.key === 'ArrowUp') dir = -1 }
      if (!dir) return
      e.preventDefault()
      const v = setVal(o, readVal(o) + dir * STEP * o.sign)
      persist(o, v)
      window.dispatchEvent(new Event('resize'))
    })
  }

  // ── Rail collapse-to-strip ─────────────────────────────────
  const RAILS = [
    { side: 'left',  btn: 'btnCollapseLeft',  cls: 'rail-collapsed-left',  varName: '--stage-left',  sizeKey: 'adt_stage_left',  key: 'adt_rail_left_collapsed',  fallback: 200, strip: 32, glyph: '‹', label: 'Source' },
    { side: 'right', btn: 'btnCollapseRight', cls: 'rail-collapsed-right', varName: '--stage-right', sizeKey: 'adt_stage_right', key: 'adt_rail_right_collapsed', fallback: 220, strip: 32, glyph: '›', label: 'Templates' },
  ]

  function applyRail(r, collapsed) {
    const tab = tabEl()
    if (!tab) return
    tab.classList.toggle(r.cls, collapsed)
    if (collapsed) {
      tab.style.setProperty(r.varName, r.strip + 'px')
    } else {
      let s
      try { s = localStorage.getItem(r.sizeKey) } catch (_) {}
      const v = parseInt(s, 10)
      tab.style.setProperty(r.varName, (isNaN(v) ? r.fallback : v) + 'px')
    }
    const btn = document.getElementById(r.btn)
    if (btn) {
      btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false')
      // Chevron points "open" (toward content) when collapsed.
      const open = r.side === 'left' ? '›' : '‹'
      btn.textContent = collapsed ? open : r.glyph
      btn.title = (collapsed ? 'Expand the ' : 'Collapse the ') + r.label + ' rail'
    }
    try { localStorage.setItem(r.key, collapsed ? '1' : '0') } catch (_) {}
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
  }

  function wireRails() {
    for (const r of RAILS) {
      let collapsed = false
      try { collapsed = localStorage.getItem(r.key) === '1' } catch (_) {}
      applyRail(r, collapsed)
      const btn = document.getElementById(r.btn)
      if (btn) btn.addEventListener('click', () => applyRail(r, !tabEl().classList.contains(r.cls)))
    }
  }

  // ── Centre focus mode (both / compose / preview) ───────────
  const CENTER_KEY = 'adt_stage_center'
  const CENTER_CLASSES = ['stage-center-both', 'stage-center-compose', 'stage-center-preview']

  function applyCenter(mode) {
    const tab = tabEl()
    if (!tab) return
    if (!['both', 'compose', 'preview'].includes(mode)) mode = 'both'
    CENTER_CLASSES.forEach((c) => tab.classList.remove(c))
    tab.classList.add('stage-center-' + mode)
    document.querySelectorAll('.seg-group .seg').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.center === mode)
      b.setAttribute('aria-pressed', b.dataset.center === mode ? 'true' : 'false')
    })
    try { localStorage.setItem(CENTER_KEY, mode) } catch (_) {}
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
  }

  function wireCenter() {
    let mode = 'both'
    try { mode = localStorage.getItem(CENTER_KEY) || 'both' } catch (_) {}
    applyCenter(mode)
    document.querySelectorAll('.seg-group .seg').forEach((b) => {
      b.addEventListener('click', () => applyCenter(b.dataset.center))
    })
  }

  function init() {
    restoreSizes()

    let saved = false
    try { saved = localStorage.getItem(KEY) === '1' } catch (_) {}
    apply(saved)

    const btn = document.getElementById('btnLayoutToggle')
    if (btn) btn.addEventListener('click', () => apply(!isOn()))

    RESIZERS.forEach(wireResizer)
    wireRails()
    wireCenter()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
