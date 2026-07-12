// Real-flow E2E: with the guarded test-mode, the app skips auth and opens the
// workspace. This drives the actual renderer — proving the main window loads
// past the license handoff and that a real UI interaction (tab switching) works.
// No Photoshop and no valid credentials are needed.
const { test, expect } = require('@playwright/test')
const { launchApp } = require('./launch')

test('test-mode boots into the workspace and tab switching works', async () => {
  const app = await launchApp()
  try {
    const win = await app.firstWindow()

    // We reached the workspace, not the login screen. (index.html has no
    // <title>, so assert on the workspace UI rather than document.title.)
    await expect(win.locator('.tablist')).toBeVisible()
    await expect(win.locator('#btnGoogle')).toHaveCount(0) // not the login page

    // Default tab (Album Creation) is active. (Tab state is tracked via the
    // `active` class; aria-selected is currently static in the markup — an
    // accessibility gap to fix in Phase 5.)
    const albumTab = win.locator('.tab-btn[data-target="tab-album"]')
    await expect(albumTab).toHaveClass(/\bactive\b/)
    await expect(win.locator('#tab-album')).toBeVisible()

    // Real interaction: switch to the Tools tab; its pane shows and its button
    // becomes active while the album pane hides.
    const toolsTab = win.locator('.tab-btn[data-target="tab-tools"]')
    await toolsTab.click()
    await expect(toolsTab).toHaveClass(/\bactive\b/)
    await expect(win.locator('#tab-tools')).toBeVisible()
    await expect(win.locator('#tab-album')).toBeHidden()
  } finally {
    await app.close()
  }
})
