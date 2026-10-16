// Albums.tsx — recent albums with their cover spreads; open one, or open another from disk.

import { BookPlus, FolderOpen, HardDrive, ImageIcon, RefreshCw } from 'lucide-preact'
import { useEffect } from 'preact/hooks'
import { call, fileUrl, inShell } from '../bridge'
import { plural, relativeTime, shortPath } from '../format'
import { album, albumLoading, loadRecent, openAlbum, recent, recentError, toast } from '../state'
import type { RecentAlbum } from '../types'
import { Button } from '../ui/controls'
import { NewAlbumDialog, openNewAlbum } from './albums/NewAlbum'

async function pickAndOpen() {
  try {
    const path = await call('dialog.pickFolder', { title: 'Open an album project folder' })
    if (typeof path === 'string') await openAlbum(path)
  } catch (e) {
    toast('error', (e as Error).message)
  }
}

function AlbumCard({ a }: { a: RecentAlbum }) {
  const loading = albumLoading.value === a.path
  const isOpen = album.value?.path === a.path
  return (
    <li class={`album-card ${a.available ? '' : 'is-unavailable'}`}>
      <button
        type="button"
        class="album-card__hit"
        disabled={!a.available || !!albumLoading.value}
        aria-busy={loading || undefined}
        onClick={() => openAlbum(a.path)}
      >
        <span class="album-card__cover">
          {a.cover && a.available ? (
            <img src={fileUrl(a.cover)} alt="" loading="lazy" decoding="async" />
          ) : (
            // No preview yet (a new album) is not the same as a drive that isn't connected.
            <span class="album-card__nocover" aria-hidden="true">{a.available ? <ImageIcon size={22} strokeWidth={1.4} /> : <HardDrive size={22} strokeWidth={1.4} />}</span>
          )}
          {loading ? <span class="album-card__progress" aria-hidden="true" /> : null}
        </span>
        <span class="album-card__body">
          <span class="album-card__name">
            {a.name}
            {isOpen ? <span class="pill pill--accent">Open</span> : null}
          </span>
          <span class="album-card__meta">
            {a.available
              ? `${plural(a.spreads, 'spread')} · ${plural(a.photos, 'photo')} · ${relativeTime(a.openedAt)}`
              : 'Drive not connected'}
          </span>
          <span class="album-card__path" title={a.path}>{shortPath(a.path, 3)}</span>
        </span>
      </button>
    </li>
  )
}

export function Albums() {
  useEffect(() => {
    if (inShell) void loadRecent()
  }, [])
  const list = recent.value
  return (
    <section class="place place--albums" aria-labelledby="albums-title">
      <header class="place__head">
        <div>
          <h1 id="albums-title" class="place__title">Albums</h1>
          <p class="place__sub">
            {list && list.length ? `${plural(list.length, 'album')} opened recently` : 'Your albums appear here once opened'}
          </p>
        </div>
        <div class="place__actions">
          <Button variant="ghost" icon={<RefreshCw size={15} />} onClick={() => loadRecent()} disabled={!inShell}>Refresh</Button>
          <Button icon={<FolderOpen size={15} />} onClick={pickAndOpen} disabled={!inShell || !!albumLoading.value}>
            Open album…
          </Button>
          <Button variant="primary" icon={<BookPlus size={15} />} onClick={openNewAlbum} disabled={!inShell}>
            New album
          </Button>
        </div>
      </header>
      <NewAlbumDialog />

      {recentError.value ? <p class="notice notice--error" role="alert">{recentError.value}</p> : null}

      {list === null ? (
        <ul class="album-grid" aria-busy="true" aria-label="Loading albums">
          {[0, 1, 2].map(() => <li class="album-card album-card--skeleton" aria-hidden="true"><span class="album-card__cover" /><span class="album-card__body"><span class="sk sk--line" /><span class="sk sk--line sk--short" /></span></li>)}
        </ul>
      ) : list.length === 0 ? (
        <div class="empty">
          <h2 class="empty__title">No albums yet</h2>
          <p class="empty__text">Start one from the shoot’s photo folders, or open an album made earlier (a folder with a project.json inside).</p>
          <div class="empty__actions">
            <Button variant="primary" icon={<BookPlus size={15} />} onClick={openNewAlbum} disabled={!inShell}>New album</Button>
            <Button icon={<FolderOpen size={15} />} onClick={pickAndOpen} disabled={!inShell}>Open album…</Button>
          </div>
        </div>
      ) : (
        <ul class="album-grid">
          {list.map((a) => <AlbumCard a={a} key={a.path} />)}
        </ul>
      )}
    </section>
  )
}
