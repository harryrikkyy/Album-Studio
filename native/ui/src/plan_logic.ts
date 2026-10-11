// plan_logic.ts — the pure parts of editing a plan (tested in test/plan_logic.test.ts).

import type { Album, Orient, Spread } from './types'

export interface Template {
  id: string
  name: string
  file: string
  preview: string | null
  collection: string
  h: number
  v: number
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

/** Does the spread's template have a frame for each of its photos, and no more? */
export function templateFits(a: Album, s: Spread): boolean | null {
  if (!s.template || s.template.h == null || s.template.v == null) return null
  const { h, v } = slotsOf(a, s)
  return s.template.h === h && s.template.v === v
}

/**
 * Spreads whose picture an edit changed: different photos or template than the spread that was
 * at the same place before. Their proofs are redrawn, so they show as updating until then.
 */
export function changedSpreads(prev: Album | null, next: Album): number[] {
  const out: number[] = []
  for (const s of next.spreads) {
    const old = prev?.spreads[s.n - 1]
    if (!old || old.template?.id !== s.template?.id || old.photoIds.join('|') !== s.photoIds.join('|')) out.push(s.n)
  }
  return out
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
}

/** The templates to offer: fitting ones first-class, then by collection, name and search text. */
export function filterTemplates(all: Template[], q: TemplateQuery): Template[] {
  const words = q.text.toLowerCase().split(/\s+/).filter(Boolean)
  return all.filter((t) => {
    if (q.fits && (t.h !== q.h || t.v !== q.v)) return false
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
