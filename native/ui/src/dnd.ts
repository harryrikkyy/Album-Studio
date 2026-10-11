// dnd.ts — dragging photos and spreads around the plan. WebKit hides a drag's data until the
// drop, so the payload is also kept here for drop targets to decide whether they accept it.

import { signal } from '@preact/signals'
import { fileUrl } from './bridge'

const MIME = 'application/x-album-studio'

export type DragPayload =
  | { kind: 'photos'; ids: string[]; from?: { n: number } }
  | { kind: 'spread'; n: number }

export const dragging = signal<DragPayload | null>(null)

/** Begin a drag. For photos, `thumbs` draws a small stack with a count as the drag image. */
export function startDrag(e: DragEvent, p: DragPayload, thumbs: string[] = []) {
  const dt = e.dataTransfer
  if (!dt) return
  dt.setData(MIME, JSON.stringify(p))
  dt.setData('text/plain', p.kind === 'photos' ? `${p.ids.length} photo(s)` : `Spread ${p.n}`)
  dt.effectAllowed = 'copyMove'
  if (thumbs.length > 1) {
    const ghost = document.createElement('div')
    ghost.className = 'drag-ghost'
    for (const t of thumbs.slice(0, 3)) {
      const img = document.createElement('img')
      img.src = fileUrl(t) ?? ''
      ghost.append(img)
    }
    const n = document.createElement('span')
    n.className = 'drag-ghost__n'
    n.textContent = String(p.kind === 'photos' ? p.ids.length : 1)
    ghost.append(n)
    document.body.append(ghost)
    dt.setDragImage(ghost, 36, 28)
    window.setTimeout(() => ghost.remove(), 0)
  }
  // Set after the browser has taken its snapshot, so the source can restyle itself.
  window.setTimeout(() => (dragging.value = p), 0)
}

export function endDrag() {
  dragging.value = null
}

/** The payload of the drag in progress (or being dropped). */
export function payloadOf(e: DragEvent): DragPayload | null {
  if (dragging.value) return dragging.value
  try {
    const raw = e.dataTransfer?.getData(MIME)
    return raw ? (JSON.parse(raw) as DragPayload) : null
  } catch {
    return null
  }
}

/** Accept a drag over a target: shows the copy or move cursor (⌥ copies photos). */
export function allowDrop(e: DragEvent, copy = false) {
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = copy ? 'copy' : 'move'
}
