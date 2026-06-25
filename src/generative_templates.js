// generative_templates.js
//
// Procedurally-generated layout templates. Solves the problem that 60% of
// album pages are "3 horizontal photos in a row" or "1 hero + 4 supporting" —
// patterns that don't need a hand-authored PSD to look professional.
//
// Each generator produces:
//   {
//     id, name,                        // stable identifiers for the template grid
//     h, v,                            // h-photo / v-photo counts (drives existing filter logic)
//     canvasWidth, canvasHeight,       // doc dimensions in pixels
//     frames: [ { name, x, y, w, h } ] // already named "toolkithframeN" / "toolkitvframeN" so
//                                      // proof_renderer.js partitions them correctly
//     params,                          // serialized so saveStateToStorage can persist
//     generator: <name>,               // discriminator for re-hydration
//   }
//
// Standard album spread is 3000×2000 (3:2 landscape) — we use that as the
// default canvas. Real PSD libraries usually run 12×8 inches at 300dpi which
// is 3600×2400, but proofs work fine at 3000×2000 and the math stays clean.

const DEFAULT_CANVAS_W = 3000
const DEFAULT_CANVAS_H = 2000
const DEFAULT_BLEED = 60     // px of safe area at every edge
const DEFAULT_GUTTER = 30    // px between adjacent frames

// Counter so generated IDs stay stable across regenerations within a session.
let _idCounter = 0
function nextId(prefix) {
  _idCounter += 1
  return `gen_${prefix}_${_idCounter}`
}

// Frame coordinate sanity helper. Floors fractional pixels and ensures we
// never emit a 0×0 frame from a math edge case.
function frame(name, x, y, w, h) {
  return {
    name,
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    w: Math.max(1, Math.round(w)),
    h: Math.max(1, Math.round(h)),
  }
}

// ─── generators ───────────────────────────────────────────────────────────────

/**
 * Equal-grid layout: rows × cols horizontal photos.
 * Used for film-strip pages, contact-sheet style spreads.
 */
function gridLayout(opts) {
  const o = {
    canvasWidth: DEFAULT_CANVAS_W,
    canvasHeight: DEFAULT_CANVAS_H,
    rows: 2,
    cols: 3,
    bleed: DEFAULT_BLEED,
    gutter: DEFAULT_GUTTER,
    ...opts,
  }
  const innerW = o.canvasWidth - 2 * o.bleed
  const innerH = o.canvasHeight - 2 * o.bleed
  const cellW = (innerW - (o.cols - 1) * o.gutter) / o.cols
  const cellH = (innerH - (o.rows - 1) * o.gutter) / o.rows
  const frames = []
  let counter = 1
  for (let r = 0; r < o.rows; r++) {
    for (let c = 0; c < o.cols; c++) {
      // Cells get assigned to h or v frames depending on aspect ratio.
      // For a wider-than-tall cell, treat as horizontal.
      const isH = cellW >= cellH
      const prefix = isH ? 'toolkithframe' : 'toolkitvframe'
      frames.push(frame(
        `${prefix}${counter}`,
        o.bleed + c * (cellW + o.gutter),
        o.bleed + r * (cellH + o.gutter),
        cellW,
        cellH,
      ))
      counter++
    }
  }
  return {
    id: nextId(`grid_${o.rows}x${o.cols}`),
    name: `${o.rows}×${o.cols} Grid`,
    canvasWidth: o.canvasWidth,
    canvasHeight: o.canvasHeight,
    frames,
    h: cellW >= cellH ? frames.length : 0,
    v: cellW >= cellH ? 0 : frames.length,
    generator: 'grid',
    params: o,
  }
}

/**
 * Hero layout: one large photo + N smaller supporting photos.
 * Hero position is configurable (top-left, top-right, ...).
 */
function heroLayout(opts) {
  const o = {
    canvasWidth: DEFAULT_CANVAS_W,
    canvasHeight: DEFAULT_CANVAS_H,
    supports: 4,
    heroAt: 'left',         // 'left', 'right', 'top', 'bottom'
    heroFraction: 0.62,     // hero takes this fraction of canvas
    bleed: DEFAULT_BLEED,
    gutter: DEFAULT_GUTTER,
    ...opts,
  }
  const innerW = o.canvasWidth - 2 * o.bleed
  const innerH = o.canvasHeight - 2 * o.bleed

  const frames = []
  let heroBox, supportBox, supportRows, supportCols

  if (o.heroAt === 'left' || o.heroAt === 'right') {
    const heroW = innerW * o.heroFraction - o.gutter / 2
    const supportW = innerW - heroW - o.gutter
    const heroX = o.heroAt === 'left' ? o.bleed : o.bleed + supportW + o.gutter
    const supportX = o.heroAt === 'left' ? o.bleed + heroW + o.gutter : o.bleed
    heroBox = { x: heroX, y: o.bleed, w: heroW, h: innerH }
    supportBox = { x: supportX, y: o.bleed, w: supportW, h: innerH }
    supportRows = o.supports
    supportCols = 1
  } else {
    const heroH = innerH * o.heroFraction - o.gutter / 2
    const supportH = innerH - heroH - o.gutter
    const heroY = o.heroAt === 'top' ? o.bleed : o.bleed + supportH + o.gutter
    const supportY = o.heroAt === 'top' ? o.bleed + heroH + o.gutter : o.bleed
    heroBox = { x: o.bleed, y: heroY, w: innerW, h: heroH }
    supportBox = { x: o.bleed, y: supportY, w: innerW, h: supportH }
    supportRows = 1
    supportCols = o.supports
  }

  // Hero frame — assign h vs v by aspect.
  const heroIsH = heroBox.w >= heroBox.h
  frames.push(frame(
    `${heroIsH ? 'toolkithframe' : 'toolkitvframe'}1`,
    heroBox.x, heroBox.y, heroBox.w, heroBox.h,
  ))

  // Support frames as a row or column grid.
  const cellW = (supportBox.w - (supportCols - 1) * o.gutter) / supportCols
  const cellH = (supportBox.h - (supportRows - 1) * o.gutter) / supportRows
  let counter = 2
  for (let r = 0; r < supportRows; r++) {
    for (let c = 0; c < supportCols; c++) {
      const isH = cellW >= cellH
      frames.push(frame(
        `${isH ? 'toolkithframe' : 'toolkitvframe'}${counter}`,
        supportBox.x + c * (cellW + o.gutter),
        supportBox.y + r * (cellH + o.gutter),
        cellW, cellH,
      ))
      counter++
    }
  }

  // Compute h/v counts for the existing template-filter logic.
  let hCount = 0, vCount = 0
  for (const f of frames) {
    if (f.name.startsWith('toolkithframe')) hCount++
    else vCount++
  }

  return {
    id: nextId(`hero_${o.heroAt}_${o.supports}`),
    name: `Hero (${o.heroAt}) + ${o.supports}`,
    canvasWidth: o.canvasWidth,
    canvasHeight: o.canvasHeight,
    frames,
    h: hCount,
    v: vCount,
    generator: 'hero',
    params: o,
  }
}

