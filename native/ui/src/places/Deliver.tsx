// Deliver.tsx — from plan to files: (1) print sheets built by PhotoCraft, (2) the files for the lab
// and the client (print JPEGs, review JPEGs, a low-res PDF), with where they go and live progress.

import { CircleAlert, CircleCheck, FileText, FolderOpen, FolderOutput, Images, Play, Square } from 'lucide-preact'
import { useEffect, useState } from 'preact/hooks'
import { call } from '../bridge'
import { canDeliver } from '../delivery_logic'
import { edit, proofUrl } from '../edit'
import {
  cancelExport, exportJob, exportKinds, exportPlanSig, exportSettings, exporting, loadExportPlan, megabytes, reveal,
  setExportKinds, setExportSettings, startExport,
} from '../exporting'
import { plural, shortPath, templateLabel } from '../format'
import { cancelRender, duration, job, loadPlan, plan, planError, running, startRender, type SheetState } from '../render'
import { album, toast } from '../state'
import { Button } from '../ui/controls'

const STATE_LABEL: Record<SheetState, string> = {
  current: 'Up to date',
  stale: 'Changed since render',
  missing: 'Not rendered',
  blocked: 'Can’t render',
}

function Progress({ value, total, label }: { value: number; total: number; label: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0
  return (
    <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={value} aria-label={label}>
      <span class="progress__bar" style={{ width: `${pct}%` }} />
    </div>
  )
}

function useClock(on: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [on])
  return now
}

function RenderPanel() {
  const j = job.value
  const now = useClock(running.value)
  if (!j) {
    return (
      <section class="job job--idle" aria-labelledby="render-title">
        <h2 class="job__title" id="render-title"><span class="job__step">1</span> Print sheets</h2>
        <p class="job__text">Each spread is built by the PhotoCraft engine inside Album Studio and saved as a layered PSD you can open and edit later. Photoshop isn’t needed.</p>
      </section>
    )
  }
  const done = j.results.filter((r) => r.state === 'done')
  const failed = j.results.filter((r) => r.state === 'failed')
  const warned = j.results.filter((r) => r.warnings && r.warnings.length)
  const avg = done.length ? done.reduce((a, r) => a + (r.ms || 0), 0) / done.length : 0
  const left = j.total - j.index
  const elapsed = j.finished ? j.finished.ms : now - j.startedAt
  return (
    <section class="job" aria-labelledby="render-title">
      <div class="job__head">
        <h2 class="job__title" id="render-title"><span class="job__step">1</span> {j.finished ? (j.finished.cancelled ? 'Render stopped' : 'Sheets rendered') : 'Rendering sheets'}</h2>
        {!j.finished ? <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={cancelRender}>Stop</Button> : null}
      </div>
      <Progress value={j.index} total={j.total} label="Sheets handled" />
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
    </section>
  )
}

