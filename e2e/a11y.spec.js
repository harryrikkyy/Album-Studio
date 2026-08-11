// Accessibility scan: run axe-core against the key screens and fail on
// serious/critical violations. Uses the isolated-profile launcher so it's a
// clean, deterministic app (no leftover project state, no lock contention).
const { test, expect } = require('@playwright/test')
const AxeBuilder = require('@axe-core/playwright').default
const { launchApp } = require('./launch')

// WCAG 2.1 A + AA is the target (plan: "contrast ≥ AA"). We gate on
// serious/critical only — moderate/minor are logged but don't fail the build
// while the design pass is in progress.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']

// Electron's Chromium can't spawn the blank assembly page that axe's default
// (runPartial) path opens via CDP Target.createTarget — it fails with "Not
// supported". Legacy mode runs axe entirely inside the target frame instead,
// which is fine here: the app is a single same-origin document with no
// cross-origin iframes to stitch together.
function buildAxe(win) {
  return new AxeBuilder({ page: win }).setLegacyMode(true).withTags(TAGS)
}

// Kill transitions/animations for the scan. .tab-btn (and others) animate
// `color` over 0.2s, so scanning right after a theme switch would sample a
// colour interpolated between the old and new palette — a phantom contrast
// failure that isn't the steady state. Freezing motion makes every scan
// deterministic and measures the real end-state colours.
async function freezeMotion(win) {
  await win.addStyleTag({
    content: '*,*::before,*::after{transition:none!important;animation:none!important}',
  })
}

function gateViolations(results) {
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical')
  return blocking.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 5),
  }))
}

// Every shipped theme, scanned. The light theme re-maps every colour token,
// so a contrast regression could hide in the theme the default scan never
// renders. axe's `color-contrast` rule is serious-impact and lives inside
// the WCAG AA tags above, so this catches it per theme.
const THEMES = ['studio-dark', 'studio-light']

test('workspace (main window) has no serious/critical a11y violations — all themes', async () => {
  const app = await launchApp()
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('.tablist', { state: 'visible' })
    await freezeMotion(win)

    // Sanity-check the theme hook is present before we rely on it, so a
    // renamed/removed API fails loudly instead of silently scanning nebula ×5.
    const ids = await win.evaluate(() => window.ADTTheme && window.ADTTheme.themes.map((t) => t.id))
    expect(ids, 'window.ADTTheme.themes must expose the shipped theme ids').toEqual(THEMES)

    for (const theme of THEMES) {
      await win.evaluate((id) => window.ADTTheme.apply(id), theme)
      // Confirm the switch landed on <html data-theme> before scanning.
      await win.waitForFunction(
        (id) => document.documentElement.getAttribute('data-theme') === id, theme)
      const results = await buildAxe(win).analyze()
      const blocking = gateViolations(results)
      expect(blocking, `[${theme}] ${JSON.stringify(blocking, null, 2)}`).toEqual([])
    }
  } finally {
    await app.close()
  }
})

// The Page Editor is opened with a spread payload rather than from project
// state, so it can be scanned with a synthetic page — no template PSD, photo
// folder or Photoshop needed. The payload exercises every panel: a photo
// (Photo panel), a text layer and a shape (Text/Shape panels), plus the layers
// rail and the spreads rail.
const EDITOR_SPREAD = {
  pageNum: 2,
  canvasW: 3000,
  canvasH: 2000,
  backdropUrl: null,
  items: [{
    id: 'p1', url: '', orient: 'h', rotation: 0, placement: null, adjust: null,
    frame: { name: 'toolkithframe1', x: 150, y: 150, w: 1250, h: 850 },
  }],
  spreads: [{ pageNum: 1, backdropUrl: null }, { pageNum: 2, backdropUrl: null }],
  overlays: [
    {
      id: 'ov_t', type: 'text', x: 0.1, y: 0.6, w: 0.8, h: 0.15,
      text: 'Sarah & James', font: 'Georgia', size: 0.08, weight: 400,
      color: '#222222', align: 'center', valign: 'middle',
    },
    { id: 'ov_s', type: 'rect', x: 0.4, y: 0.8, w: 0.2, h: 0.05, fill: '#b08d57' },
  ],
  pageBackground: '#f5f2ec',
}

test('page editor has no serious/critical a11y violations — all themes', async () => {
  const app = await launchApp()
  try {
    const main = await app.firstWindow()
    await expect(main.locator('.tablist')).toBeVisible()

    const editorPromise = app.waitForEvent('window')
    await main.evaluate((s) => window.native.invoke('editor-open', s), EDITOR_SPREAD)
    const editor = await editorPromise
    await editor.waitForLoadState('domcontentloaded')
    await editor.waitForSelector('#edLayers .ed-layer', { state: 'attached' })
    await freezeMotion(editor)

    for (const theme of THEMES) {
      // The editor reads its theme once at load from localStorage; set the
      // attribute directly so both palettes get scanned without a reload.
      await editor.evaluate((id) => {
        document.documentElement.setAttribute('data-theme', id)
        document.documentElement.style.colorScheme = id === 'studio-light' ? 'light' : 'dark'
      }, theme)

      // Scan each contextual panel, not just the default one — the Photo, Text
      // and Shape panels are display:none until something is selected, and axe
      // skips hidden subtrees, so a violation in them would never be seen.
      // Selection goes through the real layer-rail buttons (topmost first, so
      // the shape is row 0 and the text row 1) rather than a test-only hook.
      const rail = editor.locator('#edLayers .ed-layer__name')
      const panels = [
        ['page', null],
        ['shape', 0],
        ['text', 1],
      ]
      for (const [what, row] of panels) {
        if (row === null) await editor.locator('.ed-stage-wrap').click({ position: { x: 5, y: 5 } })
        else await rail.nth(row).click()
        await expect(editor.locator(
          what === 'page' ? '#edPagePanel' : what === 'text' ? '#edTextPanel' : '#edShapePanel'
        )).toBeVisible()

        const results = await buildAxe(editor).analyze()
        const blocking = gateViolations(results)
        expect(blocking, `[${theme}/${what}] ${JSON.stringify(blocking, null, 2)}`).toEqual([])
      }
    }
  } finally {
    await app.close()
  }
})

test('login window has no serious/critical a11y violations', async () => {
  const app = await launchApp({ ALBUMSTUDIO_E2E_LOGIN: '1' })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#btnGoogle', { state: 'visible' })
    await freezeMotion(win)
    const results = await buildAxe(win).analyze()
    const blocking = gateViolations(results)
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([])
  } finally {
    await app.close()
  }
})
