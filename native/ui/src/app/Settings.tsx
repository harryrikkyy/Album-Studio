// Settings.tsx — Album Studio's preferences: appearance, how plans are made, the print size for
// exports, and the space the caches take (all of it can be made again, so clearing loses nothing).

import { signal } from '@preact/signals'
import { HardDrive, LogOut, Settings as SettingsIcon, UserRound, X } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { account, signOut } from '../account'
import { expiryNote, subscriptionLine } from '../account_logic'
import { call } from '../bridge'
import { autoTemplate, setAutoTemplate } from '../edit'
import { exportSettings, megabytes, setExportSettings } from '../exporting'
import { running } from '../render'
import { album, setTheme, stored, store, theme, toast } from '../state'
import { Button, IconButton, Segmented } from '../ui/controls'

interface Cache { id: string; label: string; scope: 'app' | 'album'; bytes: number; files: number }

const open = signal(false)
export const openSettings = () => { open.value = true }

export function SettingsDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  const a = album.value
  const [caches, setCaches] = useState<Cache[] | null>(null)
  const [spreads, setSpreads] = useState<number>(stored<{ desiredSheets?: number }>('as.autoFill', {}).desiredSheets ?? 23)
  const [clearing, setClearing] = useState(false)

  const load = () => call<{ caches: Cache[] }>('storage.usage', { album: a?.path }, 120_000).then((r) => setCaches(r.caches)).catch(() => setCaches([]))
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open.value && !d.open) { setCaches(null); d.showModal(); void load() }
    else if (!open.value && d.open) d.close()
  }, [open.value])

  const s = exportSettings.value
  const total = (caches ?? []).reduce((n, c) => n + c.bytes, 0)
  const clear = async (ids: string[]) => {
    setClearing(true)
    try {
      const r = await call<{ caches: Cache[] }>('storage.clear', { ids, album: a?.path }, 300_000)
      setCaches(r.caches)
      toast('ok', 'Cleared. It is made again the next time it’s needed.')
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setClearing(false)
    }
  }

  return (
    <dialog class="dialog dialog--wide settings" ref={ref} onClose={() => (open.value = false)} aria-labelledby="settings-title">
      <div class="dialog__body">
        <div class="dialog__titlebar">
          <h2 id="settings-title" class="dialog__title"><SettingsIcon size={18} /> Settings</h2>
          <IconButton label="Close" onClick={() => (open.value = false)}><X size={16} /></IconButton>
        </div>

        {account.value ? <AccountSection /> : null}

        <section class="set-section">
          <h3>Appearance</h3>
          <Segmented label="Appearance" value={theme.value} onChange={setTheme} options={[{ value: 'studio-dark', label: 'Dark' }, { value: 'studio-light', label: 'Light' }]} />
          <p class="set-hint">Dark keeps the surround neutral for judging photos for hours; Light suits a bright room.</p>
        </section>

        <section class="set-section">
          <h3>Plan</h3>
          <label class="check">
            <input type="checkbox" checked={autoTemplate.value} onChange={(e) => setAutoTemplate((e.target as HTMLInputElement).checked)} />
            <span>Templates follow photos<span class="check__hint">When photos are added to or taken off a spread, switch to a template with a frame for each, from the same collection first.</span></span>
          </label>
          <label class="set-row">
            <span>Auto-fill plans</span>
            <input class="field field--num" type="number" min={1} max={999} value={spreads} onChange={(e) => {
              const n = Math.max(1, Math.floor(Number((e.target as HTMLInputElement).value) || 1))
              setSpreads(n)
              store('as.autoFill', { ...stored<object>('as.autoFill', {}), mode: 'desired', desiredSheets: n })
            }} />
            <span>spreads unless you choose otherwise</span>
          </label>
        </section>

        <section class="set-section">
          <h3>Deliver</h3>
          <label class="set-row">
            <span>Print JPEGs</span>
            <input class="field field--num field--xs" type="number" min={1} max={60} step={0.5} value={s.heightInches} onChange={(e) => setExportSettings({ size: 'print', heightInches: Number((e.target as HTMLInputElement).value) || 12 })} />
            <span>in tall at</span>
            <input class="field field--num field--xs" type="number" min={72} max={1200} value={s.ppi} onChange={(e) => setExportSettings({ size: 'print', ppi: Number((e.target as HTMLInputElement).value) || 300 })} />
            <span>ppi ({Math.round(s.heightInches * s.ppi).toLocaleString('en-US')} px)</span>
          </label>
        </section>

        <section class="set-section">
          <h3><HardDrive size={14} class="inline-icon" /> Storage {caches ? <span class="count">{megabytes(total)}</span> : null}</h3>
          {!caches ? <p class="muted">Measuring…</p> : (
            <ul class="set-caches">
              {caches.map((c) => (
                <li key={`${c.scope}-${c.id}`}>
                  <span>{c.label}{c.scope === 'album' && a ? <span class="muted"> · {a.name}</span> : null}</span>
                  <span class="count">{c.bytes ? megabytes(c.bytes) : 'empty'}</span>
                  <Button size="sm" variant="ghost" disabled={!c.bytes || clearing} onClick={() => void clear([c.id])}>Clear</Button>
                </li>
              ))}
            </ul>
          )}
          <p class="set-hint">All of these are made again from your photos and templates when needed; clearing only costs time. Albums, photos, templates and print files are never touched.</p>
        </section>
      </div>
    </dialog>
  )
}

function AccountSection() {
  const a = account.value!
  const warn = expiryNote(a.daysLeft)
  return (
    <section class="set-section">
      <h3><UserRound size={14} class="inline-icon" /> Account</h3>
      <div class="set-account">
        <div class="set-account__who">
          <strong>{a.name || a.email || 'Signed in'}</strong>
          {a.name && a.email ? <span>{a.email}</span> : null}
          <span class={warn && !a.bypass ? 'is-warn' : ''}>{subscriptionLine(a)}</span>
        </div>
        {a.bypass ? null : (
          <Button size="sm" variant="ghost" icon={<LogOut size={14} />} disabled={running.value} title={running.value ? 'Wait for the render to finish' : undefined} onClick={() => { open.value = false; void signOut() }}>
            Sign out
          </Button>
        )}
      </div>
    </section>
  )
}
