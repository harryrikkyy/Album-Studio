'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createFsPaths, folderEntry } = require('../src/services/fs_paths')

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-paths-test-'))
  fs.mkdirSync(path.join(root, 'Sub'))
  fs.writeFileSync(path.join(root, 'a.jpg'), 'x')
  fs.writeFileSync(path.join(root, 'Sub', 'b.jpg'), 'x')
  return root
}

test('folderEntry lists children with the loader-facing shape', async () => {
  const root = makeTree()
  try {
    const entry = folderEntry(root)
    assert.equal(entry.isFolder, true)
    assert.equal(entry.nativePath, root)
    const children = await entry.getEntries()
    const byName = Object.fromEntries(children.map(c => [c.name, c]))
    assert.equal(byName['Sub'].isFolder, true)
    assert.equal(byName['a.jpg'].isFile, true)
    assert.equal(byName['a.jpg'].url, 'file://' + path.join(root, 'a.jpg'))
    const sub = await entry.getEntry('Sub')
    assert.equal((await sub.getEntries())[0].name, 'b.jpg')
    await assert.rejects(() => entry.getEntry('missing'), /Not found: missing/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('pickFolder wraps the picked path; cancel returns null', async () => {
  const root = makeTree()
  try {
    let answer = root
    const svc = createFsPaths(async (channel) => {
      assert.equal(channel, 'pick-folder')
      return answer
    })
    const folder = await svc.pickFolder()
    assert.equal(folder.nativePath, root)
    assert.equal(folder.name, path.basename(root))
    answer = null
    assert.equal(await svc.pickFolder(), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('tokens round-trip: tokenForFolder → entryForToken', async () => {
  const root = makeTree()
  try {
    const svc = createFsPaths(async () => root)
    const folder = await svc.pickFolder()
    const token = await svc.tokenForFolder(folder)
    assert.equal(token, root) // a token IS the absolute path (project-file compat)
    const back = await svc.entryForToken(token)
    assert.equal(back.nativePath, root)
    assert.equal(await svc.entryForToken(path.join(root, 'gone')), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
