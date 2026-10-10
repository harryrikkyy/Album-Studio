// Plan.tsx — the working surface: photo pool · the current spread · spread strip · inspector.

import { ChevronLeft, ChevronRight, ImageOff, PanelRight, PanelRightClose, SquarePen, TriangleAlert } from 'lucide-preact'
import { useEffect, useRef } from 'preact/hooks'
import { fileUrl } from '../bridge'
import { plural, shortPath, signature, templateLabel } from '../format'
import {
  album, currentPhotos, currentSpread, editCurrentSpread, goToSpread, hoveredPhoto, inspectorOpen, nextSpread,
  orientFilter, poolFilter, poolPhotos, setPoolFilter, setThumbSize, spreadIndex, thumbSize, toggleInspector,
} from '../state'
import type { Photo, Spread } from '../types'
import { Button, IconButton, Kbd, Segmented } from '../ui/controls'

function Pool() {
  const a = album.value!
  const photos = poolPhotos.value
  const onSpread = new Set(currentSpread.value?.photoIds ?? [])
  const unused = a.stats.photos - a.stats.used
  return (
    <aside class="pool" aria-label="Photos">
      <div class="pool__head">
        <div class="pool__title">
          <h2>Photos</h2>
          <span class="count">{photos.length === a.stats.photos ? a.stats.photos : `${photos.length} of ${a.stats.photos}`}</span>
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
          {poolFilter.value === 'unused' ? 'Every photo is placed. Nice.' : 'No photos match these filters.'}
        </div>
      ) : (
        <ul class="pool__grid" style={{ '--row': `${thumbSize.value}px` }}>
          {photos.map((p) => (
            <PoolTile p={p} onCurrent={onSpread.has(p.id)} key={p.id} />
          ))}
        </ul>
      )}
      <div class="pool__foot">
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
      </div>
    </aside>
  )
}

/** Width ÷ height, from the thumbnail; orientation decides when the size isn't known. */
function aspect(p: Photo): number {
  if (p.width && p.height) return Math.min(3, Math.max(0.33, p.width / p.height))
  return p.orient === 'v' ? 2 / 3 : 3 / 2
}

function PoolTile({ p, onCurrent }: { p: Photo; onCurrent: boolean }) {
  const used = p.usedOn.length > 0
  const ar = aspect(p)
  return (
    <li
      // Justified rows: every photo at its own shape, rows filled edge to edge.
      // A photo alone on its row stretches at most 1.6× rather than becoming a panorama crop.
      style={{ flexGrow: ar, flexBasis: `calc(var(--row) * ${ar.toFixed(3)})`, maxWidth: `calc(var(--row) * ${(ar * 1.6).toFixed(3)})` }}
      class={`tile ${used ? 'is-used' : ''} ${onCurrent ? 'is-current' : ''} ${hoveredPhoto.value === p.id ? 'is-hovered' : ''}`}
      title={`${p.base}${used ? ` · on spread ${p.usedOn.join(', ')}` : ''}`}
      onMouseEnter={() => (hoveredPhoto.value = p.id)}
      onMouseLeave={() => (hoveredPhoto.value = null)}
      onClick={() => p.usedOn[0] && goToSpread(p.usedOn[0] - 1)}
    >
      <img src={fileUrl(p.thumb)} alt={p.base} loading="lazy" decoding="async" draggable={false} />
      {used ? <span class="tile__badge" aria-label={`On spread ${p.usedOn.join(', ')}`}>{p.usedOn.join(',')}</span> : null}
    </li>
  )
}

function Stage() {
  const a = album.value!
  const s = currentSpread.value
  if (!s) return <section class="stage" />
  const photos = currentPhotos.value
  const h = photos.filter((p) => p.orient === 'h').length
  const v = photos.filter((p) => p.orient === 'v').length
  const total = a.spreads.length
  return (
    <section class="stage" aria-label={`Spread ${s.n}`}>
      <div class="stage__head">
        <div class="stage__nav">
          <IconButton label="Previous spread (←)" onClick={() => nextSpread(-1)} disabled={spreadIndex.value === 0}>
            <ChevronLeft size={18} />
          </IconButton>
          <h2 class="stage__title">
            Spread {s.n} <span class="stage__of">of {total}</span>
          </h2>
          <IconButton label="Next spread (→)" onClick={() => nextSpread(1)} disabled={spreadIndex.value >= total - 1}>
            <ChevronRight size={18} />
          </IconButton>
        </div>
        <div class="stage__facts">
          <span>{plural(photos.length, 'photo')}</span>
          <span class="dot" aria-hidden="true" />
          <span>{signature(h, v)}</span>
          <span class="dot" aria-hidden="true" />
          <span title={s.template?.name ?? ''}>{templateLabel(s.template?.name)}</span>
          {s.missingPhotos ? (
            <span class="pill pill--warn"><TriangleAlert size={12} /> {plural(s.missingPhotos, 'photo')} missing</span>
          ) : null}
        </div>
        <div class="stage__actions">
          <Button variant="primary" icon={<SquarePen size={15} />} onClick={editCurrentSpread} title="Open this spread in the editor (Return)">
            Edit spread
          </Button>
          <IconButton label={inspectorOpen.value ? 'Hide inspector' : 'Show inspector'} pressed={inspectorOpen.value} onClick={toggleInspector}>
            {inspectorOpen.value ? <PanelRightClose size={17} /> : <PanelRight size={17} />}
          </IconButton>
        </div>
      </div>
      <div class="stage__well">
        {s.proof ? (
          <img class="stage__spread" src={fileUrl(s.proof)} alt={`Spread ${s.n} proof`} decoding="async" key={s.proof} />
        ) : (
          <div class="stage__noproof">
            <ImageOff size={28} strokeWidth={1.4} />
            <p>No preview for spread {s.n} yet.</p>
          </div>
        )}
      </div>
      <Strip />
    </section>
  )
}

