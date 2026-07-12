// Real-flow E2E: drive the actual export path — buildExportData → queueRender
// → render worker → IPC 'build-pages-batch' — with Photoshop mocked at the
// bridge boundary (runJsxDataJob records each job to a manifest and reports
// success). Proves the queue, template chunking, and render-cache behavior
// end-to-end: a second export of unchanged pages never reaches the bridge,
// and changing one page's input re-renders exactly that page.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { test, expect } = require('@playwright/test')
const { launchApp } = require('./launch')

test('export reaches the mocked bridge once; the render cache skips unchanged pages', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'albumstudio-e2e-export-'))
  const jsxLog = path.join(tmp, 'jsx-jobs.ndjson')
  const outDir = path.join(tmp, 'exports')
  fs.mkdirSync(outDir)

  const app = await launchApp({ ALBUMSTUDIO_E2E_JSX_LOG: jsxLog })
  try {
    const win = await app.firstWindow()
    await win.waitForFunction(() => !!window.__E2E__)

    // Seed real album state straight through the store's global accessors:
    // three complete pages sharing one (fake) PSD template, two photos each.
    // The bridge is mocked, so no file on any of these paths is ever opened.
    await win.evaluate((dir) => {
      window.__E2E__.resetRenderCache() // no stale cache from a previous run's userData
      outputFolder = { nativePath: dir }
      const tpl = { id: 'tpl-1', file: { nativePath: '/e2e/fake/template.psd' } }
      const cache = {}
      const page = (a, b) => ({ template: tpl, photos: [{ id: a, orient: 'H' }, { id: b, orient: 'V' }] })
      for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
        cache[id] = { file: { nativePath: `/e2e/fake/${id}.jpg` }, baseName: id }
      }
      photoCache = cache
      albumPages = { 1: page('p1', 'p2'), 2: page('p3', 'p4'), 3: page('p5', 'p6') }
      totalActivePages = 3
    }, outDir)

    // First export: all 3 pages are fresh → exactly one batched bridge job
    // (consecutive pages share the template, so they chunk together).
    await win.evaluate(() => window.__E2E__.exportRange(1, 3))
    await win.waitForFunction(() => {
      const s = window.__E2E__.renderState()
      return !s.active && s.queued === 0 && s.hashCount === 3
    })

    let jobs = fs.readFileSync(jsxLog, 'utf8').trim().split('\n').map(JSON.parse)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].scriptName).toBe('build_pages_batch.jsx')
    expect(jobs[0].data.outputPath).toBe(outDir)
    expect(jobs[0].data.templatePath).toBe('/e2e/fake/template.psd')
    expect(jobs[0].data.pages.map(p => p.pageName)).toEqual(['001', '002', '003'])

    // Second export, nothing changed: the cache must skip every page — the
    // bridge is never called again.
    await win.evaluate(() => window.__E2E__.exportRange(1, 3))
    await win.waitForFunction(() => { const s = window.__E2E__.renderState(); return !s.active && s.queued === 0 })
    expect(fs.readFileSync(jsxLog, 'utf8').trim().split('\n')).toHaveLength(1)

    // Rotate one photo on page 2 → its input hash changes → exactly page 2
    // re-renders; pages 1 and 3 still come from the cache.
    await win.evaluate(() => { projectData.imageRotations = { p3: 90 } })
    await win.evaluate(() => window.__E2E__.exportRange(1, 3))
    await win.waitForFunction(() => { const s = window.__E2E__.renderState(); return !s.active && s.queued === 0 })
    jobs = fs.readFileSync(jsxLog, 'utf8').trim().split('\n').map(JSON.parse)
    expect(jobs).toHaveLength(2)
    expect(jobs[1].data.pages.map(p => p.pageName)).toEqual(['002'])
    expect(jobs[1].data.pages[0].photos.find(p => p.id === 'p3').rotation).toBe(90)
  } finally {
    await app.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
