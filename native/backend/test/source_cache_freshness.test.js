'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const sharp = require('../../../src/sharp_config').getSharp()
const { ensureThumbnails, makeThumb, surveyFolder } = require('../lib/thumbs')
const { placeable, previewable, embeddedJpeg } = require('../lib/raw')
const { bakeAdjustments } = require('../lib/parity')

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-content-cache-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const STAMP = 1700000000
function rewrite(file, bytes) { fs.writeFileSync(file, bytes); fs.utimesSync(file, STAMP, STAMP) }
const image = (color) => sharp({ create: { width: 640, height: 480, channels: 3, background: color } })
async function images(format = 'png') {
  const buffers = []
  for (const color of ['#ee1010', '#1010ee']) {
    const pipe = image(color)
    buffers.push(await (format === 'tiff' ? pipe.tiff({ compression: 'none' }) : pipe.png({ compressionLevel: 0 })).toBuffer())
  }
  assert.equal(buffers[0].length, buffers[1].length)
  return buffers
}
async function rgb(file) { const { data } = await sharp(file).resize(1, 1).raw().toBuffer({ resolveWithObject: true }); return [...data].slice(0, 3) }
const blue = async (file) => { const p = await rgb(file); assert.ok(p[2] > p[0] + 80, `blue source expected, got ${p}`) }
const red = async (file) => { const p = await rgb(file); assert.ok(p[0] > p[2] + 80, `red source expected, got ${p}`) }
function fakeDeveloper(t, after = () => {}) {
  t.mock.method(require('child_process'), 'execFile', (command, args, options, callback) => {
    assert.equal(command, '/usr/bin/sips')
    assert.equal(options.timeout, 120000)
    sharp(args.at(-3)).jpeg().toFile(args.at(-1)).then(() => { after(); callback(null, '', '') }, (error) => callback(error, '', 'fake converter failed'))
  })
}

function rawPreview(jpeg, orientation) {
  const ifd = Buffer.alloc(2 + 3 * 12 + 4)
  ifd.writeUInt16LE(3, 0)
  const entry = (i, tag, type, value) => { const o = 2 + i * 12; ifd.writeUInt16LE(tag, o); ifd.writeUInt16LE(type, o + 2); ifd.writeUInt32LE(1, o + 4); ifd.writeUInt32LE(value, o + 8) }
  entry(0, 0x0112, 3, orientation)
  entry(1, 0x0201, 4, 8 + ifd.length)
  entry(2, 0x0202, 4, jpeg.length)
  return Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]), ifd, jpeg])
}

test('thumbnails refresh after a same-size, preserved-mtime original mutation', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.png'), [a, b] = await images()
  rewrite(source, a)
  assert.deepEqual(await ensureThumbnails(dir), { made: 1, failed: [] })
  const target = path.join(dir, '_Thumbnails', 'Photo.jpg')
  await red(target)
  const before = fs.statSync(source)
  rewrite(source, b)
  assert.deepEqual([fs.statSync(source).size, fs.statSync(source).mtimeMs], [before.size, before.mtimeMs])
  assert.deepEqual((await surveyFolder(dir)).missing, ['Photo.png'])
  assert.deepEqual(await ensureThumbnails(dir), { made: 1, failed: [] })
  await blue(target)
  assert.deepEqual(await ensureThumbnails(dir), { made: 0, failed: [] })
})

test('an unverified legacy thumbnail is refreshed only while preserving its old bytes', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.png'), [a] = await images()
  rewrite(source, a)
  const target = path.join(dir, '_Thumbnails', 'Photo.jpg')
  fs.mkdirSync(path.dirname(target))
  const legacy = await image('#1010ee').resize(100).jpeg().toBuffer()
  fs.writeFileSync(target, legacy)
  assert.deepEqual((await surveyFolder(dir)).missing, ['Photo.png'])
  assert.deepEqual(await ensureThumbnails(dir), { made: 1, failed: [] })
  await red(target)
  const histories = []
  const walk = (folder) => { for (const name of fs.readdirSync(folder)) { const file = path.join(folder, name); if (fs.statSync(file).isDirectory()) walk(file); else if (name.endsWith('.jpg') && file !== target) histories.push(file) } }
  walk(path.dirname(target))
  assert.ok(histories.some((file) => fs.readFileSync(file).equals(legacy)), 'legacy customer proxy bytes remain recoverable')
})

