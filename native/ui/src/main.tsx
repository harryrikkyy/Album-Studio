// main.tsx — mounts the interface, applies the theme, and owns the global keyboard map.

import { effect } from '@preact/signals'
import { Component, render, type ComponentChildren } from 'preact'
import { call, inShell } from './bridge'
import { Frame, goToPlace, placeForKey } from './app/Frame'
import { Albums } from './places/Albums'
import { Deliver } from './places/Deliver'
import { Pending } from './places/Pending'
import { Plan } from './places/Plan'
import { Review } from './places/Review'
import { loadPlan, plan, startRender } from './render'
import { album, editCurrentSpread, goToSpread, nextSpread, openAlbum, place, theme } from './state'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'

effect(() => {
  document.documentElement.dataset.theme = theme.value
})

function Current() {
  switch (place.value) {
    case 'albums': return <Albums />
    case 'plan': return album.value ? <Plan /> : <Albums />
    case 'review': return album.value ? <Review /> : <Albums />
    case 'deliver': return album.value ? <Deliver /> : <Albums />
    default: return <Pending which={place.value} />
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  return !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey && !e.shiftKey && !e.altKey && /^[1-7]$/.test(e.key)) {
    const p = placeForKey(e.key)
    if (p) { e.preventDefault(); goToPlace(p) }
    return
  }
  if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return
  if (place.value === 'plan' || place.value === 'review') {
    if (e.key === 'ArrowRight') { e.preventDefault(); nextSpread(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); nextSpread(-1) }
    else if (e.key === 'Enter' && place.value === 'plan') { e.preventDefault(); void editCurrentSpread() }
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

render(<Boundary><Frame><Current /></Frame></Boundary>, document.getElementById('app')!)

// Deep links: ?open=<album folder>&place=plan|review&spread=<n>&theme=studio-light. The shell uses
// them to open an album straight away (from Finder, or the last session).
void (async () => {
  const q = new URLSearchParams(location.search)
  const t = q.get('theme')
  if (t === 'studio-dark' || t === 'studio-light') theme.value = t
  const open = q.get('open')
  if (!open) return
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
