// Pool.tsx — every photo of the album. Select (click, ⌘-click, ⇧-click), then drag onto a spread
// or double-click to add to the current one. Dropping a photo from a spread here takes it off.
// The selection toolbar turns photos (also ⌘L / ⌘R), shows their landscape/portrait mix, and
// offers templates that fit. Options contain no nested controls, so screen readers can select them.

import {
  Check,
  ChevronLeft,
  ChevronRight,
  LayoutTemplate,
  RotateCcw,
  RotateCw,
  Search,
  Undo2,
  WandSparkles,
} from 'lucide-preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { allowDrop, dragging, endDrag, payloadOf, startDrag } from '../../dnd'
import { plural, signature } from '../../format'
import { addPhotos, removePhotos, rotatePhotos } from '../../plan_actions'
import { rangeSelect, seenAspect, selectionSlots } from '../../plan_logic'
import {
  album,
  currentSpread,
  goToSpread,
  hoveredPhoto,
  orientFilter,
  planView,
  poolAnchor,
  poolFilter,
  poolPhotos,
  poolSelection,
  selectionFocus,
  setPoolFilter,
  setThumbSize,
  templateBrowserOpen,
  thumbSize,
} from '../../state'
import type { Photo } from '../../types'
import { Button, IconButton, Segmented } from '../../ui/controls'
import { Thumb } from '../../ui/Thumb'
import { openAutoFill } from './AutoFill'
import { openAlbumSettings } from '../../app/AlbumSettings'
import { PHOTO_PAGE_SIZE, photoKeyIndex, photoWindow } from '../../pool_logic'

/** Width ÷ height as the photo is seen (after its turn), kept within reason for the rows. */
function aspect(p: Photo): number {
  return Math.min(3, Math.max(0.33, seenAspect(p)))
}

