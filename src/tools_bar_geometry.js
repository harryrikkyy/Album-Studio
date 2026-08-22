// @ts-check
// tools_bar_geometry.js
//
// Where the floating tools bar lands, as a pure function of Photoshop's window
// rectangle and the display it lives on. Extracted from tools_bar.js so the
// placement can be tested without a running Photoshop — the old inline version
// could only be checked by eye, on one display layout, which is how it came to
// put the bar off-screen.
//
// Coordinates are screen-space DIPs with the origin at the top-left of the
// PRIMARY display, matching both System Events' `position of window` and
// Electron's `screen` module. A display to the LEFT of the primary therefore
// has a NEGATIVE x origin, which is a real layout here and the source of an
// earlier "the bar vanished" bug — every clamp below is two-sided for that
// reason.

/**
 * @typedef {{ x: number, y: number, w: number, h: number }} PSRect
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 */

const MIN_WIDTH = 200

/**
 * Compute the bar window's rectangle.
 *
 * The bar wants to sit just BELOW Photoshop's bottom edge, spanning its width.
 * When a dropdown is open the window grows upward by `expansionPx` — that extra
 * height is empty host surface above the bar, so the bar's own strip stays put
 * and only the window's top edge moves.
 *
 * When there is no room below (Photoshop is full-height, which is the normal
 * case for a maximised window) the bar OVERLAYS Photoshop's bottom strip
 * instead. The previous behaviour flipped it to `ps.y - totalH`, i.e. above
 * Photoshop's TOP edge — which on a maximised window is off-screen or on top of
 * the menu bar. Overlapping the bottom 44px of the canvas is the mild failure;
 * disappearing is the bad one.
 *
 * @param {PSRect} ps Photoshop's window rect
 * @param {Rect} workArea the display's work area (menu bar / Dock excluded)
 * @param {{ barHeight: number, expansionPx?: number, minWidth?: number }} opts
 * @returns {Rect}
 */
function dockRect(ps, workArea, opts) {
  const barHeight = opts.barHeight
  const expansionPx = opts.expansionPx || 0
  const minWidth = opts.minWidth == null ? MIN_WIDTH : opts.minWidth
  const totalH = barHeight + expansionPx

  const waLeft = workArea.x
  const waRight = workArea.x + workArea.width
  const waTop = workArea.y
  const waBottom = workArea.y + workArea.height

  // ── Horizontal: match Photoshop, clipped to the display ──────────────────
  let x = ps.x
  let width = ps.w
  if (x < waLeft) {
    width -= waLeft - x
    x = waLeft
  }
  if (x + width > waRight) width = waRight - x
  if (width < minWidth) {
    width = Math.min(minWidth, workArea.width)
    // Re-anchor if the floor pushed us off the right edge.
    if (x + width > waRight) x = waRight - width
    if (x < waLeft) x = waLeft
  }

  // ── Vertical: below Photoshop, else overlaying its bottom strip ──────────
  const psBottom = ps.y + ps.h
  let y = psBottom - expansionPx        // bar's top edge on PS's bottom edge
  if (y + totalH > waBottom) {
    y = psBottom - totalH               // bar's BOTTOM edge on PS's bottom edge
  }

  // Whatever the mode, the window must end up wholly on the display —
  // clamping the bottom first and the top second means a bar taller than the
  // work area (absurd, but not impossible with a big dropdown on a short
  // screen) degrades to "pinned at the top" rather than "half off both ends".
  if (y + totalH > waBottom) y = waBottom - totalH
  if (y < waTop) y = waTop

  return { x, y, width, height: totalH }
}

module.exports = { dockRect, MIN_WIDTH }
