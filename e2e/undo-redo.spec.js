// Real-flow E2E: load the sample project into the running app (no native
// dialog, via the guarded test hook), then drive the actual undo/redo history
// system and assert album state restores exactly. This protects the stateful
// core — the snapshot compact/hydrate machinery — before Phase 2 refactors it.
const fs = require('fs')
const path = require('path')
const { test, expect } = require('@playwright/test')
const { launchApp } = require('./launch')

const FIXTURE = path.join(__dirname, 'fixtures', 'sample-project.json')

test('loads the sample album and undo/redo restore page state exactly', async () => {
  const project = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
  const expectedPages = Object.keys(project.albumPages).length // 15

  const app = await launchApp()
  try {
    const win = await app.firstWindow()
    await expect(win.locator('.tablist')).toBeVisible()
    // The guarded test hook must be present in test-mode.
    await win.waitForFunction(() => !!window.__E2E__)

    // Load the project (dialog-free) and confirm all pages restored.
    await win.evaluate(async (data) => { await window.__E2E__.loadProject(data) }, project)
    let s = await win.evaluate(() => window.__E2E__.state())
    expect(s.pageCount).toBe(expectedPages)

    // A real, undoable mutation: clear the album.
    await win.evaluate(() => window.__E2E__.clearAlbum())
    s = await win.evaluate(() => window.__E2E__.state())
    expect(s.pageCount).toBe(1)
    expect(s.totalActivePages).toBe(1)

    // Undo → the full album comes back exactly.
    await win.evaluate(() => window.__E2E__.undo())
    s = await win.evaluate(() => window.__E2E__.state())
    expect(s.pageCount).toBe(expectedPages)

    // Redo → back to the cleared state.
    await win.evaluate(() => window.__E2E__.redo())
    s = await win.evaluate(() => window.__E2E__.state())
    expect(s.pageCount).toBe(1)
  } finally {
    await app.close()
  }
})
