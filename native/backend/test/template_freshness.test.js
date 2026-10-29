'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const sharp = require('../../../src/sharp_config').getSharp()
const { tmpdir } = require('./fixtures')
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()
const f = require('./color_edge_fixtures')
const { templateArt } = require('../lib/psd_template')

test('template backdrops invalidate same-size/preserved-time source edits', async (t) => {
  const dir = tmpdir(),
    file = path.join(dir, 'template.psd'),
    replacement = path.join(dir, 'replacement.psd'),
    profile = await f.icc('srgb')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  f.taggedPsd8(file, profile, f.rgbPixels([220, 10, 40, 255]))
  const seconds = Math.floor(fs.statSync(file).mtimeMs / 1000)
  fs.utimesSync(file, seconds, seconds)
  const before = await templateArt(file),
    st = fs.statSync(file)
  f.taggedPsd8(replacement, profile, f.rgbPixels([10, 220, 40, 255]))
  assert.equal(fs.statSync(replacement).size, st.size)
  fs.copyFileSync(replacement, file)
  fs.utimesSync(file, st.atime, st.mtime)
  assert.equal(fs.statSync(file).mtimeMs, st.mtimeMs, 'the old precise timestamp key is also identical')
  const after = await templateArt(file)
  assert.notEqual(after.backdrop, before.backdrop)
  const pixels = await sharp(after.backdrop).removeAlpha().raw().toBuffer()
  assert.ok(pixels[1] > pixels[0] + 100, 'the new template original supplies the new backdrop')
  assert.ok(fs.existsSync(before.backdrop), 'older derived bytes remain available for recovery')
})
