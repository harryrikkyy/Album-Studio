// NewAlbum.tsx — start an album from folders of photos: choose the photos, the template
// collections, a name and place, where print sheets go, and whether to plan it straight away.
// Creating makes the missing thumbnails (progress shown), writes the project, plans it, opens it.

import { signal } from '@preact/signals'
import { BookPlus, CircleAlert, FolderPlus, Images, LayoutTemplate, X } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { call, fileUrl, onEvent } from '../../bridge'
import { plural, shortPath } from '../../format'
import { suggestSpreads } from '../../plan_logic'
import { loadRecent, openAlbum, stored, store, toast } from '../../state'
import { Button, IconButton } from '../../ui/controls'
import type { Collection, EventData, FolderInfo } from '../../../../contracts/types'

type Progress = EventData<'album.creating'>

const open = signal(false)
export const openNewAlbum = () => {
  open.value = true
}

const BAD_NAME = /[/:\\]/

async function pickFolders(title: string, directory: string | null, multiple: boolean): Promise<string[]> {
  try {
    const r = await call('dialog.pickFolder', { title, directory, multiple }, 30 * 60_000)
    return r === null ? [] : Array.isArray(r) ? r : [r]
  } catch (e) {
    toast('error', (e as Error).message)
    return []
  }
}

function ProgressView({ p, name }: { p: Progress | null; name: string }) {
  const pct = p?.stage === 'thumbs' && p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : null
  const line = !p
    ? 'Starting…'
    : p.stage === 'thumbs'
      ? p.total
        ? `Making thumbnails · ${p.folder} · ${p.done} of ${p.total}`
        : `Checking ${p.folder}…`
      : p.stage === 'project'
        ? 'Writing the album…'
        : `Planning ${plural(p.spreads ?? 0, 'spread')}…`
  return (
    <div class="dialog__body" role="status" aria-live="polite">
      <h2 id="new-album-title" class="dialog__title">
        <BookPlus size={18} /> Creating {name}
      </h2>
      <div
        class="progress"
        role="progressbar"
        aria-label="Album creation"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <span
          class={`progress__bar ${pct === null ? 'is-indeterminate' : ''}`}
          style={{ width: pct === null ? '35%' : `${pct}%` }}
        />
      </div>
      <p class="job__line">
        {line}
        {p?.stage === 'thumbs' && (p.folders ?? 0) > 1 ? ` (folder ${p.index} of ${p.folders})` : ''}
      </p>
      <p class="dialog__lead">
        Thumbnails go in a <span class="mono">_Thumbnails</span> folder next to the photos, as before; the photos
        themselves aren’t changed.
      </p>
    </div>
  )
}

