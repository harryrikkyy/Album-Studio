// main.tsx — mounts the interface, applies the theme, and owns the global keyboard map.

import { effect } from '@preact/signals'
import { Component, render, type ComponentChildren } from 'preact'
import { call, inShell, onEvent, onProtocolError } from './bridge'
import { account, checkAccount, whenAllowed } from './account'
import { SignIn } from './app/SignIn'
import { AboutDialog, openAbout } from './app/About'
import { AlbumSettingsDialog } from './app/AlbumSettings'
import { SettingsDialog, openSettings } from './app/Settings'
import { AutoFillDialog } from './places/plan/AutoFill'
import { Frame, goToPlace, placeForKey } from './app/Frame'
import { Albums } from './places/Albums'
import { Deliver } from './places/Deliver'
import { Pending } from './places/Pending'
import { Plan } from './places/Plan'
import { Review } from './places/Review'
import { Tools } from './places/Tools'
import { containDialogTab, isTypingTarget, ownsNavigationKeys, shortcutsSuspended } from './ui/keyboard'
import { Notifications } from './ui/Notifications'
import { Library } from './places/Library'
import { redo, spreadSelection, undo } from './edit'
import { openNewAlbum } from './places/albums/NewAlbum'
import { moveSpread, removePhotos, rotatePhotos, shuffleTemplate, turnTargets } from './plan_actions'
import { editCurrentSpread, loadPlan, plan, startRender } from './render'
import {
  album, currentSpread, frameAdjusting, goToSpread, nextSpread, openAlbum, place, poolAnchor, poolSelection, setTheme, templateBrowserOpen, theme,
  toggleInspector, toast,
} from './state'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'

onProtocolError(error => toast('error', `Album Studio received an unsupported message: ${error.message}`, 12000))

effect(() => {
  document.documentElement.dataset.theme = theme.value
})

function Current() {
  switch (place.value) {
    case 'albums': return <Albums />
    case 'plan': return album.value ? <Plan /> : <Albums />
    case 'review': return album.value ? <Review /> : <Albums />
    case 'deliver': return album.value ? <Deliver /> : <Albums />
    case 'tools': return <Tools />
    case 'library': return <Library />
    default: return <Pending which={place.value} />
  }
}

function isTyping(e: KeyboardEvent): boolean {
  return isTypingTarget(e.target)
}

document.addEventListener('keydown', containDialogTab, true)
document.addEventListener('keydown', (e) => {
  if (shortcutsSuspended(e, !!document.querySelector('dialog[open]'), account.value?.state === 'allowed')) return
  if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-7]$/.test(e.key)) {
    const p = placeForKey(e.key)
    if (p) { e.preventDefault(); goToPlace(p) }
    return
  }
  if (e.metaKey && e.key === ',') { e.preventDefault(); openSettings(); return }
  // ⌘L / ⌘R turn the photos last picked (in the pool or on the spread) left or right, as in Preview.
  if (e.metaKey && !e.shiftKey && !e.altKey && (e.key === 'l' || e.key === 'r') && place.value === 'plan' && album.value && !isTyping(e)) {
    e.preventDefault()
    void rotatePhotos(turnTargets(), e.key === 'l' ? -90 : 90)
    return
  }
  // Undo and redo work everywhere an album is open, except while typing (the field has its own).
  if (e.metaKey && !e.altKey && e.key.toLowerCase() === 'z' && album.value && !isTyping(e)) {
    e.preventDefault()
    void (e.shiftKey ? redo() : undo())
    return
  }
  if (isTyping(e) || e.metaKey || e.ctrlKey) return
  if (ownsNavigationKeys(e.target) && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' ', 'Backspace', 'Delete'].includes(e.key)) return
  // Moving a photo in its frame has its own keys (Return, Esc).
  if (frameAdjusting.value) return
  if (place.value === 'plan' || place.value === 'review') {
    const s = currentSpread.value
    if (e.altKey) {
      // ⌥← ⌥→ move the current spread.
      if (place.value === 'plan' && s && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        void moveSpread(s.n, s.n + (e.key === 'ArrowRight' ? 1 : -1))
      }
      return
    }
    if (e.key === 'ArrowRight') { e.preventDefault(); nextSpread(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); nextSpread(-1) }
    else if (place.value !== 'plan' || !s) return
    else if (e.key === 'Enter') { e.preventDefault(); void editCurrentSpread() }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); templateBrowserOpen.value = !templateBrowserOpen.value }
    else if ((e.key === 's' || e.key === 'S') && s.photoIds.length) { e.preventDefault(); void shuffleTemplate(s.n) }
    else if ((e.key === 'Backspace' || e.key === 'Delete') && spreadSelection.value && s.photoIds.includes(spreadSelection.value)) {
      e.preventDefault()
      void removePhotos(s.n, [spreadSelection.value])
    } else if (e.key === 'Escape') {
      if (templateBrowserOpen.value) templateBrowserOpen.value = false
      else if (spreadSelection.value) spreadSelection.value = null
      else { poolSelection.value = new Set(); poolAnchor.value = null }
    }
  }
})

