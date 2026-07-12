#!/usr/bin/env node
// bench/app_bench.js — app-level benchmarks on the synthetic 200-page album
// (run bench/make_fixture.js first):
//   node bench/app_bench.js [pages=200]
//
// Measures: launch → workspace paint, 200-page project load, page navigation
// latency, Tab 7 storyboard build (all pages), and per-process memory after
// the album is loaded. Uses the same guarded test-mode as the E2E suite.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { _electron: electron } = require('playwright-core')

const PAGES = parseInt(process.argv[2] || '200', 10)
const projectPath = path.join(__dirname, 'fixture', `project-${PAGES}.json`)

async function main() {
  if (!fs.existsSync(projectPath)) {
    console.error(`fixture missing — run: node bench/make_fixture.js ${PAGES}`)
    process.exit(1)
  }
  const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'))

  // Isolated profile so the bench measures a clean cold start, never contends
  // with the developer's live app over the DOM-storage lock, and isn't turned
  // away by the single-instance lock.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'albumstudio-bench-profile-'))
  const tLaunch = Date.now()
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, ALBUMSTUDIO_E2E: '1', ALBUMSTUDIO_USER_DATA: userData },
  })
  const win = await app.firstWindow()
  const window_ms = Date.now() - tLaunch
  await win.waitForSelector('.tablist', { state: 'visible' })
  const startup_ms = Date.now() - tLaunch
  await win.waitForFunction(() => !!window.__E2E__)

  const load_ms = await win.evaluate(async (data) => {
    const t = Date.now()
    await window.__E2E__.loadProject(data)
    return Date.now() - t
  }, project)
  const state = await win.evaluate(() => window.__E2E__.state())
  if (state.pageCount !== PAGES) {
    throw new Error(`project load incomplete: pageCount=${state.pageCount}`)
  }

  // Page navigation latency (synchronous DOM rebuild per changePage).
  const nav = await win.evaluate((totalPages) => {
    const times = []
    for (let i = 0; i < 10; i++) {
      const target = 2 + Math.floor((i / 10) * (totalPages - 2))
      const t = performance.now()
      window.__E2E__.changePage ? window.__E2E__.changePage(target) : null
      times.push(performance.now() - t)
    }
    return times
  }, PAGES)

  // Tab 7: storyboard build for every page.
  const storyboard_ms = await win.evaluate(() => {
    const btn = document.querySelector('.tab-btn[data-target="tab-export"]')
    const t = performance.now()
    btn.click()
    return performance.now() - t
  })

  // Memory per process once the album is loaded and painted.
  await new Promise((r) => setTimeout(r, 1500))
  const metrics = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => ({ type: m.type, mem_mb: Math.round(m.memory.workingSetSize / 1024) })))

  const sortedNav = [...nav].sort((a, b) => a - b)
  console.log(JSON.stringify({
    pages: PAGES,
    startup_ms,
    startup_to_window_ms: window_ms,
    project_load_ms: load_ms,
    change_page_ms: {
      median: +sortedNav[Math.floor(sortedNav.length / 2)].toFixed(1),
      max: +sortedNav[sortedNav.length - 1].toFixed(1),
    },
    storyboard_build_ms: +storyboard_ms.toFixed(1),
    processes_mem_mb: metrics,
    total_mem_mb: metrics.reduce((s, m) => s + m.mem_mb, 0),
  }, null, 2))

  await app.close()
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch (_) {}
}

main().catch((e) => { console.error(e); process.exit(1) })
