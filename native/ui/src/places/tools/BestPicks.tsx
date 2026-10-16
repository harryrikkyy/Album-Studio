// BestPicks.tsx — narrow a shoot to its keepers: every photo scored for sharpness, exposure and
// near-duplicates (the Electron app's curation engine), the picks updating live as the limits
// move, any photo kept or dropped by hand with a click. Then copy the picks to `_Selected`, or
// plan the open album from them.

import { FolderOpen, Images, LayoutTemplate, Sparkles } from 'lucide-preact'
import { useMemo, useState } from 'preact/hooks'
import { call, fileUrl, onEvent } from '../../bridge'
import { plural, shortPath } from '../../format'
import { DEFAULT_PICKS, choose, pickKey, type PickOptions, type Reason, type Scored } from '../../picks_logic'
import { album, place, stored, store, toast } from '../../state'
import { Button, Segmented } from '../../ui/controls'
import { openAutoFillWith } from '../plan/AutoFill'
import type { PicksProgress } from '../../../../contracts/types'

type View = 'keep' | Exclude<Reason, 'error'>
const REASON: Record<Reason, string> = { blur: 'Blurry', exposure: 'Exposure', duplicate: 'Duplicate', cap: 'Over the count', error: 'Unreadable', yours: 'Dropped by you' }

type Progress = PicksProgress