function select(p: Photo, e: MouseEvent | KeyboardEvent, order: readonly Photo[], toggle = false) {
  selectionFocus.value = 'pool'
  const sel = new Set(poolSelection.value)
  if (e.shiftKey) {
    const ids = order.map((x) => x.id)
    for (const id of rangeSelect(ids, poolAnchor.value, p.id)) sel.add(id)
  } else if (e.metaKey || e.ctrlKey || toggle) {
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

async function addToCurrent(ids: string[], copy = false) {
  const s = currentSpread.value
  const a = album.value
  if (!a) return
  if (!s) {
    planView.value = 'spread'
    requestAnimationFrame(() => document.getElementById('first-spread-button')?.focus())
    return
  }
  const result = await addPhotos(s.n, ids, { copy })
  if (result && album.value?.path === a.path && planView.value === 'photos') {
    goToSpread(s.n - 1)
    requestAnimationFrame(() => document.getElementById('spread-heading')?.focus())
  }
}

function PoolTile({
  p,
  onCurrent,
  selected,
  tabIndex,
  position,
  total,
  order,
  onFocus,
  onMove,
}: {
  p: Photo
  onCurrent: boolean
  selected: boolean
  tabIndex: number
  position: number
  total: number
  order: readonly Photo[]
  onFocus: () => void
  onMove: (key: string) => boolean
}) {
  const used = p.usedOn.length > 0
  const ar = aspect(p)
  return (
    <li
      // Justified rows: every photo at its own shape, rows filled edge to edge.
      // A photo alone on its row stretches at most 1.6× rather than becoming a panorama crop.
      style={{
        flexGrow: ar,
        flexBasis: `calc(var(--row) * ${ar.toFixed(3)})`,
        maxWidth: `calc(var(--row) * ${(ar * 1.6).toFixed(3)})`,
      }}
      class={`tile ${used ? 'is-used' : ''} ${onCurrent ? 'is-current' : ''} ${selected ? 'is-selected' : ''} ${hoveredPhoto.value === p.id ? 'is-hovered' : ''}`}
      role="option"
      aria-selected={selected}
      aria-label={`${p.base}${used ? ` · on spread ${p.usedOn.join(', ')}` : ' · unused'}`}
      aria-posinset={position}
      aria-setsize={total}
      tabIndex={tabIndex}
      onFocus={onFocus}
      title={`${p.base}${used ? ` · on spread ${p.usedOn.join(', ')}` : ''}\nDouble-click to add to this spread`}
      draggable
      onDragStart={(e) => {
        const ids = dragSet(p)
        if (!poolSelection.value.has(p.id)) {
          poolSelection.value = new Set([p.id])
          poolAnchor.value = p.id
        }
        const a = album.value!
        startDrag(
          e,
          { kind: 'photos', ids },
          ids.map((id) => a.photos[id]?.thumb ?? ''),
        )
      }}
      onDragEnd={endDrag}
      onMouseEnter={() => (hoveredPhoto.value = p.id)}
      onMouseLeave={() => (hoveredPhoto.value = null)}
      onClick={(e) => select(p, e, order)}
      onDblClick={() => addToCurrent(dragSet(p))}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.altKey || e.metaKey || e.ctrlKey) return
        if (e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          select(p, e, order, true)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          e.stopPropagation()
          addToCurrent(dragSet(p))
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          poolSelection.value = new Set()
          poolAnchor.value = null
        } else if (onMove(e.key)) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      <Thumb p={p} />
      <span class="tile__name" aria-hidden="true">
        {p.base}
      </span>
      {selected ? (
        <span class="tile__check" aria-hidden="true">
          <Check size={11} strokeWidth={3} />
        </span>
      ) : null}
      {used ? (
        <span class="tile__badge" aria-hidden="true" title={`On spread ${p.usedOn.join(', ')}`}>
          {p.usedOn.join(',')}
        </span>
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
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [active, setActive] = useState<string | null>(null)
  const grid = useRef<HTMLUListElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const focusNext = useRef<string | null>(null)
  const pageInfo = useMemo(() => photoWindow(photos, query, page), [photos, query, page])
  const tabStop = pageInfo.visible.find((p) => p.id === active)?.id ?? pageInfo.visible[0]?.id
  const resultIds = useMemo(() => new Set(pageInfo.matches.map((p) => p.id)), [pageInfo.matches])
  const hiddenSelected = [...sel].filter((id) => !resultIds.has(id)).length
  useEffect(() => {
    setPage(0)
  }, [query, poolFilter.value, orientFilter.value, a.path])
  useLayoutEffect(() => {
    if (grid.current) grid.current.scrollTop = 0
  }, [pageInfo.index, query])
  useLayoutEffect(() => {
    if (!focusNext.current) return
    const index = pageInfo.visible.findIndex((p) => p.id === focusNext.current)
    if (index < 0) return
    grid.current?.querySelectorAll<HTMLElement>('[role="option"]')[index]?.focus()
    focusNext.current = null
  }, [pageInfo.visible])
  const moveFocus = (p: Photo, key: string) => {
    const target = photoKeyIndex(
      key,
      pageInfo.matches.findIndex((x) => x.id === p.id),
      pageInfo.matches.length,
    )
    if (target === null) return false
    const id = pageInfo.matches[target]!.id
    focusNext.current = id
    setActive(id)
    setPage(Math.floor(target / PHOTO_PAGE_SIZE))
    // The current page may not change, so focus it immediately as well.
    if (Math.floor(target / PHOTO_PAGE_SIZE) === pageInfo.index) {
      grid.current?.querySelectorAll<HTMLElement>('[role="option"]')[target - pageInfo.offset]?.focus()
      focusNext.current = null
    }
    return true
  }
  const drag = dragging.value
  // Photos dragged off a spread can be dropped back here.
  const takesBack = drag?.kind === 'photos' && !!drag.from
  return (
    <aside
      class={`pool ${over ? 'is-drop' : ''}`}
      aria-label="Photos"
      onDragOver={(e) => {
        const p = payloadOf(e)
        if (p?.kind === 'photos' && p.from) {
          allowDrop(e)
          setOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(false)
      }}
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
          <span class="count" role="status">
            {pageInfo.matches.length === a.stats.photos
              ? a.stats.photos
              : `${pageInfo.matches.length} of ${a.stats.photos}`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            class="pool__autofill"
            icon={<WandSparkles size={14} />}
            onClick={openAutoFill}
            title="Plan every spread from the photos"
          >
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
              { value: 'h', label: 'H', title: 'Landscape only', ariaLabel: 'Landscape only' },
              { value: 'v', label: 'V', title: 'Portrait only', ariaLabel: 'Portrait only' },
            ]}
          />
        </div>
        <label class="search pool__search">
          <Search size={14} aria-hidden="true" />
          <span class="visually-hidden">Search photos by file name</span>
          <input
            ref={search}
            type="search"
            placeholder="Find a photo…"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
      </div>
      <p id="pool-keys" class="visually-hidden">
        Arrow keys move between photos. Space selects or deselects; Shift Space selects a range. Enter adds the
        selection to the current spread. Home and End reach the first and last result.
      </p>
      {pageInfo.matches.length === 0 ? (
        <div class="pool__empty">
          <p>
            {!a.stats.photos
              ? 'No photos in this album yet.'
              : !query && poolFilter.value === 'unused' && orientFilter.value === 'any'
                ? 'Every photo is placed.'
                : 'No photos match these filters.'}
          </p>
          {!a.stats.photos ? (
            <Button size="sm" onClick={openAlbumSettings}>
              Add photo folders…
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                setQuery('')
                setPoolFilter('all')
                orientFilter.value = 'any'
              }}
            >
              Show all photos
            </Button>
          )}
        </div>
      ) : (
        <ul
          ref={grid}
          class="pool__grid"
          style={{ '--row': `${thumbSize.value}px` }}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Photos"
          aria-describedby="pool-keys"
        >
          {pageInfo.visible.map((p, index) => (
            <PoolTile
              p={p}
              onCurrent={onSpread.has(p.id)}
              selected={sel.has(p.id)}
              key={p.id}
              tabIndex={p.id === tabStop ? 0 : -1}
              position={pageInfo.offset + index + 1}
              total={pageInfo.matches.length}
              order={pageInfo.matches}
              onFocus={() => setActive(p.id)}
              onMove={(key) => moveFocus(p, key)}
            />
          ))}
        </ul>
      )}
      {takesBack ? (
        <div class="pool__dropnote" aria-hidden="true">
          <Undo2 size={16} /> Drop to take {drag.ids.length > 1 ? 'these photos' : 'this photo'} off spread{' '}
          {drag.from!.n}
        </div>
      ) : null}
      <div class="pool__foot">
        {pageInfo.pages > 1 ? (
          <div class="pool__pages" aria-label="Photo pages">
            <IconButton
              label="Previous photo page"
              disabled={pageInfo.index === 0}
              onClick={() => setPage(pageInfo.index - 1)}
            >
              <ChevronLeft size={15} />
            </IconButton>
            <span role="status">
              {pageInfo.offset + 1}–{pageInfo.offset + pageInfo.visible.length} of {pageInfo.matches.length}
            </span>
            <IconButton
              label="Next photo page"
              disabled={pageInfo.index === pageInfo.pages - 1}
              onClick={() => setPage(pageInfo.index + 1)}
            >
              <ChevronRight size={15} />
            </IconButton>
          </div>
        ) : null}
        {hiddenSelected ? (
          <p class="pool__hidden-selection">{plural(hiddenSelected, 'selected photo')} outside these filters</p>
        ) : null}
        {sel.size ? (
          <SelectionBar
            onClear={() => {
              poolSelection.value = new Set()
              poolAnchor.value = null
              requestAnimationFrame(() =>
                (grid.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ?? search.current)?.focus(),
              )
            }}
          />
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
function SelectionBar({ onClear }: { onClear: () => void }) {
  const a = album.value!
  const sel = poolSelection.value
  const s = currentSpread.value
  // In pool order; photos hidden by a filter stay selected.
  const ids = [...a.pool.filter((id) => sel.has(id))]
  const { h, v } = selectionSlots(a, ids)
  const one = ids.length === 1 ? a.photos[ids[0]!] : null
  const showTemplates = () => {
    selectionFocus.value = 'pool'
    planView.value = 'spread'
    templateBrowserOpen.value = true
  }
  return (
    <div class="pool__selection">
      <div class="pool__selection-row">
        <span class="pool__selection-what">
          {plural(ids.length, 'photo')} selected <span class="count">{signature(h, v)}</span>
        </span>
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
      </div>
      {one?.usedOn.length ? (
        <label class="select pool__placements">
          <span class="visually-hidden">Go to a spread using the selected photo</span>
          <select
            value=""
            onChange={(e) => {
              goToSpread(Number(e.currentTarget.value) - 1)
              e.currentTarget.value = ''
              requestAnimationFrame(() => document.getElementById('spread-heading')?.focus())
            }}
          >
            <option value="" disabled>
              Show where this photo is used…
            </option>
            {one.usedOn.map((n) => (
              <option value={n} key={n}>
                Spread {n}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div class="pool__selection-row">
        <IconButton label="Turn left (⌘L)" onClick={() => void rotatePhotos(ids, -90)}>
          <RotateCcw size={15} />
        </IconButton>
        <IconButton label="Turn right (⌘R)" onClick={() => void rotatePhotos(ids, 90)}>
          <RotateCw size={15} />
        </IconButton>
        <span class="pool__selection-grow" />
        <Button
          size="sm"
          icon={<LayoutTemplate size={14} />}
          onClick={showTemplates}
          title={`Templates with frames for ${signature(h, v)}`}
        >
          Templates
        </Button>
        <Button size="sm" variant="primary" onClick={() => addToCurrent(ids)}>
          {s ? `Add to spread ${s.n}` : 'Start a spread'}
        </Button>
      </div>
    </div>
  )
}