function ExportPanel() {
  const p = exportPlanSig.value
  const s = exportSettings.value
  const k = exportKinds.value
  const j = exportJob.value
  const busy = exporting.value
  const now = useClock(busy)
  const counts = { ready: 0, todo: 0, stale: 0, nosheet: 0, blocked: 0 }
  for (const x of p?.spreads ?? []) counts[x.state]++
  const pxH = Math.round(s.heightInches * s.ppi)
  const toMake = counts.todo + counts.stale
  const canExport = canDeliver(p ? p.spreads.map((sp) => sp.state) : null, k, busy, running.value)

  return (
    <section class="job" aria-labelledby="export-title">
      <div class="job__head">
        <h2 class="job__title" id="export-title"><span class="job__step">2</span> Files for the lab and the client</h2>
        {busy ? <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={cancelExport}>Stop</Button> : null}
      </div>

      <label class="check">
        <input type="checkbox" checked={k.jpegs} disabled={busy} onChange={(e) => setExportKinds({ jpegs: (e.target as HTMLInputElement).checked })} />
        <span>
          Print and review JPEGs
          <span class="check__hint">JPEG-High-Res (best quality) and JPEG-Low-Res (small files), one per spread.</span>
        </span>
      </label>
      <div class={`export-size ${k.jpegs ? '' : 'is-off'}`}>
        <label class="export-size__opt">
          <input type="radio" name="export-size" checked={s.size === 'print'} disabled={busy || !k.jpegs} onChange={() => setExportSettings({ size: 'print' })} />
          <input class="field field--num field--xs" type="number" min={1} max={60} step={0.5} value={s.heightInches} disabled={busy || !k.jpegs} aria-label="Print height in inches" onChange={(e) => setExportSettings({ size: 'print', heightInches: Number((e.target as HTMLInputElement).value) || 12 })} />
          <span>in tall at</span>
          <input class="field field--num field--xs" type="number" min={72} max={1200} step={1} value={s.ppi} disabled={busy || !k.jpegs} aria-label="Resolution in pixels per inch" onChange={(e) => setExportSettings({ size: 'print', ppi: Number((e.target as HTMLInputElement).value) || 300 })} />
          <span>ppi</span>
          <span class="export-size__px">{s.size === 'print' ? `${pxH.toLocaleString('en-US')} px tall` : ''}</span>
        </label>
        <label class="export-size__opt">
          <input type="radio" name="export-size" checked={s.size === 'original'} disabled={busy || !k.jpegs} onChange={() => setExportSettings({ size: 'original' })} />
          <span>As rendered, no resizing</span>
        </label>
      </div>
      <label class="check">
        <input type="checkbox" checked={k.pdf} disabled={busy} onChange={(e) => setExportKinds({ pdf: (e.target as HTMLInputElement).checked })} />
        <span>
          Client PDF
          <span class="check__hint">{p ? `“${p.paths.pdf.split('/').pop()}”` : 'Low-res pages'}, one page per spread.</span>
        </span>
      </label>

      {j && (busy || j.finished) ? (
        <div class="export-run">
          <Progress value={j.index} total={j.total || 1} label="Sheets exported" />
          <p class="job__line">
            {j.phase === 'pdf' ? 'Writing the PDF…' : <><b>{j.index}</b> of {j.total}{j.current ? ` · spread ${j.current}` : ''}</>}
            {' · '}{duration(j.finished ? j.finished.ms : now - j.startedAt)}
          </p>
          {j.results.some((r) => r.state === 'failed') ? (
            <ul class="job__issues">
              {j.results.filter((r) => r.state === 'failed').map((r) => <li class="is-bad"><CircleAlert size={14} /> <span><b>Spread {r.n}</b>: {r.error}</span></li>)}
            </ul>
          ) : null}
        </div>
      ) : null}

      <p class="export-state">
        {!p ? 'Checking…' : (
          <>
            {counts.ready ? <span class="is-ok">{plural(counts.ready, 'spread')} exported</span> : null}
            {toMake ? <span>{counts.ready ? ' · ' : ''}{plural(toMake, 'spread')} to export{counts.stale ? ` (${counts.stale} changed)` : ''}</span> : null}
            {counts.nosheet ? <span class="is-warn">{counts.ready || toMake ? ' · ' : ''}{plural(counts.nosheet, 'spread')} not rendered yet</span> : null}
            {counts.blocked ? <span class="is-warn"> · {plural(counts.blocked, 'spread')} needs attention before delivery</span> : null}
          </>
        )}
      </p>

      <div class="export-actions">
        {p?.spreads.filter((sp) => sp.state === 'blocked' || sp.state === 'nosheet').map((sp) => <p class="is-warn" key={sp.n}>{sp.reason || `Spread ${sp.n} needs rendering.`}</p>)}
        {p?.preflight?.warnings.map((warning, i) => <p class="is-warn" key={`${warning.code}-${i}`}>{warning.message}</p>)}
        <Button variant="primary" icon={<Images size={14} />} disabled={!canExport} onClick={() => void startExport()} title={running.value ? 'Wait for the render to finish' : ''}>
          {busy ? 'Exporting…' : k.jpegs && toMake ? `Export ${plural(toMake, 'spread')}` : 'Export'}
        </Button>
        {k.jpegs && counts.ready && !busy ? <Button variant="ghost" onClick={() => void startExport(true)} title="Make every file again, even unchanged ones">Export all again</Button> : null}
      </div>

      {p && (counts.ready || p.pdf) ? (
        <ul class="export-out" aria-label="Exported files">
          {counts.ready ? <li><button type="button" class="link-row" onClick={() => reveal(p.paths.high)}><FolderOpen size={14} /> <span>JPEG-High-Res</span><span class="mono">{shortPath(p.paths.high, 2)}</span></button></li> : null}
          {counts.ready ? <li><button type="button" class="link-row" onClick={() => reveal(p.paths.low)}><FolderOpen size={14} /> <span>JPEG-Low-Res</span><span class="mono">{shortPath(p.paths.low, 2)}</span></button></li> : null}
          {p.pdf ? <li><button type="button" class="link-row" onClick={() => reveal(p.pdf!.path)}><FileText size={14} /> <span>{p.pdf.path.split('/').pop()}</span><span class="mono">{megabytes(p.pdf.bytes)}</span></button></li> : null}
        </ul>
      ) : null}
    </section>
  )
}