export function BestPicks() {
  const a = album.value
  const [source, setSource] = useState<{ label: string; folders: string[]; album: boolean } | null>(null)
  const [scored, setScored] = useState<Scored[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [o, setO] = useState<PickOptions>({ ...DEFAULT_PICKS, ...stored<Partial<PickOptions>>('as.picks', {}) })
  const [yours, setYours] = useState<Map<string, boolean>>(new Map())
  const [view, setView] = useState<View>('keep')

  const analyze = async (label: string, folders: string[], isAlbum: boolean) => {
    setSource({ label, folders, album: isAlbum })
    setScored(null)
    setYours(new Map())
    setBusy(true)
    const off = onEvent('picks.progress', setProgress)
    try {
      const r = await call('picks.analyze', { folders }, 6 * 60 * 60_000)
      setScored(r.photos)
    } catch (e) {
      toast('error', (e as Error).message, 9000)
    } finally {
      off()
      setBusy(false)
      setProgress(null)
    }
  }
  const chooseFolder = async () => {
    const dir = await call('dialog.pickFolder', { title: 'Choose a folder of photos' }).catch(() => null)
    if (typeof dir === 'string' && dir) await analyze(dir.split('/').pop() ?? dir, [dir], false)
  }
  const fromAlbum = () => a && analyze(a.name, a.photoFolders.map((f) => f.path), true)

  const set = (patch: Partial<PickOptions>) => {
    const next = { ...o, ...patch }
    setO(next)
    store('as.picks', next)
  }
  const picked = useMemo(() => (scored ? choose(scored, o, yours) : null), [scored, o, yours])
  const toggle = (p: Scored) => {
    const k = pickKey(p)
    const kept = picked?.keep.some((x) => pickKey(x) === k)
    setYours(new Map(yours).set(k, !kept))
  }
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of picked?.drop.values() ?? []) c[r] = (c[r] ?? 0) + 1
    return c
  }, [picked])
  const shown = !scored || !picked ? [] : view === 'keep' ? picked.keep : scored.filter((p) => picked.drop.get(pickKey(p)) === view)
  const h = picked?.keep.filter((p) => p.orient === 'h').length ?? 0

  const copy = async () => {
    if (!picked?.keep.length) return
    try {
      const r = await call('picks.copy', { picks: picked.keep.map((p) => ({ folder: p.folder, base: p.base })) }, 60 * 60_000)
      toast('ok', `${plural(r.copied, 'file')} copied to ${r.folders.length === 1 ? shortPath(r.folders[0]!.dest, 2) : `${r.folders.length} _Selected folders`}${r.skipped ? ` (${r.skipped} already there)` : ''}.`, 8000)
    } catch (e) {
      toast('error', (e as Error).message, 9000)
    }
  }
  const planFromPicks = () => {
    if (!a || !picked) return
    const byThumb = new Map<string, string>()
    for (const ph of Object.values(a.photos)) if (ph) byThumb.set(ph.thumb, ph.id)
    const ids = picked.keep.map((p) => byThumb.get(p.thumb)).filter((id): id is string => !!id)
    place.value = 'plan'
    openAutoFillWith(ids)
  }

  return (
    <div class="tool">
      <header class="tool__head">
        <div>
          <h2 class="tool__title"><Sparkles size={17} /> Best picks</h2>
          <p class="tool__sub">{source ? <>{source.label} · {scored ? plural(scored.length, 'photo') : 'scoring…'}</> : 'Narrow a shoot to its sharpest, best-exposed photos, one of each burst.'}</p>
        </div>
        <div class="place__actions">
          {a ? <Button icon={<Images size={14} />} disabled={busy} onClick={fromAlbum}>This album’s photos</Button> : null}
          <Button icon={<FolderOpen size={14} />} disabled={busy} onClick={chooseFolder}>Choose folder…</Button>
        </div>
      </header>

      {!source ? (
        <div class="empty">
          <h3 class="empty__title">Choose the photos to sort</h3>
          <p class="empty__text">Every photo is scored once (from its thumbnail, RAW included); then move the limits and watch the picks change. Click any photo to keep or drop it yourself.</p>
          <div class="empty__actions">
            {a ? <Button variant="primary" icon={<Images size={15} />} onClick={fromAlbum}>This album’s photos</Button> : null}
            <Button icon={<FolderOpen size={15} />} onClick={chooseFolder}>Choose folder…</Button>
          </div>
        </div>
      ) : busy ? (
        <div class="picks-busy" role="status">
          <div class="progress"><span class="progress__bar" style={{ width: `${progress?.total ? Math.round((progress.done / progress.total) * 100) : 5}%` }} /></div>
          <p class="job__line">{progress ? `${progress.stage === 'thumbs' ? 'Making thumbnails' : 'Scoring'} · ${progress.folder} · ${progress.done} of ${progress.total}` : 'Starting…'}</p>
        </div>
      ) : scored && picked ? (
        <>
          <div class="lab-bar picks-bar">
            <label class="picks-slider">
              <span>Sharpness at least <b>{o.minSharpness}</b></span>
              <input type="range" min={0} max={400} step={5} value={o.minSharpness} onInput={(e) => set({ minSharpness: Number((e.target as HTMLInputElement).value) })} />
            </label>
            <label class="picks-slider">
              <span>Exposure at least <b>{o.minExposure.toFixed(2)}</b></span>
              <input type="range" min={0} max={1} step={0.05} value={o.minExposure} onInput={(e) => set({ minExposure: Number((e.target as HTMLInputElement).value) })} />
            </label>
            <label class="picks-slider">
              <span>Bursts: alike within <b>{o.dupThreshold}</b></span>
              <input type="range" min={0} max={16} step={1} value={o.dupThreshold} onInput={(e) => set({ dupThreshold: Number((e.target as HTMLInputElement).value) })} />
            </label>
            <label class="lab-field">
              <span>At most</span>
              <input class="field field--num field--xs" type="number" min={0} placeholder="any" value={o.targetH ?? ''} aria-label="Most landscape photos" onInput={(e) => { const v = (e.target as HTMLInputElement).value; set({ targetH: v === '' ? null : Math.max(0, Math.floor(Number(v))) }) }} />
              <span>H</span>
              <input class="field field--num field--xs" type="number" min={0} placeholder="any" value={o.targetV ?? ''} aria-label="Most portrait photos" onInput={(e) => { const v = (e.target as HTMLInputElement).value; set({ targetV: v === '' ? null : Math.max(0, Math.floor(Number(v))) }) }} />
              <span>V</span>
            </label>
          </div>
          <div class="lab-bar lab-bar--sel">
            <Segmented
              label="Show"
              value={view}
              onChange={setView}
              options={[
                { value: 'keep', label: `Picks ${picked.keep.length}` },
                { value: 'blur', label: `Blurry ${counts.blur ?? 0}` },
                { value: 'exposure', label: `Exposure ${counts.exposure ?? 0}` },
                { value: 'duplicate', label: `Bursts ${counts.duplicate ?? 0}` },
                ...(counts.cap ? [{ value: 'cap' as View, label: `Over the count ${counts.cap}` }] : []),
                ...(counts.yours ? [{ value: 'yours' as View, label: `Dropped by you ${counts.yours}` }] : []),
              ]}
            />
            <span class="muted">{picked.keep.length} of {scored.length} · {h} H · {picked.keep.length - h} V</span>
            <span class="lab-bar__grow" />
            <Button disabled={!picked.keep.length} onClick={copy} title="Copy the picked photos (RAW and JPEG) into _Selected next to them">Copy to _Selected</Button>
            {source.album && a ? <Button variant="primary" icon={<LayoutTemplate size={14} />} disabled={!picked.keep.length} onClick={planFromPicks}>Plan the album from {plural(picked.keep.length, 'pick')}…</Button> : null}
          </div>
          <ul class="picks-grid" aria-label={view === 'keep' ? 'Picks' : REASON[view]}>
            {shown.map((p) => {
              const reason = picked.drop.get(pickKey(p))
              return (
                <li key={pickKey(p)}>
                  <button type="button" class={`picks-tile ${reason ? 'is-dropped' : ''} ${yours.has(pickKey(p)) ? 'is-yours' : ''}`} onClick={() => toggle(p)} title={`${p.base} · sharpness ${p.sharpness} · exposure ${p.exposure.toFixed(2)}\n${reason ? 'Click to keep it' : 'Click to drop it'}`}>
                    <img src={fileUrl(p.thumb)} alt={p.base} loading="lazy" decoding="async" />
                    {reason ? <span class="picks-tile__why">{REASON[reason]}</span> : null}
                  </button>
                </li>
              )
            })}
            {!shown.length ? <li class="picks-empty muted">{view === 'keep' ? 'Nothing passes these limits.' : 'None.'}</li> : null}
          </ul>
        </>
      ) : null}
    </div>
  )
}
