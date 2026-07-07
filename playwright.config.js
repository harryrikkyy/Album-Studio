// Playwright config for Electron end-to-end tests.
// E2E launches the real app (main process = app.js) and drives its windows.
// Runs serially (one Electron instance at a time) and only on macOS — the app
// intentionally quits on non-darwin platforms.
const { defineConfig } = require('@playwright/test')

module.exports = defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.js',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
})
