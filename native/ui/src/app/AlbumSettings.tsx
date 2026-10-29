// AlbumSettings.tsx — the open album's photo folders and template collections, changed after
// it was created. Changes are made on a copy and applied together with Save (one undo step);
// photo folders new to the album get their thumbnails first, with progress.

import { signal } from '@preact/signals'
import { FolderPlus, Images, LayoutTemplate, Settings2, TriangleAlert, X } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { call, fileUrl, onEvent } from '../bridge'
import { applyUpdate, forgetTemplateCatalogue } from '../edit'
import { plural, shortPath } from '../format'
import { album, toast } from '../state'
import { Button, IconButton } from '../ui/controls'
import type { Collection, EventData, FolderInfo } from '../../../contracts/types'

type Progress = EventData<'album.folders'>

const open = signal(false)
export const openAlbumSettings = () => {
  if (album.value) open.value = true
}

async function pick(title: string, directory: string | null): Promise<string[]> {
  try {
    const r = await call('dialog.pickFolder', { title, directory, multiple: true }, 30 * 60_000)
    return r === null ? [] : Array.isArray(r) ? r : [r]
  } catch (e) {
    toast('error', (e as Error).message)
    return []
  }
}

export function AlbumSettingsDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  const a = album.value
  const [folders, setFolders] = useState<FolderInfo[] | null>(null)
  const [colls, setColls] = useState<Collection[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open.value && !d.open && a) {
      setFolders(null)
      setColls(null)
      setError(null)
      setProgress(null)
      d.showModal()
      void call('folders.inspect', { paths: a.photoFolders.map((f) => f.path) }, 5 * 60_000)
        .then(setFolders)
        .catch((e) => setError((e as Error).message))
      void call('templates.inspect', { paths: a.templateCollections.map((c) => c.path) })
        .then(setColls)
        .catch((e) => setError((e as Error).message))
    } else if (!open.value && d.open) d.close()
  }, [open.value])

  useEffect(() => onEvent('album.folders', setProgress), [])

  if (!a) return null
  const placedFrom = (folder: string) =>
    Object.values(a.photos).filter((p) => p !== undefined && p.folder === folder && p.usedOn.length > 0).length
  const changed =
    folders &&
    colls &&
    (folders.map((f) => f.path).join('|') !== a.photoFolders.map((f) => f.path).join('|') ||
      colls.map((c) => c.path).join('|') !== a.templateCollections.map((c) => c.path).join('|'))
  const removedPlaced = folders
    ? a.photoFolders.filter((f) => !folders.some((x) => x.path === f.path)).reduce((n, f) => n + placedFrom(f.path), 0)
    : 0

  const addFolders = async () => {
    const picked = (await pick('Add photo folders', a.photoFolders[0]?.path.replace(/\/[^/]+$/, '') ?? null)).filter(
      (p) => !folders?.some((f) => f.path === p),
    )
    if (!picked.length) return
    const info = await call('folders.inspect', { paths: picked }, 5 * 60_000).catch(() => [])
    setFolders([...(folders ?? []), ...info])
  }
  const addCollections = async () => {
    const picked = (
      await pick('Add template collections', a.templateCollections[0]?.path.replace(/\/[^/]+$/, '') ?? null)
    ).filter((p) => !colls?.some((c) => c.path === p))
    if (!picked.length) return
    const info = await call('templates.inspect', { paths: picked }).catch(() => [])
    setColls([...(colls ?? []), ...info])
  }

  const save = async () => {
    if (!folders || !colls || !changed || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await call(
        'album.setFolders',
        { album: a.path, photoFolders: folders.map((f) => f.path), templateCollections: colls.map((c) => c.path) },
        6 * 60 * 60_000,
      )
      forgetTemplateCatalogue()
      applyUpdate(r)
      open.value = false
      toast('ok', 'Album folders saved. ⌘Z undoes it.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      setProgress(null)
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
      aria-labelledby="album-settings-title"
    >
      <div class="dialog__body">
        <div class="dialog__titlebar">
          <h2 id="album-settings-title" class="dialog__title">
            <Settings2 size={18} /> {a.name}
          </h2>
          <IconButton label="Close" disabled={busy} onClick={() => (open.value = false)}>
            <X size={16} />
          </IconButton>
        </div>

        <section class="na-section" aria-labelledby="as-photos">
          <div class="na-section__head">
            <h3 id="as-photos">
              <Images size={15} /> Photo folders
            </h3>
            <Button size="sm" icon={<FolderPlus size={14} />} disabled={busy} onClick={addFolders}>
              Add folders…
            </Button>
          </div>
          {!folders ? (
            <p class="muted">Looking at the folders…</p>
          ) : (
            <ul class="na-folders">
              {folders.map((f) => {
                const placed = placedFrom(f.path)
                return (
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
                            {f.raws ? ` · ${f.raws} RAW` : ''}
                            {placed ? ` · ${placed} placed` : ''}
                            {f.missing ? ` · ${f.missing} need thumbnails` : ''}
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
                      label={`Take ${f.name} out of the album`}
                      disabled={busy || folders.length === 1}
                      onClick={() => setFolders(folders.filter((x) => x.path !== f.path))}
                    >
                      <X size={14} />
                    </IconButton>
                  </li>
                )
              })}
            </ul>
          )}
          {removedPlaced ? (
            <p class="fit fit--warn">
              <TriangleAlert size={13} />
              <span>
                {plural(removedPlaced, 'placed photo')} come{removedPlaced === 1 ? 's' : ''} from a folder you took out.{' '}
                {removedPlaced === 1 ? 'It stays' : 'They stay'} on{' '}
                {removedPlaced === 1 ? 'its spread' : 'their spreads'} as missing until replaced.
              </span>
            </p>
          ) : null}
        </section>

        <section class="na-section" aria-labelledby="as-templates">
          <div class="na-section__head">
            <h3 id="as-templates">
              <LayoutTemplate size={15} /> Template collections
            </h3>
            <Button size="sm" icon={<FolderPlus size={14} />} disabled={busy} onClick={addCollections}>
              Add collections…
            </Button>
          </div>
          {!colls ? (
            <p class="muted">Counting templates…</p>
          ) : colls.length ? (
            <ul class="as-colls">
              {colls.map((c) => (
                <li key={c.path}>
                  <LayoutTemplate size={15} aria-hidden="true" />
                  <span class="as-colls__name" title={c.path}>
                    {c.name}
                  </span>
                  <span class="count">{c.exists ? plural(c.templates, 'template') : 'not connected'}</span>
                  <IconButton
                    label={`Take ${c.name} out of the album`}
                    disabled={busy}
                    onClick={() => setColls(colls.filter((x) => x.path !== c.path))}
                  >
                    <X size={14} />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : (
            <p class="muted">
              No template collections: spreads keep their templates, but none can be chosen or fitted.
            </p>
          )}
        </section>

        {busy && progress?.total ? (
          <div class="export-run" role="status">
            <div class="progress">
              <span
                class="progress__bar"
                style={{ width: `${Math.round(((progress.done ?? 0) / progress.total) * 100)}%` }}
              />
            </div>
            <p class="job__line">
              Making thumbnails · {progress.folder} · {progress.done} of {progress.total}
            </p>
          </div>
        ) : null}
        {error ? (
          <p class="dialog__error" role="alert">
            {error}
          </p>
        ) : null}

        <div class="dialog__actions">
          <Button variant="ghost" disabled={busy} onClick={() => (open.value = false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!changed} busy={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </dialog>
  )
}
