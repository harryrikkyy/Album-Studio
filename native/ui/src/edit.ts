// edit.ts — changing the album: every edit goes through `edit()`, which sends it to the background
// helper (one undo step per call), applies the album that comes back, and marks the spreads whose
// preview is being redrawn. Previews arrive as `proofs.updated` events a moment later.

import { batch, effect, signal } from '@preact/signals'
import { call, fileUrl, onEvent } from './bridge'
import { albumQueue } from './album_queue'
import { templateLabel } from './format'
import { describeSlots, changedSpreads, type Template } from './plan_logic'
import { album, assetVersion, spreadIndex, stored, store, toast } from './state'
import type { Album, Spread } from './types'
import type { AlbumOperation, OperationReport, UpdateResult as ContractUpdateResult } from '../../contracts/types'

export type Op = AlbumOperation

type Report = OperationReport
export type UpdateResult = ContractUpdateResult

export const canUndo = signal(false)
export const canRedo = signal(false)
export const editing = signal(0) // edits in flight

/** Pick a fitting template on its own when photos change (on by default). */
export const autoTemplate = signal<boolean>(stored('as.autoTemplate', true))
export function setAutoTemplate(on: boolean) {
  autoTemplate.value = on
  store('as.autoTemplate', on)
}

/** Spreads whose preview is being redrawn after an edit. */
export const proofPending = signal<ReadonlySet<number>>(new Set())
/** Per spread: bumped when its proof file is rewritten, so the image is fetched again. */
export const proofVersion = signal<Readonly<Record<number, number>>>({})

/** The selected photo on the current spread (clicked on the spread or in the inspector). */
export const spreadSelection = signal<string | null>(null)

function setPending(add: number[], remove: number[] = []) {
  const next = new Set(proofPending.value)
  for (const n of add) next.add(n)
  for (const n of remove) next.delete(n)
  proofPending.value = next
}

/** Apply an album the helper sent back after an edit, undo or redo. */
function apply(prev: Album, r: UpdateResult) {
  if (album.value?.path !== prev.path) return // another album was opened meanwhile
  const changed = changedSpreads(prev, r.album)
  batch(() => {
    album.value = r.album
    canUndo.value = r.canUndo
    canRedo.value = r.canRedo
    if (spreadIndex.value > r.album.spreads.length - 1) spreadIndex.value = Math.max(0, r.album.spreads.length - 1)
    const s = r.album.spreads[spreadIndex.value]
    if (spreadSelection.value && !s?.photoIds.includes(spreadSelection.value)) spreadSelection.value = null
    setPending(changed.filter((n) => r.album.spreads[n - 1]?.template))
  })
}

/** Run after every earlier edit, so edits apply in the order they were made. */
const queued = albumQueue<Album>(() => album.value)

/**
 * Change the album. All `ops` are one undo step. Resolves with the helper's report, or null when
 * the edit failed (the reason is shown to the user).
 */
export function edit(ops: Op[]): Promise<Report | null> {
  if (!ops.length) return Promise.resolve(null)
  const requested = structuredClone(ops)
  return queued(async (a) => {
    editing.value++
    try {
      const r = await call('album.update', { album: a.path, ops: requested })
      apply(a, r)
      if (album.value?.path === a.path) explain(r.report)
      return r.report ?? {}
    } catch (e) {
      toast('error', `${album.value?.path === a.path ? '' : `${a.name}: `}${(e as Error).message}`, 8000)
      return null
    } finally {
      editing.value--
    }
  })
}

function explain(report: Report | undefined) {
  if (!report) return
  for (const t of report.templates ?? []) {
    if (t.auto) toast('info', `Spread ${t.n} now uses ${templateLabel(t.name)}, which fits its photos.`)
  }
  for (const m of report.noTemplate ?? []) {
    toast('error', `No template in this album’s collections takes ${describeSlots(m.h, m.v)} photos. Spread ${m.n} keeps its template; photos without a frame won’t show.`, 9000)
  }
}

export function undo() { return step('album.undo', 'Nothing to undo.') }
export function redo() { return step('album.redo', 'Nothing to redo.') }

function step(method: 'album.undo' | 'album.redo', nothing: string) {
  return queued(async (a) => {
    editing.value++
    try {
      const r = await call(method, { album: a.path })
      if (r.changed === false && album.value?.path === a.path) toast('info', nothing, 2500)
      apply(a, r)
    } catch (e) {
      toast('error', `${album.value?.path === a.path ? '' : `${a.name}: `}${(e as Error).message}`, 8000)
    } finally {
      editing.value--
    }
  })
}

/** A spread's preview image, fetched again whenever it is redrawn. */
export function proofUrl(s: Spread): string | undefined {
  const u = fileUrl(s.proof)
  return u && `${u}?v=${assetVersion.value}.${proofVersion.value[s.n] ?? 0}`
}

// ── proofs ──────────────────────────────────────────────────────────────────

onEvent('proofs.updated', (d) => {
  const e = d
  const a = album.value
  if (!a || a.path !== e.album) return
  batch(() => {
    const s = a.spreads[e.n - 1]
    if (s && s.proof !== e.proof) {
      const spreads = a.spreads.slice()
      spreads[e.n - 1] = { ...s, proof: e.proof }
      album.value = { ...a, spreads }
    }
    proofVersion.value = { ...proofVersion.value, [e.n]: (proofVersion.value[e.n] ?? 0) + 1 }
    setPending([], [e.n])
  })
})

onEvent('proofs.failed', (d) => {
  const e = d
  if (album.value?.path !== e.album) return
  setPending([], [e.n])
  toast('error', `The preview of spread ${e.n} couldn’t be drawn: ${e.error}`, 8000)
})

onEvent('proofs.idle', (d) => {
  const e = d
  if (album.value?.path === e.album) proofPending.value = new Set()
})

// ── templates ───────────────────────────────────────────────────────────────

export const templates = signal<Template[] | null>(null)
export const templatesError = signal<string | null>(null)
let templatesFor: string | null = null

/** Collections changed: the next look at templates reads the catalogue again. */
export function forgetTemplateCatalogue() {
  templates.value = null
  templatesFor = null
}

/** Apply the result of an edit made outside `edit()` (album settings), so undo knows of it. */
export function applyUpdate(r: UpdateResult) {
  const a = album.value
  if (a) apply(a, r)
}

/** The album's template catalogue (loaded once per album). */
export async function loadTemplates(force = false) {
  const a = album.value
  if (!a || (!force && templatesFor === a.path && templates.value)) return
  templatesFor = a.path
  templatesError.value = null
  try {
    const list = await call('templates.list', { album: a.path }, 60_000)
    if (templatesFor === a.path) templates.value = list
  } catch (e) {
    templatesError.value = (e as Error).message
  }
}

// ── another album ───────────────────────────────────────────────────────────

// Another album opened: its history, previews and templates are its own.
let openPath: string | null = null
effect(() => {
  const p = album.value?.path ?? null
  if (p === openPath) return
  openPath = p
  batch(() => {
    canUndo.value = false
    canRedo.value = false
    proofPending.value = new Set()
    proofVersion.value = {}
    spreadSelection.value = null
    templates.value = null
  })
  templatesFor = null
})
