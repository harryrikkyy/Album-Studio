/* ============================================================
   ui_tilt.js — Tier-1 "3D" interactive depth + core-loop feedback
   ------------------------------------------------------------
   1) Pointer-reactive tilt for the Page preview (the hero artifact)
      and the card grids. Upgrades the themes' static :hover tilt to
      cursor-tracking, and adds a soft specular sheen to the preview.
   2) Live-preview "refresh pulse": a one-shot accent ring whenever the
      composite updates, so every edit visibly lands (instant-feedback
      dopamine — see live-design-engine.md).

   Design notes (see docs/ideas + ui-ux-design-system.md):
   - GPU-friendly: only mutates `transform` + a couple of CSS vars.
   - Event-delegated at document level (works with the virtualized,
     event-delegated grids — no per-tile listeners, no edits to the
     render functions).
   - Fully disabled under `prefers-reduced-motion`.
   - Inline `transform` overrides the per-theme :hover tilt while the
     pointer is inside; clearing it on leave animates back to rest.
   ============================================================ */

(function () {
  'use strict'

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (reduceMotion.matches) return // honour the user's OS preference

  // Cards the themes already tilt + the hero preview. Each entry: the max
  // tilt angle (deg) and whether it gets a pointer-following sheen.
  const TILE_SELECTOR = '.thumb-card, .wp-card, .sb-page-card, .tools-card'
  const PREVIEW_ID = 'yellowPreviewArea'
  const TILT_TILE = 6
  const TILT_PREVIEW = 8
  const PERSPECTIVE = 900

  let active = null          // the element currently being tilted
  let pending = null         // {el, rx, ry, mx, my} awaiting a rAF flush
  let rafId = 0

  function targetFor(node) {
    if (!node || !node.closest) return null
    const tile = node.closest(TILE_SELECTOR)
    if (tile) return { el: tile, max: TILT_TILE, sheen: false }
    const prev = node.closest('#' + PREVIEW_ID)
    if (prev) return { el: prev, max: TILT_PREVIEW, sheen: true }
    return null
  }

  function flush() {
    rafId = 0
    if (!pending) return
    const { el, rx, ry, mx, my, sheen } = pending
    el.style.transform =
      `perspective(${PERSPECTIVE}px) rotateX(${rx}deg) rotateY(${ry}deg)`
    if (sheen) {
      el.style.setProperty('--tilt-mx', mx + '%')
      el.style.setProperty('--tilt-my', my + '%')
    }
    pending = null
  }

  function onMove(e) {
    const t = targetFor(e.target)
    if (!t) { if (active) reset(active); return }

    // Switching from one card to another: snap the previous one back.
    if (active && active !== t.el) reset(active)

    if (active !== t.el) {
      active = t.el
      // No transition while actively tracking (immediate, 1:1 feel).
      active.classList.add('is-tilting')
      if (t.sheen) active.classList.add('has-sheen')
    }

    const r = t.el.getBoundingClientRect()
    if (!r.width || !r.height) return
    const px = (e.clientX - r.left) / r.width   // 0..1
    const py = (e.clientY - r.top) / r.height   // 0..1
    const ry = (px - 0.5) * 2 * t.max           // cursor right → tilt right edge back
    const rx = -(py - 0.5) * 2 * t.max
    pending = { el: t.el, rx, ry, mx: px * 100, my: py * 100, sheen: t.sheen }
    if (!rafId) rafId = requestAnimationFrame(flush)
  }

  function reset(el) {
    el.classList.remove('is-tilting') // re-enable the return transition
    el.style.transform = ''
    el.style.removeProperty('--tilt-mx')
    el.style.removeProperty('--tilt-my')
    // Drop the sheen after the transition so it fades rather than snaps.
    setTimeout(() => el.classList.remove('has-sheen'), 260)
    if (active === el) active = null
  }

  document.addEventListener('pointermove', onMove, { passive: true })
  document.addEventListener('pointerleave', () => { if (active) reset(active) }, true)
  // Pointer capture (e.g. dragging a slider/photo) should cancel any tilt.
  document.addEventListener('pointerdown', (e) => {
    const t = targetFor(e.target)
    if (!t && active) reset(active)
  }, { passive: true })
})()

/* ── Live-preview refresh pulse ────────────────────────────────
   When the Page preview composite updates (its <img> is swapped in),
   flash a one-shot accent ring so the edit→see loop feels instant and
   alive. Isolated MutationObserver on the single preview element — no
   hooks into the render/compose code. */
;(function () {
  'use strict'
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  function attach() {
    const area = document.getElementById('yellowPreviewArea')
    if (!area) return
    let clearTimer = null
    const pulse = () => {
      area.classList.remove('preview-refresh')
      void area.offsetWidth // restart the animation if mid-flight
      area.classList.add('preview-refresh')
      clearTimeout(clearTimer)
      clearTimer = setTimeout(() => area.classList.remove('preview-refresh'), 700)
    }
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.addedNodes && m.addedNodes.length) { pulse(); return }
      }
    })
    obs.observe(area, { childList: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach)
  } else {
    attach()
  }
})()