export function NewAlbumDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  const [folders, setFolders] = useState<FolderInfo[]>([])
  const [collections, setCollections] = useState<Collection[] | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [parent, setParent] = useState<string | null>(null)
  const [output, setOutput] = useState<string | null>(null)
  const [plan, setPlan] = useState<boolean>(stored('as.newAlbum.plan', true))
  const usual = stored<{ desiredSheets?: number }>('as.autoFill', {}).desiredSheets ?? 23
  const [spreads, setSpreads] = useState<number>(usual)
  const [spreadsTouched, setSpreadsTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Open/close the native dialog with the signal; start fresh each time.
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open.value && !d.open) {
      setFolders([])
      setName('')
      setNameTouched(false)
      setParent(null)
      setOutput(null)
      setError(null)
      setProgress(null)
      setSpreads(usual)
      setSpreadsTouched(false)
      d.showModal()
      void call('library.collections')
        .then(({ collections: list }) => {
          setCollections(list)
          // The Library's defaults for new albums (until chosen there: every collection in use).
          setChosen(new Set(list.filter((c) => c.exists && c.templates && c.isDefault).map((c) => c.path)))
        })
        .catch(() => setCollections([]))
    } else if (!open.value && d.open) d.close()
  }, [open.value])

  useEffect(() => onEvent('album.creating', setProgress), [])

  const addFolders = async () => {
    const start = folders.at(-1)?.path.replace(/\/[^/]+$/, '') ?? parent
    const picked = (await pickFolders('Choose photo folders', start, true)).filter(
      (p) => !folders.some((f) => f.path === p),
    )
    if (!picked.length) return
    const info = await call('folders.inspect', { paths: picked }, 5 * 60_000).catch((e) => {
      toast('error', (e as Error).message)
      return []
    })
    const next = [...folders, ...info]
    setFolders(next)
    if (!folders.length && info[0]) {
      const s = await call('album.suggest', { photoFolders: [info[0].path] }).catch(() => null)
      if (s) {
        if (!nameTouched) setName(s.name)
        if (!parent) setParent(s.parent)
      }
    }
  }

  const addCollection = async () => {
    const picked = await pickFolders(
      'Choose a template collection',
      collections?.[0]?.path.replace(/\/[^/]+$/, '') ?? null,
      true,
    )
    if (!picked.length) return
    const info = await call('templates.inspect', { paths: picked }).catch(() => [])
    const known = new Set((collections ?? []).map((c) => c.path))
    setCollections([...(collections ?? []), ...info.filter((c) => !known.has(c.path))])
    setChosen(new Set([...chosen, ...info.filter((c) => c.templates).map((c) => c.path)]))
  }

  const photos = folders.reduce((n, f) => n + f.photos, 0)
  // Until the user types a number, offer one that suits the photos.
  useEffect(() => {
    if (!spreadsTouched) setSpreads(suggestSpreads(photos, usual))
  }, [photos])
  const raws = folders.reduce((n, f) => n + f.raws, 0)
  const missing = folders.reduce((n, f) => n + f.missing, 0)
  const chosenList = (collections ?? []).filter((c) => chosen.has(c.path))
  const templates = chosenList.reduce((n, c) => n + c.templates, 0)
  const problems = [
    !folders.length ? 'Add a folder of photos.' : null,
    folders.some((f) => !f.exists) ? 'A photo folder isn’t there (drive disconnected?).' : null,
    folders.length && !photos ? 'These folders have no photos.' : null,
    !name.trim() ? 'Give the album a name.' : BAD_NAME.test(name) ? 'A name can’t contain / : or \\.' : null,
    !parent ? 'Choose where to save the album.' : null,
    plan && !templates ? 'Choose a template collection to plan with, or start empty.' : null,
    plan && !(spreads >= 1) ? 'Plan at least 1 spread.' : null,
  ].filter(Boolean) as string[]

  const create = async (e: Event) => {
    e.preventDefault()
    if (problems.length || busy || !parent) return
    setBusy(true)
    setError(null)
    setProgress(null)
    store('as.newAlbum.plan', plan)
    try {
      const r = await call(
        'album.create',
        {
          name: name.trim(),
          parent,
          photoFolders: folders.map((f) => f.path),
          templateCollections: chosenList.map((c) => c.path),
          outputFolder: output,
          autoFill: plan ? { mode: 'desired', desiredSheets: spreads, chronological: true } : null,
        },
        6 * 60 * 60_000,
      )
      // Close it before Plan replaces this screen, so the window doesn't keep a modal state.
      ref.current?.close()
      open.value = false
      await openAlbum(r.album.path)
      void loadRecent()
      toast(
        'ok',
        plan
          ? `${r.album.name} is ready: ${plural(r.album.stats.spreads, 'spread')} planned.`
          : `${r.album.name} is ready. Drag photos onto the spread to start.`,
        7000,
      )
      if (r.thumbFailed)
        toast(
          'error',
          `${plural(r.thumbFailed, 'photo')} couldn’t be read for a thumbnail and won’t show in the album (${r.thumbFailures[0]}).`,
          12000,
        )
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      class="dialog dialog--wide"
      ref={ref}
      onCancel={(e) => {
        if (busy) e.preventDefault()
      }}
      onClose={() => (open.value = false)}
      aria-labelledby="new-album-title"
    >
      {busy ? (
        <ProgressView p={progress} name={name.trim()} />
      ) : (
        <form class="dialog__body" onSubmit={create}>
          <div class="dialog__titlebar">
            <h2 id="new-album-title" class="dialog__title">
              <BookPlus size={18} /> New album
            </h2>
            <IconButton label="Close" onClick={() => (open.value = false)}>
              <X size={16} />
            </IconButton>
          </div>

          <section class="na-section" aria-labelledby="na-photos">
            <div class="na-section__head">
              <h3 id="na-photos">
                <Images size={15} /> Photos
              </h3>
              <Button size="sm" icon={<FolderPlus size={14} />} onClick={addFolders}>
                Add folders…
              </Button>
            </div>
            {folders.length ? (
              <ul class="na-folders">
                {folders.map((f) => (
                  <li key={f.path} class={f.exists ? '' : 'is-missing'}>
                    <span class="na-folders__samples" aria-hidden="true">
                      {f.samples.slice(0, 3).map((s) => (
                        <img src={fileUrl(s)} alt="" loading="lazy" />
                      ))}
                      {!f.samples.length ? <Images size={18} /> : null}
                    </span>
                    <span class="na-folders__text">
                      <span class="na-folders__name">{f.name}</span>
                      <span class="na-folders__meta">
                        {f.exists ? (
                          <>
                            {plural(f.photos, 'photo')}
                            {f.raws ? ` · ${f.raws} RAW` : ''} ·{' '}
                            {f.missing ? `${f.missing} need thumbnails` : 'thumbnails ready'}
                          </>
                        ) : (
                          'Not there — drive disconnected?'
                        )}
                      </span>
                      <span class="na-folders__path mono" title={f.path}>
                        {shortPath(f.path, 3)}
                      </span>
                    </span>
                    <IconButton
                      label={`Remove ${f.name}`}
                      onClick={() => setFolders(folders.filter((x) => x.path !== f.path))}
                    >
                      <X size={14} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            ) : (
              <button type="button" class="na-drop" onClick={addFolders}>
                <FolderPlus size={22} strokeWidth={1.5} />
                <span>Choose the shoot’s photo folders</span>
                <span class="na-drop__hint">JPEG, TIFF, HEIC and camera RAW. You can add several folders.</span>
              </button>
            )}
          </section>

          <section class="na-section" aria-labelledby="na-templates">
            <div class="na-section__head">
              <h3 id="na-templates">
                <LayoutTemplate size={15} /> Template collections
              </h3>
              <Button size="sm" icon={<FolderPlus size={14} />} onClick={addCollection}>
                Add collection…
              </Button>
            </div>
            {collections === null ? (
              <p class="muted">Looking at your earlier albums…</p>
            ) : collections.length ? (
              <ul class="na-colls">
                {collections.map((c) => (
                  <li key={c.path}>
                    <label class={`check ${c.exists && c.templates ? '' : 'is-disabled'}`} title={c.path}>
                      <input
                        type="checkbox"
                        disabled={!c.exists || !c.templates}
                        checked={chosen.has(c.path)}
                        onChange={(e) => {
                          const next = new Set(chosen)
                          if ((e.target as HTMLInputElement).checked) next.add(c.path)
                          else next.delete(c.path)
                          setChosen(next)
                        }}
                      />
                      <span>
                        {c.name}{' '}
                        <span class="count">{c.exists ? plural(c.templates, 'template') : 'not connected'}</span>
                        {c.albums.length ? (
                          <span class="check__hint">
                            Used by {c.albums.slice(0, 3).join(', ')}
                            {c.albums.length > 3 ? ` and ${c.albums.length - 3} more` : ''}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="muted">No collections yet. Add the folder of template PSDs you design with.</p>
            )}
          </section>

          <section class="na-grid">
            <label class="na-field">
              <span class="na-field__label">Name</span>
              <input
                class="field field--wide"
                type="text"
                value={name}
                placeholder="Wedding Album"
                onInput={(e) => {
                  setName((e.target as HTMLInputElement).value)
                  setNameTouched(true)
                }}
              />
            </label>
            <div class="na-field">
              <span class="na-field__label">Save in</span>
              <span class="na-path">
                <span class="mono" title={parent ?? ''}>
                  {parent ? shortPath(parent, 3) : 'Not chosen'}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const [p] = await pickFolders('Where to save the album', parent, false)
                    if (p) setParent(p)
                  }}
                >
                  Change…
                </Button>
              </span>
            </div>
            <div class="na-field">
              <span class="na-field__label">Print sheets</span>
              <span class="na-path">
                <span class="mono" title={output ?? ''}>
                  {output ? shortPath(output, 3) : `In the album, “exports”`}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const [p] = await pickFolders('Where print sheets go', output ?? parent, false)
                    if (p) setOutput(p)
                  }}
                >
                  Change…
                </Button>
                {output ? (
                  <Button size="sm" variant="ghost" onClick={() => setOutput(null)}>
                    Default
                  </Button>
                ) : null}
              </span>
            </div>
          </section>

          <fieldset class="choice">
            <legend class="visually-hidden">First plan</legend>
            <label class={`choice__row ${plan ? 'is-on' : ''}`}>
              <input type="radio" name="plan" checked={plan} onChange={() => setPlan(true)} />
              <span class="choice__text">Plan</span>
              <input
                class="field field--num"
                type="number"
                min={1}
                max={999}
                value={spreads}
                aria-label="Spreads"
                onFocus={() => setPlan(true)}
                onInput={(e) => {
                  setSpreadsTouched(true)
                  setSpreads(Math.floor(Number((e.target as HTMLInputElement).value) || 0))
                }}
              />
              <span class="choice__text">spreads now, in capture order</span>
              {photos && spreads ? (
                <span class="choice__hint">≈ {plural(Math.max(1, Math.round(photos / spreads)), 'photo')} each</span>
              ) : null}
            </label>
            <label class={`choice__row ${!plan ? 'is-on' : ''}`}>
              <input type="radio" name="plan" checked={!plan} onChange={() => setPlan(false)} />
              <span class="choice__text">Start empty and place photos myself</span>
            </label>
          </fieldset>

          {error ? (
            <p class="dialog__error" role="alert">
              <CircleAlert size={13} class="inline-icon" /> {error}
            </p>
          ) : null}

          <div class="dialog__actions dialog__actions--split">
            <span class={`dialog__summary ${folders.length && problems.length ? 'is-todo' : ''}`} aria-live="polite">
              {!folders.length ? null : problems.length ? (
                problems[0]
              ) : (
                <>
                  {plural(photos, 'photo')}
                  {raws ? ` (${raws} RAW)` : ''} · {plural(templates, 'template')}
                  {missing ? ` · ${plural(missing, 'thumbnail')} to make` : ''}
                </>
              )}
            </span>
            <Button variant="ghost" onClick={() => (open.value = false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={problems.length > 0}>
              Create album
            </Button>
          </div>
        </form>
      )}
    </dialog>
  )
}
