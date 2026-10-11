// Plan.tsx — the working surface: photo pool · the current spread · spread strip (or the template
// browser) · inspector. Everything here edits the album; every edit can be undone.

import {
  ArrowLeftToLine, ArrowRightToLine, ChevronLeft, ChevronRight, Eraser, Ellipsis, LayoutTemplate, PanelRight,
  PanelRightClose, Plus, Shuffle, SquarePen, Trash2, TriangleAlert,
} from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { allowDrop, dragging, endDrag, payloadOf, startDrag } from '../dnd'
import { proofPending, proofUrl } from '../edit'
import { plural, signature, templateLabel } from '../format'
import { addPhotos, clearSpread, deleteSpread, insertSpread, moveSpread, shuffleTemplate } from '../plan_actions'
import { slotsOf, templateFits } from '../plan_logic'
import { sheetStateOf } from '../render'
import { album, currentSpread, editCurrentSpread, goToSpread, inspectorOpen, nextSpread, spreadIndex, templateBrowserOpen, toggleInspector } from '../state'
import type { Spread } from '../types'
import { Button, IconButton } from '../ui/controls'
import { Menu } from '../ui/Menu'
import { Inspector } from './plan/Inspector'
import { Pool } from './plan/Pool'
import { SpreadView } from './plan/SpreadView'
import { TemplateBrowser } from './plan/TemplateBrowser'

function StageHead({ s }: { s: Spread }) {
  const a = album.value!
  const total = a.spreads.length
  const { h, v } = slotsOf(a, s)
  const fits = templateFits(a, s)
  return (
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
        <span>{plural(s.photoIds.length, 'photo')}</span>
        <span class="dot" aria-hidden="true" />
        <span>{signature(h, v)}</span>
        <span class="dot" aria-hidden="true" />
        <button type="button" class="stage__tpl" title={`${s.template?.name ?? 'No template'} — choose another (T)`} onClick={() => (templateBrowserOpen.value = !templateBrowserOpen.value)}>
          {templateLabel(s.template?.name)}
        </button>
        {fits === false && s.photoIds.length ? (
          <span class="pill pill--warn" title="The template's frames don't match the photos"><TriangleAlert size={12} /> Doesn’t fit</span>
        ) : null}
        {s.missingPhotos ? (
          <span class="pill pill--warn"><TriangleAlert size={12} /> {plural(s.missingPhotos, 'photo')} missing</span>
        ) : null}
      </div>
      <div class="stage__actions">
        <IconButton label="Templates (T)" pressed={templateBrowserOpen.value} onClick={() => (templateBrowserOpen.value = !templateBrowserOpen.value)}>
          <LayoutTemplate size={17} />
        </IconButton>
        <IconButton label="Shuffle template (S)" disabled={!s.photoIds.length} onClick={() => void shuffleTemplate(s.n)}>
          <Shuffle size={16} />
        </IconButton>
        <Menu
          label="Spread actions"
          icon={<Ellipsis size={18} />}
          items={[
            { label: 'New spread after this', icon: <Plus size={15} />, onSelect: () => void insertSpread(s.n + 1) },
            { label: 'New spread before this', icon: <Plus size={15} />, onSelect: () => void insertSpread(s.n) },
            { label: 'Move left', icon: <ArrowLeftToLine size={15} />, hint: '⌥←', disabled: s.n === 1, onSelect: () => void moveSpread(s.n, s.n - 1), separatorBefore: true },
            { label: 'Move right', icon: <ArrowRightToLine size={15} />, hint: '⌥→', disabled: s.n === total, onSelect: () => void moveSpread(s.n, s.n + 1) },
            { label: 'Clear spread', icon: <Eraser size={15} />, disabled: !s.photoIds.length && !s.template, onSelect: () => void clearSpread(s.n), separatorBefore: true },
            { label: 'Delete spread', icon: <Trash2 size={15} />, danger: true, onSelect: () => void deleteSpread(s.n) },
          ]}
        />
        <Button variant="primary" icon={<SquarePen size={15} />} onClick={editCurrentSpread} title="Open this spread in the editor (Return)">
          Edit spread
        </Button>
        <IconButton label={inspectorOpen.value ? 'Hide inspector' : 'Show inspector'} pressed={inspectorOpen.value} onClick={toggleInspector}>
          {inspectorOpen.value ? <PanelRightClose size={17} /> : <PanelRight size={17} />}
        </IconButton>
      </div>
    </div>
  )
}

