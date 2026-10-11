// plan_actions.ts — what the user can do to a plan, in their words. Buttons, drag and drop and the
// keyboard all call these, so a change behaves the same however it was asked for.

import { autoTemplate, edit, type Op } from './edit'
import { plural } from './format'
import { album, goToSpread, spreadIndex, toast } from './state'

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
