// Integration tests: exercise the REAL main-process IPC handlers through REAL
// ipcRenderer, launched via the Electron harness. Targets the deterministic,
// Photoshop-free handlers (generative templates, project read/write, library).
// This protects the request→handler→response contract before Phase 2 reshapes it.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { test, expect } = require('@playwright/test')
const { _electron: electron } = require('playwright-core')

// Invoke a main-process IPC channel from the renderer and return its result.
function invoke(win, channel, ...args) {
  return win.evaluate(
    ({ channel, args }) => require('electron').ipcRenderer.invoke(channel, ...args),
    { channel, args }
  )
}

test.describe('main-process IPC handlers', () => {
  let app, win

  test.beforeAll(async () => {
    app = await electron.launch({
      args: [path.join(__dirname, '..')],
      env: { ...process.env, ALBUMSTUDIO_E2E: '1' },
    })
    win = await app.firstWindow()
    await expect(win.locator('.tablist')).toBeVisible()
  })

  test.afterAll(async () => { await app.close() })

  test('generative-catalog returns a non-empty catalog of well-formed templates', async () => {
    const res = await invoke(win, 'generative-catalog')
    expect(res.ok).toBe(true)
    expect(Array.isArray(res.templates)).toBe(true)
    expect(res.templates.length).toBeGreaterThan(0)
    for (const t of res.templates) {
      expect(typeof t.id).toBe('string')
      expect(Array.isArray(t.frames)).toBe(true)
      expect(t.frames.length).toBeGreaterThan(0)
    }
  })

  test('generative-regen re-hydrates a template from a catalog spec', async () => {
    const cat = await invoke(win, 'generative-catalog')
    const res = await invoke(win, 'generative-regen', cat.templates[0])
    expect(res.ok).toBe(true)
    expect(res.template.frames.length).toBe(cat.templates[0].frames.length)
  })

  test('generative-regen reports an unknown generator cleanly', async () => {
    const res = await invoke(win, 'generative-regen', { generator: 'nope' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/unknown/i)
  })

  test('project-write then project-read round-trips album state to disk', async () => {
    const dir = path.join(os.tmpdir(), `albumstudio-e2e-${Date.now()}`)
    const payload = {
      albumPages: { 1: { photos: [], template: null } },
      totalActivePages: 3,
      workspace: { imageTokens: [] },
    }
    try {
      const w = await invoke(win, 'project-write', dir, payload)
      expect(w.ok).toBe(true)
      expect(fs.existsSync(path.join(dir, 'project.json'))).toBe(true)

      const r = await invoke(win, 'project-read', dir)
      expect(r.ok).toBe(true)
      expect(r.data.version).toBe(1)               // stamped by the handler
      expect(r.data.totalActivePages).toBe(3)      // preserved from payload
      expect(r.data.albumPages['1']).toBeTruthy()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('project-read reports a clean error when no project exists', async () => {
    const missing = path.join(os.tmpdir(), `albumstudio-nope-${Date.now()}`)
    const r = await invoke(win, 'project-read', missing)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not found/i)
  })

  test('library-list returns the expected catalog structure', async () => {
    const res = await invoke(win, 'library-list')
    expect(res.ok).toBe(true)
    for (const kind of ['templates', 'wallpapers', 'pngs', 'masks', 'layouts']) {
      expect(res.library).toHaveProperty(kind)
    }
    expect(typeof res.dir).toBe('string')
  })
})
