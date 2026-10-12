// SpreadView.tsx — the current spread, large, and directly editable: drop photos on it to add
// them, onto a photo to replace it, drag a photo to another frame to swap, or off to the pool.
// Frames come from the template itself (spread.layout), laid over the preview as hit areas.

import { Crop, FileWarning, ImagePlus, LoaderCircle, RotateCcw, RotateCw, X } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { call, fileUrl } from '../../bridge'
import { allowDrop, dragging, endDrag, payloadOf, startDrag, type DragPayload } from '../../dnd'
import { proofPending, proofUrl, spreadSelection } from '../../edit'
import { addPhotos, placePhoto, removePhotos, replacePhoto, rotatePhotos, swapPhotos } from '../../plan_actions'
import { album, hoveredPhoto, selectionFocus } from '../../state'
import type { Spread } from '../../types'
import { FrameAdjust } from './FrameAdjust'

interface LayoutFrame { name: string; orient: 'h' | 'v'; x: number; y: number; w: number; h: number; z: number; photoId: string | null }
interface Layout { n: number; template: string | null; width: number | null; height: number | null; backdrop: string | null; frames: LayoutFrame[]; unplaced: string[] }

const cache = new Map<string, Layout>()

/** The spread's frames, fetched when its template or photos change; the last one shows meanwhile. */
function useLayout(albumPath: string, s: Spread): Layout | null {
  const key = `${albumPath}|${s.n}|${s.template?.id ?? ''}|${s.photoIds.join(',')}`
  const [layout, setLayout] = useState<Layout | null>(cache.get(key) ?? null)
  useEffect(() => {
    let live = true
    const hit = cache.get(key)
    if (hit) { setLayout(hit); return }
    call<Layout>('spread.layout', { album: albumPath, n: s.n }, 30_000)
      .then((l) => {
        if (cache.size > 200) cache.clear()
        cache.set(key, l)
        if (live) setLayout(l)
      })
      .catch(() => { if (live) setLayout(null) })
    return () => { live = false }
  }, [key])
  return layout && layout.n === s.n ? layout : null
}

type Target = 'spread' | number | null // what a drag is over: the spread, or a frame (by z)

/**
 * What dropping `p` on frame `f` of spread `n` would do, in words; null if it can't go there.
 * A photo that is on another spread trades places with the frame's photo; an unused one replaces it.
 */
function frameAction(p: DragPayload | null, f: LayoutFrame, n: number): string | null {
  if (p?.kind !== 'photos' || p.ids.length !== 1) return null
  const id = p.ids[0]!
  if (id === f.photoId) return null
  if (p.from?.n === n) return f.photoId ? 'Swap' : null
  if (!f.photoId) return 'Add'
  const elsewhere = p.from || album.value?.photos[id]?.usedOn.some((m) => m !== n)
  return elsewhere ? 'Swap' : 'Replace'
}

