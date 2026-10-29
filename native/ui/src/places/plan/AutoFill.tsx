// AutoFill.tsx — plan the whole album in one go: photos in capture order, split across exactly N
// spreads or a min–max count per spread, each given a template whose frames fit.

import { signal } from '@preact/signals'
import { WandSparkles } from 'lucide-preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { plural } from '../../format'
import { autoFill, type AutoFillOptions } from '../../plan_actions'
import { album, stored, store } from '../../state'
import { Button } from '../../ui/controls'

const open = signal(false)
/** Photos to plan with (Best picks); null: every photo of the album. */
const onlyIds = signal<string[] | null>(null)
export const openAutoFill = () => {
  onlyIds.value = null
  open.value = true
}
export const openAutoFillWith = (ids: string[]) => {
  onlyIds.value = ids
  open.value = true
}

const DEFAULTS: AutoFillOptions = { mode: 'desired', desiredSheets: 23, min: 3, max: 6, chronological: true }

export function AutoFillDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  const a = album.value
  const [o, setO] = useState<AutoFillOptions>(() => ({
    ...DEFAULTS,
    ...stored<Partial<AutoFillOptions>>('as.autoFill', {}),
  }))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open.value && !d.open) d.showModal()
    else if (!open.value && d.open) d.close()
  }, [open.value])

  if (!a) return null
  const planned = a.stats.planned
  const ids = onlyIds.value
  const photos = ids ? ids.length : a.stats.photos
  const valid = o.mode === 'desired' ? o.desiredSheets >= 1 : o.min >= 1 && o.max >= o.min
  const set = (patch: Partial<AutoFillOptions>) => setO({ ...o, ...patch })
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0))

  const submit = async (e: Event) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    store('as.autoFill', o)
    const ok = await autoFill(ids ? { ...o, ids } : o)
    setBusy(false)
    if (ok) open.value = false
  }

  return (
    <dialog
      class="dialog"
      ref={ref}
      onCancel={(e) => {
        if (busy) e.preventDefault()
      }}
      onClose={() => (open.value = false)}
      aria-labelledby="autofill-title"
      aria-busy={busy || undefined}
    >
      <form method="dialog" class="dialog__body" onSubmit={submit}>
        <h2 id="autofill-title" class="dialog__title">
          <WandSparkles size={18} /> Auto-fill the album
        </h2>
        <p class="dialog__lead">
          Places {ids ? `the ${plural(photos, 'picked photo')}` : `all ${plural(photos, 'photo')}`} across the album in
          order, and gives each spread a template whose frames fit its photos.
        </p>

        <fieldset class="choice">
          <legend class="visually-hidden">How to split the photos</legend>
          <label class={`choice__row ${o.mode === 'desired' ? 'is-on' : ''}`}>
            <input type="radio" name="mode" checked={o.mode === 'desired'} onChange={() => set({ mode: 'desired' })} />
            <span class="choice__text">Exactly</span>
            <input
              class="field field--num"
              type="number"
              min={1}
              max={999}
              value={o.desiredSheets}
              aria-label="Number of spreads"
              onFocus={() => set({ mode: 'desired' })}
              onInput={(e) => set({ mode: 'desired', desiredSheets: num((e.target as HTMLInputElement).value) })}
            />
            <span class="choice__text">spreads</span>
            <span class="choice__hint">
              ≈ {o.desiredSheets ? Math.round(photos / o.desiredSheets) : '–'} photos each
            </span>
          </label>
          <label class={`choice__row ${o.mode === 'range' ? 'is-on' : ''}`}>
            <input type="radio" name="mode" checked={o.mode === 'range'} onChange={() => set({ mode: 'range' })} />
            <input
              class="field field--num"
              type="number"
              min={1}
              max={50}
              value={o.min}
              aria-label="Fewest photos per spread"
              onFocus={() => set({ mode: 'range' })}
              onInput={(e) => set({ mode: 'range', min: num((e.target as HTMLInputElement).value) })}
            />
            <span class="choice__text">to</span>
            <input
              class="field field--num"
              type="number"
              min={1}
              max={50}
              value={o.max}
              aria-label="Most photos per spread"
              onFocus={() => set({ mode: 'range' })}
              onInput={(e) => set({ mode: 'range', max: num((e.target as HTMLInputElement).value) })}
            />
            <span class="choice__text">photos per spread</span>
          </label>
        </fieldset>

        <label class="check">
          <input
            type="checkbox"
            checked={o.chronological}
            onChange={(e) => set({ chronological: (e.target as HTMLInputElement).checked })}
          />
          <span>
            Order by capture time
            <span class="check__hint">From each photo’s camera date. Off: keep the folder’s file-name order.</span>
          </span>
        </label>

        {planned ? (
          <p class="dialog__warn">
            This replaces the plan of all {plural(a.spreads.length, 'spread')}. ⌘Z brings it back.
          </p>
        ) : null}
        {!valid ? (
          <p class="dialog__error" role="alert">
            {o.mode === 'desired'
              ? 'Enter 1 or more spreads.'
              : 'The smallest count must be 1 or more, and not above the largest.'}
          </p>
        ) : null}

        <div class="dialog__actions">
          <Button variant="ghost" onClick={() => (open.value = false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!valid} busy={busy}>
            {busy ? 'Planning…' : 'Auto-fill'}
          </Button>
        </div>
      </form>
    </dialog>
  )
}
