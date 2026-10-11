// render.ts — render jobs as seen by the interface: the per-spread plan, the running job's
// progress (pushed by the background helper as events), and the actions that start or cancel it.

import { batch, computed, effect, signal } from '@preact/signals'
import { call, onEvent } from './bridge'
import { plural } from './format'
import { album, assetVersion, openAlbumQuietly, toast } from './state'

export type SheetState = 'current' | 'stale' | 'missing' | 'blocked'
export interface PlanEntry { n: number; state: SheetState; reason?: string; unsupported?: string[] }
export interface Plan { outputFolder: string; spreads: PlanEntry[] }

export interface SheetResult { n: number; state: 'done' | 'failed' | 'skipped'; ms?: number; error?: string; warnings?: string[] }
export interface Job {
  jobId: number
  album: string
  total: number
  index: number          // sheets handled so far
  current: number | null // spread being worked on
  phase: string
  startedAt: number
  results: SheetResult[]
  finished: null | { done: number; skipped: number; failed: number; cancelled: boolean; ms: number }
}

export const plan = signal<Plan | null>(null)
export const planError = signal<string | null>(null)
export const job = signal<Job | null>(null)
export const running = computed(() => !!job.value && !job.value.finished)

export async function loadPlan() {
  const a = album.value
  if (!a) return
  planError.value = null
  try {
    plan.value = await call<Plan>('render.plan', { album: a.path })
  } catch (e) {
    planError.value = (e as Error).message
  }
}

export async function startRender(spreads: number[] | null, force = false) {
  const a = album.value
  if (!a || running.value) return
  try {
    await call('render.start', { album: a.path, spreads, force })
  } catch (e) {
    toast('error', (e as Error).message, 8000)
  }
}

export async function cancelRender() {
  const j = job.value
  if (!j) return
  await call('render.cancel', { jobId: j.jobId }).catch(() => {})
  toast('info', 'Stopping after the sheet in progress…')
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

onEvent('render.started', (d) => {
  const data = d as { jobId: number; total: number; album: string }
  job.value = { jobId: data.jobId, album: data.album, total: data.total, index: 0, current: null, phase: 'Starting', startedAt: Date.now(), results: [], finished: null }
})

onEvent('render.progress', (d) => {
  const p = d as { jobId: number; index: number; n: number; state: string; ms?: number; error?: string; warnings?: string[] }
  const j = job.value
  if (!j || j.jobId !== p.jobId) return
  const phase = p.state === 'preparing' ? 'Preparing photos' : p.state === 'building' ? 'Building in PhotoCraft' : ''
  const settled = p.state === 'done' || p.state === 'failed' || p.state === 'skipped'
  job.value = {
    ...j,
    current: settled ? null : p.n,
    phase: phase || j.phase,
    index: settled ? p.index : j.index,
    results: settled ? [...j.results, { n: p.n, state: p.state as SheetResult['state'], ms: p.ms, error: p.error, warnings: p.warnings }] : j.results,
  }
  if (settled && plan.value) {
    const state: SheetState | null = p.state === 'failed' ? null : 'current'
    if (state) plan.value = { ...plan.value, spreads: plan.value.spreads.map((s) => (s.n === p.n ? { ...s, state } : s)) }
  }
})

onEvent('render.finished', (d) => {
  const f = d as { jobId: number; done: number; skipped: number; failed: number; cancelled: boolean; ms: number }
  const j = job.value
  if (!j || j.jobId !== f.jobId) return
  batch(() => {
    job.value = { ...j, current: null, finished: { done: f.done, skipped: f.skipped, failed: f.failed, cancelled: f.cancelled, ms: f.ms } }
    assetVersion.value++
  })
  const parts = [f.done ? `${plural(f.done, 'sheet')} rendered` : null, f.skipped ? `${f.skipped} unchanged` : null, f.failed ? `${f.failed} failed` : null].filter(Boolean)
  const verb = f.cancelled ? 'Render stopped' : 'Render finished'
  toast(f.failed ? 'error' : 'ok', `${verb}: ${parts.join(', ') || 'nothing to do'} · ${duration(f.ms)}`, 9000)
  // Pick up the new sheets and previews.
  if (album.value && album.value.path === j.album) void openAlbumQuietly(j.album).then(loadPlan)
})

// After edits settle (the previews are redrawn), sheets may have gone out of date: ask again.
// The plan is cheap (a hash per spread), so it follows the album rather than being cached.
let planTimer = 0
function refreshPlanSoon() {
  window.clearTimeout(planTimer)
  planTimer = window.setTimeout(() => { if (!running.value) void loadPlan() }, 250)
}
onEvent('proofs.idle', (d) => {
  if (album.value && (d as { album: string }).album === album.value.path) refreshPlanSoon()
})
let planFor: string | null = null
effect(() => {
  const p = album.value?.path ?? null
  if (p === planFor) return
  planFor = p
  plan.value = null
  if (p) refreshPlanSoon()
})

/** A spread's sheet as the plan sees it; null until the plan has loaded. */
export function sheetStateOf(n: number): PlanEntry | null {
  return plan.value?.spreads.find((s) => s.n === n) ?? null
}

export { duration }
