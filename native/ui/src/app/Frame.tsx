// Frame.tsx — the window's frame: the top bar (with room for the traffic lights), the rail of
// places, and the toast stack. The current place renders inside.

import { BookImage, Brush, CircleAlert, CircleCheck, Info, LayoutGrid, LayoutTemplate, Library, LoaderCircle, Moon, PackageCheck, Redo2, Settings, Sun, Undo2, Wrench, X } from 'lucide-preact'
import type { ComponentChildren } from 'preact'
import { call, inShell } from '../bridge'
import { canRedo, canUndo, editing, redo, undo } from '../edit'
import { plural } from '../format'
import { editCurrentSpread, job, running } from '../render'
import { album, dismissToast, place, setTheme, theme, toasts, type Place } from '../state'
import { IconButton } from '../ui/controls'
import { openAlbumSettings } from './AlbumSettings'
import { openSettings } from './Settings'

const PLACES: { id: Place; label: string; icon: ComponentChildren; key: string; needsAlbum: boolean }[] = [
  { id: 'albums', label: 'Albums', icon: <BookImage size={20} strokeWidth={1.6} />, key: '1', needsAlbum: false },
  { id: 'plan', label: 'Plan', icon: <LayoutTemplate size={20} strokeWidth={1.6} />, key: '2', needsAlbum: true },
  { id: 'review', label: 'Review', icon: <LayoutGrid size={20} strokeWidth={1.6} />, key: '3', needsAlbum: true },
  { id: 'edit', label: 'Edit', icon: <Brush size={20} strokeWidth={1.6} />, key: '4', needsAlbum: true },
  { id: 'deliver', label: 'Deliver', icon: <PackageCheck size={20} strokeWidth={1.6} />, key: '5', needsAlbum: true },
  { id: 'library', label: 'Library', icon: <Library size={20} strokeWidth={1.6} />, key: '6', needsAlbum: false },
  { id: 'tools', label: 'Tools', icon: <Wrench size={20} strokeWidth={1.6} />, key: '7', needsAlbum: false },
]

export function goToPlace(p: Place) {
  const def = PLACES.find((x) => x.id === p)
  if (!def || (def.needsAlbum && !album.value)) return
  if (p === 'edit') {
    // Edit is the PhotoCraft editor itself: open the current spread there.
    void editCurrentSpread()
    return
  }
  place.value = p
}

export function placeForKey(key: string): Place | null {
  return PLACES.find((p) => p.key === key)?.id ?? null
}

function TopBar() {
  const a = album.value
  // Mouse-down on the bar's empty space moves the window, as a title bar does.
  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input, [role="button"]')) return
    if (inShell) void call('shell.dragWindow').catch(() => {})
  }
  return (
    <header class="topbar" onMouseDown={onMouseDown} onDblClick={() => inShell && void call('shell.zoomWindow').catch(() => {})}>
      <div class="topbar__title">
        {a ? (
          <>
            <button type="button" class="topbar__album topbar__album--btn" onClick={openAlbumSettings} title="Album folders and template collections">{a.name}</button>
            <span class="topbar__meta">{plural(a.stats.spreads, 'spread')} · {plural(a.stats.photos, 'photo')}</span>
            <span class={`topbar__save ${editing.value ? 'is-saving' : ''}`} role="status">{editing.value ? 'Saving…' : ''}</span>
          </>
        ) : (
          <span class="topbar__album">Album Studio</span>
        )}
      </div>
      <div class="topbar__actions">
        {a ? (
          <div class="topbar__history">
            <IconButton label="Undo (⌘Z)" disabled={!canUndo.value} onClick={() => void undo()}><Undo2 size={16} strokeWidth={1.8} /></IconButton>
            <IconButton label="Redo (⇧⌘Z)" disabled={!canRedo.value} onClick={() => void redo()}><Redo2 size={16} strokeWidth={1.8} /></IconButton>
          </div>
        ) : null}
        {running.value && job.value ? (
          <button type="button" class="topbar__job" onClick={() => goToPlace('deliver')} title="Show the render">
            <LoaderCircle size={14} /> Rendering {job.value.index} of {job.value.total}
          </button>
        ) : null}
        <IconButton label="Settings (⌘,)" onClick={openSettings}><Settings size={16} strokeWidth={1.7} /></IconButton>
        <button
          type="button"
          class="icon-btn"
          aria-label={theme.value === 'studio-dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme.value === 'studio-dark' ? 'Light theme' : 'Dark theme'}
          onClick={() => setTheme(theme.value === 'studio-dark' ? 'studio-light' : 'studio-dark')}
        >
          {theme.value === 'studio-dark' ? <Sun size={16} strokeWidth={1.7} /> : <Moon size={16} strokeWidth={1.7} />}
        </button>
      </div>
    </header>
  )
}

function Rail() {
  const current = place.value
  const hasAlbum = !!album.value
  return (
    <nav class="rail" aria-label="Places">
      {PLACES.map((p) => {
        const disabled = p.needsAlbum && !hasAlbum
        return (
          <button
            type="button"
            class={`rail__item ${current === p.id ? 'is-current' : ''}`}
            aria-current={current === p.id ? 'page' : undefined}
            disabled={disabled}
            title={disabled ? `${p.label} — open an album first` : `${p.label}  ⌘${p.key}`}
            onClick={() => goToPlace(p.id)}
          >
            <span class="rail__icon" aria-hidden="true">{p.icon}</span>
            <span class="rail__label">{p.label}</span>
          </button>
        )
      })}
    </nav>
  )
}

function Toasts() {
  const list = toasts.value
  return (
    <div class="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div class={`toast toast--${t.kind}`} key={t.id}>
          <span class="toast__icon" aria-hidden="true">
            {t.kind === 'error' ? <CircleAlert size={16} /> : t.kind === 'ok' ? <CircleCheck size={16} /> : <Info size={16} />}
          </span>
          <span class="toast__text">{t.text}</span>
          <button type="button" class="icon-btn icon-btn--sm" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function Frame({ children }: { children: ComponentChildren }) {
  return (
    <div class="frame">
      <TopBar />
      <Rail />
      <main class="frame__main" id="main">{children}</main>
      <Toasts />
    </div>
  )
}
