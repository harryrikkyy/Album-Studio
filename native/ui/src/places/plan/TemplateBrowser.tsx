// TemplateBrowser.tsx — templates, under the spread so each choice shows in the preview a moment
// later. For the current spread: templates that fit its photos come first, a click sets one. For
// photos selected in the pool: templates that fit them, and a click puts them on a spread with it
// (the current one when empty, else a new one after it). All collections are a click away.

import { Check, Search, Shuffle, X } from 'lucide-preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { fileUrl } from '../../bridge'
import { autoTemplate, loadTemplates, setAutoTemplate, templates, templatesError } from '../../edit'
import { plural, signature, templateLabel } from '../../format'
import { placeWithTemplate, setTemplate, shuffleTemplate } from '../../plan_actions'
import { albumShape, filterTemplates, selectionSlots, shapeOf, sizeWords, slotsOf } from '../../plan_logic'
import { album, currentSpread, poolSelection, selectionFocus, stored, store, templateBrowserOpen } from '../../state'
import { Button, IconButton, Segmented } from '../../ui/controls'

const PAGE = 120

export function TemplateBrowser() {
  const a = album.value!
  const s = currentSpread.value
  const [fits, setFits] = useState(true)
  const [collection, setCollection] = useState<string | null>(stored<string | null>('as.tplCollection', null))
  const [text, setText] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const search = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    search.current?.focus()
    return () => {
      if (opener?.isConnected && opener.getClientRects().length) opener.focus()
      else document.getElementById('spread-heading')?.focus()
    }
  }, [])

  // The pool's selection, in pool order, when templates are for it.
  const picked = poolSelection.value
  const selIds = useMemo(() => a.pool.filter((id) => picked.has(id)), [a.pool, picked])
  const forSelection = selectionFocus.value === 'pool' && selIds.length > 0

  useEffect(() => { void loadTemplates() }, [a.path])
  useEffect(() => setLimit(PAGE), [fits, collection, text, s?.n, forSelection, selIds.length])

  const slots = forSelection ? selectionSlots(a, selIds) : s ? slotsOf(a, s) : { h: 0, v: 0 }
  const all = templates.value
  const collections = useMemo(() => [...new Set((all ?? []).map((t) => t.collection))], [all])
  // The album keeps to one page shape: "fits" means that shape too; others are marked.
  const shape = useMemo(() => (all ? albumShape(a, all) : null), [all, a.spreads])
  const fitting = useMemo(() => (all ? filterTemplates(all, { fits: true, ...slots, collection, text: '', shape }).length : 0), [all, slots.h, slots.v, collection, shape])
  const list = useMemo(() => (all ? filterTemplates(all, { fits, ...slots, collection, text, shape }) : []), [all, fits, slots.h, slots.v, collection, text, shape])

  if (!s) return null
  const close = () => (templateBrowserOpen.value = false)
  const target = !s.photoIds.length ? `spread ${s.n}` : `a new spread after spread ${s.n}`

  return (
    <section
      class="tpl-browser"
      aria-label="Templates"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
      }}
    >
      <header class="tpl-browser__head">
        <h2 class="tpl-browser__title">
          Templates <span class="count">for {signature(slots.h, slots.v)}</span>
        </h2>
        {selIds.length ? (
          <Segmented
            label="Templates for"
            value={forSelection ? 'selection' : 'spread'}
            onChange={(v) => (selectionFocus.value = v === 'selection' ? 'pool' : 'spread')}
            options={[
              { value: 'selection', label: `${plural(selIds.length, 'selected photo')}`, title: 'Templates for the photos selected on the left' },
              { value: 'spread', label: `Spread ${s.n}`, title: 'Templates for the photos on this spread' },
            ]}
          />
        ) : null}
        <Segmented
          label="Which templates"
          value={fits ? 'fits' : 'all'}
          onChange={(v) => setFits(v === 'fits')}
          options={[
            { value: 'fits', label: `${forSelection ? 'Fits them' : 'Fits this spread'} ${all ? fitting : ''}`, title: 'A frame for each photo, no empty frames' },
            { value: 'all', label: 'All' },
          ]}
        />
        <label class="select">
          <span class="visually-hidden">Collection</span>
          <select
            value={collection ?? ''}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value || null
              setCollection(v)
              store('as.tplCollection', v)
            }}
          >
            <option value="">All collections</option>
            {collections.map((c) => <option value={c}>{c}</option>)}
          </select>
        </label>
        <label class="search">
          <Search size={14} aria-hidden="true" />
          <span class="visually-hidden">Search templates by name</span>
          <input ref={search} type="search" placeholder="Name, e.g. 0019" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
        </label>
        <div class="tpl-browser__actions">
          <label class="check check--inline" title="When photos are added or removed, switch to a template that fits them">
            <input type="checkbox" checked={autoTemplate.value} onChange={(e) => setAutoTemplate((e.target as HTMLInputElement).checked)} />
            <span>Follow photos</span>
          </label>
          {forSelection ? null : (
            <Button size="sm" variant="ghost" icon={<Shuffle size={14} />} onClick={() => void shuffleTemplate(s.n)} disabled={!s.photoIds.length} title="Another template that fits (S)">
              Shuffle
            </Button>
          )}
          <IconButton label="Close templates (Esc)" onClick={close}><X size={16} /></IconButton>
        </div>
      </header>
      {forSelection ? <p class="tpl-browser__hint">Click a template to put the {plural(selIds.length, 'selected photo')} on {target} with it.</p> : null}

      {templatesError.value ? (
        <div class="notice notice--error" role="alert"><p>{templatesError.value}</p><Button size="sm" onClick={() => void loadTemplates()}>Try loading templates again</Button></div>
      ) : !all ? (
        <ul class="tpl-grid" aria-busy="true">
          {Array.from({ length: 8 }, () => <li class="tpl-card tpl-card--skeleton"><span class="tpl-card__img" /></li>)}
        </ul>
      ) : !list.length ? (
        <div class="tpl-browser__empty">
          {fits && !text
            ? <>No template in {collection ?? 'these collections'} has exactly {signature(slots.h, slots.v)} frames{shape ? ' in this album’s page size' : ''}.{forSelection ? ' Turn sideways photos upright first if some are portraits.' : ''} <button type="button" class="link" onClick={() => setFits(false)}>Show all templates</button></>
            : <>No templates match. <button type="button" class="link" onClick={() => { setText(''); setCollection(null) }}>Clear the search</button></>}
        </div>
      ) : (
        <ul class="tpl-grid" aria-label={plural(list.length, 'template')}>
          {list.slice(0, limit).map((t) => {
            const current = !forSelection && s.template?.id === t.id
            const fitsThis = t.h === slots.h && t.v === slots.v
            const otherSize = !!shape && !!shapeOf(t) && shapeOf(t) !== shape
            return (
              <li key={t.id}>
                <button
                  type="button"
                  class={`tpl-card ${current ? 'is-current' : ''}`}
                  aria-pressed={forSelection ? undefined : current}
                  onClick={() => {
                    if (forSelection) void placeWithTemplate(selIds, t.id, t.name)
                    else if (!current) void setTemplate(s.n, t.id)
                  }}
                  title={`${t.name} · ${t.collection} · ${sizeWords(t)}${otherSize ? ' (not this album’s page size)' : ''}${forSelection ? `\nPut the selected photos on ${target} with this template` : ''}`}
                >
                  <span class="tpl-card__img">
                    {t.preview ? <img src={fileUrl(t.preview)} alt="" loading="lazy" decoding="async" /> : null}
                    {current ? <span class="tpl-card__current"><Check size={12} /> Current</span> : null}
                    {otherSize ? <span class="tpl-card__size">Other size</span> : null}
                  </span>
                  <span class="tpl-card__cap">
                    <span class="tpl-card__name">{templateLabel(t.name)}</span>
                    <span class={`tpl-card__slots ${fitsThis ? '' : 'is-off'}`}>{signature(t.h, t.v)}</span>
                  </span>
                  {collection ? null : <span class="tpl-card__coll">{t.collection}</span>}
                </button>
              </li>
            )
          })}
          {list.length > limit ? (
            <li class="tpl-grid__more">
              <Button size="sm" onClick={() => setLimit(limit + PAGE * 2)}>Show more ({list.length - limit})</Button>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  )
}
