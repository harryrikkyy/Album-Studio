// @ts-check
// overlay_render.js — page overlay layers (text, shapes) → SVG.
//
// ONE generator, TWO consumers:
//   • the Spread Editor injects this SVG straight into its stage (preview)
//   • proof_renderer composites the same SVG over the page (proof + export)
//
// Both call the same function, so the preview IS the export — WYSIWYG is
// structural here rather than two code paths kept in sync by hand.
//
// Geometry is normalized: every position, size and stroke width is a fraction
// of the canvas (x/w of width, y/h and font size of height). A layer therefore
// renders identically at a 1500px proof and a 7000px final composite, which is
// the whole reason the editor can trust its own preview.
//
// Text wrapping is computed HERE rather than left to the renderer, because SVG
// has no auto-wrap and librsvg/Chrome would otherwise disagree on line breaks.
// Widths come from a deterministic metrics estimate (see estimateAdvance) so
// both sides break lines at exactly the same words.

// Everything below is wrapped in an IIFE: this file is loaded as a PLAIN
// <script> in the Page Editor window, where top-level `const`/`function`
// declarations share one script scope with editor_renderer.js. Without the
// wrapper, generic names here (`esc`, `num`, `api`) collide with that file and
// the whole window dies on a redeclaration SyntaxError.
;(function (/** @type {any} */ root) {
    'use strict'

    /**
     * @typedef {object} OverlayLayer
     * @property {string} id
     * @property {'text'|'rect'|'ellipse'|'line'} type
     * @property {number} x      left edge, fraction of canvas width (0..1)
     * @property {number} y      top edge, fraction of canvas height (0..1)
     * @property {number} w      width, fraction of canvas width
     * @property {number} h      height, fraction of canvas height
     * @property {number} [rot]  rotation in degrees about the layer's center
     * @property {number} [opacity] 0..1
     * @property {boolean} [hidden]
     * @property {boolean} [locked]
     * @property {string} [text]
     * @property {string} [font]
     * @property {number} [size]        font size, fraction of canvas height
     * @property {number} [weight]      100..900
     * @property {boolean} [italic]
     * @property {boolean} [underline]
     * @property {string} [color]
     * @property {'left'|'center'|'right'} [align]
     * @property {'top'|'middle'|'bottom'} [valign]
     * @property {number} [lineHeight]  multiple of font size
     * @property {number} [tracking]    letter spacing, fraction of font size
     * @property {string} [fill]
     * @property {string} [stroke]
     * @property {number} [strokeWidth] fraction of canvas height
     * @property {number} [radius]      corner radius, fraction of canvas height
     * @property {number} [shadow]      drop shadow strength 0..1
     */

    // ── XML escaping ────────────────────────────────────────────────
    // Overlay text is user content that lands in an SVG document, so it must be
    // escaped or a stray `<` silently corrupts the whole page render.
    /** @type {Record<string, string>} */
    const XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
    /** @param {string} s */
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => XML_ESC[c])
    }

    // Colors reach the SVG as attribute values. Anything that isn't a plain
    // hex/rgb/named colour is dropped rather than interpolated, so a crafted
    // value can't close the attribute and inject markup.
    const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|[a-zA-Z]{3,20})$/
    /**
     * @param {string|undefined} c
     * @param {string} fallback
     */
    function safeColor(c, fallback) {
        if (typeof c === 'string' && COLOR_RE.test(c.trim())) return c.trim()
        return fallback
    }

    // Font families are interpolated into a style attribute — same risk, same fix.
    const FONT_RE = /^[a-zA-Z0-9 _.-]{1,64}$/
    /** @param {string|undefined} f */
    function safeFont(f) {
        if (typeof f === 'string' && FONT_RE.test(f.trim())) return f.trim()
        return 'Helvetica Neue'
    }

    /** @param {number|undefined} n @param {number} lo @param {number} hi @param {number} dflt */
    function num(n, lo, hi, dflt) {
        const v = typeof n === 'number' && isFinite(n) ? n : dflt
        return Math.max(lo, Math.min(hi, v))
    }

    // Round to 3dp — keeps the SVG compact and, more importantly, makes the output
    // byte-identical for identical input so render-cache hashing stays stable.
    /** @param {number} n */
    function r3(n) {
        return Math.round(n * 1000) / 1000
    }

    // ── Text metrics ────────────────────────────────────────────────
    // A real font metrics table would mean shipping and parsing font files in the
    // main process. Instead: per-character advance ratios (multiples of font size)
    // grouped by width class, averaged from the macOS system faces this app
    // offers. Deterministic, so the editor and the exporter wrap identically —
    // which matters far more here than absolute accuracy, because the two must
    // agree with each other, not with a spec.
    const WIDE = new Set(['W', 'M', '@', '%'])
    const NARROW = new Set(['i', 'l', 'j', 'I', '.', ',', ':', ';', "'", '|', '!', '`'])
    const MEDIUM_NARROW = new Set(['f', 't', 'r', '(', ')', '[', ']', '{', '}', '-', ' '])

    /**
     * Approximate advance width of one character, as a multiple of font size.
     * @param {string} ch
     * @param {number} weight
     */
    function estimateAdvance(ch, weight) {
        // Heavier weights are marginally wider; ~4% from Regular to Black.
        const wf = 1 + Math.max(0, (weight - 400)) * 0.00008
        let base
        if (WIDE.has(ch)) base = 0.86
        else if (NARROW.has(ch)) base = 0.26
        else if (MEDIUM_NARROW.has(ch)) base = 0.34
        else if (ch >= 'A' && ch <= 'Z') base = 0.64
        else if (ch >= '0' && ch <= '9') base = 0.55
        else base = 0.52
        return base * wf
    }

    /**
     * Estimated width of a string at a given font size, including tracking.
     * @param {string} text
     * @param {number} fontSize   in px
     * @param {number} weight
     * @param {number} tracking   fraction of font size, added after every char
     */
    function estimateTextWidth(text, fontSize, weight, tracking) {
        let total = 0
        for (const ch of String(text)) total += estimateAdvance(ch, weight) + tracking
        return total * fontSize
    }

    /**
     * Greedy word wrap to a pixel width. Explicit newlines always break; words
     * longer than the box are hard-split so they can't overflow silently.
     * @param {string} text
     * @param {number} maxWidth  px; <= 0 disables wrapping
     * @param {number} fontSize
     * @param {number} weight
     * @param {number} tracking
     * @returns {string[]}
     */
    function wrapText(text, maxWidth, fontSize, weight, tracking) {
        /** @type {string[]} */
        const out = []
        const paragraphs = String(text == null ? '' : text).split('\n')
        for (const para of paragraphs) {
            if (maxWidth <= 0) { out.push(para); continue }
            const words = para.split(' ')
            let line = ''
            for (const word of words) {
                const candidate = line ? line + ' ' + word : word
                if (estimateTextWidth(candidate, fontSize, weight, tracking) <= maxWidth || !line) {
                    // A single word wider than the box still has to go somewhere:
                    // place it, then hard-split the overflow below.
                    line = candidate
                } else {
                    out.push(line)
                    line = word
                }
            }
            // Hard-split any line that is still too wide (one very long token).
            let cur = line
            while (cur && estimateTextWidth(cur, fontSize, weight, tracking) > maxWidth && cur.length > 1) {
                let cut = cur.length
                while (cut > 1 && estimateTextWidth(cur.slice(0, cut), fontSize, weight, tracking) > maxWidth) cut--
                out.push(cur.slice(0, cut))
                cur = cur.slice(cut)
            }
            out.push(cur)
        }
        return out
    }

    // ── Layer → SVG ─────────────────────────────────────────────────

    /**
     * Render one text layer.
     * @param {OverlayLayer} L
     * @param {number} W canvas width in px
     * @param {number} H canvas height in px
     */
    function textSvg(L, W, H) {
        const raw = L.text == null ? '' : String(L.text)
        if (!raw.trim()) return ''

        const fontSize = num(L.size, 0.005, 0.5, 0.05) * H
        const weight = num(L.weight, 100, 900, 400)
        const tracking = num(L.tracking, -0.2, 1, 0)
        const lineHeight = num(L.lineHeight, 0.5, 4, 1.25)
        const boxW = num(L.w, 0, 2, 0.4) * W
        const boxH = num(L.h, 0, 2, 0.1) * H
        const boxX = num(L.x, -1, 2, 0.1) * W
        const boxY = num(L.y, -1, 2, 0.1) * H
        const align = L.align === 'center' ? 'center' : L.align === 'right' ? 'right' : 'left'
        const valign = L.valign === 'middle' ? 'middle' : L.valign === 'bottom' ? 'bottom' : 'top'

        const lines = wrapText(raw, boxW, fontSize, weight, tracking)
        const lineStep = fontSize * lineHeight
        const blockH = lines.length * lineStep

        // Vertical placement. SVG `dominant-baseline` is inconsistent between
        // librsvg and Chrome, so baselines are computed explicitly from an ascent
        // ratio instead — that keeps the editor and the export aligned.
        const ASCENT = 0.78
        let firstBaseline
        if (valign === 'middle') firstBaseline = boxY + (boxH - blockH) / 2 + fontSize * ASCENT
        else if (valign === 'bottom') firstBaseline = boxY + boxH - blockH + fontSize * ASCENT
        else firstBaseline = boxY + fontSize * ASCENT

        const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
        const tx = align === 'center' ? boxX + boxW / 2 : align === 'right' ? boxX + boxW : boxX

        const color = safeColor(L.color, '#111111')
        const font = safeFont(L.font)
        const style = [
            `font-family:'${font}'`,
            `font-size:${r3(fontSize)}px`,
            `font-weight:${weight}`,
            L.italic ? 'font-style:italic' : '',
            tracking ? `letter-spacing:${r3(tracking * fontSize)}px` : '',
            L.underline ? 'text-decoration:underline' : '',
        ].filter(Boolean).join(';')

        const tspans = lines.map((ln, i) =>
            `<tspan x="${r3(tx)}" y="${r3(firstBaseline + i * lineStep)}">${esc(ln) || ' '}</tspan>`
        ).join('')

        let out = `<text text-anchor="${anchor}" style="${style}" fill="${color}"`
        if (L.stroke && num(L.strokeWidth, 0, 1, 0) > 0) {
            out += ` stroke="${safeColor(L.stroke, 'none')}" stroke-width="${r3(num(L.strokeWidth, 0, 1, 0) * H)}"`
            out += ' paint-order="stroke fill" stroke-linejoin="round"'
        }
        out += `>${tspans}</text>`
        return out
    }

    /**
     * Render one shape layer.
     * @param {OverlayLayer} L
     * @param {number} W
     * @param {number} H
     */
    function shapeSvg(L, W, H) {
        const x = num(L.x, -1, 2, 0.1) * W
        const y = num(L.y, -1, 2, 0.1) * H
        const w = num(L.w, 0, 2, 0.2) * W
        const h = num(L.h, 0, 2, 0.2) * H
        const fill = L.fill === 'none' ? 'none' : safeColor(L.fill, '#000000')
        const strokeW = num(L.strokeWidth, 0, 1, 0) * H
        const stroke = strokeW > 0 ? safeColor(L.stroke, '#000000') : 'none'
        const strokeAttr = strokeW > 0 ? ` stroke="${stroke}" stroke-width="${r3(strokeW)}"` : ''

        if (L.type === 'ellipse') {
            return `<ellipse cx="${r3(x + w / 2)}" cy="${r3(y + h / 2)}" rx="${r3(w / 2)}" ry="${r3(h / 2)}" fill="${fill}"${strokeAttr}/>`
        }
        if (L.type === 'line') {
            // A line uses the box diagonal's midline: left-center to right-center,
            // so rotation (applied by the caller) gives any angle.
            const cy = y + h / 2
            return `<line x1="${r3(x)}" y1="${r3(cy)}" x2="${r3(x + w)}" y2="${r3(cy)}" stroke="${strokeW > 0 ? stroke : safeColor(L.fill, '#000000')}" stroke-width="${r3(strokeW > 0 ? strokeW : 0.004 * H)}" stroke-linecap="round"/>`
        }
        const rad = num(L.radius, 0, 1, 0) * H
        const radAttr = rad > 0 ? ` rx="${r3(rad)}" ry="${r3(rad)}"` : ''
        return `<rect x="${r3(x)}" y="${r3(y)}" width="${r3(w)}" height="${r3(h)}"${radAttr} fill="${fill}"${strokeAttr}/>`
    }

    /**
     * Wrap a layer's markup in the transforms common to every type: rotation
     * about its own center, and opacity.
     * @param {OverlayLayer} L
     * @param {string} inner
     * @param {number} W
     * @param {number} H
     */
    function wrapLayer(L, inner, W, H) {
        if (!inner) return ''
        const attrs = []
        const rot = num(L.rot, -360, 360, 0)
        if (rot) {
            const cx = (num(L.x, -1, 2, 0) + num(L.w, 0, 2, 0) / 2) * W
            const cy = (num(L.y, -1, 2, 0) + num(L.h, 0, 2, 0) / 2) * H
            attrs.push(`transform="rotate(${r3(rot)} ${r3(cx)} ${r3(cy)})"`)
        }
        const op = num(L.opacity, 0, 1, 1)
        if (op !== 1) attrs.push(`opacity="${r3(op)}"`)
        if (num(L.shadow, 0, 1, 0) > 0) attrs.push('filter="url(#ovShadow)"')
        if (!attrs.length) return inner
        return `<g ${attrs.join(' ')}>${inner}</g>`
    }

    /**
     * Build the full overlay SVG for one page.
     *
     * Returns '' when there is nothing to draw, so callers can skip compositing
     * entirely rather than paying for an empty transparent layer on every render.
     *
     * @param {OverlayLayer[]} layers
     * @param {number} width   target raster width in px
     * @param {number} height  target raster height in px
     * @returns {string} SVG document, or '' if no visible layers
     */
    function buildOverlaySvg(layers, width, height) {
        if (!Array.isArray(layers) || !layers.length) return ''
        const W = Math.max(1, Math.round(width))
        const H = Math.max(1, Math.round(height))

        const visible = layers.filter((L) => L && !L.hidden)
        if (!visible.length) return ''

        let body = ''
        let needsShadow = false
        for (const L of visible) {
            const inner = L.type === 'text' ? textSvg(L, W, H) : shapeSvg(L, W, H)
            if (!inner) continue
            if (num(L.shadow, 0, 1, 0) > 0) needsShadow = true
            body += wrapLayer(L, inner, W, H)
        }
        if (!body) return ''

        // One shared shadow filter — per-layer filters would bloat the document
        // and slow librsvg down for no visual gain.
        const defs = needsShadow
            ? `<defs><filter id="ovShadow" x="-20%" y="-20%" width="140%" height="140%">`
            + `<feDropShadow dx="0" dy="${r3(H * 0.004)}" stdDeviation="${r3(H * 0.004)}" flood-opacity="0.45"/>`
            + `</filter></defs>`
            : ''

        return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}${body}</svg>`
    }

    /**
     * Stable hash input for the render cache: the overlay state that affects
     * pixels. Hidden layers and key order must not change the result, or every
     * render would miss the cache.
     * @param {OverlayLayer[]} layers
     */
    function overlayCacheKey(layers) {
        if (!Array.isArray(layers) || !layers.length) return 0
        const visible = layers.filter((L) => L && !L.hidden)
        if (!visible.length) return 0
        // Render at a fixed nominal size: the SVG is resolution-independent, so
        // this captures every pixel-affecting field without depending on the
        // output size (which is hashed separately by the caller).
        return buildOverlaySvg(visible, 1000, 1000)
    }

    const api = {
        buildOverlaySvg,
        overlayCacheKey,
        // Exported for unit tests + the editor's own hit-testing.
        wrapText,
        estimateTextWidth,
        esc,
        safeColor,
        safeFont,
    }

    // Two load paths, one implementation — this is what keeps preview and
    // export honest: the main process requires it, and the Page Editor window
    // (context-isolated, no `require`) pulls the same file in as a <script>.
    if (typeof module !== 'undefined' && module.exports) module.exports = api
    if (root) root.OverlayRender = api
})(typeof window !== 'undefined' ? window : null)