test('a manually edited verified thumbnail is preserved and refresh reports a recoverable conflict', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.png'), [a, b] = await images()
  rewrite(source, a)
  await ensureThumbnails(dir)
  const target = path.join(dir, '_Thumbnails', 'Photo.jpg')
  const manual = await image('#1010ee').resize(100).jpeg().toBuffer()
  fs.writeFileSync(target, manual)
  rewrite(source, b)
  const result = await ensureThumbnails(dir)
  assert.equal(result.made, 0)
  assert.match(result.failed.join(' '), /edited|changed|preserv/i)
  assert.deepEqual(fs.readFileSync(target), manual)
})

test('a source change during thumbnail decoding cannot publish a stale proxy', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.png'), [a, b] = await images()
  rewrite(source, a)
  const target = path.join(dir, '_Thumbnails', 'Photo.jpg')
  fs.mkdirSync(path.dirname(target))
  const prior = await image('#10dd10').resize(100).jpeg().toBuffer()
  fs.writeFileSync(target, prior)
  const toFile = sharp.prototype.toFile
  let changed = false
  t.mock.method(sharp.prototype, 'toFile', async function (file, ...args) {
    const result = await toFile.call(this, file, ...args)
    if (!changed) { changed = true; rewrite(source, b) }
    return result
  })
  await assert.rejects(makeThumb(source, target), /changed|raced/i)
  assert.deepEqual(fs.readFileSync(target), prior)
})

test('RAW development uses source content, retains previous derived copies and rejects symlinks', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.ARW'), [a, b] = await images('tiff'), cache = path.join(dir, 'developed')
  // This fake converter isolates the development/cache lifecycle; these TIFF bytes are not
  // a proprietary camera RAW. Real sips/camera compatibility is a separate external oracle.
  fakeDeveloper(t)
  rewrite(source, a)
  const first = await placeable(source, cache)
  const oldBytes = fs.readFileSync(first)
  await red(first)
  rewrite(source, b)
  const second = await placeable(source, cache)
  assert.notEqual(second, first)
  await blue(second)
  assert.deepEqual(fs.readFileSync(first), oldBytes)
  assert.equal(await placeable(source, cache), second)
  const alias = path.join(dir, 'Alias.ARW'); fs.symlinkSync(source, alias)
  await assert.rejects(placeable(alias, cache), /symlink|regular file/i)
})

test('embedded RAW preview content and orientation refresh under a preserved stamp', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.ARW')
  const jpg = [await image('#ee1010').jpeg().toBuffer(), await image('#1010ee').jpeg().toBuffer()]
  const size = Math.max(...jpg.map((value) => value.length))
  const bytes = jpg.map((value, i) => rawPreview(Buffer.concat([value, Buffer.alloc(size - value.length)]), i ? 6 : 1))
  assert.equal(bytes[0].length, bytes[1].length)
  const dirs = { developedDir: path.join(dir, 'developed'), previewDir: path.join(dir, 'previews'), minEdge: 1 }
  rewrite(source, bytes[0])
  const first = await previewable(source, dirs)
  assert.equal(first.rotation, 0)
  await red(first.file)
  rewrite(source, bytes[1])
  const second = await previewable(source, dirs)
  assert.notEqual(second.file, first.file)
  assert.equal(second.rotation, 90)
  await blue(second.file)
  assert.ok(fs.existsSync(first.file))
})

test('adjustment baking invalidates same-size, preserved-stamp sources without replacing old cache copies', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.png'), [a, b] = await images(), cache = path.join(dir, 'adjusted')
  rewrite(source, a)
  const first = await bakeAdjustments(source, { exposure: 0.2 }, cache)
  const oldBytes = fs.readFileSync(first)
  rewrite(source, b)
  const second = await bakeAdjustments(source, { exposure: 0.2 }, cache)
  assert.notEqual(second, first)
  await blue(second)
  assert.deepEqual(fs.readFileSync(first), oldBytes)
  assert.equal(await bakeAdjustments(source, { exposure: 0.2 }, cache), second)
})

test('source changes during adjustment decoding reject publication and preserve prior cache data', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.png'), [a, b] = await images(), cache = path.join(dir, 'adjusted')
  rewrite(source, a)
  const toFile = sharp.prototype.toFile
  let changed = false
  t.mock.method(sharp.prototype, 'toFile', async function (file, ...args) {
    const result = await toFile.call(this, file, ...args)
    if (!changed) { changed = true; rewrite(source, b) }
    return result
  })
  await assert.rejects(bakeAdjustments(source, { exposure: 0.2 }, cache), /changed|raced/i)
  assert.deepEqual(fs.existsSync(cache) ? fs.readdirSync(cache).filter((name) => name.endsWith('.jpg')) : [], [])
})

