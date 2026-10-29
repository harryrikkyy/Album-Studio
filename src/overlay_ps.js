// @ts-check
// overlay_ps.js — page overlays → native Photoshop text layers.
//
// The libvips path composites overlays as a flat raster (overlay_render.js).
// The Photoshop path instead rebuilds TEXT layers natively so the delivered
// PSD stays editable: the client can retype a name in Photoshop without
// coming back to the app.
//
// The usual problem with native text is that Photoshop re-flows it against its
// own font metrics, so the delivered page silently disagrees with the preview
// the user approved. We sidestep that: `resolveTextLayout` has ALREADY wrapped
// the copy, and each line is handed to Photoshop as a separate hard line in a
// POINT text layer. Photoshop is never asked to make a wrapping decision, so
// the line breaks cannot differ. What can still differ is the width of each
// line — our advance-width estimate is not the real font's — so a centred line
// may sit a pixel or two off, and a line tuned to sit flush against a photo
// edge should be eyeballed once. Shapes stay rasterized; only text is native.
//
// Font handling is the other sharp edge. Photoshop wants PostScript names
// ("HelveticaNeue-Bold"), not CSS families ("Helvetica Neue" + weight 700), and
// a name it doesn't recognise throws. The table below maps the families the
// editor offers, per weight and style, and the JSX falls back to Photoshop's
// current font rather than failing the page if a name is missing.

const { resolveTextLayout } = require('./overlay_render')

// PostScript names for the macOS system faces the editor's font list offers.
// `r` = upright, `i` = italic. Keys are CSS weights; the nearest available
// weight is used, so a family with only 400/700 still handles a 500 request.
// A family with no `i` block gets faux italic (Photoshop slants the upright
// face) rather than silently rendering upright.
/** @type {Record<string, { r: Record<number, string>, i?: Record<number, string> }>} */
const PS_FONTS = {
  'Helvetica Neue': {
    r: {
      100: 'HelveticaNeue-Thin',
      200: 'HelveticaNeue-Thin',
      300: 'HelveticaNeue-Light',
      400: 'HelveticaNeue',
      500: 'HelveticaNeue-Medium',
      700: 'HelveticaNeue-Bold',
      900: 'HelveticaNeue-Bold',
    },
    i: {
      100: 'HelveticaNeue-ThinItalic',
      300: 'HelveticaNeue-LightItalic',
      400: 'HelveticaNeue-Italic',
      500: 'HelveticaNeue-MediumItalic',
      700: 'HelveticaNeue-BoldItalic',
    },
  },
  'Avenir Next': {
    r: {
      100: 'AvenirNext-UltraLight',
      200: 'AvenirNext-UltraLight',
      300: 'AvenirNext-UltraLight',
      400: 'AvenirNext-Regular',
      500: 'AvenirNext-Medium',
      600: 'AvenirNext-DemiBold',
      700: 'AvenirNext-Bold',
      900: 'AvenirNext-Heavy',
    },
    i: {
      100: 'AvenirNext-UltraLightItalic',
      400: 'AvenirNext-Italic',
      500: 'AvenirNext-MediumItalic',
      600: 'AvenirNext-DemiBoldItalic',
      700: 'AvenirNext-BoldItalic',
      900: 'AvenirNext-HeavyItalic',
    },
  },
  Futura: {
    r: { 400: 'Futura-Medium', 500: 'Futura-Medium', 700: 'Futura-Bold', 900: 'Futura-Bold' },
    i: { 400: 'Futura-MediumItalic', 700: 'Futura-MediumItalic' },
  },
  'Gill Sans': {
    r: {
      300: 'GillSans-Light',
      400: 'GillSans',
      600: 'GillSans-SemiBold',
      700: 'GillSans-Bold',
      900: 'GillSans-UltraBold',
    },
    i: { 300: 'GillSans-LightItalic', 400: 'GillSans-Italic', 700: 'GillSans-BoldItalic' },
  },
  Optima: {
    r: { 400: 'Optima-Regular', 700: 'Optima-Bold', 900: 'Optima-ExtraBlack' },
    i: { 400: 'Optima-Italic', 700: 'Optima-BoldItalic' },
  },
  Georgia: {
    r: { 400: 'Georgia', 700: 'Georgia-Bold' },
    i: { 400: 'Georgia-Italic', 700: 'Georgia-BoldItalic' },
  },
  Baskerville: {
    r: { 400: 'Baskerville', 600: 'Baskerville-SemiBold', 700: 'Baskerville-Bold' },
    i: { 400: 'Baskerville-Italic', 700: 'Baskerville-BoldItalic' },
  },
  Didot: {
    r: { 400: 'Didot', 700: 'Didot-Bold' },
    i: { 400: 'Didot-Italic' },
  },
  Palatino: {
    r: { 400: 'Palatino-Roman', 700: 'Palatino-Bold' },
    i: { 400: 'Palatino-Italic', 700: 'Palatino-BoldItalic' },
  },
  'Times New Roman': {
    r: { 400: 'TimesNewRomanPSMT', 700: 'TimesNewRomanPS-BoldMT' },
    i: { 400: 'TimesNewRomanPS-ItalicMT', 700: 'TimesNewRomanPS-BoldItalicMT' },
  },
  'American Typewriter': {
    r: {
      300: 'AmericanTypewriter-Light',
      400: 'AmericanTypewriter',
      600: 'AmericanTypewriter-Semibold',
      700: 'AmericanTypewriter-Bold',
    },
  },
  Menlo: {
    r: { 400: 'Menlo-Regular', 700: 'Menlo-Bold' },
    i: { 400: 'Menlo-Italic', 700: 'Menlo-BoldItalic' },
  },
  'Snell Roundhand': {
    r: { 400: 'SnellRoundhand', 700: 'SnellRoundhand-Bold', 900: 'SnellRoundhand-Black' },
  },
  Zapfino: {
    r: { 400: 'Zapfino' },
  },
}

