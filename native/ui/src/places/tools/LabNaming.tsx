// LabNaming.tsx — name an order folder's sheets the way the print lab wants them (the Electron
// app's Renamer): first and last half sheets "00" and "zz", pages "<order> (01)"…, the cover pad
// "ZZZ--<order>--<lamination>--<size>--<N>+1", special laminations tagged. Every name shows live
// before anything changes on disk; the rename is collision-safe and can be undone.

import { FolderOpen, Images, Tag, Undo2 } from 'lucide-preact'
import { signal } from '@preact/signals'
import { useEffect, useMemo, useState } from 'preact/hooks'
import { call, fileUrl } from '../../bridge'
import { plural, shortPath } from '../../format'
import { EFFECTS, LAMINATIONS, SIZES, computeAssignedNames, computeRenames, matchStandardSize, readBack, type CoverPad, type NamingTile, type RenameOp, type SheetRole } from '../../lab_naming'
import { album, stored, store, toast } from '../../state'
import { Button, Segmented } from '../../ui/controls'

interface Sheet { path: string; fileName: string; baseName: string; ext: string; thumb: string | null; width: number; height: number }

const ROLE_LABEL: Record<SheetRole, string> = { first: 'First', last: 'Last', cover: 'Cover', page: 'Page' }

/** The last rename's reverse, kept while the app runs (leaving the tool doesn't lose it). */
const lastRename = signal<{ folder: string; ops: RenameOp[] } | null>(null)

