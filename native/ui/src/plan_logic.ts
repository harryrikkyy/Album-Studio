// plan_logic.ts — the pure parts of editing a plan (tested in test/plan_logic.test.ts).

import type { Adjust, Album, Orient, Photo, Placement, Spread } from './types'

export interface Template {
  id: string
  name: string
  file: string
  preview: string | null
  collection: string
  h: number
  v: number
  /** Page size in pixels, from the PSD; null when it couldn't be read. */
  width?: number | null
  height?: number | null
}

/** Width ÷ height to two places (7200×2400 and 10800×3600 are the same shape); null if unknown. */
export function shapeOf(t: { width?: number | null; height?: number | null } | null | undefined): number | null {
  return t && t.width && t.height ? Math.round((t.width / t.height) * 100) / 100 : null
}

type Sized = { width?: number | null; height?: number | null }

function shapeCounts(list: Iterable<Sized>): Map<number, number> {
  const counts = new Map<number, number>()
  for (const t of list) {
    const s = shapeOf(t)
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  return counts
}

/** The page shape most of these templates have (ties go to the one `tiebreak` has most); null if none. */
export function commonShape(list: Iterable<Sized>, tiebreak: Iterable<Sized> = []): number | null {
  const counts = shapeCounts(list)
  const second = shapeCounts(tiebreak)
  let best: number | null = null
  for (const [s, n] of counts) {
    const b = best === null ? -1 : counts.get(best)!
    if (n > b || (n === b && (second.get(s) ?? 0) > (second.get(best!) ?? 0))) best = s
  }
  return best
}

/** The album's page shape: most of its spreads' templates have it, else most of its catalogue. */
export function albumShape(a: Album, all: Template[]): number | null {
  const byId = new Map(all.map((t) => [t.id, t]))
  const used = a.spreads
    .map((s) => (s.template ? byId.get(s.template.id) : undefined))
    .filter((t): t is Template => !!t)
  return commonShape(used, all) ?? commonShape(all)
}

/** A template's page size in pixels, as words: "7200 × 2400". */
export function sizeWords(t: { width?: number | null; height?: number | null }): string {
  return t.width && t.height ? `${t.width} × ${t.height}` : 'size unknown'
}

/** Landscape and portrait counts of a spread's photos (photos missing from disk don't count). */
export function slotsOf(a: Album, s: Spread): { h: number; v: number } {
  let h = 0
  let v = 0
  for (const id of s.photoIds) {
    const p = a.photos[id]
    if (!p) continue
    if (p.orient === 'v') v++
    else h++
  }
  return { h, v }
}

/** Landscape and portrait counts of any photos (a selection in the pool). */
export function selectionSlots(a: Album, ids: Iterable<string>): { h: number; v: number } {
  let h = 0
  let v = 0
  for (const id of ids) {
    const p = a.photos[id]
    if (!p) continue
    if (p.orient === 'v') v++
    else h++
  }
  return { h, v }
}

/** The user's turn as one of 0, 90, 180, 270. */
export function turnOf(p: Pick<Photo, 'rotation'>): 0 | 90 | 180 | 270 {
  const t = (((Math.round((p.rotation || 0) / 90) * 90) % 360) + 360) % 360
  return t as 0 | 90 | 180 | 270
}

/** Width ÷ height as the photo is seen, after its turn; orientation decides when the size isn't known. */
export function seenAspect(p: Pick<Photo, 'width' | 'height' | 'orient' | 'rotation'>): number {
  if (!p.width || !p.height) return p.orient === 'v' ? 2 / 3 : 3 / 2
  const quarter = turnOf(p) % 180 === 90
  return quarter ? p.height / p.width : p.width / p.height
}

/** Does the spread's template have a frame for each of its photos, and no more? */
export function templateFits(a: Album, s: Spread): boolean | null {
  if (!s.template || s.template.h == null || s.template.v == null) return null
  const { h, v } = slotsOf(a, s)
  return s.template.h === h && s.template.v === v
}

/**
 * Spreads whose picture an edit changed: different photos, template or photo turns than the
 * spread that was at the same place before. Their proofs are redrawn, so they show as updating.
 */
export function changedSpreads(prev: Album | null, next: Album): number[] {
  const out: number[] = []
  const turns = (a: Album, s: Spread) =>
    s.photoIds
      .map((id) => {
        const p = a.photos[id]
        return `${p?.rotation ?? 0}:${JSON.stringify(p?.placement ?? null)}:${JSON.stringify(p?.adjust ?? null)}`
      })
      .join('|')
  for (const s of next.spreads) {
    const old = prev?.spreads[s.n - 1]
    if (
      !old ||
      old.template?.id !== s.template?.id ||
      old.photoIds.join('|') !== s.photoIds.join('|') ||
      turns(prev!, old) !== turns(next, s)
    )
      out.push(s.n)
  }
  return out
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Where a photo's picture goes in its frame, in the frame's pixels: cover the frame, zoom by
 * `scale`, pan by `ox`/`oy` across the overflow — the same as the previews and print sheets.
 * `photoW`/`photoH` are the photo as seen (after its turn).
 */
export function placementLayout(
  frameW: number,
  frameH: number,
  photoW: number,
  photoH: number,
  pl: Placement | null | undefined,
) {
  const s = Math.max(frameW / photoW, frameH / photoH) * Math.max(1, pl?.scale ?? 1)
  const width = photoW * s
  const height = photoH * s
  const overflowX = Math.max(0, width - frameW)
  const overflowY = Math.max(0, height - frameH)
  const ox = clamp(pl?.ox ?? 0, -1, 1)
  const oy = clamp(pl?.oy ?? 0, -1, 1)
  return { left: (-overflowX * (1 + ox)) / 2, top: (-overflowY * (1 + oy)) / 2, width, height, overflowX, overflowY }
}

/** The placement after dragging the picture by (dx, dy) frame pixels: it follows the pointer. */
export function panBy(
  start: Placement,
  dx: number,
  dy: number,
  overflowX: number,
  overflowY: number,
): Required<Placement> {
  return {
    scale: start.scale ?? 1,
    ox: overflowX > 0.5 ? clamp((start.ox ?? 0) - (2 * dx) / overflowX, -1, 1) : 0,
    oy: overflowY > 0.5 ? clamp((start.oy ?? 0) - (2 * dy) / overflowY, -1, 1) : 0,
  }
}

type Affine = number[][] // 4 rows × 5 columns: R, G, B, A, offset

function compose(outer: Affine, inner: Affine): Affine {
  // (outer ∘ inner) as 5×5 matrices with an implicit last row [0 0 0 0 1].
  return outer.map((row) =>
    [0, 1, 2, 3, 4].map((c) => {
      let v = 0
      for (let k = 0; k < 4; k++) v += row[k]! * inner[k]![c]!
      return v + (c === 4 ? row[4]! : 0)
    }),
  )
}

const IDENTITY: Affine = [
  [1, 0, 0, 0, 0],
  [0, 1, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 1, 0],
]
const LUMA = [0.2126, 0.7152, 0.0722]

/**
 * A colour matrix (SVG feColorMatrix values, sRGB 0–1) that approximates the previews' colour
 * adjustments, for a live look at a thumbnail: greyscale → exposure → saturation → contrast with
 * warmth/tint gains → fade. Null when nothing changes.
 */
export function colourMatrix(adj: Adjust | null | undefined): number[] | null {
  if (!adj) return null
  const e = adj.exposure ?? 0,
    s = adj.saturation ?? 0,
    c = adj.contrast ?? 0
  const w = adj.warmth ?? 0,
    t = adj.tint ?? 0,
    f = adj.fade ?? 0
  if (!e && !s && !c && !w && !t && !f && !adj.bw) return null
  let m = IDENTITY
  if (adj.bw)
    m = compose(
      [
        [...LUMA, 0, 0],
        [...LUMA, 0, 0],
        [...LUMA, 0, 0],
        [0, 0, 0, 1, 0],
      ],
      m,
    )
  if (e) {
    const b = Math.pow(2, e / 100)
    m = compose(
      [
        [b, 0, 0, 0, 0],
        [0, b, 0, 0, 0],
        [0, 0, b, 0, 0],
        [0, 0, 0, 1, 0],
      ],
      m,
    )
  }
  if (s && !adj.bw) {
    const k = Math.max(0, 1 + s / 100)
    const row = (i: number) => [0, 1, 2].map((j) => (1 - k) * LUMA[j]! + (i === j ? k : 0))
    m = compose(
      [
        [...row(0), 0, 0],
        [...row(1), 0, 0],
        [...row(2), 0, 0],
        [0, 0, 0, 1, 0],
      ],
      m,
    )
  }
  if (c || w || t || f) {
    const slope = Math.max(0, 1 + c / 100)
    const gains = [1 + w / 200 + t / 200, 1 - t / 200, 1 - w / 200 + t / 200]
    const lift = (f / 100) * (64 / 255)
    m = compose(
      gains
        .map((g, i) => {
          const r = [0, 0, 0, 0, g * 0.5 * (1 - slope) + lift]
          r[i] = g * slope
          return r
        })
        .concat([[0, 0, 0, 1, 0]]),
      m,
    )
  }
  return m.flat().map((v) => Math.round(v * 10000) / 10000)
}

/**
 * How many spreads to offer for a first plan: the user's usual count when there are photos enough
 * for it (3 or more a spread), otherwise about five photos a spread.
 */
export function suggestSpreads(photos: number, usual: number): number {
  if (photos <= 0) return Math.max(1, usual)
  if (photos >= usual * 3) return usual
  return Math.max(1, Math.min(usual, Math.round(photos / 5)))
}

/** Shift-click selection: everything between the anchor and the clicked item, in list order. */
export function rangeSelect(list: string[], anchor: string | null, target: string): string[] {
  const j = list.indexOf(target)
  const i = anchor ? list.indexOf(anchor) : -1
  if (j < 0) return []
  if (i < 0) return [target]
  return list.slice(Math.min(i, j), Math.max(i, j) + 1)
}

export interface TemplateQuery {
  fits: boolean
  h: number
  v: number
  collection: string | null
  text: string
  /** With `fits`: only this page shape too (templates of unknown size pass). */
  shape?: number | null
}

/** The templates to offer: fitting ones first-class, then by collection, name and search text. */
export function filterTemplates(all: Template[], q: TemplateQuery): Template[] {
  const words = q.text.toLowerCase().split(/\s+/).filter(Boolean)
  return all.filter((t) => {
    if (q.fits && (t.h !== q.h || t.v !== q.v)) return false
    if (q.fits && q.shape && shapeOf(t) && shapeOf(t) !== q.shape) return false
    if (q.collection && t.collection !== q.collection) return false
    const name = t.name.toLowerCase()
    return words.every((w) => name.includes(w))
  })
}

/** "2 landscape + 1 portrait". */
export function describeSlots(h: number, v: number): string {
  const parts: string[] = []
  if (h) parts.push(`${h} landscape`)
  if (v) parts.push(`${v} portrait`)
  return parts.join(' + ') || 'no photos'
}

/** Which way a photo lies, for drop rules and labels. */
export function orientOf(a: Album, id: string): Orient {
  return a.photos[id]?.orient === 'v' ? 'v' : 'h'
}
