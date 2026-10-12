// Pool.tsx — every photo of the album. Select (click, ⌘-click, ⇧-click), then drag onto a spread
// or double-click to add to the current one. Dropping a photo from a spread here takes it off.
// Each photo turns left or right from its corner buttons (or ⌘L / ⌘R with photos selected), and a
// selection shows its landscape/portrait mix and the templates that fit it.

import { Check, LayoutTemplate, RotateCcw, RotateCw, Undo2, WandSparkles } from 'lucide-preact'
import { useState } from 'preact/hooks'
import { allowDrop, dragging, endDrag, payloadOf, startDrag } from '../../dnd'
import { plural, signature } from '../../format'
import { addPhotos, removePhotos, rotatePhotos } from '../../plan_actions'
import { rangeSelect, seenAspect, selectionSlots } from '../../plan_logic'
import {
  album, currentSpread, goToSpread, hoveredPhoto, orientFilter, poolAnchor, poolFilter, poolPhotos, poolSelection,
  selectionFocus, setPoolFilter, setThumbSize, templateBrowserOpen, thumbSize,
} from '../../state'
import type { Photo } from '../../types'
import { Button, IconButton, Segmented } from '../../ui/controls'
import { Thumb } from '../../ui/Thumb'
import { openAutoFill } from './AutoFill'

/** Width ÷ height as the photo is seen (after its turn), kept within reason for the rows. */
function aspect(p: Photo): number {
  return Math.min(3, Math.max(0.33, seenAspect(p)))
}

function select(p: Photo, e: MouseEvent | KeyboardEvent) {
  selectionFocus.value = 'pool'
  const sel = new Set(poolSelection.value)
  if (e.shiftKey) {
    const ids = poolPhotos.value.map((x) => x.id)
    for (const id of rangeSelect(ids, poolAnchor.value, p.id)) sel.add(id)
  } else if (e.metaKey) {
    if (sel.has(p.id)) sel.delete(p.id)
    else sel.add(p.id)
    poolAnchor.value = p.id
  } else {
    sel.clear()
    sel.add(p.id)
    poolAnchor.value = p.id
  }
  poolSelection.value = sel
}

/** The selection in pool order, or just `p` when it isn't part of the selection. */
function dragSet(p: Photo): string[] {
  const sel = poolSelection.value
  if (!sel.has(p.id)) return [p.id]
  return poolPhotos.value.filter((x) => sel.has(x.id)).map((x) => x.id)
}

function addToCurrent(ids: string[], copy = false) {
  const s = currentSpread.value
  if (s) void addPhotos(s.n, ids, { copy })
}

function PoolTile({ p, onCurrent, selected }: { p: Photo; onCurrent: boolean; selected: boolean }) {
  const used = p.usedOn.length > 0
  const ar = aspect(p)
  return (
    <li
      // Justified rows: every photo at its own shape, rows filled edge to edge.
      // A photo alone on its row stretches at most 1.6× rather than becoming a panorama crop.
      style={{ flexGrow: ar, flexBasis: `calc(var(--row) * ${ar.toFixed(3)})`, maxWidth: `calc(var(--row) * ${(ar * 1.6).toFixed(3)})` }}
      class={`tile ${used ? 'is-used' : ''} ${onCurrent ? 'is-current' : ''} ${selected ? 'is-selected' : ''} ${hoveredPhoto.value === p.id ? 'is-hovered' : ''}`}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      title={`${p.base}${used ? ` · on spread ${p.usedOn.join(', ')}` : ''}\nDouble-click to add to this spread`}
      draggable
      onDragStart={(e) => {
        const ids = dragSet(p)
        if (!poolSelection.value.has(p.id)) { poolSelection.value = new Set([p.id]); poolAnchor.value = p.id }
        const a = album.value!
        startDrag(e, { kind: 'photos', ids }, ids.map((id) => a.photos[id]?.thumb ?? ''))
      }}
      onDragEnd={endDrag}
      onMouseEnter={() => (hoveredPhoto.value = p.id)}
      onMouseLeave={() => (hoveredPhoto.value = null)}
      onClick={(e) => select(p, e)}
      onDblClick={() => addToCurrent(dragSet(p))}
      onKeyDown={(e) => {
        if (e.key === ' ') { e.preventDefault(); select(p, e) }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addToCurrent(dragSet(p)) }
      }}
    >
      <Thumb p={p} alt={p.base} />
      {selected ? <span class="tile__check" aria-hidden="true"><Check size={11} strokeWidth={3} /></span> : null}
      <span class="tile__turns" onDblClick={(e) => e.stopPropagation()}>
        <button type="button" class="tile__turn" tabIndex={-1} title="Turn left (⌘L)" aria-label={`Turn ${p.base} left`} onClick={(e) => { e.stopPropagation(); void rotatePhotos([p.id], -90) }}>
          <RotateCcw size={12} strokeWidth={2.2} />
        </button>
        <button type="button" class="tile__turn" tabIndex={-1} title="Turn right (⌘R)" aria-label={`Turn ${p.base} right`} onClick={(e) => { e.stopPropagation(); void rotatePhotos([p.id], 90) }}>
          <RotateCw size={12} strokeWidth={2.2} />
        </button>
      </span>
      {used ? (
        <button
          type="button"
          class="tile__badge"
          tabIndex={-1}
          title={`Go to spread ${p.usedOn[0]}`}
          aria-label={`On spread ${p.usedOn.join(', ')}; go there`}
          onClick={(e) => { e.stopPropagation(); goToSpread(p.usedOn[0]! - 1) }}
        >
          {p.usedOn.join(',')}
        </button>
      ) : null}
    </li>
  )
}

