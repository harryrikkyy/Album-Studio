// SpreadView.tsx — the current spread, large, and directly editable: drop photos on it to add
// them, onto a photo to replace it, drag a photo to another frame to swap, or off to the pool.
// Frames come from the template itself (spread.layout), laid over the preview as hit areas.

import { FileWarning, ImagePlus, LoaderCircle } from 'lucide-preact'
import { useEffect, useState } from 'preact/hooks'
import { call, fileUrl } from '../../bridge'
import { allowDrop, dragging, endDrag, payloadOf, startDrag, type DragPayload } from '../../dnd'
import { proofPending, proofUrl, spreadSelection } from '../../edit'
import { addPhotos, replacePhoto, swapPhotos } from '../../plan_actions'
import { album, hoveredPhoto } from '../../state'
import type { Spread } from '../../types'

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

  // A drag that ends anywhere clears the highlight.
  useEffect(() => { if (!drag) setOver(null) }, [drag])

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
        <div class={`spread ${over === 'spread' ? 'is-drop' : ''} ${pending ? 'is-pending' : ''}`} style={{ '--ar': ar }}>
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
                onClick={() => (spreadSelection.value = f.photoId === sel ? null : f.photoId)}
                onMouseEnter={() => (hoveredPhoto.value = f.photoId)}
                onMouseLeave={() => (hoveredPhoto.value = null)}
              >
                {over === f.z && act ? <span class="frame-hit__label">{act}</span> : null}
              </div>
            )
          })}
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