export function SpreadView({ s }: { s: Spread }) {
  const a = album.value!
  const layout = useLayout(a.path, s)
  const [over, setOver] = useState<Target>(null)
  const pending = proofPending.value.has(s.n)
  const drag = dragging.value
  const ar = layout?.width && layout.height ? layout.width / layout.height : 3
  const sel = spreadSelection.value
  // The photo being moved/zoomed in its frame (by frame z), and the spread's size on screen.
  const [adjusting, setAdjusting] = useState<number | null>(null)
  const spreadEl = useRef<HTMLDivElement>(null)
  const [px, setPx] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = spreadEl.current
    if (!el) return
    const ro = new ResizeObserver(() => setPx({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [spreadEl.current])

  // A drag that ends anywhere clears the highlight; another spread or photo ends adjusting.
  useEffect(() => { if (!drag) setOver(null) }, [drag])
  useEffect(() => setAdjusting(null), [s.n, s.photoIds.join('|'), s.template?.id])

  const onSpreadOver = (e: DragEvent) => {
    const p = payloadOf(e)
    if (p?.kind !== 'photos' || p.from?.n === s.n) return
    allowDrop(e, e.altKey)
    if (over !== 'spread') setOver('spread')
  }
  const onSpreadDrop = (e: DragEvent) => {
    const p = payloadOf(e)
    setOver(null)
    endDrag()
    if (p?.kind !== 'photos' || p.from?.n === s.n) return
    e.preventDefault()
    void addPhotos(s.n, p.ids, { copy: e.altKey })
  }

  const onFrameDrop = (e: DragEvent, f: LayoutFrame) => {
    const p = payloadOf(e)
    e.stopPropagation()
    setOver(null)
    endDrag()
    const act = frameAction(p, f, s.n)
    if (!act || p?.kind !== 'photos') return
    e.preventDefault()
    const id = p.ids[0]!
    if (act === 'Add') void addPhotos(s.n, [id])
    else if (p.from?.n === s.n) void swapPhotos(s.n, id, f.photoId!)
    else void replacePhoto(s.n, f.photoId!, id)
  }

  const img = s.proof ? proofUrl(s) : layout?.backdrop ? fileUrl(layout.backdrop) : undefined
  const count = drag?.kind === 'photos' ? drag.ids.length : 0

  return (
    <div class="spread-wrap" onDragOver={onSpreadOver} onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(null) }} onDrop={onSpreadDrop}>
      {img ? (
        <div ref={spreadEl} class={`spread ${over === 'spread' ? 'is-drop' : ''} ${pending ? 'is-pending' : ''} ${adjusting !== null ? 'is-adjusting' : ''}`} style={{ '--ar': ar }}>
          <img class="spread__img" src={img} alt={`Spread ${s.n}`} decoding="async" draggable={false} />
          {layout?.frames.map((f) => {
            const act = drag ? frameAction(drag, f, s.n) : null
            const photo = f.photoId ? a.photos[f.photoId] : null
            return (
              <div
                key={f.z}
                class={`frame-hit ${f.photoId ? '' : 'is-empty'} ${sel && sel === f.photoId ? 'is-selected' : ''} ${hoveredPhoto.value && hoveredPhoto.value === f.photoId ? 'is-hovered' : ''} ${over === f.z ? 'is-over' : ''} ${drag?.kind === 'photos' && drag.from?.n === s.n && drag.ids[0] === f.photoId ? 'is-source' : ''}`}
                style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}
                title={photo ? `${photo.base} — drag to swap or take off; drop a photo here to replace it` : `Empty ${f.orient === 'h' ? 'landscape' : 'portrait'} frame`}
                draggable={!!f.photoId}
                onDragStart={(e) => { if (f.photoId) startDrag(e, { kind: 'photos', ids: [f.photoId], from: { n: s.n } }) }}
                onDragEnd={endDrag}
                onDragOver={(e) => {
                  const p = payloadOf(e)
                  if (!frameAction(p, f, s.n)) return // falls through to the spread
                  e.stopPropagation()
                  allowDrop(e)
                  if (over !== f.z) setOver(f.z)
                }}
                onDrop={(e) => { if (frameAction(payloadOf(e), f, s.n)) onFrameDrop(e, f) }}
                onClick={() => { selectionFocus.value = 'spread'; spreadSelection.value = f.photoId === sel ? null : f.photoId }}
                onDblClick={() => { if (photo) { selectionFocus.value = 'spread'; spreadSelection.value = photo.id; setAdjusting(f.z) } }}
                onMouseEnter={() => (hoveredPhoto.value = f.photoId)}
                onMouseLeave={() => (hoveredPhoto.value = null)}
              >
                {over === f.z && act ? <span class="frame-hit__label">{act}</span> : null}
                {sel && sel === f.photoId && !drag && photo && adjusting === null ? (
                  <span class="frame-tools" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
                    <button type="button" class="frame-tools__btn" title="Move and zoom in the frame (double-click the photo)" aria-label={`Move and zoom ${photo.base} in its frame`} onClick={() => setAdjusting(f.z)}><Crop size={13} /></button>
                    <button type="button" class="frame-tools__btn" title="Turn left (⌘L)" aria-label={`Turn ${photo.base} left`} onClick={() => void rotatePhotos([photo.id], -90)}><RotateCcw size={13} /></button>
                    <button type="button" class="frame-tools__btn" title="Turn right (⌘R)" aria-label={`Turn ${photo.base} right`} onClick={() => void rotatePhotos([photo.id], 90)}><RotateCw size={13} /></button>
                    <button type="button" class="frame-tools__btn" title="Take off this spread (⌫)" aria-label={`Take ${photo.base} off this spread`} onClick={() => void removePhotos(s.n, [photo.id])}><X size={13} /></button>
                  </span>
                ) : null}
              </div>
            )
          })}
          {(() => {
            const f = adjusting !== null ? layout?.frames.find((x) => x.z === adjusting) : null
            const photo = f?.photoId ? a.photos[f.photoId] : null
            if (!f || !photo || !px.w) return null
            return (
              <FrameAdjust
                key={`${photo.id}-${f.z}`}
                frame={f}
                photo={photo}
                spreadPx={px}
                onCancel={() => setAdjusting(null)}
                onDone={(pl) => { setAdjusting(null); void placePhoto(photo.id, pl) }}
              />
            )
          })()}
          {pending ? <span class="spread__busy" role="status"><LoaderCircle size={13} /> Updating preview</span> : null}
          {over === 'spread' ? <span class="spread__droplabel">Add {count > 1 ? `${count} photos` : 'photo'} to spread {s.n}</span> : null}
        </div>
      ) : s.template && !s.template.file ? (
        <div class={`spread-empty ${over === 'spread' ? 'is-drop' : ''}`}>
          <FileWarning size={30} strokeWidth={1.3} />
          <p class="spread-empty__title">The template isn’t on disk</p>
          <p class="spread-empty__text">{s.template.name ?? 'This spread’s template'} wasn’t found in the album’s template collections. Connect the drive it is on, or pick another template.</p>
        </div>
      ) : s.template ? (
        <div class="spread spread--skeleton" style={{ '--ar': ar }} role="status">
          <span class="spread__busy"><LoaderCircle size={13} /> Drawing the preview</span>
        </div>
      ) : (
        <div class={`spread-empty ${over === 'spread' ? 'is-drop' : ''}`}>
          <ImagePlus size={30} strokeWidth={1.3} />
          <p class="spread-empty__title">{s.photoIds.length ? `Spread ${s.n} has no template` : `Spread ${s.n} is empty`}</p>
          <p class="spread-empty__text">
            {s.photoIds.length
              ? 'Pick one under Templates, or add a photo and a fitting one is chosen for you.'
              : 'Drag photos here from the left, or double-click them.'}
          </p>
        </div>
      )}
    </div>
  )
}
