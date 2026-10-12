// Inspector.tsx — the current spread in detail: its template (and whether it fits the photos),
// its photos in order (drag to reorder, drop a photo on one to replace it, × to take it off), and
// where it stands.

import { CircleCheck, GripVertical, LayoutTemplate, RotateCw, Shuffle, TriangleAlert, X } from 'lucide-preact'
import { useState } from 'preact/hooks'
import { fileUrl } from '../../bridge'
import { allowDrop, endDrag, payloadOf, startDrag } from '../../dnd'
import { spreadSelection } from '../../edit'
import { shortPath, signature, templateLabel } from '../../format'
import { addPhotos, movePhoto, removePhotos, replacePhoto, rotatePhotos, shuffleTemplate } from '../../plan_actions'
import { slotsOf, templateFits } from '../../plan_logic'
import { sheetStateOf } from '../../render'
import { album, currentPhotos, currentSpread, hoveredPhoto, inspectorOpen, selectionFocus, templateBrowserOpen } from '../../state'
import { Button, Kbd } from '../../ui/controls'
import { Thumb } from '../../ui/Thumb'

function FitNote() {
  const a = album.value!
  const s = currentSpread.value!
  const fits = templateFits(a, s)
  if (fits === null || !s.photoIds.length) return null
  const { h, v } = slotsOf(a, s)
  if (fits) return <p class="fit fit--ok"><CircleCheck size={13} /> A frame for every photo</p>
  const th = s.template!.h ?? 0
  const tv = s.template!.v ?? 0
  const missing = Math.max(0, h - th) + Math.max(0, v - tv)
  const empty = Math.max(0, th - h) + Math.max(0, tv - v)
  return (
    <p class="fit fit--warn">
      <TriangleAlert size={13} />
      <span>
        Frames for {signature(th, tv)}, photos {signature(h, v)}.
        {missing ? ` ${missing} photo${missing === 1 ? ' won’t' : 's won’t'} show.` : ''}
        {empty ? ` ${empty} frame${empty === 1 ? ' stays' : 's stay'} empty.` : ''}
      </span>
    </p>
  )
}

const SHEET_WORDS = { current: 'Up to date', stale: 'Changed since render', missing: 'Not rendered' } as const

function SheetState({ n, rendered }: { n: number; rendered: boolean }) {
  const st = sheetStateOf(n)
  if (!st) return <>{rendered ? 'Rendered' : 'Not rendered'}</>
  if (st.state === 'blocked') return <span class="muted">{st.reason ?? 'Can’t render yet'}</span>
  if (st.edited) return <span class="is-ok" title="Saved from the editor after it was rendered; renders keep it">Edited in the editor</span>
  return <span class={st.state === 'stale' ? 'is-warn' : st.state === 'current' ? 'is-ok' : ''}>{SHEET_WORDS[st.state]}</span>
}

