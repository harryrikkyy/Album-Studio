'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createPhotoshopBridge } = require('../src/bridge')
const { jsxString } = require('../src/jsx/escape')

test('jsxString escapes quotes, backslashes, newlines, and JS line separators', () => {
  assert.equal(jsxString('plain'), "'plain'")
  assert.equal(jsxString("o'brien"), "'o\\'brien'")
  assert.equal(jsxString('a\\b'), "'a\\\\b'")
  assert.equal(jsxString('a\r\nb'), "'a\\r\\nb'")
  assert.equal(jsxString('a b c'), "'a\\u2028b\\u2029c'")
  // The classic injection attempt stays inert inside the literal.
  const evil = jsxString('foo\');app.activeDocument.close();//')
  assert.equal(evil, "'foo\\');app.activeDocument.close();//'")
})

test('the factory picks the mock in E2E mode regardless of platform', () => {
  const bridge = createPhotoshopBridge({ e2e: true, platform: 'win32', jsxLogPath: undefined })
  assert.equal(bridge.name, 'mock')
})

test('the factory picks macOS on darwin and refuses unknown platforms', () => {
  const mac = createPhotoshopBridge({ e2e: false, platform: 'darwin', scriptsDir: '/tmp' })
  assert.equal(mac.name, 'macos')
  assert.throws(
    () => createPhotoshopBridge({ e2e: false, platform: 'win32' }),
    /No PhotoshopBridge implementation for win32/
  )
})

test('the mock records runJsxDataJob to the manifest and reports success', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-')), 'jobs.ndjson')
  const bridge = createPhotoshopBridge({ e2e: true, jsxLogPath: log })

  const res = await bridge.runJsxDataJob('build_page.jsx', { page: 1 })
  assert.deepEqual(res, { success: true, mocked: true })
  await bridge.runJsxDataJob('export_album.jsx', { pages: [2] })

  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(lines, [
    { scriptName: 'build_page.jsx', data: { page: 1 } },
    { scriptName: 'export_album.jsx', data: { pages: [2] } },
  ])
  fs.rmSync(path.dirname(log), { recursive: true, force: true })
})

test('the mock never throws for the direct execute calls', async () => {
  const bridge = createPhotoshopBridge({ e2e: true, jsxLogPath: undefined })
  assert.equal(await bridge.executeJSX('alert(1)'), 'success')
  assert.equal(await bridge.executeJSXFile('/nope/missing.jsx'), 'success')
  assert.equal(bridge.getPhotoshopAppName(), 'Adobe Photoshop (mocked)')
})