async function changeOutputFolder(current: string | undefined) {
  try {
    const folder = await call<string | null>('dialog.pickFolder', { title: 'Where print sheets are saved', directory: current ?? null })
    if (!folder) return
    const r = await edit([{ op: 'setOutputFolder', folder }])
    if (r) {
      toast('info', `Print sheets now go to ${shortPath(folder, 3)}. The JPEG folders and the PDF go next to it.`)
      await Promise.all([loadPlan(), loadExportPlan()])
    }
  } catch (e) {
    toast('error', (e as Error).message)
  }
}

export function Deliver() {
  const a = album.value!
  const [selected, setSelected] = useState<Set<number>>(new Set())
  useEffect(() => { void loadPlan(); void loadExportPlan() }, [a])
  // A render that finishes changes what can be exported.
  useEffect(() => { if (job.value?.finished) void loadExportPlan() }, [job.value?.finished])
  const p = plan.value
  const ep = exportPlanSig.value
  const byN = new Map((p?.spreads ?? []).map((s) => [s.n, s]))
  const exportByN = new Map((ep?.spreads ?? []).map((s) => [s.n, s.state]))
  // Sheets edited by hand in the editor are only rendered again when chosen one by one.
  const toRender = (p?.spreads ?? []).filter((s) => (s.state === 'missing' || s.state === 'stale') && !s.edited).map((s) => s.n)
  const editedChosen = [...selected].filter((n) => byN.get(n)?.edited)
  const editedCount = (p?.spreads ?? []).filter((s) => s.edited).length
  const current = job.value && !job.value.finished ? job.value.current : null
  const busy = running.value || exporting.value

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
            <FolderOutput size={13} class="inline-icon" /> Sheets go to{' '}
            <button type="button" class="link-inline mono" title={`${p?.outputFolder ?? ''} — show in Finder`} onClick={() => p?.outputFolder && reveal(p.outputFolder)}>{shortPath(p?.outputFolder, 3) || '…'}</button>
            {' '}<button type="button" class="link" disabled={busy} onClick={() => void changeOutputFolder(p?.outputFolder)}>Change…</button>
          </p>
        </div>
        <div class="place__actions">
          {selected.size ? (
            <>
              <Button variant="ghost" onClick={() => setSelected(new Set())} disabled={busy}>Clear selection</Button>
              {editedChosen.length ? <span class="deliver__warn">Replaces the hand edits in spread{editedChosen.length > 1 ? 's' : ''} {editedChosen.join(', ')}</span> : null}
              <Button variant="primary" icon={<Play size={14} />} disabled={busy} onClick={() => startRender([...selected].sort((x, y) => x - y), true, editedChosen.length > 0)}>
                Render {plural(selected.size, 'spread')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" disabled={busy || !p} onClick={() => startRender(null, true)} title={editedCount ? `Render every spread again, even unchanged ones. ${plural(editedCount, 'sheet')} edited in the editor ${editedCount > 1 ? 'are' : 'is'} kept.` : 'Render every spread again, even unchanged ones'}>Render all again</Button>
              <Button variant="primary" icon={<Play size={14} />} disabled={busy || !toRender.length} onClick={() => startRender(toRender)}>
                {running.value ? 'Rendering…' : toRender.length ? `Render ${plural(toRender.length, 'sheet')}` : 'All sheets up to date'}
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
            const isNow = current === s.n || (exporting.value && exportJob.value?.current === s.n)
            const ex = exportByN.get(s.n)
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
                  <span class="sheet__img">{s.proof ? <img src={proofUrl(s)} alt="" loading="lazy" decoding="async" /> : null}</span>
                  <span class="sheet__cap">
                    <span class="sheet__n">{s.n}</span>
                    <span class="sheet__tpl">{templateLabel(s.template?.name)}</span>
                    {ex === 'ready' ? <span class="sheet__jpeg" title="Print and review JPEGs are made from this sheet">JPEG</span> : null}
                    <span
                      class={`chip chip--${isNow ? 'now' : st?.edited ? 'edited' : state ?? 'loading'}`}
                      title={st?.edited ? 'Saved from the editor after it was rendered. Renders keep it unless you choose this spread and render it.' : undefined}
                    >
                      {isNow ? (running.value ? 'Rendering…' : 'Exporting…') : st?.edited ? (state === 'stale' ? 'Edited · plan changed' : 'Edited in the editor') : state ? (state === 'blocked' ? st?.reason : STATE_LABEL[state]) : '…'}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
        <div class="deliver__side">
          <RenderPanel />
          <ExportPanel />
        </div>
      </div>
    </section>
  )
}