function Stage() {
  const s = currentSpread.value
  if (!s) return <section class="stage" />
  return (
    <section class={`stage ${templateBrowserOpen.value ? 'has-browser' : ''}`} aria-label={`Spread ${s.n}`}>
      <StageHead s={s} />
      <div class="stage__well">
        <SpreadView s={s} />
      </div>
      {templateBrowserOpen.value ? <TemplateBrowser /> : <Strip />}
    </section>
  )
}

function Strip() {
  const a = album.value!
  const ref = useRef<HTMLOListElement>(null)
  const i = spreadIndex.value
  const [over, setOver] = useState<number | null>(null)
  const drag = dragging.value
  const pending = proofPending.value
  useEffect(() => { if (!drag) setOver(null) }, [drag])
  // Keep the current spread in view as the user moves through the album.
  useEffect(() => {
    const el = ref.current?.children[i] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [i])

  return (
    <ol class="strip" ref={ref} aria-label="Spreads">
      {a.spreads.map((s, idx) => {
        const mode = drag?.kind === 'spread' ? (drag.n !== s.n ? 'move' : null) : drag?.kind === 'photos' && drag.from?.n !== s.n ? 'add' : null
        return (
          <li key={s.n}>
            <button
              type="button"
              class={`strip__item ${idx === i ? 'is-current' : ''} ${over === s.n && mode ? `is-${mode}` : ''} ${drag?.kind === 'spread' && drag.n === s.n ? 'is-source' : ''}`}
              aria-current={idx === i ? 'true' : undefined}
              aria-label={`Spread ${s.n}, ${plural(s.photoIds.length, 'photo')}`}
              title={`Spread ${s.n} — drag to reorder; drop photos here to add them`}
              draggable
              onClick={() => goToSpread(idx)}
              onDragStart={(e) => startDrag(e, { kind: 'spread', n: s.n })}
              onDragEnd={endDrag}
              onDragOver={(e) => {
                const p = payloadOf(e)
                const ok = p?.kind === 'spread' ? p.n !== s.n : p?.kind === 'photos' && p.from?.n !== s.n
                if (!ok) return
                allowDrop(e, p?.kind === 'photos' && e.altKey)
                if (over !== s.n) setOver(s.n)
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => {
                const p = payloadOf(e)
                setOver(null)
                endDrag()
                if (!p) return
                e.preventDefault()
                if (p.kind === 'spread') void moveSpread(p.n, s.n)
                else if (p.from?.n !== s.n) void addPhotos(s.n, p.ids, { copy: e.altKey })
              }}
            >
              <span class={`strip__img ${pending.has(s.n) ? 'is-pending' : ''}`}>
                {s.proof ? <img src={proofUrl(s)} alt="" loading="lazy" decoding="async" draggable={false} /> : null}
              </span>
              <span class="strip__n">{s.n}</span>
              <StatusDot s={s} />
            </button>
          </li>
        )
      })}
      <li>
        <button type="button" class="strip__add" onClick={() => void insertSpread(a.spreads.length + 1)} title="Add a spread at the end">
          <Plus size={18} />
          <span class="visually-hidden">Add a spread at the end</span>
        </button>
      </li>
    </ol>
  )
}

function StatusDot({ s }: { s: Spread }) {
  const a = album.value!
  const fits = templateFits(a, s)
  const sheet = sheetStateOf(s.n)?.state ?? (s.sheet ? 'current' : null)
  const [cls, label] = s.missingPhotos
    ? ['warn', 'photos missing']
    : fits === false && s.photoIds.length
      ? ['warn', 'template doesn’t fit the photos']
      : sheet === 'current'
        ? ['ok', 'rendered, up to date']
        : sheet === 'stale'
          ? ['stale', 'changed since its sheet was rendered']
          : s.photoIds.length
            ? ['plan', 'planned, not rendered']
            : ['empty', 'empty']
  return <span class={`status-dot status-dot--${cls}`} title={label} aria-label={label} />
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