/**
 * Pick the PostScript name for a family at a requested weight/style.
 *
 * Returns the name plus whether Photoshop must fake the slant, so the JSX can
 * set fauxItalic instead of quietly rendering upright text where the preview
 * showed italics.
 *
 * @param {string} family
 * @param {number} weight
 * @param {boolean} italic
 * @returns {{ name: string|null, fauxItalic: boolean }}
 */
function resolvePsFont(family, weight, italic) {
  const entry = PS_FONTS[family]
  if (!entry) return { name: null, fauxItalic: false }

  const pickNearest = (/** @type {Record<number, string>} */ table) => {
    const keys = Object.keys(table)
      .map(Number)
      .sort((a, b) => a - b)
    if (!keys.length) return null
    let best = keys[0]
    for (const k of keys) {
      if (Math.abs(k - weight) < Math.abs(best - weight)) best = k
    }
    return table[best]
  }

  if (italic && entry.i) {
    const name = pickNearest(entry.i)
    if (name) return { name, fauxItalic: false }
  }
  // Italic requested but the family ships no italic cut — Photoshop slants
  // the upright face, matching what the browser does in the preview.
  return { name: pickNearest(entry.r), fauxItalic: italic }
}

// Round to 3dp — the same precision overlay_render emits into the SVG, so the
// numbers Photoshop places at and the numbers librsvg drew at are identical
// rather than merely close.
/** @param {number} n */
function r3(n) {
  return Math.round(n * 1000) / 1000
}

/** '#rgb' | '#rrggbb' → {r,g,b} 0..255. Null for anything else. */
function hexToRgb(/** @type {any} */ hex) {
  if (typeof hex !== 'string') return null
  let h = hex.trim()
  if (!h.startsWith('#')) return null
  h = h.slice(1)
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  const n = parseInt(h, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/**
 * Build the JSX-ready description of a page's TEXT overlays.
 *
 * Everything is in canvas pixels, already laid out — the JSX places rather
 * than computes, so the delivered PSD matches the preview.
 *
 * @param {any[]} overlays
 * @param {number} width  canvas width in px
 * @param {number} height canvas height in px
 * @returns {any[]} one entry per visible text layer (empty if none)
 */
function buildPsTextLayers(overlays, width, height) {
  if (!Array.isArray(overlays) || !overlays.length) return []
  const out = []
  for (const L of overlays) {
    if (!L || L.hidden || L.type !== 'text') continue
    const t = resolveTextLayout(L, width, height)
    if (!t) continue
    const font = resolvePsFont(t.font, t.weight, t.italic)
    const rgb = hexToRgb(t.color) || { r: 17, g: 17, b: 17 }
    out.push({
      // ExtendScript treats \r as the hard line break inside contents.
      // The lines are pre-wrapped, so Photoshop never re-flows them.
      contents: t.lines.join('\r'),
      fontName: font.name,
      fauxItalic: font.fauxItalic,
      underline: t.underline,
      sizePx: r3(t.fontSize),
      leadingPx: r3(t.lineStep),
      // Photoshop tracking is in 1/1000 em; ours is a fraction of em.
      tracking: Math.round(t.trackingEm * 1000),
      color: rgb,
      justification: t.align,
      x: r3(t.anchorX),
      y: r3(t.firstBaseline),
      opacity: Math.round(t.opacity * 100),
      rot: t.rot,
      // Rotation pivot. The SVG turns the layer about its BOX centre,
      // which is not the same point as the rendered text's own centre
      // (a top-aligned caption in a tall box, say) — the JSX needs both
      // to reproduce the placement instead of spinning about the glyphs.
      pivotX: r3(t.cx),
      pivotY: r3(t.cy),
      name: (t.lines[0] || 'Text').slice(0, 40),
    })
  }
  return out
}

/** True when the page has any non-text overlay that still needs rasterizing. */
function hasShapeOverlays(/** @type {any[]} */ overlays) {
  return Array.isArray(overlays) && overlays.some((L) => L && !L.hidden && L.type !== 'text')
}

module.exports = {
  buildPsTextLayers,
  hasShapeOverlays,
  // Exported for unit tests.
  resolvePsFont,
  hexToRgb,
  PS_FONTS,
}