// Every interface error reaches the app's log, so a problem a user hits can be diagnosed.
function report(kind: string, detail: unknown) {
  const err = detail instanceof Error ? { message: detail.message, stack: detail.stack } : { message: String(detail) }
  if (inShell) void call('shell.log', { level: 'error', kind, ...err }).catch(() => {})
}
window.addEventListener('error', (e) => report('error', e.error ?? e.message))
window.addEventListener('unhandledrejection', (e) => report('unhandledrejection', e.reason))

/** A failure while drawing shows a way back instead of a blank window. */
class Boundary extends Component<{ children: ComponentChildren }, { error: Error | null }> {
  override state = { error: null as Error | null }
  override componentDidCatch(error: Error) {
    report('render', error)
    this.setState({ error })
  }
  override render() {
    if (!this.state.error) return this.props.children
    return (
      <div class="crash" role="alert">
        <h1>Something went wrong drawing this screen</h1>
        <p>Your albums and files are safe. Reload the window to carry on; the details are in Album Studio’s log.</p>
        <pre class="mono">{this.state.error.message}</pre>
        <button type="button" class="btn btn--primary" onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }
}

// The menu bar (the shell's album menu): each command as if its button or key was used.
onEvent('menu', (d) => {
  const command = (d as { command: string }).command
  if (account.value?.state !== 'allowed') return // the sign-in screen has no album commands
  if (document.querySelector('dialog[open]')) {
    // The native Edit menu still belongs to a focused field inside the dialog.
    if ((command === 'undo' || command === 'redo') && isTypingTarget(document.activeElement)) document.execCommand(command)
    return
  }
  const typing = isTyping({ target: document.activeElement } as unknown as KeyboardEvent)
  if (command === 'undo' || command === 'redo') {
    // In a text field the menu's Undo is the field's own; elsewhere it is the album's.
    if (typing) document.execCommand(command)
    else if (album.value) void (command === 'undo' ? undo() : redo())
  } else if (command === 'about') openAbout()
  else if (command === 'newAlbum') { place.value = 'albums'; openNewAlbum() }
  else if (command === 'openAlbum') { place.value = 'albums'; void pickAndOpenAlbum() }
  else if (command === 'editSpread') void editCurrentSpread()
  else if ((command === 'rotateLeft' || command === 'rotateRight') && album.value && !typing) {
    place.value = 'plan'
    void rotatePhotos(turnTargets(), command === 'rotateLeft' ? -90 : 90)
  }
  else if (command.startsWith('place.')) goToPlace(command.slice(6) as Parameters<typeof goToPlace>[0])
  else if (command === 'templates' && album.value) { place.value = 'plan'; templateBrowserOpen.value = !templateBrowserOpen.value }
  else if (command === 'inspector' && album.value) { place.value = 'plan'; toggleInspector() }
  else if (command === 'theme') setTheme(theme.value === 'studio-dark' ? 'studio-light' : 'studio-dark')
})

async function pickAndOpenAlbum() {
  try {
    const path = await call('dialog.pickFolder', { title: 'Open an album project folder' })
    if (typeof path === 'string') await openAlbum(path)
  } catch (e) {
    report('menu', e)
  }
}

/** The app, once the Creative Hubb account lets it open; the sign-in screen until then. */
function Root() {
  return <>
    {account.value?.state !== 'allowed' ? <SignIn /> : <Frame><Current /><AboutDialog /><AlbumSettingsDialog /><AutoFillDialog /><SettingsDialog /></Frame>}
    <Notifications />
  </>
}

void checkAccount()
render(<Boundary><Root /></Boundary>, document.getElementById('app')!)

// Deep links: ?open=<album folder>&place=plan|review&spread=<n>&theme=studio-light. The shell uses
// them to open an album straight away (from Finder, or the last session).
void (async () => {
  const q = new URLSearchParams(location.search)
  const t = q.get('theme')
  if (t === 'studio-dark' || t === 'studio-light') theme.value = t
  const open = q.get('open')
  if (!open) return
  await whenAllowed()
  await openAlbum(open)
  const n = Number(q.get('spread'))
  if (n > 0) goToSpread(n - 1)
  const p = q.get('place')
  if (p === 'review' || p === 'plan' || p === 'deliver') place.value = p
  // ?action=render: render what's missing or changed (the shell's "Render album" entry point).
  if (q.get('action') === 'render') {
    await loadPlan()
    const todo = (plan.value?.spreads ?? []).filter((x) => x.state === 'missing' || x.state === 'stale').map((x) => x.n)
    if (todo.length) await startRender(todo)
  }
})()
