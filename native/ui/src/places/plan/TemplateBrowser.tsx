// TemplateBrowser.tsx — choose the current spread's template, under the spread so each choice
// shows in the preview a moment later. Templates that fit the spread's photos come first; all of
// the album's collections are a click away.

import { Check, Search, Shuffle, X } from 'lucide-preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { fileUrl } from '../../bridge'
import { autoTemplate, loadTemplates, setAutoTemplate, templates, templatesError } from '../../edit'
import { plural, signature, templateLabel } from '../../format'
import { setTemplate, shuffleTemplate } from '../../plan_actions'
import { filterTemplates, slotsOf } from '../../plan_logic'
import { album, currentSpread, stored, store, templateBrowserOpen } from '../../state'
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

  useEffect(() => { void loadTemplates() }, [a.path])
  useEffect(() => setLimit(PAGE), [fits, collection, text, s?.n])

  const slots = s ? slotsOf(a, s) : { h: 0, v: 0 }
  const all = templates.value
  const collections = useMemo(() => [...new Set((all ?? []).map((t) => t.collection))], [all])
  const fitting = useMemo(() => (all ? filterTemplates(all, { fits: true, ...slots, collection, text: '' }).length : 0), [all, slots.h, slots.v, collection])
  const list = useMemo(() => (all ? filterTemplates(all, { fits, ...slots, collection, text }) : []), [all, fits, slots.h, slots.v, collection, text])

  if (!s) return null
  const close = () => (templateBrowserOpen.value = false)

  return (
    <section
      class="tpl-browser"
      aria-label="Templates"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); close() }
      }}
    >
      <header class="tpl-browser__head">
        <h2 class="tpl-browser__title">
          Templates <span class="count">for {signature(slots.h, slots.v)}</span>
        </h2>
        <Segmented
          label="Which templates"
          value={fits ? 'fits' : 'all'}
          onChange={(v) => setFits(v === 'fits')}
          options={[
            { value: 'fits', label: `Fits this spread ${all ? fitting : ''}`, title: 'A frame for each photo, no empty frames' },
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
          <Button size="sm" variant="ghost" icon={<Shuffle size={14} />} onClick={() => void shuffleTemplate(s.n)} disabled={!s.photoIds.length} title="Another template that fits (S)">
            Shuffle
          </Button>
          <IconButton label="Close templates (Esc)" onClick={close}><X size={16} /></IconButton>
        </div>
      </header>

      {templatesError.value ? (
        <p class="notice notice--error" role="alert">{templatesError.value}</p>
      ) : !all ? (
        <ul class="tpl-grid" aria-busy="true">
          {Array.from({ length: 8 }, () => <li class="tpl-card tpl-card--skeleton"><span class="tpl-card__img" /></li>)}
        </ul>
      ) : !list.length ? (
        <div class="tpl-browser__empty">
          {fits && !text
            ? <>No template in {collection ?? 'these collections'} has exactly {signature(slots.h, slots.v)} frames. <button type="button" class="link" onClick={() => setFits(false)}>Show all templates</button></>
            : <>No templates match. <button type="button" class="link" onClick={() => { setText(''); setCollection(null) }}>Clear the search</button></>}
        </div>
      ) : (
        <ul class="tpl-grid" aria-label={plural(list.length, 'template')}>
          {list.slice(0, limit).map((t) => {
            const current = s.template?.id === t.id
            const fitsThis = t.h === slots.h && t.v === slots.v
            return (
              <li key={t.id}>
                <button
                  type="button"
                  class={`tpl-card ${current ? 'is-current' : ''}`}
                  aria-pressed={current}
                  onClick={() => { if (!current) void setTemplate(s.n, t.id) }}
                  title={`${t.name} · ${t.collection}`}
                >
                  <span class="tpl-card__img">
                    {t.preview ? <img src={fileUrl(t.preview)} alt="" loading="lazy" decoding="async" /> : null}
                    {current ? <span class="tpl-card__current"><Check size={12} /> Current</span> : null}
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