export function Inspector() {
  const s = currentSpread.value
  const [overRow, setOverRow] = useState<string | null>(null)
  if (!s || !inspectorOpen.value) return null
  const photos = currentPhotos.value
  const sel = spreadSelection.value

  return (
    <aside class="inspector" aria-label="Inspector">
      <section class="insp-section">
        <h3 class="insp-section__title">Template</h3>
        {s.template ? (
          <>
            <button type="button" class="insp-template" onClick={() => (templateBrowserOpen.value = true)} title="Choose another template (T)">
              {s.template.preview ? <img src={fileUrl(s.template.preview)} alt="" decoding="async" /> : <span class="insp-template__none" />}
            </button>
            <dl class="facts">
              <dt>Name</dt><dd title={s.template.name ?? ''}>{templateLabel(s.template.name)}</dd>
              <dt>Frames</dt><dd>{signature(s.template.h ?? 0, s.template.v ?? 0)}</dd>
              <dt>File</dt><dd class="mono" title={s.template.file ?? ''}>{s.template.file ? shortPath(s.template.file, 2) : 'Not found on disk'}</dd>
            </dl>
            <FitNote />
          </>
        ) : (
          <p class="muted">No template on this spread.</p>
        )}
        <div class="insp-section__actions">
          <Button size="sm" icon={<LayoutTemplate size={14} />} onClick={() => (templateBrowserOpen.value = !templateBrowserOpen.value)} aria-pressed={templateBrowserOpen.value}>
            {s.template ? 'Change' : 'Choose'}
          </Button>
          <Button size="sm" variant="ghost" icon={<Shuffle size={14} />} disabled={!s.photoIds.length} onClick={() => void shuffleTemplate(s.n)} title="Another template that fits (S)">
            Shuffle
          </Button>
        </div>
      </section>

      <section class="insp-section">
        <h3 class="insp-section__title">On this spread <span class="count">{photos.length}</span></h3>
        {photos.length ? (
          <ol class="insp-photos">
            {photos.map((p, i) => (
              <li
                key={p.id}
                class={`${hoveredPhoto.value === p.id ? 'is-hovered' : ''} ${sel === p.id ? 'is-selected' : ''} ${overRow === p.id ? 'is-over' : ''}`}
                draggable
                onDragStart={(e) => startDrag(e, { kind: 'photos', ids: [p.id], from: { n: s.n } })}
                onDragEnd={() => { endDrag(); setOverRow(null) }}
                onDragOver={(e) => {
                  const d = payloadOf(e)
                  if (d?.kind !== 'photos' || d.ids.length !== 1 || d.ids[0] === p.id) return
                  allowDrop(e)
                  if (overRow !== p.id) setOverRow(p.id)
                }}
                onDragLeave={() => setOverRow(null)}
                onDrop={(e) => {
                  const d = payloadOf(e)
                  setOverRow(null)
                  endDrag()
                  if (d?.kind !== 'photos' || d.ids.length !== 1 || d.ids[0] === p.id) return
                  e.preventDefault()
                  // Within the spread: move to this place. From elsewhere: take this photo's place.
                  if (d.from?.n === s.n) void movePhoto(s.n, d.ids[0]!, i)
                  else void replacePhoto(s.n, p.id, d.ids[0]!)
                }}
                onMouseEnter={() => (hoveredPhoto.value = p.id)}
                onMouseLeave={() => (hoveredPhoto.value = null)}
                onClick={() => { selectionFocus.value = 'spread'; spreadSelection.value = sel === p.id ? null : p.id }}
              >
                <GripVertical size={14} class="insp-photos__grip" aria-hidden="true" />
                <span class="insp-photos__thumb"><Thumb p={p} /></span>
                <span class="insp-photos__name">{p.base}</span>
                <span class="insp-photos__orient" title={`${p.orient === 'v' ? 'Portrait' : 'Landscape'}${p.rotation ? `, turned ${p.rotation}°` : ''}`}>{p.orient === 'v' ? 'V' : 'H'}</span>
                <button
                  type="button"
                  class="icon-btn icon-btn--sm insp-photos__turn"
                  aria-label={`Turn ${p.base} right`}
                  title="Turn right (⌘R)"
                  onClick={(e) => { e.stopPropagation(); void rotatePhotos([p.id], 90) }}
                >
                  <RotateCw size={13} />
                </button>
                <button
                  type="button"
                  class="icon-btn icon-btn--sm insp-photos__remove"
                  aria-label={`Take ${p.base} off this spread`}
                  title="Take off this spread (⌫)"
                  onClick={(e) => { e.stopPropagation(); void removePhotos(s.n, [p.id]) }}
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p
            class="insp-drop"
            onDragOver={(e) => { const d = payloadOf(e); if (d?.kind === 'photos') allowDrop(e, e.altKey) }}
            onDrop={(e) => { const d = payloadOf(e); endDrag(); if (d?.kind === 'photos') { e.preventDefault(); void addPhotos(s.n, d.ids, { copy: e.altKey }) } }}
          >
            Drag photos here or onto the spread.
          </p>
        )}
      </section>

      <section class="insp-section">
        <h3 class="insp-section__title">Status</h3>
        <dl class="facts">
          <dt>Preview</dt><dd>{s.proof ? 'Ready' : 'Not drawn yet'}</dd>
          <dt>Print sheet</dt><dd><SheetState n={s.n} rendered={!!s.sheet} /></dd>
          <dt>Text & shapes</dt><dd>{s.edited ? 'Edited' : 'None'}</dd>
        </dl>
      </section>
      <p class="insp-hint">
        <Kbd keys={['←', '→']} /> spreads · <Kbd keys={['T']} /> templates · <Kbd keys={['S']} /> shuffle
        · <Kbd keys={['⌫']} /> take off · <Kbd keys={['⌘', 'Z']} /> undo · <Kbd keys={['↩']} /> edit
      </p>
    </aside>
  )
}
