// exporting.ts — exports as seen by the interface: what is ready, the running export's progress
// (pushed by the background helper as events), and the actions that start or stop it.

import { computed, effect, signal } from '@preact/signals'
import { call, onEvent } from './bridge'
import { plural } from './format'
import { album, stored, store, toast } from './state'

export type ExportState = 'ready' | 'todo' | 'stale' | 'nosheet' | 'blocked'
export interface ExportSettings { size: 'print' | 'original'; heightInches: number; ppi: number }
export interface ExportPaths { sheets: string; high: string; low: string; pdf: string }
export interface ExportPlan {
  paths: ExportPaths
  settings: ExportSettings & { highQuality: number; lowQuality: number }
  spreads: { n: number; state: ExportState; reason?: string }[]
  preflight?: { errors: { code: string; n?: number; message: string }[]; warnings: { code: string; n?: number; message: string }[] }
  pdf: { path: string; bytes: number; at: string } | null
}
export type PdfResult = { path?: string; pages?: number; bytes?: number; error?: string } | null
export interface ExportJob {
  jobId: string
  total: number
  index: number
  current: number | null
  phase: 'exporting' | 'pdf' | null
  startedAt: number
  results: { n: number; state: 'done' | 'skipped' | 'failed'; ms?: number; error?: string }[]
  missingSheets: number[]
  finished: null | { done: number; skipped: number; failed: number; cancelled: boolean; ms: number; pdf: PdfResult }
}

export const exportSettings = signal<ExportSettings>({ size: 'print', heightInches: 12, ppi: 300, ...stored<Partial<ExportSettings>>('as.export', {}) })
export const exportKinds = signal<{ jpegs: boolean; pdf: boolean }>({ jpegs: true, pdf: true, ...stored<Partial<{ jpegs: boolean; pdf: boolean }>>('as.exportKinds', {}) })
export const exportPlanSig = signal<ExportPlan | null>(null)
export const exportJob = signal<ExportJob | null>(null)
export const exporting = computed(() => !!exportJob.value && !exportJob.value.finished)

export function setExportSettings(patch: Partial<ExportSettings>) {
  exportSettings.value = { ...exportSettings.value, ...patch }
  store('as.export', exportSettings.value)
  void loadExportPlan()
}

export function setExportKinds(patch: Partial<{ jpegs: boolean; pdf: boolean }>) {
  exportKinds.value = { ...exportKinds.value, ...patch }
  store('as.exportKinds', exportKinds.value)
}

let planRequest = 0
export async function loadExportPlan() {
  const a = album.value
  const request = ++planRequest, settings = { ...exportSettings.value }
  exportPlanSig.value = null
  if (!a) return
  try {
    const result = await call<ExportPlan>('export.plan', { album: a.path, ...settings })
    if (request === planRequest && album.value?.path === a.path) exportPlanSig.value = result
  } catch (e) {
    if (request === planRequest && album.value?.path === a.path) toast('error', (e as Error).message, 8000)
  }
}

export async function startExport(force = false) {
  const a = album.value
  if (!a || exporting.value) return
  try {
    await call('export.start', { album: a.path, ...exportSettings.value, ...exportKinds.value, force })
  } catch (e) {
    toast('error', (e as Error).message, 8000)
  }
}

export async function cancelExport() {
  const j = exportJob.value
  if (!j) return
  await call('export.cancel', { jobId: j.jobId }).catch(() => {})
  toast('info', 'Stopping after the sheet in progress…')
}

/** Show a file or folder in Finder. */
export function reveal(path: string) {
  void call('shell.reveal', { path }).catch((e) => toast('error', (e as Error).message))
}

export function megabytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`
}

onEvent('export.started', (d) => {
  const e = d as { jobId: string; total: number; missingSheets: number[] }
  exportJob.value = { jobId: e.jobId, total: e.total, index: 0, current: null, phase: null, startedAt: Date.now(), results: [], missingSheets: e.missingSheets, finished: null }
})

onEvent('export.progress', (d) => {
  const p = d as { jobId: string; index: number; n: number | null; state: string; ms?: number; error?: string }
  const j = exportJob.value
  if (!j || j.jobId !== p.jobId) return
  if (p.state === 'warning') { toast('error', p.error ?? 'Delivery needs recovery.', 12000); return }
  if (p.state === 'exporting') exportJob.value = { ...j, current: p.n, phase: 'exporting' }
  else if (p.state === 'pdf') exportJob.value = { ...j, current: null, phase: 'pdf' }
  else exportJob.value = { ...j, current: null, index: p.index, results: [...j.results, { n: p.n!, state: p.state as 'done' | 'skipped' | 'failed', ms: p.ms, error: p.error }] }
})

onEvent('export.finished', (d) => {
  const f = d as { jobId: string; done: number; skipped: number; failed: number; cancelled: boolean; ms: number; pdf: PdfResult; error?: string }
  const j = exportJob.value
  if (!j || j.jobId !== f.jobId) return
  exportJob.value = { ...j, current: null, phase: null, finished: { done: f.done, skipped: f.skipped, failed: f.failed, cancelled: f.cancelled, ms: f.ms, pdf: f.pdf } }
  const parts = [f.done ? `${plural(f.done, 'sheet')} exported` : null, f.skipped ? `${f.skipped} unchanged` : null, f.failed ? `${f.failed} failed` : null, f.pdf?.pages ? `PDF of ${plural(f.pdf.pages, 'page')}` : null].filter(Boolean)
  toast(f.failed || f.pdf?.error || f.error ? 'error' : 'ok', `${f.cancelled ? 'Export stopped' : 'Export finished'}: ${parts.join(', ') || 'nothing to do'}${f.error ? ` · ${f.error}` : f.pdf?.error ? ` · the PDF failed: ${f.pdf.error}` : ''}`, 9000)
  void loadExportPlan()
})

// Another album: its own plan; a new export state is fetched when Deliver shows.
let planFor = album.value
effect(() => {
  const p = album.value
  if (p === planFor) return
  planFor = p
  planRequest++
  exportPlanSig.value = null
})
