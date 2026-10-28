// @ts-check
// editor_geometry.js — pure layer geometry: which corner moves which edge,
// where a snap lands, which layer a click means. It began as the Electron
// editor's arithmetic, pulled out so it could be tested directly; today the
// proof renderer (proof_renderer.js) uses it, so a moved or scaled layer
// renders exactly where it was placed.
//
// It replaced duplicates: `layerBox` once existed both in the Electron editor
// and in proof_renderer.js, and that kind of split had already caused a bug.
//
// Everything here is a plain function of its arguments: no DOM, no state.
// Coordinates are unitless, so the same helpers serve normalized overlay
// space (0..1) and canvas-pixel template-layer space.

;(function (/** @type {any} */ root) {
    'use strict'

    /**
     * @typedef {{ x: number, y: number, w: number, h: number }} Box
     */

    const numOr = (/** @type {any} */ v, /** @type {number} */ dflt) =>
        (typeof v === 'number' && isFinite(v) ? v : dflt)

    /**
     * Where a template layer actually sits once its edits are applied.
     *
     * The editor canvas, the hit-test, the right-hand panel and the proof
     * renderer must all agree on this or a moved layer renders somewhere other
     * than where it was dragged.
     *
     * @param {{ x: number, y: number, w: number, h: number }} node
     * @param {{ dx?: number, dy?: number, sx?: number, sy?: number }} [edit]
     * @returns {Box}
     */
    function layerBox(node, edit) {
        const e = edit || {}
        return {
            x: numOr(node.x, 0) + numOr(e.dx, 0),
            y: numOr(node.y, 0) + numOr(e.dy, 0),
            w: numOr(node.w, 0) * numOr(e.sx, 1),
            h: numOr(node.h, 0) * numOr(e.sy, 1),
        }
    }

    /**
     * Resize a box by dragging one corner.
     *
     * The opposite corner stays put, which is what makes dragging the north or
     * west handles move the origin as well as the size — the part that is easy
     * to get subtly wrong and hard to notice.
     *
     * @param {Box} orig            box as it was when the drag began
     * @param {string} handle       'nw' | 'ne' | 'sw' | 'se'
     * @param {number} dx           pointer delta, same units as the box
     * @param {number} dy
     * @param {{ keepAspect?: boolean, min?: number }} [opts]
     * @returns {Box}
     */
    function resizeBox(orig, handle, dx, dy, opts) {
        const o = opts || {}
        const min = numOr(o.min, 0.01)
        const h = String(handle || '')
        let x = orig.x, y = orig.y, w = orig.w, hh = orig.h

        if (h.includes('e')) w = Math.max(min, orig.w + dx)
        if (h.includes('s')) hh = Math.max(min, orig.h + dy)
        // Dragging a west/north handle pins the far edge: the box grows
        // leftward/upward, so the origin moves by however much the size did.
        if (h.includes('w')) { w = Math.max(min, orig.w - dx); x = orig.x + (orig.w - w) }
        if (h.includes('n')) { hh = Math.max(min, orig.h - dy); y = orig.y + (orig.h - hh) }

        if (o.keepAspect && orig.w > 0) {
            hh = w * (orig.h / orig.w)
            // Re-pin the bottom edge, or a shift-drag from the north creeps.
            if (h.includes('n')) y = orig.y + (orig.h - hh)
        }
        return { x, y, w, h: hh }
    }

    /**
     * The smallest box containing every input box.
     * @param {Box[]} boxes
     * @returns {Box|null}
     */
    function boundingBox(boxes) {
        if (!boxes || !boxes.length) return null
        const x = Math.min(...boxes.map((b) => b.x))
        const y = Math.min(...boxes.map((b) => b.y))
        const r = Math.max(...boxes.map((b) => b.x + b.w))
        const b2 = Math.max(...boxes.map((b) => b.y + b.h))
        return { x, y, w: r - x, h: b2 - y }
    }

    /**
     * Align boxes to an edge.
     *
     * ONE box aligns to the page; SEVERAL align to their own bounding box —
     * which is what every design tool does, and what makes single-selection
     * centring useful at all.
     *
     * @param {Box[]} boxes
     * @param {'left'|'hcenter'|'right'|'top'|'vcenter'|'bottom'} edge
     * @param {Box} [page]  the reference for a single box; defaults to 0..1
     * @returns {Box[]} new boxes, input order preserved
     */
    function alignBoxes(boxes, edge, page) {
        if (!boxes || !boxes.length) return []
        const ref = boxes.length > 1
            ? /** @type {Box} */ (boundingBox(boxes))
            : (page || { x: 0, y: 0, w: 1, h: 1 })
        return boxes.map((b) => {
            const out = { ...b }
            switch (edge) {
                case 'left': out.x = ref.x; break
                case 'hcenter': out.x = ref.x + ref.w / 2 - b.w / 2; break
                case 'right': out.x = ref.x + ref.w - b.w; break
                case 'top': out.y = ref.y; break
                case 'vcenter': out.y = ref.y + ref.h / 2 - b.h / 2; break
                case 'bottom': out.y = ref.y + ref.h - b.h; break
                default: break
            }
            return out
        })
    }

    /**
     * Space boxes evenly between the outermost two.
     *
     * Equalises the GAPS, not the centres: with boxes of different sizes,
     * even centres still look uneven, and evenly spaced is what the user
     * means. The first and last boxes never move.
     *
     * Fewer than three boxes has no meaningful answer, so the input is
     * returned untouched and the caller can say why.
     *
     * @param {Box[]} boxes
     * @param {'h'|'v'} axis
     * @returns {Box[]} new boxes, INPUT order preserved
     */
    function distributeBoxes(boxes, axis) {
        if (!boxes || boxes.length < 3) return (boxes || []).map((b) => ({ ...b }))
        const k = axis === 'v' ? 'y' : 'x'
        const size = axis === 'v' ? 'h' : 'w'

        const order = boxes.map((b, i) => ({ b, i })).sort((p, q) => p.b[k] - q.b[k])
        const first = order[0].b
        const last = order[order.length - 1].b
        const span = (last[k] + last[size]) - first[k]
        const used = order.reduce((sum, e) => sum + e.b[size], 0)
        const gap = (span - used) / (order.length - 1)

        const out = boxes.map((b) => ({ ...b }))
        let cursor = first[k]
        for (const e of order) {
            out[e.i][k] = cursor
            cursor += e.b[size] + gap
        }
        return out
    }

    /**
     * Snap a moving box's edges and centre to nearby guide lines.
     *
     * Each axis is considered independently, and the CLOSEST candidate within
     * tolerance wins, so a box can snap horizontally without being dragged
     * vertically as a side effect.
     *
     * @param {Box} box    the box at its unsnapped position
     * @param {number} x   proposed left edge
     * @param {number} y   proposed top edge
     * @param {{ xs?: number[], ys?: number[] }} targets guide lines
     * @param {number} [tol] max distance that still snaps
     * @returns {{ x: number, y: number, guideX: number|null, guideY: number|null }}
     */
    function snapPosition(box, x, y, targets, tol) {
        const t = numOr(tol, 0.006)
        const xs = (targets && targets.xs) || []
        const ys = (targets && targets.ys) || []

        // Each candidate is [where the edge would land, its offset from x].
        const best = (/** @type {number[][]} */ edges, /** @type {number[]} */ lines) => {
            let d = t, at = null, guide = null
            for (const [pos, offset] of edges) {
                for (const line of lines) {
                    const gap = Math.abs(pos - line)
                    if (gap < d) { d = gap; at = line - offset; guide = line }
                }
            }
            return { at, guide }
        }

        const hx = best([[x, 0], [x + box.w / 2, box.w / 2], [x + box.w, box.w]], xs)
        const hy = best([[y, 0], [y + box.h / 2, box.h / 2], [y + box.h, box.h]], ys)
        return {
            x: hx.at != null ? hx.at : x,
            y: hy.at != null ? hy.at : y,
            guideX: hx.guide,
            guideY: hy.guide,
        }
    }

    /**
     * Choose which of several overlapping layers a click meant.
     *
     * Bounds-based rather than per-pixel: the layer images are file:// URLs,
     * and drawing them to a canvas to sample alpha taints it in Electron, so
     * getImageData throws. Two rules make bounds behave — prefer the SMALLEST
     * box containing the point (a specific piece of art over the sheet it sits
     * on), and let a repeat click at the same spot step to the next candidate,
     * so a covered layer stays reachable.
     *
     * @template {{ id: string } & Box} T
     * @param {T[]} candidates  every selectable layer, any order
     * @param {number} px @param {number} py
     * @param {{ x: number, y: number, index: number }|null} [prev] previous pick
     * @param {number} [tol] how close counts as "the same spot"
     * @returns {{ hit: T|null, index: number, hits: T[] }}
     */
    function pickAtPoint(candidates, px, py, prev, tol) {
        const t = numOr(tol, 0)
        const hits = (candidates || [])
            .filter((c) => px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h)
            .sort((a, b) => (a.w * a.h) - (b.w * b.h))
        if (!hits.length) return { hit: null, index: 0, hits }

        const same = !!prev && Math.abs(prev.x - px) <= t && Math.abs(prev.y - py) <= t
        const index = same ? (prev.index + 1) % hits.length : 0
        return { hit: hits[index], index, hits }
    }

    const api = {
        layerBox,
        resizeBox,
        boundingBox,
        alignBoxes,
        distributeBoxes,
        snapPosition,
        pickAtPoint,
    }

    // Required by the proof renderer and the test suite; the guard below also
    // allows loading as a plain <script>, as the Electron editor once did.
    if (typeof module !== 'undefined' && module.exports) module.exports = api
    if (root) root.EditorGeometry = api
})(typeof window !== 'undefined' ? window : null)
