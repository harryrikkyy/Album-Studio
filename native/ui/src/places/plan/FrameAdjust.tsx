// FrameAdjust.tsx — move and zoom a photo inside its frame, on the spread. Drag to move it, scroll
// or pinch (or the slider) to zoom; what the frame crops away shows faintly around it. Return or
// Done keeps it, Esc cancels, Fit puts it back to the plain centred fit. The math is the previews'
// and print sheets' own (cover, zoom, pan), so what is seen here is what they show.

import { Check, Maximize, X } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { fileUrl } from '../../bridge'
import { panBy, placementLayout, turnOf } from '../../plan_logic'
import type { Photo, Placement } from '../../types'

export interface FrameBox { x: number; y: number; w: number; h: number } // fractions of the spread

const MAX_ZOOM = 5
const fitted: Required<Placement> = { scale: 1, ox: 0, oy: 0 }

export function FrameAdjust({ frame, photo, spreadPx, onDone, onCancel }: {
  frame: FrameBox
  photo: Photo
  spreadPx: { w: number; h: number }
  onDone: (pl: Placement | null) => void
  onCancel: () => void
}) {
  const [pl, setPl] = useState<Required<Placement>>({ scale: photo.placement?.scale ?? 1, ox: photo.placement?.ox ?? 0, oy: photo.placement?.oy ?? 0 })
  const current = useRef(pl)
  current.current = pl
  const drag = useRef<{ x: number; y: number; start: Placement } | null>(null)
  const root = useRef<HTMLDivElement>(null)

  // The frame and the photo as seen (after its turn), in screen pixels.
  const fw = frame.w * spreadPx.w
  const fh = frame.h * spreadPx.h
  const t = turnOf(photo)
  const quarter = t % 180 === 90
  const pw = photo.width ?? (photo.orient === 'v' ? 2 : 3)
  const ph = photo.height ?? (photo.orient === 'v' ? 3 : 2)
  const L = placementLayout(fw, fh, quarter ? ph : pw, quarter ? pw : ph, pl)
  // The image element is laid out unturned, centred where the turned picture goes, then turned.
  const img = {
    left: `${L.left + L.width / 2}px`,
    top: `${L.top + L.height / 2}px`,
    width: `${quarter ? L.height : L.width}px`,
    height: `${quarter ? L.width : L.height}px`,
    transform: `translate(-50%, -50%) rotate(${t}deg)`,
  }

  const zoomTo = (scale: number) => setPl((p) => ({ ...p, scale: Math.max(1, Math.min(MAX_ZOOM, scale)) }))
  const done = () => onDone(pl.scale === 1 && !pl.ox && !pl.oy ? null : pl)

  useEffect(() => {
    root.current?.focus()
    // Safari's pinch arrives as gesture events rather than ctrl+wheel.
    const el = root.current
    if (!el) return
    let base = 1
    const start = (e: Event) => { e.preventDefault(); base = current.current.scale }
    const change = (e: Event) => { e.preventDefault(); zoomTo(base * ((e as unknown as { scale: number }).scale || 1)) }
    el.addEventListener('gesturestart', start)
    el.addEventListener('gesturechange', change)
    return () => { el.removeEventListener('gesturestart', start); el.removeEventListener('gesturechange', change) }
  }, [])

  return (
    <div
      ref={root}
      class="adjust"
      style={{ left: `${frame.x * 100}%`, top: `${frame.y * 100}%`, width: `${frame.w * 100}%`, height: `${frame.h * 100}%` }}
      tabIndex={-1}
      role="group"
      aria-label={`Move and zoom ${photo.base} in its frame`}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done() }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('.adjust__bar')) return
        e.preventDefault()
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* a pointer that can't be captured still drags while over the frame */ }
        drag.current = { x: e.clientX, y: e.clientY, start: pl }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const at = placementLayout(fw, fh, quarter ? ph : pw, quarter ? pw : ph, d.start)
        setPl(panBy(d.start, e.clientX - d.x, e.clientY - d.y, at.overflowX, at.overflowY))
      }}
      onPointerUp={() => { drag.current = null }}
      onPointerCancel={() => { drag.current = null }}
      onWheel={(e) => {
        e.preventDefault()
        zoomTo(pl.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)))
      }}
      onDblClick={(e) => { e.stopPropagation(); done() }}
    >
      <img class="adjust__ghost" src={fileUrl(photo.thumb)} alt="" draggable={false} style={img} />
      <div class="adjust__clip">
        <img src={fileUrl(photo.thumb)} alt="" draggable={false} style={img} />
      </div>
      <div class="adjust__bar" onDblClick={(e) => e.stopPropagation()}>
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={pl.scale}
          aria-label="Zoom"
          onInput={(e) => zoomTo(Number((e.target as HTMLInputElement).value))}
        />
        <button type="button" class="adjust__btn" title="Fit the frame, centred" aria-label="Fit" onClick={() => setPl(fitted)}><Maximize size={13} /><span class="adjust__word">Fit</span></button>
        <button type="button" class="adjust__btn" title="Cancel (Esc)" aria-label="Cancel" onClick={onCancel}><X size={14} /></button>
        <button type="button" class="adjust__btn adjust__btn--done" title="Done (Return)" aria-label="Done" onClick={done}><Check size={14} /><span class="adjust__word">Done</span></button>
      </div>
    </div>
  )
}
