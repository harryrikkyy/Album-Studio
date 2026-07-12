// Real-flow E2E: the Renamer window boots with its isolated preload intact.
// Regression test for the sandbox bug where the preload's
// require('./renamer_naming') threw in a (default-)sandboxed preload, killing
// the whole bridge — window.renamerAPI stayed undefined and every button in
// the window was dead (the folder picker being the visible symptom).
const { test, expect } = require('@playwright/test')
const { launchApp } = require('./launch')

test('renamer window boots with a working preload bridge', async () => {
  const app = await launchApp()
  try {
    const main = await app.firstWindow()
    await expect(main.locator('.tablist')).toBeVisible()

    // Open the Renamer through the real IPC path and wait for its window.
    const renamerPromise = app.waitForEvent('window')
    await main.evaluate(() => window.native.invoke('renamer-open'))
    const renamer = await renamerPromise
    await renamer.waitForLoadState('domcontentloaded')

    const pageErrors = []
    renamer.on('pageerror', (e) => pageErrors.push(e.message))

    // The bridge survived the preload phase…
    const api = await renamer.evaluate(() => ({
      hasPickFolder: typeof window.renamerAPI?.pickFolder === 'function',
      hasApplyRenames: typeof window.renamerAPI?.applyRenames === 'function',
      // …including the naming module it re-exports (plain-data round trip).
      pageCount: window.renamerAPI?.naming.countPageSheets(
        [{ role: 'page' }, { role: 'cover' }, { role: 'page' }]),
    }))
    expect(api.hasPickFolder).toBe(true)
    expect(api.hasApplyRenames).toBe(true)
    expect(api.pageCount).toBe(2)

    // …and the renderer script actually ran to completion: the theme boot
    // stamped the root element and the toolbar buttons exist.
    await expect(renamer.locator('#btnPickFolder')).toBeVisible()
    const theme = await renamer.evaluate(() => document.documentElement.getAttribute('data-theme'))
    expect(theme).toBeTruthy()

    // A real bridge interaction that doesn't open a native dialog: listing a
    // directory through the renamer-list-dir IPC.
    const listing = await renamer.evaluate((dir) => window.renamerAPI.listDir(dir), __dirname)
    expect(listing.ok).toBe(true)

    expect(pageErrors).toEqual([])
  } finally {
    await app.close()
  }
})
