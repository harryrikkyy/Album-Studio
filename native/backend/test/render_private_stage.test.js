'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const ag = require('ag-psd')
const { tmpdir } = require('./fixtures')
const appCache = tmpdir()
process.env.ALBUM_STUDIO_CACHE_DIR = appCache
test.after(() => fs.rmSync(appCache, { recursive: true, force: true }))
const { startRender } = require('../lib/render')
async function fixture(t) {
  const root = tmpdir(),
    album = path.join(root, 'Album'),
    shoot = path.join(root, 'Shoot'),
    templates = path.join(root, 'Templates'),
    output = path.join(album, 'exports')
  for (const folder of [album, shoot, templates, output]) fs.mkdirSync(folder, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  await sharp({ create: { width: 400, height: 200, channels: 3, background: '#be481d' } })
    .jpeg()
    .toFile(path.join(shoot, 'photo.jpg'))
  const imageData = { width: 200, height: 100, data: new Uint8ClampedArray(200 * 100 * 4).fill(255) }
  fs.writeFileSync(
    path.join(templates, '1h0v.psd'),
    ag.writePsdBuffer({
      width: 200,
      height: 100,
      imageData,
      children: [{ name: 'ToolkitHFrame_001', left: 0, top: 0, right: 200, bottom: 100, imageData }],
    }),
  )
  fs.writeFileSync(
    path.join(album, 'project.json'),
    JSON.stringify({
      version: 1,
      workspace: { imageTokens: [shoot], templateTokens: [templates], outputToken: output },
      totalActivePages: 1,
      albumPages: {
        1: {
          photos: [{ id: 'img_Shoot_photo_jpg', orient: 'h' }],
          template: { id: 'tpl_Templates_1h0v_psd', name: '1h0v.psd', h: 1, v: 0 },
        },
      },
    }),
  )
  return { album, output }
}
function findRetained(folder, base) {
  if (!fs.existsSync(folder)) return null
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name)
    if (entry.isFile() && entry.name === base) return file
    if (entry.isDirectory()) {
      const found = findRetained(file, base)
      if (found) return found
    }
  }
  return null
}
for (const scenario of ['unknown-file', 'edited-snapshot'])
  test(`render retains the complete private stage after ${scenario} without losing its committed sheet`, async (t) => {
    const f = await fixture(t),
      metadata = path.join(f.output, '.album-studio')
    let stage, originalNames, changed, done
    const finished = new Promise((resolve) => {
      done = resolve
    })
    await startRender(
      { album: f.album },
      {
        emit: (event, data) => {
          if (event === 'render.progress' && data.state === 'done') {
            stage = path.join(
              metadata,
              fs.readdirSync(metadata).find((name) => name.startsWith('render-sources-')),
            )
            originalNames = fs.readdirSync(stage)
            if (scenario === 'unknown-file') {
              changed = 'customer-notes.txt'
              fs.writeFileSync(path.join(stage, changed), 'customer recovery notes')
            } else {
              changed = originalNames.find((name) => /\.(jpg|jpeg)$/i.test(name))
              assert.ok(changed)
              fs.chmodSync(path.join(stage, changed), 0o600)
              fs.writeFileSync(path.join(stage, changed), 'customer changed snapshot')
            }
          }
          if (event === 'render.finished') done(data)
        },
      },
    )
    let timer
    const result = await Promise.race([
      finished,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('render cleanup did not settle')), 15000)
      }),
    ]).finally(() => clearTimeout(timer))
    assert.ok(stage)
    assert.ok(originalNames.length >= 2)
    assert.equal(result.done, 1)
    assert.equal(result.failed, 0)
    assert.equal(result.results[0].committed, true)
    for (const name of [...originalNames, changed])
      assert.ok(
        findRetained(metadata, name),
        `private cleanup discarded ${name} instead of retaining the complete stage`,
      )
    assert.match(result.finishingError || '', /private|preserv|review/i)
    assert.equal(
      fs.readFileSync(findRetained(metadata, changed), 'utf8'),
      scenario === 'unknown-file' ? 'customer recovery notes' : 'customer changed snapshot',
    )
    assert.equal(fs.existsSync(result.results[0].path), true)
  })
