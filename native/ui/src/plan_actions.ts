// plan_actions.ts — what the user can do to a plan, in their words. Buttons, drag and drop and the
// keyboard all call these, so a change behaves the same however it was asked for.

import { autoTemplate, edit, spreadSelection, type Op } from './edit'
import { plural, templateLabel } from './format'
import { album, currentSpread, goToSpread, poolAnchor, poolSelection, selectionFocus, spreadIndex, toast } from './state'
import type { Adjust, Placement } from './types'

/** Spreads a set of photos is on now, other than `except`. */
function spreadsOf(ids: string[], except: number): number[] {
  const a = album.value
  const out = new Set<number>()
  for (const id of ids) for (const n of a?.photos[id]?.usedOn ?? []) if (n !== except) out.add(n)
  return [...out]
}

/** Append template fitting for every spread whose photos changed. */
function fit(ops: Op[], spreads: number[]): Op[] {
  if (!autoTemplate.value) return ops
  return [...ops, ...[...new Set(spreads)].map((n) => ({ op: 'fitTemplate', n }))]
}

export function addPhotos(n: number, ids: string[], { copy = false, index }: { copy?: boolean; index?: number } = {}) {
  if (!ids.length) return Promise.resolve(null)
  const left = copy ? [] : spreadsOf(ids, n)
  return edit(fit([{ op: 'addPhoto', n, ids, copy, index }], [n, ...left]))
}

export function removePhotos(n: number, ids: string[]) {
  return edit(fit(ids.map((id) => ({ op: 'removePhoto', n, id })), [n]))
}

/** `newId` takes `oldId`'s frame; if `newId` was on another spread, `oldId` goes there instead. */
export function replacePhoto(n: number, oldId: string, newId: string) {
  return edit(fit([{ op: 'replacePhoto', n, oldId, newId }], [n, ...spreadsOf([newId], n)]))
}

export function swapPhotos(n: number, a: string, b: string) {
  return edit(fit([{ op: 'swapPhotos', n, a, b }], [n]))
}

export function movePhoto(n: number, id: string, index: number) {
  return edit([{ op: 'movePhoto', n, id, index }])
}

/**
 * Turn photos clockwise by `by` degrees (-90 turns left), wherever they appear. A quarter turn
 * swaps landscape and portrait, so spreads holding them get a fitting template when templates
 * follow photos.
 */
export function rotatePhotos(ids: string[], by: 90 | -90 | 180) {
  if (!ids.length) {
    toast('info', 'Select photos to turn first: in the photos on the left, or one on the spread.')
    return Promise.resolve(null)
  }
  return edit(fit([{ op: 'rotatePhotos', ids, by }], by === 180 ? [] : spreadsOf(ids, 0)))
}

/** The photos a turn applies to: where the user last picked photos (the pool or the spread). */
export function turnTargets(): string[] {
  const a = album.value
  if (!a) return []
  const onSpread = spreadSelection.value && a.photos[spreadSelection.value] ? [spreadSelection.value] : []
  const inPool = [...poolSelection.value].filter((id) => a.photos[id])
  if (selectionFocus.value === 'spread') return onSpread.length ? onSpread : inPool
  return inPool.length ? inPool : onSpread
}

/**
 * Put photos on a spread with this template, as one undoable step: on the current spread when it
 * is empty, otherwise on a new spread after it (nothing already planned is replaced). They move off
 * any spread they were on; those spreads get a fitting template when templates follow photos.
 */
export async function placeWithTemplate(ids: string[], templateId: string, templateName: string) {
  const s = currentSpread.value
  if (!s || !ids.length) return
  const empty = !s.photoIds.length
  const n = empty ? s.n : s.n + 1
  const ops: Op[] = empty ? [] : [{ op: 'insertSpread', at: n }]
  // The spreads they leave, numbered as they will be once the new spread is in.
  const left = spreadsOf(ids, 0).map((m) => (!empty && m >= n ? m + 1 : m)).filter((m) => m !== n)
  ops.push({ op: 'addPhoto', n, ids }, { op: 'setTemplate', n, templateId })
  const r = await edit(fit(ops, left))
  if (!r) return
  goToSpread(n - 1)
  poolSelection.value = new Set()
  poolAnchor.value = null
  toast('ok', `${plural(ids.length, 'photo')} on ${empty ? '' : 'a new '}spread ${n} with ${templateLabel(templateName)}. ⌘Z undoes it.`)
}

/** A photo's colour (wherever it appears); all zero restores it. */
export function adjustPhoto(id: string, adjust: Adjust) {
  return edit([{ op: 'adjustPhoto', id, adjust }])
}

/** How a photo sits in its frame (wherever it appears); null fits it again, centred. */
export function placePhoto(id: string, pl: Placement | null) {
  return edit([pl ? { op: 'placePhoto', id, scale: pl.scale, ox: pl.ox, oy: pl.oy } : { op: 'placePhoto', id }])
}

export function setTemplate(n: number, templateId: string) {
  return edit([{ op: 'setTemplate', n, templateId }])
}

export function shuffleTemplate(n: number) {
  return edit([{ op: 'fitTemplate', n, another: true }])
}

export async function insertSpread(at: number) {
  const r = await edit([{ op: 'insertSpread', at }])
  if (r) goToSpread(at - 1)
}

export async function deleteSpread(n: number) {
  const r = await edit([{ op: 'removeSpread', n }])
  if (r) toast('info', `Spread ${n} deleted. ⌘Z brings it back.`)
}

export function clearSpread(n: number) {
  return edit([{ op: 'clearSpread', n }])
}

export async function moveSpread(from: number, to: number) {
  const count = album.value?.spreads.length ?? 0
  if (from === to || to < 1 || to > count) return
  const followed = spreadIndex.value === from - 1
  const r = await edit([{ op: 'moveSpread', from, to }])
  if (r && followed) goToSpread(to - 1)
}

export interface AutoFillOptions {
  mode: 'desired' | 'range'
  desiredSheets: number
  min: number
  max: number
  chronological: boolean
  /** Only these photos (Best picks). */
  ids?: string[]
}

export async function autoFill(o: AutoFillOptions) {
  const r = await edit([{ op: 'autoFill', ...o }])
  const f = r?.autoFill
  if (!f) return false
  goToSpread(0)
  const notes = [
    f.cappedTo != null ? `only ${f.cappedTo} spreads: there aren’t enough photos for more` : null,
    f.withoutTemplate ? `${plural(f.withoutTemplate, 'spread')} without a fitting template` : null,
  ].filter(Boolean)
  toast(f.withoutTemplate ? 'error' : 'ok', `Planned ${plural(f.spreads, 'spread')}${notes.length ? ` (${notes.join('; ')})` : ''}. ⌘Z undoes it.`, 9000)
  return true
}
