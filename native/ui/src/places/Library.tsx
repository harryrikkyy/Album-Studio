// Library.tsx — the template collections across albums: the ones albums use and any added here,
// each browsable by frame layout and name; which ones new albums start with; and, with an album
// open, which ones it draws from. The library only remembers folders: it never copies, moves or
// deletes them.

import { BookCheck, FolderOpen, FolderPlus, LayoutTemplate, Library as LibraryIcon, Search, X } from 'lucide-preact'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { call, fileUrl } from '../bridge'
import { applyUpdate, forgetTemplateCatalogue, type UpdateResult } from '../edit'
import { reveal } from '../exporting'
import { plural, shortPath, signature, templateLabel } from '../format'
import type { Template } from '../plan_logic'
import { album, toast } from '../state'
import { Button, IconButton } from '../ui/controls'

interface Coll { path: string; name: string; exists: boolean; templates: number; albums: string[]; isDefault: boolean }

const PAGE = 160

export function Library() {
  const a = album.value
  const [colls, setColls] = useState<Coll[] | null>(null)
  const [current, setCurrent] = useState<string | null>(null)
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [layout, setLayout] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [limit, setLimit] = useState(PAGE)

  const reload = async () => {
    try {
      const r = await call<{ collections: Coll[] }>('library.collections')
      setColls(r.collections)
      if (!current && r.collections[0]) setCurrent(r.collections[0].path)
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }
  useEffect(() => { void reload() }, [])
  useEffect(() => {
    setTemplates(null); setLayout(null); setText(''); setLimit(PAGE)
    if (current) void call<Template[]>('library.templates', { path: current }, 60_000).then(setTemplates).catch(() => setTemplates([]))
  }, [current])

  const coll = colls?.find((c) => c.path === current) ?? null
  const layouts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of templates ?? []) m.set(`${t.h}|${t.v}`, (m.get(`${t.h}|${t.v}`) ?? 0) + 1)
    return [...m].sort((x, y) => {
      const [xh, xv] = x[0].split('|').map(Number)
      const [yh, yv] = y[0].split('|').map(Number)
      return xh! + xv! - (yh! + yv!) || xh! - yh!
    })
  }, [templates])
  const shown = (templates ?? []).filter((t) => (!layout || `${t.h}|${t.v}` === layout) && t.name.toLowerCase().includes(text.trim().toLowerCase()))

  const add = async () => {
    const r = await call<string | string[] | null>('dialog.pickFolder', { title: 'Add template collections', multiple: true }).catch(() => null)
    const paths = r === null ? [] : Array.isArray(r) ? r : [r]
    if (!paths.length) return
    const next = await call<{ collections: Coll[] }>('library.add', { paths })
    setColls(next.collections)
    setCurrent(paths[0]!)
  }
  const remove = async (c: Coll) => {
    const next = await call<{ collections: Coll[] }>('library.remove', { path: c.path })
    setColls(next.collections)
    if (current === c.path) setCurrent(next.collections[0]?.path ?? null)
    toast('info', `${c.name} is out of the library. Its folder is untouched; add it again any time.`)
  }
  const toggleDefault = async (c: Coll) => {
    const paths = (colls ?? []).filter((x) => (x.path === c.path ? !x.isDefault : x.isDefault)).map((x) => x.path)
    const next = await call<{ collections: Coll[] }>('library.setDefaults', { paths })
    setColls(next.collections)
  }
  const inAlbum = (p: string) => !!a?.templateCollections.some((c) => c.path === p)
  const toggleInAlbum = async (c: Coll) => {
    if (!a) return
    const paths = inAlbum(c.path) ? a.templateCollections.map((x) => x.path).filter((p) => p !== c.path) : [...a.templateCollections.map((x) => x.path), c.path]
    try {
      const r = await call<UpdateResult>('album.setFolders', { album: a.path, templateCollections: paths })
      forgetTemplateCatalogue()
      applyUpdate(r)
      toast('info', `${c.name} ${inAlbum(c.path) ? 'is no longer' : 'is now'} one of ${a.name}’s collections. ⌘Z undoes it.`)
    } catch (e) {
      toast('error', (e as Error).message)
    }
  }

  return (
    <section class="place place--library" aria-label="Library">
      <nav class="tools-nav lib-nav" aria-label="Template collections">
        <div class="lib-nav__head">
          <h1 class="tools-nav__title">Library</h1>
          <IconButton label="Add template collections" onClick={add}><FolderPlus size={16} /></IconButton>
        </div>
        {colls === null ? <p class="muted lib-nav__note">Looking at your albums…</p> : !colls.length ? (
          <p class="muted lib-nav__note">No collections yet. Add the folders of template PSDs you design with.</p>
        ) : colls.map((c) => (
          <button type="button" class={`tools-nav__item ${current === c.path ? 'is-current' : ''}`} aria-current={current === c.path ? 'page' : undefined} onClick={() => setCurrent(c.path)} title={c.path}>
            <span class="tools-nav__icon" aria-hidden="true"><LayoutTemplate size={16} /></span>
            <span>
              <span class="tools-nav__label">{c.name}</span>
              <span class="tools-nav__hint">{c.exists ? plural(c.templates, 'template') : 'Drive not connected'}{c.albums.length ? ` · ${plural(c.albums.length, 'album')}` : ''}{c.isDefault ? ' · for new albums' : ''}</span>
            </span>
          </button>
        ))}
      </nav>

      <div class="tools-body">
        {!coll ? (
          <div class="empty">
            <LibraryIcon size={28} strokeWidth={1.4} />
            <h3 class="empty__title">Your template collections</h3>
            <p class="empty__text">Collections your albums use show here on their own. Add others to keep them at hand for new albums.</p>
            <Button variant="primary" icon={<FolderPlus size={15} />} onClick={add}>Add collections…</Button>
          </div>
        ) : (
          <div class="tool">
            <header class="tool__head">
              <div>
                <h2 class="tool__title"><LayoutTemplate size={17} /> {coll.name}</h2>
                <p class="tool__sub"><span class="mono" title={coll.path}>{shortPath(coll.path, 3)}</span>{coll.albums.length ? ` · used by ${coll.albums.slice(0, 3).join(', ')}${coll.albums.length > 3 ? '…' : ''}` : ''}</p>
              </div>
              <div class="place__actions">
                <label class="check check--inline" title="New albums start with this collection ticked">
                  <input type="checkbox" checked={coll.isDefault} onChange={() => void toggleDefault(coll)} />
                  <span>For new albums</span>
                </label>
                {a ? (
                  <Button size="sm" icon={<BookCheck size={14} />} onClick={() => void toggleInAlbum(coll)} disabled={!coll.exists}>
                    {inAlbum(coll.path) ? `Remove from ${a.name}` : `Use in ${a.name}`}
                  </Button>
                ) : null}
                <IconButton label="Show in Finder" onClick={() => reveal(coll.path)} disabled={!coll.exists}><FolderOpen size={16} /></IconButton>
                <IconButton label="Take out of the library (the folder stays)" onClick={() => void remove(coll)}><X size={16} /></IconButton>
              </div>
            </header>
            {!coll.exists ? <p class="notice notice--error">This collection’s drive isn’t connected.</p> : (
              <>
                <div class="lab-bar lib-filter">
                  <div class="lib-layouts" role="radiogroup" aria-label="Frame layout">
                    <button type="button" role="radio" aria-checked={!layout} class={`chip-btn ${!layout ? 'is-on' : ''}`} onClick={() => setLayout(null)}>All {templates?.length ?? ''}</button>
                    {layouts.map(([k, n]) => {
                      const [h, v] = k.split('|').map(Number)
                      return <button type="button" role="radio" aria-checked={layout === k} class={`chip-btn ${layout === k ? 'is-on' : ''}`} onClick={() => setLayout(layout === k ? null : k)}>{signature(h!, v!)} <span class="count">{n}</span></button>
                    })}
                  </div>
                  <label class="search">
                    <Search size={14} aria-hidden="true" />
                    <span class="visually-hidden">Search templates by name</span>
                    <input type="search" placeholder="Name, e.g. 0019" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} />
                  </label>
                </div>
                {templates === null ? (
                  <ul class="tpl-grid" aria-busy="true">{Array.from({ length: 12 }, () => <li class="tpl-card tpl-card--skeleton"><span class="tpl-card__img" /></li>)}</ul>
                ) : (
                  <ul class="tpl-grid lib-grid">
                    {shown.slice(0, limit).map((t) => (
                      <li key={t.id} class="tpl-card" title={`${t.name} · ${t.file}`}>
                        <span class="tpl-card__img">{t.preview ? <img src={fileUrl(t.preview)} alt="" loading="lazy" decoding="async" /> : null}</span>
                        <span class="tpl-card__cap"><span class="tpl-card__name">{templateLabel(t.name)}</span><span class="tpl-card__slots">{signature(t.h, t.v)}</span></span>
                      </li>
                    ))}
                    {shown.length > limit ? <li class="tpl-grid__more"><Button size="sm" onClick={() => setLimit(limit + PAGE * 2)}>Show more ({shown.length - limit})</Button></li> : null}
                    {!shown.length ? <li class="picks-empty muted">No templates match.</li> : null}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
