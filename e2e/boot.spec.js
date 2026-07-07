// First E2E: the app launches and reaches its login window.
// This needs no Photoshop, no valid .env, and no real auth — the login screen
// is a static page — so it's a safe, deterministic "does it boot" check that
// guards against a regression making the app fail to start at all.
const path = require('path')
const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright-core')

test('app boots to the login window with the sign-in button', async () => {
  // Force the login screen deterministically (independent of any saved license
  // on the dev machine), so this guards the real login path users hit on a
  // fresh install.
  const app = await electron.launch({
    args: [path.join(__dirname, '..')], // launch the project (main = app.js)
    env: { ...process.env, ALBUMSTUDIO_E2E_LOGIN: '1' },
  })
  try {
    const win = await app.firstWindow()
    await expect(win).toHaveTitle(/Creative Hubb/i)
    await expect(win.locator('#btnGoogle')).toBeVisible()
  } finally {
    await app.close()
  }
})