/**
 * Strip layout: N equal-width horizontal photos in a single row, full bleed.
 * Common for "the day in 5 frames" wedding pages.
 */
function stripLayout(opts) {
  const o = {
    canvasWidth: DEFAULT_CANVAS_W,
    canvasHeight: DEFAULT_CANVAS_H,
    count: 3,
    bleed: DEFAULT_BLEED,
    gutter: DEFAULT_GUTTER,
    ...opts,
  }
  const innerW = o.canvasWidth - 2 * o.bleed
  const innerH = o.canvasHeight - 2 * o.bleed
  const cellW = (innerW - (o.count - 1) * o.gutter) / o.count
  const frames = []
  for (let i = 0; i < o.count; i++) {
    frames.push(frame(
      `toolkithframe${i + 1}`,
      o.bleed + i * (cellW + o.gutter),
      o.bleed,
      cellW,
      innerH,
    ))
  }
  return {
    id: nextId(`strip_${o.count}`),
    name: `Strip · ${o.count} horizontals`,
    canvasWidth: o.canvasWidth,
    canvasHeight: o.canvasHeight,
    frames,
    h: o.count,
    v: 0,
    generator: 'strip',
    params: o,
  }
}

/**
 * Two-up layout: pair of vertical photos centered with breathing room.
 */
function pairLayout(opts) {
  const o = {
    canvasWidth: DEFAULT_CANVAS_W,
    canvasHeight: DEFAULT_CANVAS_H,
    bleed: DEFAULT_BLEED,
    gutter: 120,
    ...opts,
  }
  const innerW = o.canvasWidth - 2 * o.bleed
  const innerH = o.canvasHeight - 2 * o.bleed
  const cellW = (innerW - o.gutter) / 2
  const frames = [
    frame('toolkitvframe1', o.bleed, o.bleed + innerH * 0.05, cellW, innerH * 0.9),
    frame('toolkitvframe2', o.bleed + cellW + o.gutter, o.bleed + innerH * 0.05, cellW, innerH * 0.9),
  ]
  return {
    id: nextId('pair'),
    name: 'Pair · 2 verticals',
    canvasWidth: o.canvasWidth,
    canvasHeight: o.canvasHeight,
    frames,
    h: 0,
    v: 2,
    generator: 'pair',
    params: o,
  }
}

// ─── catalog ─────────────────────────────────────────────────────────────────
// A handful of preset templates that will appear in the template grid the
// moment the user enables generative templates. Tuned to cover the most
// common wedding-album page patterns; every preset can be regenerated with
// new parameters via the regen() helper below.

function defaultCatalog() {
  _idCounter = 0
  return [
    // Strip layouts: 1 / 2 / 3 / 4 / 5 horizontals
    stripLayout({ count: 1 }),
    stripLayout({ count: 2 }),
    stripLayout({ count: 3 }),
    stripLayout({ count: 4 }),
    stripLayout({ count: 5 }),

    // Pairs and trios of verticals
    pairLayout({}),

    // Grid layouts — 2×2, 2×3, 3×3
    gridLayout({ rows: 2, cols: 2 }),
    gridLayout({ rows: 2, cols: 3 }),
    gridLayout({ rows: 3, cols: 3 }),

    // Hero layouts
    heroLayout({ heroAt: 'left',  supports: 3 }),
    heroLayout({ heroAt: 'right', supports: 3 }),
    heroLayout({ heroAt: 'left',  supports: 4 }),
    heroLayout({ heroAt: 'top',   supports: 4 }),
    heroLayout({ heroAt: 'bottom', supports: 4 }),
  ]
}

/**
 * Re-create a generative template from its serialized params. Used when the
 * project is re-loaded — generative templates are persisted as
 * { generator, params } pairs because the frame coordinates are reproducible
 * from those alone.
 */
function regen(spec) {
  switch (spec.generator) {
    case 'grid':  return gridLayout(spec.params)
    case 'hero':  return heroLayout(spec.params)
    case 'strip': return stripLayout(spec.params)
    case 'pair':  return pairLayout(spec.params)
    default:      return null
  }
}

module.exports = {
  gridLayout,
  heroLayout,
  stripLayout,
  pairLayout,
  defaultCatalog,
  regen,
  DEFAULT_CANVAS_W,
  DEFAULT_CANVAS_H,
}
