// main.tsx — mounts the interface, applies the theme, and owns the global keyboard map.

import { effect } from '@preact/signals'
import { render } from 'preact'
import { Frame, goToPlace, placeForKey } from './app/Frame'
import { Albums } from './places/Albums'
import { Pending } from './places/Pending'
import { Plan } from './places/Plan'
import { Review } from './places/Review'
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

render(<Frame><Current /></Frame>, document.getElementById('app')!)

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
  if (p === 'review' || p === 'plan') place.value = p
})()
