// state.ts — the interface's state, as signals (only what changed re-renders), and the actions
// that change it. Components read signals and call actions; nothing else mutates state.

import { batch, computed, signal } from '@preact/signals'
import { call, fileUrl } from './bridge'
import type { Album, Orient, Photo, RecentAlbum, Spread } from './types'

export type Place = 'albums' | 'plan' | 'review' | 'edit' | 'deliver' | 'library' | 'tools'
export type Theme = 'studio-dark' | 'studio-light'

/** Per-viewer conveniences only; the album itself never lives in browser storage. */
export function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}
export function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode or full: a preference simply isn't remembered */
  }
}

export const place = signal<Place>('albums')
export const theme = signal<Theme>(stored<Theme>('as.theme', 'studio-dark'))

export const recent = signal<RecentAlbum[] | null>(null)
export const recentError = signal<string | null>(null)

export const album = signal<Album | null>(null)
export const albumLoading = signal<string | null>(null) // the path being opened
export const albumError = signal<string | null>(null)

export const spreadIndex = signal(0)
export const poolFilter = signal<'all' | 'unused' | 'used'>(stored('as.poolFilter', 'all'))
export const orientFilter = signal<'any' | Orient>('any')
export const thumbSize = signal<number>(stored('as.thumbSize', 72))
export const inspectorOpen = signal<boolean>(stored('as.inspectorOpen', true))
export const hoveredPhoto = signal<string | null>(null)
/** Photos selected in the pool (to drag or add together), and the last one clicked. */
export const poolSelection = signal<ReadonlySet<string>>(new Set())
export const poolAnchor = signal<string | null>(null)
/** The template browser, open under the spread. */
export const templateBrowserOpen = signal(false)

export type Toast = { id: number; kind: 'info' | 'ok' | 'error'; text: string }
export const toasts = signal<Toast[]>([])
let toastId = 1

/** Bumped after a render so previews that kept their file name are fetched again. */
export const assetVersion = signal(0)

/** A preview or proof image: its file URL, re-fetched after each render. */
export function previewUrl(path: string | null | undefined): string | undefined {
  const u = fileUrl(path)
  return u && assetVersion.value ? `${u}?v=${assetVersion.value}` : u
}

export const currentSpread = computed<Spread | null>(() => album.value?.spreads[spreadIndex.value] ?? null)

export const currentPhotos = computed<Photo[]>(() => {
  const a = album.value
  const s = currentSpread.value
  if (!a || !s) return []
  return s.photoIds.map((id) => a.photos[id]).filter((p): p is Photo => Boolean(p))
})

/** The pool after filters, in capture/file order. */
export const poolPhotos = computed<Photo[]>(() => {
  const a = album.value
  if (!a) return []
  const f = poolFilter.value
  const o = orientFilter.value
  const out: Photo[] = []
  for (const id of a.pool) {
    const p = a.photos[id]
    if (!p) continue
    if (f === 'unused' && p.usedOn.length) continue
    if (f === 'used' && !p.usedOn.length) continue
    if (o !== 'any' && p.orient !== o) continue
    out.push(p)
  }
  return out
})

// ── actions ────────────────────────────────────────────────────────────────

export function setTheme(t: Theme) {
  theme.value = t
  store('as.theme', t)
}

export function setThumbSize(px: number) {
  thumbSize.value = Math.max(56, Math.min(200, Math.round(px)))
  store('as.thumbSize', thumbSize.value)
}

export function setPoolFilter(f: 'all' | 'unused' | 'used') {
  poolFilter.value = f
  store('as.poolFilter', f)
}

export function toggleInspector() {
  inspectorOpen.value = !inspectorOpen.value
  store('as.inspectorOpen', inspectorOpen.value)
}

export function toast(kind: Toast['kind'], text: string, ms = 4500) {
  const t = { id: toastId++, kind, text }
  toasts.value = [...toasts.value, t]
  window.setTimeout(() => dismissToast(t.id), ms)
}

export function dismissToast(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

export async function loadRecent() {
  recentError.value = null
  try {
    recent.value = await call<RecentAlbum[]>('album.recent')
  } catch (e) {
    recentError.value = (e as Error).message
    recent.value = recent.value ?? []
  }
}

export async function openAlbum(path: string) {
  albumLoading.value = path
  albumError.value = null
  try {
    const a = await call<Album>('album.open', { path })
    batch(() => {
      album.value = a
      spreadIndex.value = 0
      place.value = 'plan'
      poolSelection.value = new Set()
      poolAnchor.value = null
      templateBrowserOpen.value = false
    })
    void loadRecent()
  } catch (e) {
    albumError.value = (e as Error).message
    toast('error', (e as Error).message, 8000)
  } finally {
    albumLoading.value = null
  }
}

/** Re-read the open album (after a render) without moving the user anywhere. */
export async function openAlbumQuietly(path: string) {
  try {
    const a = await call<Album>('album.open', { path })
    if (album.value?.path === path) album.value = a
  } catch (e) {
    toast('error', (e as Error).message, 8000)
  }
}

export function goToSpread(i: number) {
  const n = album.value?.spreads.length ?? 0
  if (!n) return
  spreadIndex.value = Math.max(0, Math.min(n - 1, i))
}

export function nextSpread(step = 1) {
  goToSpread(spreadIndex.value + step)
}

/** Open the current spread's rendered sheet in the PhotoCraft editor. */
export async function editCurrentSpread() {
  const s = currentSpread.value
  if (!s) return
  if (!s.sheet) {
    toast('info', `Spread ${s.n} hasn’t been rendered yet. Render it in Deliver, then edit it here.`, 6000)
    return
  }
  try {
    await call('editor.open', { path: s.sheet })
  } catch (e) {
    toast('error', (e as Error).message, 8000)
  }
}