test('an edit racing the thumbnail capture is restored exclusively and retained in history', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.png'), [a, b] = await images()
  rewrite(source, a)
  await ensureThumbnails(dir)
  const target = path.join(dir, '_Thumbnails', 'Photo.jpg')
  const manual = await image('#10dd10').resize(100).jpeg().toBuffer()
  rewrite(source, b)
  const exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive
  t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
    if (from === target) fs.writeFileSync(target, manual)
    return rename.call(exclusive, from, to)
  })
  const result = await ensureThumbnails(dir)
  assert.equal(result.made, 0)
  assert.match(result.failed.join(' '), /changed|preserved/i)
  assert.deepEqual(fs.readFileSync(target), manual)
  fs.writeFileSync(target, Buffer.from('a later edit of the restored proxy'))
  const historyRoot = path.join(path.dirname(target), '.album-studio-thumbs', 'history')
  assert.ok(fs.readdirSync(historyRoot).some((name) => fs.readFileSync(path.join(historyRoot, name, 'image.jpg')).equals(manual)), 'restoration cannot alias mutable target bytes into recovery history')
})

test('a new target appearing during thumbnail publication is never replaced', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.png'), [a, b] = await images()
  rewrite(source, a)
  await ensureThumbnails(dir)
  const target = path.join(dir, '_Thumbnails', 'Photo.jpg'), old = fs.readFileSync(target)
  const manual = await image('#10dd10').resize(100).jpeg().toBuffer()
  rewrite(source, b)
  const link = fs.promises.link
  t.mock.method(fs.promises, 'link', async (from, to) => {
    if (to === target) fs.writeFileSync(target, manual)
    return link.call(fs.promises, from, to)
  })
  const result = await ensureThumbnails(dir)
  assert.equal(result.made, 0)
  assert.deepEqual(fs.readFileSync(target), manual)
  const historyRoot = path.join(path.dirname(target), '.album-studio-thumbs', 'history')
  assert.ok(fs.readdirSync(historyRoot).some((name) => fs.readFileSync(path.join(historyRoot, name, 'image.jpg')).equals(old)))
})

test('RAW development detects a source mutation during the converter and publishes no stale image', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.ARW'), [a, b] = await images('tiff'), cache = path.join(dir, 'developed')
  rewrite(source, a)
  fakeDeveloper(t, () => rewrite(source, b))
  await assert.rejects(placeable(source, cache), /changed|raced/i)
  assert.deepEqual(fs.readdirSync(cache).filter((name) => name.endsWith('.jpg')), [])
})

test('manually changed development and adjustment outputs are rejected without replacement', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.ARW'), [a] = await images('tiff'), cache = path.join(dir, 'developed')
  rewrite(source, a)
  fakeDeveloper(t)
  const developed = await placeable(source, cache)
  const manual = await image('#10dd10').jpeg().toBuffer()
  fs.writeFileSync(developed, manual)
  await assert.rejects(placeable(source, cache), /edited|changed/i)
  assert.deepEqual(fs.readFileSync(developed), manual)
  const png = path.join(dir, 'Photo.png'), [bytes] = await images()
  rewrite(png, bytes)
  const adjusted = await bakeAdjustments(png, { exposure: 0.2 }, path.join(dir, 'adjusted'))
  fs.writeFileSync(adjusted, manual)
  await assert.rejects(bakeAdjustments(png, { exposure: 0.2 }, path.join(dir, 'adjusted')), /edited|changed/i)
  assert.deepEqual(fs.readFileSync(adjusted), manual)
})

