// render.ts — render jobs as seen by the interface: the per-spread plan, the running job's
// progress (pushed by the background helper as events), and the actions that start or cancel it.

import { batch, computed, effect, signal } from '@preact/signals'
import { call, onEvent } from './bridge'
import { plural } from './format'
import { exportSettings } from './exporting'
import { album, assetVersion, currentSpread, openAlbumQuietly, toast } from './state'
import { jobIssues, mayOpenRenderedSheet, type JobReport } from './job_report'
import type { RenderPlan as ContractRenderPlan, RenderPlanEntry, RenderResult } from '../../contracts/types'

export type SheetState = RenderPlanEntry['state']
export type PlanEntry = RenderPlanEntry
export type Plan = ContractRenderPlan

export type SheetResult = RenderResult
export interface Job {
  jobId: string
  album: string
  total: number
  index: number          // sheets handled so far
  current: number | null // spread being worked on
  phase: string
  startedAt: number
  results: SheetResult[]
  finished: null | JobReport
}

export const plan = signal<Plan | null>(null)
export const planError = signal<string | null>(null)
export const job = signal<Job | null>(null)
export const running = computed(() => !!job.value && !job.value.finished)

let planRequest = 0
export async function loadPlan() {
  const a = album.value
  const request = ++planRequest, settings = { ...exportSettings.value }
  plan.value = null
  planError.value = null
  if (!a) return
  try {
    const result = await call('render.plan', { album: a.path, ...settings })
    if (request === planRequest && album.value?.path === a.path) plan.value = result
  } catch (e) {
    if (request === planRequest && album.value?.path === a.path) planError.value = (e as Error).message
  }
}

/** `overwriteEdited`: the user chose sheets edited in the editor, knowing this replaces them. */
export async function startRender(spreads: number[] | null, force = false, overwriteEdited = false) {
  const a = album.value
  if (!a || running.value) return
  try {
    await call('render.start', { album: a.path, spreads, force, overwriteEdited, ...exportSettings.value })
  } catch (e) {
    toast('error', (e as Error).message, 8000)
  }
}