function Strip() {
  const a = album.value!
  const ref = useRef<HTMLOListElement>(null)
  const i = spreadIndex.value
  // Keep the current spread in view as the user moves through the album.
  useEffect(() => {
    const el = ref.current?.children[i] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [i])
  return (
    <ol class="strip" ref={ref} aria-label="Spreads">
      {a.spreads.map((s, idx) => (
        <li key={s.n}>
          <button
            type="button"
            class={`strip__item ${idx === i ? 'is-current' : ''}`}
            aria-current={idx === i ? 'true' : undefined}
            aria-label={`Spread ${s.n}, ${plural(s.photoIds.length, 'photo')}`}
            onClick={() => goToSpread(idx)}
          >
            <span class="strip__img">
              {s.proof ? <img src={fileUrl(s.proof)} alt="" loading="lazy" decoding="async" /> : null}
            </span>
            <span class="strip__n">{s.n}</span>
            <StatusDot s={s} />
          </button>
        </li>
      ))}
    </ol>
  )
}

function StatusDot({ s }: { s: Spread }) {
  const [cls, label] = s.missingPhotos
    ? ['warn', 'photos missing']
    : s.sheet
      ? ['ok', 'rendered']
      : s.photoIds.length
        ? ['plan', 'planned']
        : ['empty', 'empty']
  return <span class={`status-dot status-dot--${cls}`} title={label} aria-label={label} />
}

function Inspector() {
  const s = currentSpread.value
  if (!s || !inspectorOpen.value) return null
  const photos = currentPhotos.value
  return (
    <aside class="inspector" aria-label="Inspector">
      <section class="insp-section">
        <h3 class="insp-section__title">Template</h3>
        {s.template ? (
          <>
            <div class="insp-template">
              {s.template.preview ? <img src={fileUrl(s.template.preview)} alt="" decoding="async" /> : <span class="insp-template__none" />}
            </div>
            <dl class="facts">
              <dt>Name</dt><dd title={s.template.name ?? ''}>{templateLabel(s.template.name)}</dd>
              <dt>Slots</dt><dd>{signature(s.template.h ?? 0, s.template.v ?? 0)}</dd>
              <dt>File</dt><dd class="mono" title={s.template.file ?? ''}>{s.template.file ? shortPath(s.template.file, 2) : 'Not found on disk'}</dd>
            </dl>
          </>
        ) : (
          <p class="muted">No template on this spread.</p>
        )}
      </section>
      <section class="insp-section">
        <h3 class="insp-section__title">On this spread <span class="count">{photos.length}</span></h3>
        <ul class="insp-photos">
          {photos.map((p) => (
            <li
              class={hoveredPhoto.value === p.id ? 'is-hovered' : ''}
              onMouseEnter={() => (hoveredPhoto.value = p.id)}
              onMouseLeave={() => (hoveredPhoto.value = null)}
            >
              <img src={fileUrl(p.thumb)} alt="" loading="lazy" decoding="async" />
              <span class="insp-photos__name">{p.base}</span>
              <span class="insp-photos__orient">{p.orient === 'v' ? 'Portrait' : 'Landscape'}</span>
            </li>
          ))}
        </ul>
      </section>
      <section class="insp-section">
        <h3 class="insp-section__title">Status</h3>
        <dl class="facts">
          <dt>Preview</dt><dd>{s.proof ? 'Ready' : 'Not generated'}</dd>
          <dt>Print sheet</dt><dd>{s.sheet ? 'Rendered' : 'Not rendered'}</dd>
          <dt>Text & shapes</dt><dd>{s.edited ? 'Edited' : 'None'}</dd>
        </dl>
      </section>
      <p class="insp-hint"><Kbd keys={['←', '→']} /> move between spreads · <Kbd keys={['↩']} /> edit</p>
    </aside>
  )
}

export function Plan() {
  return (
    <div class={`place place--plan ${inspectorOpen.value ? '' : 'no-inspector'}`}>
      <Pool />
      <Stage />
      <Inspector />
    </div>
  )
}
