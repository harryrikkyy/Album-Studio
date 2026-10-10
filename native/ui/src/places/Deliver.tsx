// Deliver.tsx — print sheets built by PhotoCraft: what needs rendering, render it, watch it go.

import { CircleAlert, CircleCheck, FolderOutput, Play, Square } from 'lucide-preact'
import { useEffect, useState } from 'preact/hooks'
import { plural, shortPath, templateLabel } from '../format'
import { cancelRender, duration, job, loadPlan, plan, planError, running, startRender, type SheetState } from '../render'
import { album, previewUrl } from '../state'
import { Button } from '../ui/controls'

const STATE_LABEL: Record<SheetState, string> = {
  current: 'Up to date',
  stale: 'Changed since render',
  missing: 'Not rendered',
  blocked: 'Can’t render',
}

function JobPanel() {
  const j = job.value
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running.value) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [running.value])
  if (!j) {
    return (
      <aside class="job job--idle" aria-label="Render">
        <h2 class="job__title">Render</h2>
        <p class="job__text">Sheets are built by the PhotoCraft engine inside Album Studio and saved as layered PSDs you can open and edit later. Photoshop isn’t needed.</p>
      </aside>
    )
  }
  const done = j.results.filter((r) => r.state === 'done')
  const failed = j.results.filter((r) => r.state === 'failed')
  const warned = j.results.filter((r) => r.warnings && r.warnings.length)
  const pct = j.total ? Math.round((j.index / j.total) * 100) : 0
  const avg = done.length ? done.reduce((a, r) => a + (r.ms || 0), 0) / done.length : 0
  const left = j.total - j.index
  const elapsed = (j.finished ? j.finished.ms : now - j.startedAt)
  return (
    <aside class="job" aria-label="Render progress">
      <div class="job__head">
        <h2 class="job__title">{j.finished ? (j.finished.cancelled ? 'Render stopped' : 'Render finished') : 'Rendering'}</h2>
        {!j.finished ? <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={cancelRender}>Stop</Button> : null}
      </div>
      <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={j.total} aria-valuenow={j.index} aria-label="Sheets handled">
        <span class="progress__bar" style={{ width: `${pct}%` }} />
      </div>
      <p class="job__line">
        <b>{j.index}</b> of {j.total} · {duration(elapsed)}
        {!j.finished && avg && left ? <> · about {duration(avg * left)} left</> : null}
      </p>
      {!j.finished && j.current ? <p class="job__now">Spread {j.current} · {j.phase}</p> : null}
      <dl class="job__counts">
        <div><dt>Rendered</dt><dd>{done.length}</dd></div>
        <div><dt>Unchanged</dt><dd>{j.results.filter((r) => r.state === 'skipped').length}</dd></div>
        <div><dt>Failed</dt><dd class={failed.length ? 'is-bad' : ''}>{failed.length}</dd></div>
      </dl>
      {failed.length || warned.length ? (
        <ul class="job__issues">
          {failed.map((r) => <li class="is-bad"><CircleAlert size={14} /> <span><b>Spread {r.n}</b> failed: {r.error}</span></li>)}
          {warned.map((r) => <li><CircleAlert size={14} /> <span><b>Spread {r.n}</b>: {r.warnings!.join('; ')}</span></li>)}
        </ul>
      ) : j.finished && !failed.length ? (
        <p class="job__ok"><CircleCheck size={14} /> Every sheet built cleanly.</p>
      ) : null}
    </aside>
  )
}

export function Deliver() {
  const a = album.value!
  const [selected, setSelected] = useState<Set<number>>(new Set())
  useEffect(() => { void loadPlan() }, [a.path])
  const p = plan.value
  const byN = new Map((p?.spreads ?? []).map((s) => [s.n, s]))
  const toRender = (p?.spreads ?? []).filter((s) => s.state === 'missing' || s.state === 'stale').map((s) => s.n)
  const current = job.value && !job.value.finished ? job.value.current : null
  const busy = running.value

  const toggle = (n: number) => {
    const next = new Set(selected)
    if (next.has(n)) next.delete(n)
    else next.add(n)
    setSelected(next)
  }

  return (
    <section class="place place--deliver" aria-labelledby="deliver-title">
      <header class="place__head">
        <div>
          <h1 id="deliver-title" class="place__title">Deliver</h1>
          <p class="place__sub">
            <FolderOutput size={13} class="inline-icon" /> Sheets go to <span class="mono" title={p?.outputFolder}>{shortPath(p?.outputFolder, 3) || '…'}</span>
          </p>
        </div>
        <div class="place__actions">
          {selected.size ? (
            <>
              <Button variant="ghost" onClick={() => setSelected(new Set())} disabled={busy}>Clear selection</Button>
              <Button variant="primary" icon={<Play size={14} />} disabled={busy} onClick={() => startRender([...selected].sort((x, y) => x - y), true)}>
                Render {plural(selected.size, 'spread')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={busy || !p} onClick={() => startRender(null, true)} title="Render every spread again, even unchanged ones">Render all again</Button>
              <Button variant="primary" icon={<Play size={14} />} disabled={busy || !toRender.length} onClick={() => startRender(toRender)}>
                {busy ? 'Rendering…' : toRender.length ? `Render ${plural(toRender.length, 'sheet')}` : 'All sheets up to date'}
              </Button>
            </>
          )}
        </div>
      </header>
      {planError.value ? <p class="notice notice--error" role="alert">{planError.value}</p> : null}
      <div class="deliver">
        <ol class="sheet-grid" aria-label="Spreads">
          {a.spreads.map((s) => {
            const st = byN.get(s.n)
            const state = st?.state
            const isNow = current === s.n
            return (
              <li key={s.n}>
                <button
                  type="button"
                  class={`sheet ${selected.has(s.n) ? 'is-selected' : ''} ${isNow ? 'is-rendering' : ''}`}
                  aria-pressed={selected.has(s.n)}
                  disabled={state === 'blocked'}
                  onClick={() => toggle(s.n)}
                  title={st?.reason || (st?.unsupported?.length ? st.unsupported.join('; ') : '')}
                >
                  <span class="sheet__img">{s.proof ? <img src={previewUrl(s.proof)} alt="" loading="lazy" decoding="async" /> : null}</span>
                  <span class="sheet__cap">
                    <span class="sheet__n">{s.n}</span>
                    <span class="sheet__tpl">{templateLabel(s.template?.name)}</span>
                    <span class={`chip chip--${isNow ? 'now' : state ?? 'loading'}`}>
                      {isNow ? 'Rendering…' : state ? (state === 'blocked' ? st?.reason : STATE_LABEL[state]) : '…'}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
        <JobPanel />
      </div>
    </section>
  )
}
