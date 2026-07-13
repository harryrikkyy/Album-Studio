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

test('workspace (main window) has no serious/critical a11y violations', async () => {
  const app = await launchApp()
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('.tablist', { state: 'visible' })
    const results = await buildAxe(win).analyze()
    const blocking = gateViolations(results)
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([])
  } finally {
    await app.close()
  }
})

test('login window has no serious/critical a11y violations', async () => {
  const app = await launchApp({ ALBUMSTUDIO_E2E_LOGIN: '1' })
  try {
    const win = await app.firstWindow()
    await win.waitForSelector('#btnGoogle', { state: 'visible' })
    const results = await buildAxe(win).analyze()
    const blocking = gateViolations(results)
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([])
  } finally {
    await app.close()
  }
})