export function Pool() {
  const a = album.value!
  const photos = poolPhotos.value
  const s = currentSpread.value
  const onSpread = new Set(s?.photoIds ?? [])
  const unused = a.stats.photos - a.stats.used
  const sel = poolSelection.value
  const [over, setOver] = useState(false)
  const drag = dragging.value
  // Photos dragged off a spread can be dropped back here.
  const takesBack = drag?.kind === 'photos' && !!drag.from
  return (
    <aside
      class={`pool ${over ? 'is-drop' : ''}`}
      aria-label="Photos"
      onDragOver={(e) => {
        const p = payloadOf(e)
        if (p?.kind === 'photos' && p.from) { allowDrop(e); setOver(true) }
      }}
      onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(false) }}
      onDrop={(e) => {
        setOver(false)
        const p = payloadOf(e)
        endDrag()
        if (p?.kind === 'photos' && p.from) {
          e.preventDefault()
          void removePhotos(p.from.n, p.ids)
        }
      }}
    >
      <div class="pool__head">
        <div class="pool__title">
          <h2>Photos</h2>
          <span class="count">{photos.length === a.stats.photos ? a.stats.photos : `${photos.length} of ${a.stats.photos}`}</span>
          <Button size="sm" variant="ghost" class="pool__autofill" icon={<WandSparkles size={14} />} onClick={openAutoFill} title="Plan every spread from the photos">
            Auto-fill…
          </Button>
        </div>
        <div class="pool__filters">
          <Segmented
            label="Show"
            value={poolFilter.value}
            onChange={setPoolFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'unused', label: `Unused ${unused}` },
              { value: 'used', label: 'Used' },
            ]}
          />
          <Segmented
            label="Orientation"
            value={orientFilter.value}
            onChange={(v) => (orientFilter.value = v)}
            options={[
              { value: 'any', label: 'Any', title: 'Landscape and portrait' },
              { value: 'h', label: 'H', title: 'Landscape only' },
              { value: 'v', label: 'V', title: 'Portrait only' },
            ]}
          />
        </div>
      </div>
      {photos.length === 0 ? (
        <div class="pool__empty">
          {poolFilter.value === 'unused' ? 'Every photo is placed.' : 'No photos match these filters.'}
        </div>
      ) : (
        <ul class="pool__grid" style={{ '--row': `${thumbSize.value}px` }} role="listbox" aria-multiselectable="true" aria-label="Photos">
          {photos.map((p) => (
            <PoolTile p={p} onCurrent={onSpread.has(p.id)} selected={sel.has(p.id)} key={p.id} />
          ))}
        </ul>
      )}
      {takesBack ? (
        <div class="pool__dropnote" aria-hidden="true">
          <Undo2 size={16} /> Drop to take {drag.ids.length > 1 ? 'these photos' : 'this photo'} off spread {drag.from!.n}
        </div>
      ) : null}
      <div class="pool__foot">
        {sel.size ? (
          <SelectionBar />
        ) : (
          <label class="slider">
            <span class="visually-hidden">Thumbnail size</span>
            <input
              type="range"
              min={56}
              max={200}
              step={4}
              value={thumbSize.value}
              onInput={(e) => setThumbSize(Number((e.target as HTMLInputElement).value))}
            />
          </label>
        )}
      </div>
    </aside>
  )
}

/** What can be done with the photos selected in the pool. */
function SelectionBar() {
  const a = album.value!
  const sel = poolSelection.value
  const s = currentSpread.value
  // In pool order; photos hidden by a filter stay selected.
  const ids = [...a.pool.filter((id) => sel.has(id))]
  const { h, v } = selectionSlots(a, ids)
  const showTemplates = () => { selectionFocus.value = 'pool'; templateBrowserOpen.value = true }
  return (
    <div class="pool__selection">
      <div class="pool__selection-row">
        <span class="pool__selection-what">{plural(ids.length, 'photo')} selected <span class="count">{signature(h, v)}</span></span>
        <Button size="sm" variant="ghost" onClick={() => { poolSelection.value = new Set(); poolAnchor.value = null }}>Clear</Button>
      </div>
      <div class="pool__selection-row">
        <IconButton label="Turn left (⌘L)" onClick={() => void rotatePhotos(ids, -90)}><RotateCcw size={15} /></IconButton>
        <IconButton label="Turn right (⌘R)" onClick={() => void rotatePhotos(ids, 90)}><RotateCw size={15} /></IconButton>
        <span class="pool__selection-grow" />
        <Button size="sm" icon={<LayoutTemplate size={14} />} onClick={showTemplates} title={`Templates with frames for ${signature(h, v)}`}>Templates</Button>
        <Button size="sm" variant="primary" disabled={!s} onClick={() => addToCurrent(ids)}>
          Add to spread {s?.n}
        </Button>
      </div>
    </div>
  )
}