export function LabNaming() {
  const a = album.value
  const [folder, setFolder] = useState<string | null>(stored<string | null>('as.labFolder', null))
  const [sheets, setSheets] = useState<Map<string, Sheet>>(new Map())
  const [tiles, setTiles] = useState<NamingTile[]>([])
  const [name, setName] = useState('')
  const [custom, setCustom] = useState<string | null>(null)
  const [cover, setCover] = useState<CoverPad | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const undo = lastRename.value
  const setUndo = (v: { folder: string; ops: RenameOp[] } | null) => { lastRename.value = v }
  const [dragFrom, setDragFrom] = useState<string | null>(null)
  const [albumPrints, setAlbumPrints] = useState<string | null>(null)

  // The open album's print JPEGs, offered as a one-click folder.
  useEffect(() => {
    if (!a) { setAlbumPrints(null); return }
    void call('export.plan', { album: a.path }).then((p) => setAlbumPrints(p.paths.high)).catch(() => setAlbumPrints(null))
  }, [a?.path])

  const load = async (dir: string, keep = false) => {
    setLoading(true)
    try {
      const r = await call('lab.list', { folder: dir }, 10 * 60_000)
      const back = readBack(r.sheets.map((s) => ({ path: s.path, baseName: s.baseName })))
      setSheets(new Map(r.sheets.map((s) => [s.path, s])))
      setTiles(back.tiles)
      if (!keep) {
        setName(back.folderName ?? r.name)
        setCustom(back.customPageName)
        setCover(back.coverPad)
        if (lastRename.value?.folder !== dir) setUndo(null)
      }
      setSelected(null)
      setFolder(dir)
      store('as.labFolder', dir)
    } catch (e) {
      toast('error', (e as Error).message, 8000)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { if (folder) void load(folder) }, [])

  const choose = async () => {
    const dir = await call('dialog.pickFolder', { title: 'Choose the order folder', directory: folder }).catch(() => null)
    if (typeof dir === 'string') await load(dir)
  }

  const input = { folderName: name.trim() || 'order', tiles, coverPad: cover, customPageName: custom }
  const names = useMemo(() => new Map(computeAssignedNames(input).map((n) => [n.path, n.baseName])), [tiles, name, custom, cover])
  const ops = computeRenames(input).filter((o) => sheets.get(o.fromPath)?.baseName !== o.toBaseName)
  const pages = tiles.filter((t) => t.role === 'page').length
  const sel = tiles.find((t) => t.path === selected) ?? null
  const coverTile = tiles.find((t) => t.role === 'cover')

  /** Give the selected sheet a role; first, last and cover are one each. */
  const setRole = (role: SheetRole) => {
    if (!sel) return
    setTiles(tiles.map((t) => (t.path === sel.path ? { ...t, role, effect: role === 'page' ? t.effect : null } : role !== 'page' && t.role === role ? { ...t, role: 'page' } : t)))
    if (role === 'cover' && !cover) {
      const s = sheets.get(sel.path)
      setCover({ lamination: LAMINATIONS[0]!, size: (s && matchStandardSize(s.width, s.height)) ?? SIZES[0]! })
    }
  }
  const setEffect = (effect: string | null) => sel && setTiles(tiles.map((t) => (t.path === sel.path ? { ...t, effect } : t)))
  const move = (from: string, to: string) => {
    const next = tiles.slice()
    const i = next.findIndex((t) => t.path === from)
    const [t] = next.splice(i, 1)
    next.splice(next.findIndex((x) => x.path === to), 0, t!)
    setTiles(next)
  }

  const rename = async () => {
    if (!folder || !ops.length) return
    setBusy(true)
    try {
      const r = await call('lab.rename', { folder, ops })
      setUndo({ folder, ops: r.undo })
      toast('ok', `${plural(r.renamed, 'sheet')} renamed for the lab.`)
      await load(folder, true)
    } catch (e) {
      toast('error', (e as Error).message, 9000)
    } finally {
      setBusy(false)
    }
  }
  const revert = async () => {
    if (!undo) return
    setBusy(true)
    try {
      await call('lab.rename', undo)
      toast('info', 'The sheets have their names back.')
      setUndo(null)
      await load(undo.folder)
    } catch (e) {
      toast('error', (e as Error).message, 9000)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="tool">
      <header class="tool__head">
        <div>
          <h2 class="tool__title"><Tag size={17} /> Lab naming</h2>
          <p class="tool__sub">
            {folder ? <><span class="mono" title={folder}>{shortPath(folder, 3)}</span> · {plural(tiles.length, 'sheet')}</> : 'Name an order folder’s sheets the way the print lab wants them.'}
          </p>
        </div>
        <div class="place__actions">
          {albumPrints && albumPrints !== folder ? <Button icon={<Images size={14} />} onClick={() => void load(albumPrints)} title={albumPrints}>This album’s print JPEGs</Button> : null}
          <Button icon={<FolderOpen size={14} />} onClick={choose}>{folder ? 'Other folder…' : 'Choose folder…'}</Button>
        </div>
      </header>

      {!folder ? (
        <div class="empty">
          <h3 class="empty__title">Choose an order folder</h3>
          <p class="empty__text">The sheets (JPEG, PNG or PSD) of one order. Click a sheet to make it the first or last half sheet or the cover pad, drag to reorder, and every new name shows before anything is renamed.</p>
          <div class="empty__actions">
            {albumPrints ? <Button variant="primary" icon={<Images size={15} />} onClick={() => void load(albumPrints)}>This album’s print JPEGs</Button> : null}
            <Button icon={<FolderOpen size={15} />} onClick={choose}>Choose folder…</Button>
          </div>
        </div>
      ) : (
        <>
          <div class="lab-bar">
            <label class="lab-field">
              <span>Order</span>
              <input class="field" type="text" value={name} placeholder="e.g. 256" onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label="Order name or number" />
            </label>
            <span class="lab-group">
              <span class="lab-bar__label">Pages</span>
              <Segmented
                label="Page names"
                value={custom === null ? 'order' : 'custom'}
                onChange={(v) => setCustom(v === 'custom' ? (custom ?? 'page') : null)}
                options={[{ value: 'order', label: `${name.trim() || 'order'} (01)` }, { value: 'custom', label: 'Custom_001' }]}
              />
              {custom !== null ? <input class="field lab-group__field" type="text" value={custom} placeholder="Name" onInput={(e) => setCustom((e.target as HTMLInputElement).value)} aria-label="Custom page name" /> : null}
            </span>
            <span class="lab-group">
              <span class="lab-bar__label">Cover pad</span>
              <label class="select"><span class="visually-hidden">Lamination</span>
                <select value={cover?.lamination ?? ''} disabled={!coverTile} onChange={(e) => setCover({ lamination: (e.target as HTMLSelectElement).value, size: cover?.size ?? SIZES[0]! })}>
                  {!cover ? <option value="">Lamination</option> : null}
                  {LAMINATIONS.map((l) => <option value={l}>{l}</option>)}
                </select>
              </label>
              <label class="select"><span class="visually-hidden">Size</span>
                <select value={cover?.size ?? ''} disabled={!coverTile} onChange={(e) => setCover({ lamination: cover?.lamination ?? LAMINATIONS[0]!, size: (e.target as HTMLSelectElement).value })}>
                  {!cover ? <option value="">Size</option> : null}
                  {SIZES.map((s) => <option value={s}>{s.replace('x', ' × ')}</option>)}
                </select>
              </label>
            </span>
          </div>

          <div class="lab-bar lab-bar--sel" aria-live="polite">
            {sel ? (
              <>
                <span class="lab-bar__label">{sheets.get(sel.path)?.fileName}</span>
                <Segmented label="Role" value={sel.role} onChange={setRole} options={(['first', 'page', 'last', 'cover'] as SheetRole[]).map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
                {sel.role === 'page' ? (
                  <label class="select"><span class="visually-hidden">Special lamination</span>
                    <select value={sel.effect ?? ''} onChange={(e) => setEffect((e.target as HTMLSelectElement).value || null)}>
                      <option value="">No special lamination</option>
                      {EFFECTS.map((fx) => <option value={fx}>{fx}</option>)}
                    </select>
                  </label>
                ) : null}
              </>
            ) : (
              <span class="muted">Click a sheet to give it a role or a special lamination. Drag sheets to reorder the pages.</span>
            )}
            <span class="lab-bar__grow" />
            {undo ? <Button variant="ghost" icon={<Undo2 size={14} />} disabled={busy} onClick={revert}>Undo rename</Button> : null}
            <Button variant="primary" disabled={!ops.length || busy || loading || (!!coverTile && !cover)} busy={busy} onClick={rename}>
              {ops.length ? `Rename ${plural(ops.length, 'sheet')}` : 'Names are up to date'}
            </Button>
          </div>
          {!tiles.some((t) => t.role === 'first') || !tiles.some((t) => t.role === 'last') ? (
            <p class="lab-note">{!tiles.some((t) => t.role === 'first') ? 'No first half sheet (00) chosen yet. ' : ''}{!tiles.some((t) => t.role === 'last') ? 'No last half sheet (zz) chosen yet. ' : ''}{pages ? `${plural(pages, 'page sheet')} numbered in order.` : ''}</p>
          ) : null}

          {loading && !tiles.length ? <p class="muted lab-note">Reading the folder…</p> : (
            <ol class="lab-grid" aria-label="Sheets">
              {tiles.map((t) => {
                const s = sheets.get(t.path)
                const next = names.get(t.path)
                const changes = next !== null && next !== s?.baseName
                return (
                  <li key={t.path}>
                    <button
                      type="button"
                      class={`lab-tile ${selected === t.path ? 'is-selected' : ''} ${dragFrom === t.path ? 'is-source' : ''}`}
                      aria-pressed={selected === t.path}
                      draggable
                      onDragStart={(e) => { setDragFrom(t.path); e.dataTransfer?.setData('text/plain', t.path) }}
                      onDragEnd={() => setDragFrom(null)}
                      onDragOver={(e) => { if (dragFrom && dragFrom !== t.path) e.preventDefault() }}
                      onDrop={(e) => { e.preventDefault(); if (dragFrom && dragFrom !== t.path) move(dragFrom, t.path); setDragFrom(null) }}
                      onClick={() => setSelected(selected === t.path ? null : t.path)}
                    >
                      <span class="lab-tile__img">{s?.thumb ? <img src={fileUrl(s.thumb)} alt="" loading="lazy" decoding="async" draggable={false} /> : <span class="muted">{s?.ext.slice(1).toUpperCase()}</span>}</span>
                      <span class="lab-tile__name">{next ?? (t.role === 'cover' ? 'Choose the pad’s lamination and size' : '')}{s?.ext}</span>
                      <span class="lab-tile__old">{changes ? `now ${s?.fileName}` : 'unchanged'}</span>
                      {t.role !== 'page' || t.effect ? <span class={`lab-tile__badge lab-tile__badge--${t.role}`}>{t.role === 'page' ? t.effect : t.role === 'cover' ? 'Cover pad' : t.role === 'first' ? '00' : 'zz'}</span> : null}
                    </button>
                  </li>
                )
              })}
            </ol>
          )}
        </>
      )}
    </div>
  )
}
