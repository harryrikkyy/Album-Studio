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

// Every shipped theme, scanned. The app defaults to nebula, but the other
// four re-map every colour token (notably --txt-muted against the lighter
// --bg-* surfaces), so a contrast regression could hide in a theme the
// default scan never renders. axe's `color-contrast` rule is serious-impact
// and lives inside the WCAG AA tags above, so this catches it per theme.
const THEMES = ['nebula', 'obsidian', 'synthwave', 'glass', 'glass-dark']

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
