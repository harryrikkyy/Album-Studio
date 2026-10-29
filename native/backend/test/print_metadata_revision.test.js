'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const ag = require('ag-psd')
const sharpConfig = require('../../../src/sharp_config')
const sharp = sharpConfig.getSharp()
const { tmpdir } = require('./fixtures')
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
process.env.ALBUM_STUDIO_CACHE_DIR = tmpdir()
ag.initializeCanvas((w, h) => ({
  width: w,
  height: h,
  getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }) }),
}))
const pixels = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) })
function psd(frameWidth = 600) {
  return ag.writePsdBuffer({
    width: 600,
    height: 200,
    imageData: pixels(600, 200),
    children: [
      {
        name: 'ToolkitHFrame_001',
        left: 0,
        top: 0,
        right: frameWidth,
        bottom: frameWidth / 3,
        imageData: pixels(frameWidth, frameWidth / 3),
      },
    ],
  })
}
async function fixture(t, width = 1200) {
  const root = tmpdir(),
    albumPath = path.join(root, 'Album'),
    output = path.join(albumPath, 'exports'),
    shoot = path.join(root, 'Shoot'),
    templates = path.join(root, 'Templates')
  for (const folder of [output, shoot, templates]) fs.mkdirSync(folder, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const photo = path.join(shoot, 'photo.jpg'),
    template = path.join(templates, '1h0v.psd'),
    sheet = path.join(output, 'Page_001.psd')
  await sharp({ create: { width, height: width / 3, channels: 3, background: '#c43566' } })
    .jpeg()
    .toFile(photo)
  fs.writeFileSync(template, psd())
  fs.writeFileSync(sheet, psd())
  const workspace = { outputToken: output, imageTokens: [shoot], templateTokens: [templates] }
  fs.writeFileSync(
    path.join(albumPath, 'project.json'),
    JSON.stringify({
      version: 1,
      workspace,
      totalActivePages: 1,
      albumPages: {
        1: {
          photos: [{ id: 'img_Shoot_photo_jpg', orient: 'h' }],
          template: { id: 'tpl_Templates_1h0v_psd', name: '1h0v.psd', h: 1, v: 0 },
        },
      },
    }),
  )
  const { openAlbum } = require('../lib/album'),
    album = await openAlbum({ path: albumPath })
  const { spreadHash } = require('../lib/render'),
    { fileStamp } = require('../lib/cache')
  fs.mkdirSync(path.join(output, '.album-studio'), { recursive: true })
  fs.writeFileSync(
    path.join(output, '.album-studio', 'render-cache.json'),
    JSON.stringify({
      1: {
        hash: await spreadHash(album.spreads[0], album, workspace),
        sheet: await fileStamp(sheet),
        sheetDigest: sha(fs.readFileSync(sheet)),
      },
    }),
  )
  return { root, albumPath, album, workspace, output, photo, template, sheet }
}
test('delivery cannot validate a transient taller PSD header then upsample the restored low-resolution sheet', async (t) => {
  const f = await fixture(t),
    settings = require('../lib/print_settings'),
    dimensions = settings.psdDimensions
  const original = fs.readFileSync(f.sheet),
    replacement = Buffer.from(original)
  replacement.writeUInt32BE(300, 14)
  replacement.writeUInt32BE(900, 18)
  let injected = false
  t.mock.method(settings, 'psdDimensions', async (file, ...args) => {
    if (file !== f.sheet || injected) return dimensions(file, ...args)
    injected = true
    fs.writeFileSync(file, replacement)
    try {
      return await dimensions(file, ...args)
    } finally {
      fs.writeFileSync(file, original)
    }
  })
  delete require.cache[require.resolve('../lib/deliver')]
  const { startExport } = require('../lib/deliver')
  t.after(() => {
    delete require.cache[require.resolve('../lib/deliver')]
  })
  let finish, timer
  const done = new Promise((resolve, reject) => {
    finish = resolve
    timer = setTimeout(() => reject(Error('metadata export did not finish')), 20000)
  })
  let error, result
  try {
    try {
      await startExport(
        { album: f.albumPath, heightInches: 1, ppi: 300 },
        {
          emit: (event, data) => {
            if (event === 'export.finished') finish(data)
          },
        },
      )
      result = await done
    } catch (e) {
      error = e
    }
  } finally {
    clearTimeout(timer)
  }
  assert.equal(injected, true)
  assert.ok(
    error || (result && result.failed),
    'a 200-pixel sheet was accepted for a 300-PPI, one-inch delivery after an A/B/A metadata substitution',
  )
  assert.equal(fs.existsSync(path.join(f.albumPath, 'JPEG-High-Res', 'Page_001.jpg')), false)
  assert.equal(sha(fs.readFileSync(f.sheet)), sha(original))
})
test('photo metadata and full-decode checks consume the same verified low-resolution original bytes', async (t) => {
  const f = await fixture(t, 150),
    original = fs.readFileSync(f.photo)
  const replacement = await sharp({ create: { width: 1200, height: 400, channels: 3, background: '#c43566' } })
    .jpeg()
    .toBuffer()
  let injected = false
  t.mock.method(sharpConfig, 'getSharp', () => (input, ...args) => {
    injected = true
    fs.writeFileSync(f.photo, replacement)
    const pipeline = sharp(input, ...args),
      stats = pipeline.stats.bind(pipeline)
    pipeline.stats = async (...call) => {
      try {
        return await stats(...call)
      } finally {
        fs.writeFileSync(f.photo, original)
      }
    }
    return pipeline
  })
  const report = await require('../lib/preflight').preflightAlbum(f.album, f.workspace, {
    size: 'print',
    heightInches: 1,
    ppi: 300,
    phase: 'render',
  })
  assert.equal(injected, true)
  assert.ok(
    report.errors.some((e) => ['low_effective_ppi', 'photo_corrupt', 'source_changed'].includes(e.code)),
    'preflight certified replacement metadata rather than the restored original that rendering consumes',
  )
  assert.equal(sha(fs.readFileSync(f.photo)), sha(original))
})
test('template geometry cannot come from a transient easier frame while the original PSD is restored', async (t) => {
  const f = await fixture(t, 300),
    original = fs.readFileSync(f.template),
    replacement = psd(150)
  const color = require('../lib/color'),
    read = color.readPsdBuffer
  let injected = false
  t.mock.method(color, 'readPsdBuffer', async (file, ...args) => {
    if (file !== f.template || injected) return read(file, ...args)
    injected = true
    fs.writeFileSync(file, replacement)
    try {
      return await read(file, ...args)
    } finally {
      fs.writeFileSync(file, original)
    }
  })
  delete require.cache[require.resolve('../lib/preflight')]
  t.after(() => {
    delete require.cache[require.resolve('../lib/preflight')]
  })
  const report = await require('../lib/preflight').preflightAlbum(f.album, f.workspace, {
    size: 'print',
    heightInches: 1,
    ppi: 300,
    phase: 'render',
  })
  assert.equal(injected, true)
  assert.ok(
    report.errors.some((e) => ['template_corrupt', 'low_effective_ppi', 'source_changed'].includes(e.code)),
    'transient easier geometry bypassed the original low-resolution policy',
  )
  assert.equal(sha(fs.readFileSync(f.template)), sha(original))
})