test('old stamp-only RAW cache files are preserved and cannot be treated as content evidence', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.ARW'), [a] = await images('tiff'), cache = path.join(dir, 'developed')
  rewrite(source, a)
  fs.mkdirSync(cache)
  const st = fs.statSync(source), key = require('crypto').createHash('sha1').update(`${source}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16)
  const legacy = path.join(cache, `Photo-${key}.jpg`), manual = await image('#1010ee').jpeg().toBuffer()
  fs.writeFileSync(legacy, manual)
  fakeDeveloper(t)
  const developed = await placeable(source, cache)
  assert.notEqual(developed, legacy)
  await red(developed)
  assert.deepEqual(fs.readFileSync(legacy), manual)
})

test('embedded preview rejects symlinks and bounds corrupt JPEG offsets/lengths', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.ARW'), jpeg = await image('#ee1010').jpeg().toBuffer()
  const bytes = rawPreview(jpeg, 1)
  bytes.writeUInt32LE(0xffffffff, 8 + 2 + 2 * 12 + 8)
  fs.writeFileSync(source, bytes)
  assert.equal(await embeddedJpeg(source), null, 'claimed 4 GiB preview is not allocated or truncated')
  const alias = path.join(dir, 'Alias.ARW'); fs.symlinkSync(source, alias)
  await assert.rejects(embeddedJpeg(alias), /symlink|regular file/i)
})

test('different sources targeting the same thumbnail name are serialized and independently verified', async (t) => {
  const dir = directory(t), [a, b] = await images(), first = path.join(dir, 'A.png'), second = path.join(dir, 'B.png'), target = path.join(dir, '_Thumbnails', 'Shared.jpg')
  rewrite(first, a); rewrite(second, b)
  await Promise.all([makeThumb(first, target), makeThumb(second, target)])
  await blue(target)
})

for (const slot of ['image.jpg', 'evidence.json']) {
  test(`a racing unrelated ${slot} in thumbnail history cannot be overwritten`, async (t) => {
    const dir = directory(t), source = path.join(dir, 'Photo.png'), [a, b] = await images()
    rewrite(source, a)
    await ensureThumbnails(dir)
    const target = path.join(dir, '_Thumbnails', 'Photo.jpg'), prior = fs.readFileSync(target)
    rewrite(source, b)
    const exclusive = require('../lib/exclusive_rename'), rename = exclusive.renameExclusive
    const unrelated = Buffer.from(`customer recovery file ${slot}`)
    let raced
    t.mock.method(exclusive, 'renameExclusive', async (from, to) => {
      if (path.basename(to) === slot && to.includes(`${path.sep}history${path.sep}`)) { raced = to; fs.writeFileSync(to, unrelated) }
      return rename.call(exclusive, from, to)
    })
    const result = await ensureThumbnails(dir)
    assert.equal(result.made, 0)
    assert.ok(result.failed.length)
    assert.deepEqual(fs.readFileSync(raced), unrelated)
    assert.deepEqual(fs.readFileSync(target), prior)
  })
}

test('cache publication uses atomic exclusive moves when the filesystem refuses hard links', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.png'), [a] = await images()
  rewrite(source, a)
  t.mock.method(fs.promises, 'link', async () => { throw Object.assign(new Error('hard links unavailable in the simulated filesystem'), { code: 'ENOTSUP' }) })
  assert.deepEqual(await ensureThumbnails(dir), { made: 1, failed: [] })
  await red(path.join(dir, '_Thumbnails', 'Photo.jpg'))
  const adjusted = await bakeAdjustments(source, { exposure: 0.2 }, path.join(dir, 'adjusted'))
  await red(adjusted)
  const raw = path.join(dir, 'Raw.ARW'), [tiff] = await images('tiff')
  rewrite(raw, tiff); fakeDeveloper(t)
  await red(await placeable(raw, path.join(dir, 'developed')))
})

test('a source changed and restored during RAW decoding cannot change the verified pixels consumed', async (t) => {
  const dir = directory(t), source = path.join(dir, 'Photo.ARW'), [a, b] = await images('tiff'), cache = path.join(dir, 'developed')
  rewrite(source, a)
  // Alter the original during decoding. The decoder must receive the frozen red source,
  // not those transient blue bytes. Precise filesystems may additionally reject the edit.
  let decoded
  t.mock.method(require('child_process'), 'execFile', (_command, args, _options, callback) => {
    rewrite(source, b)
    decoded = args.at(-3)
    sharp(decoded).jpeg().toFile(args.at(-1)).then(() => { rewrite(source, a); callback(null, '', '') }, (error) => callback(error, '', 'fake decoder failed'))
  })
  let result
  try { result = await placeable(source, cache) } catch (error) { assert.match(error.message, /changed|raced/i) }
  assert.notEqual(decoded, source, 'the converter must consume a private verified source')
  assert.deepEqual(fs.readFileSync(source), a)
  if (result) await red(result)
  else assert.deepEqual(fs.readdirSync(cache).filter((name) => name.endsWith('.jpg')), [])
})
