// Settings.tsx — Album Studio's preferences: appearance, how plans are made, the print size for
// exports, and cache space, including files that need review before clearing.

import { signal } from '@preact/signals'
import { HardDrive, LogOut, Settings as SettingsIcon, UserRound, X } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { account, signOut } from '../account'
import { expiryNote, subscriptionLine } from '../account_logic'
import { call } from '../bridge'
import { validateDefinition } from '../../../contracts/runtime.js'
import { autoTemplate, setAutoTemplate } from '../edit'
import { exportSettings, megabytes, setExportSettings } from '../exporting'
import { running } from '../render'
import { album, setTheme, stored, store, theme, toast } from '../state'
import { Button, IconButton, Segmented } from '../ui/controls'
import type { StorageUsage } from '../../../contracts/types'

const open = signal(false)
export const openSettings = () => {
  open.value = true
}

export function SettingsDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  const a = album.value
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [cacheError, setCacheError] = useState<string | null>(null)
  const cacheRequest = useRef(0)
  const [spreads, setSpreads] = useState<number>(
    stored<{ desiredSheets?: number }>('as.autoFill', {}).desiredSheets ?? 23,
  )
  const [clearing, setClearing] = useState(false)

  const load = async () => {
    const request = ++cacheRequest.current
    setUsage(null)
    setCacheError(null)
    try {
      const r = await call('storage.usage', a ? { album: a.path } : {}, 120_000)
      if (request === cacheRequest.current && open.peek()) setUsage(r)
    } catch (e) {
      if (request === cacheRequest.current && open.peek()) setCacheError((e as Error).message)
    }
  }
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open.value) {
      if (!d.open) d.showModal()
      void load()
    } else if (d.open) d.close()
    return () => {
      cacheRequest.current++
    }
  }, [open.value, a?.path])

  const s = exportSettings.value
  const total = (usage?.caches ?? []).reduce((n, c) => n + c.bytes, 0)
  const measuring = !usage && !cacheError
  const clear = async (ids: string[]) => {
    const request = ++cacheRequest.current
    setClearing(true)
    try {
      const params = validateDefinition('StorageClearParams', { ids, ...(a ? { album: a.path } : {}) })
      const r = await call('storage.clear', params, 300_000)
      if (request === cacheRequest.current && open.peek()) {
        setUsage(r)
        toast('ok', 'No cache files needed clearing.')
      }
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setClearing(false)
    }
  }

  return (
    <dialog
      class="dialog dialog--wide settings"
      ref={ref}
      onCancel={(e) => {
        if (clearing) e.preventDefault()
      }}
      onClose={() => (open.value = false)}
      aria-labelledby="settings-title"
    >
      <div class="dialog__body">
        <div class="dialog__titlebar">
          <h2 id="settings-title" class="dialog__title">
            <SettingsIcon size={18} /> Settings
          </h2>
          <IconButton label="Close" disabled={clearing} onClick={() => (open.value = false)}>
            <X size={16} />
          </IconButton>
        </div>

        {account.value ? <AccountSection /> : null}

        <section class="set-section">
          <h3>Appearance</h3>
          <Segmented
            label="Appearance"
            value={theme.value}
            onChange={setTheme}
            options={[
              { value: 'studio-dark', label: 'Dark' },
              { value: 'studio-light', label: 'Light' },
            ]}
          />
          <p class="set-hint">
            Dark keeps the surround neutral for judging photos for hours; Light suits a bright room.
          </p>
        </section>

        <section class="set-section">
          <h3>Plan</h3>
          <label class="check">
            <input
              type="checkbox"
              checked={autoTemplate.value}
              onChange={(e) => setAutoTemplate((e.target as HTMLInputElement).checked)}
            />
            <span>
              Templates follow photos
              <span class="check__hint">
                When photos are added to or taken off a spread, switch to a template with a frame for each, from the
                same collection first.
              </span>
            </span>
          </label>
          <label class="set-row">
            <span>Auto-fill plans</span>
            <input
              class="field field--num"
              type="number"
              min={1}
              max={999}
              value={spreads}
              onChange={(e) => {
                const n = Math.max(1, Math.floor(Number((e.target as HTMLInputElement).value) || 1))
                setSpreads(n)
                store('as.autoFill', { ...stored<object>('as.autoFill', {}), mode: 'desired', desiredSheets: n })
              }}
            />
            <span>spreads unless you choose otherwise</span>
          </label>
        </section>

        <section class="set-section">
          <h3>Deliver</h3>
          <label class="set-row">
            <span>Print JPEGs</span>
            <input
              class="field field--num field--xs"
              aria-label="Print height in inches"
              type="number"
              min={1}
              max={60}
              step={0.5}
              value={s.heightInches}
              onChange={(e) =>
                setExportSettings({ size: 'print', heightInches: Number((e.target as HTMLInputElement).value) || 12 })
              }
            />
            <span>in tall at</span>
            <input
              class="field field--num field--xs"
              aria-label="Print resolution in pixels per inch"
              type="number"
              min={72}
              max={1200}
              value={s.ppi}
              onChange={(e) =>
                setExportSettings({ size: 'print', ppi: Number((e.target as HTMLInputElement).value) || 300 })
              }
            />
            <span>ppi ({Math.round(s.heightInches * s.ppi).toLocaleString('en-US')} px)</span>
          </label>
        </section>

        <section class="set-section">
          <div class="set-storage-heading">
            <h3>
              <HardDrive size={14} class="inline-icon" /> Storage
            </h3>
            <Button
              size="sm"
              variant="ghost"
              disabled={clearing}
              aria-busy={measuring || undefined}
              aria-disabled={measuring || undefined}
              onClick={() => {
                if (!measuring) void load()
              }}
            >
              {cacheError ? 'Try measuring again' : 'Refresh storage'}
            </Button>
          </div>
          {cacheError ? (
            <div class="notice notice--error" role="alert">
              <p>{cacheError}</p>
            </div>
          ) : !usage ? (
            <p class="muted" role="status">
              Measuring…
            </p>
          ) : (
            <>
              <h4>
                Caches <span class="count">{total ? megabytes(total) : 'empty'}</span>
              </h4>
              {usage.caches.length === 0 ? (
                <p class="muted">No caches found.</p>
              ) : (
                <ul class="set-caches">
                  {usage.caches.map((c) => (
                    <li key={`${c.scope}-${c.id}`}>
                      <span>
                        {c.label}
                        {c.scope === 'album' && a ? <span class="muted"> · {a.name}</span> : null}
                      </span>
                      <span class="count">{c.bytes ? megabytes(c.bytes) : 'empty'}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!c.bytes || clearing}
                        onClick={() => void clear([c.id])}
                      >
                        Clear
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <p class="set-hint">
                Clearing preserves recovery copies, edited files and files whose ownership cannot be verified.
              </p>
              {usage.retention ? (
                <RetainedWork retention={usage.retention} />
              ) : (
                <p class="set-hint">
                  Retained-work usage is unavailable. Try refreshing storage or updating Album Studio.
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </dialog>
  )
}

function RetainedWork({ retention: r }: { retention: NonNullable<StorageUsage['retention']> }) {
  const [revealing, setRevealing] = useState(false)
  const atLimit = r.stages >= r.limits.maxHistoryStages || r.bytes >= r.limits.maxHistoryBytes
  const reveal = async () => {
    setRevealing(true)
    try {
      await call('shell.reveal', { path: r.historyPath })
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setRevealing(false)
    }
  }
  const size = (bytes: number) =>
    bytes < 1e6 ? `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}` : megabytes(bytes)
  return (
    <section class="set-retention" aria-labelledby="retained-work-title">
      <h4 id="retained-work-title">Retained work</h4>
      <dl class="set-storage-usage">
        <div>
          <dt>Saved work folders</dt>
          <dd>
            {r.stages.toLocaleString('en-US')} of {r.limits.maxHistoryStages.toLocaleString('en-US')}
          </dd>
        </div>
        <div>
          <dt>Space used</dt>
          <dd>
            {size(r.bytes)} of {size(r.limits.maxHistoryBytes)}
          </dd>
        </div>
      </dl>
      {atLimit ? (
        <p class="set-retention-warning" role="alert">
          Retained work has reached its limit. New renders or exports may stop. Show the folder to review it; opening it
          does not free space. Safe cleanup requires ownership review.
        </p>
      ) : null}
      <p class="set-hint">
        These files are kept for recovery and are never cleared automatically. Album Studio also reserves at least{' '}
        {size(r.limits.minFreeBytes)} of free disk space for private work; this is a requirement, not a measurement of
        available space.
      </p>
      <Button size="sm" busy={revealing} onClick={() => void reveal()}>
        Show retained work
      </Button>
    </section>
  )
}

function AccountSection() {
  const a = account.value!
  const warn = expiryNote(a.daysLeft)
  return (
    <section class="set-section">
      <h3>
        <UserRound size={14} class="inline-icon" /> Account
      </h3>
      <div class="set-account">
        <div class="set-account__who">
          <strong>{a.name || a.email || 'Signed in'}</strong>
          {a.name && a.email ? <span>{a.email}</span> : null}
          <span class={warn && !a.bypass ? 'is-warn' : ''}>{subscriptionLine(a)}</span>
        </div>
        {a.bypass ? null : (
          <Button
            size="sm"
            variant="ghost"
            icon={<LogOut size={14} />}
            disabled={running.value}
            title={running.value ? 'Wait for the render to finish' : undefined}
            onClick={() => {
              open.value = false
              void signOut()
            }}
          >
            Sign out
          </Button>
        )}
      </div>
    </section>
  )
}