export async function cancelRender() {
  const j = job.value
  if (!j) return
  await call('render.cancel', { jobId: j.jobId }).catch(() => {})
  toast('info', 'Stopping before the next sheet is saved…')
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

// ── Editing a spread ───────────────────────────────────────────────────────

/** A spread to open in the editor as soon as the render making its sheet finishes. */
let editAfterRender: { album: string; n: number } | null = null

async function openSheet(path: string) {
  try {
    await call('editor.open', { path })
  } catch (e) {
    toast('error', (e as Error).message, 8000)
  }
}

/**
 * Open the current spread in the PhotoCraft editor. A sheet that is up to date, or was edited
 * there by hand, opens as it is; otherwise this spread is rendered first and opens when done.
 */
export async function editCurrentSpread() {
  const a = album.value
  const s = currentSpread.value
  if (!a || !s) return
  if (!s.photoIds.length) { toast('info', `Spread ${s.n} is empty. Add photos to it first.`, 5000); return }
  if (!s.template) { toast('info', `Spread ${s.n} has no template yet. Choose one under Templates (T).`, 5000); return }
  if (!s.template.file) { toast('error', `Spread ${s.n}’s template isn’t on disk. Connect its drive, or choose another template.`, 7000); return }
  const st = sheetStateOf(s.n)
  if (s.sheet && (!st || st.edited || st.state === 'current')) { await openSheet(s.sheet); return }
  if (st?.state === 'blocked') { toast('error', st.reason ?? `Spread ${s.n} can’t be rendered yet.`, 7000); return }
  if (running.value) { toast('info', 'A render is running. Edit this spread when it has finished.', 5000); return }
  editAfterRender = { album: a.path, n: s.n }
  toast('info', `${s.sheet ? 'Spread changed since its sheet was made: rendering' : 'Rendering'} spread ${s.n} for the editor…`, 6000)
  await startRender([s.n])
}

onEvent('render.started', (d) => {
  const data = d
  job.value = { jobId: data.jobId, album: data.album, total: data.total, index: 0, current: null, phase: 'Starting', startedAt: Date.now(), results: [], finished: null }
})

// Back from the editor: a sheet may have been saved there. Look at the album, its sheets and
// their previews again.
onEvent('shell.albumShown', () => {
  const a = album.value
  if (a) void openAlbumQuietly(a.path).then(loadPlan)
})

onEvent('render.progress', (d) => {
  const p = d
  const j = job.value
  if (!j || j.jobId !== p.jobId) return
  const phase = p.state === 'preparing' ? 'Preparing photos' : p.state === 'building' ? 'Building in PhotoCraft' : ''
  const settled = p.state === 'done' || p.state === 'failed' || p.state === 'skipped' || p.state === 'cancelled'
  const results = [...j.results]
  if (p.state === 'done' || p.state === 'failed' || p.state === 'skipped' || p.state === 'cancelled') {
    if (typeof p.n !== 'number') { toast('error', p.error ?? 'The render returned a sheet result without its spread number.', 10000); return }
    results.push({ n: p.n, state: p.state, ms: p.ms, error: p.error, warnings: p.warnings })
  }
  job.value = {
    ...j,
    current: settled ? null : p.n ?? j.current,
    phase: phase || j.phase,
    index: settled ? p.index ?? j.index : j.index,
    results,
  }
  if (settled && plan.value) {
    const state: SheetState | null = p.state === 'done' || p.state === 'skipped' ? 'current' : null
    if (state) plan.value = { ...plan.value, spreads: plan.value.spreads.map((s) => (s.n === p.n ? { ...s, state } : s)) }
  }
})

onEvent('render.finished', (d) => {
  const f = d
  const j = job.value
  if (!j || j.jobId !== f.jobId) return
  batch(() => {
    job.value = { ...j, current: null, results: f.results, finished: { done: f.done, skipped: f.skipped, failed: f.failed, cancelled: f.cancelled, ms: f.ms, error: f.error, finishingError: f.finishingError, warnings: f.warnings } }
    assetVersion.value++
  })
  const parts = [f.done ? `${plural(f.done, 'sheet')} rendered` : null, f.skipped ? `${f.skipped} unchanged` : null, f.failed ? `${f.failed} failed` : null].filter(Boolean)
  const verb = f.cancelled ? 'Render stopped' : 'Render finished'
  const issues = jobIssues(f)
  toast(f.failed || issues.length ? 'error' : 'ok', `${verb}: ${parts.join(', ') || 'nothing to do'} · ${duration(f.ms)}${issues.length ? ` · ${issues.join(' ')}` : ''}`, issues.length ? 15000 : 9000)
  // Pick up the new sheets and previews, then open the spread waiting for the editor.
  const wanted = editAfterRender && editAfterRender.album === j.album ? editAfterRender : null
  editAfterRender = null
  if (album.value && album.value.path === j.album) {
    void openAlbumQuietly(j.album).then(async () => {
      await loadPlan()
      const done = wanted && mayOpenRenderedSheet(f.results, wanted.n, f.cancelled)
      const sheet = wanted ? album.value?.spreads[wanted.n - 1]?.sheet : null
      if (done && sheet) await openSheet(sheet)
    })
  }
})

// After edits settle (the previews are redrawn), sheets may have gone out of date: ask again.
// The plan is cheap (a hash per spread), so it follows the album rather than being cached.
let planTimer = 0
function refreshPlanSoon() {
  window.clearTimeout(planTimer)
  planTimer = window.setTimeout(() => { if (!running.value) void loadPlan() }, 250)
}
onEvent('proofs.idle', (d) => {
  if (album.value && d.album === album.value.path) refreshPlanSoon()
})
let planFor: string | null = null
let planSettings = exportSettings.value
effect(() => {
  const p = album.value?.path ?? null
  const settings = exportSettings.value
  if (p === planFor && settings === planSettings) return
  planFor = p
  planSettings = settings
  planRequest++
  plan.value = null
  if (p) refreshPlanSoon()
})

/** A spread's sheet as the plan sees it; null until the plan has loaded. */
export function sheetStateOf(n: number): PlanEntry | null {
  return plan.value?.spreads.find((s) => s.n === n) ?? null
}

export { duration }
