'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  escapeHtml,
  _generativePreviewSvg,
  getPanelHeaderHTML,
  getDisplayName,
  _hashPage,
  _parseExifDateFromBuffer,
  _proofTemplatePreviewPath,
  _isEditingTarget,
  _compactPage,
  _hydratePage,
} = require('../src/renderer_pure')

// ─── escapeHtml ──────────────────────────────────────────────────────────────
test('escapeHtml neutralizes the HTML metacharacters', () => {
  assert.equal(escapeHtml(`<img src=x onerror="a('b')">`),
    '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;')
  assert.equal(escapeHtml('A & B'), 'A &amp; B')
})

test('escapeHtml renders null/undefined as empty string', () => {
  assert.equal(escapeHtml(null), '')
  assert.equal(escapeHtml(undefined), '')
})

// ─── _generativePreviewSvg ───────────────────────────────────────────────────
test('_generativePreviewSvg emits an SVG rect per frame, colored by orient', () => {
  const svg = _generativePreviewSvg({
    _canvas: { w: 3000, h: 2000 },
    _frames: [
      { name: 'toolkithframe1', x: 0, y: 0, w: 100, h: 100 },
      { name: 'toolkitvframe1', x: 100, y: 0, w: 50, h: 100 },
    ],
  })
  assert.equal((svg.match(/<rect /g) || []).length, 3) // 1 bg + 2 frames
  assert.match(svg, /#7d4dff/) // horizontal fill
  assert.match(svg, /#ff6b9b/) // vertical fill
})

test('_generativePreviewSvg falls back to default canvas dims', () => {
  const svg = _generativePreviewSvg({})
  assert.match(svg, /viewBox="0 0 3000 2000"/)
})

// ─── getPanelHeaderHTML ──────────────────────────────────────────────────────
test('getPanelHeaderHTML embeds the panel type in both action buttons', () => {
  const html = getPanelHeaderHTML('wallpapers')
  assert.equal((html.match(/data-type="wallpapers"/g) || []).length, 2)
  assert.match(html, /btn-reload-fld/)
  assert.match(html, /btn-remove-fld/)
})

// ─── getDisplayName ──────────────────────────────────────────────────────────
test('getDisplayName returns the folder name for a normal folder', () => {
  assert.equal(getDisplayName({ name: 'Smith Wedding', nativePath: '/x/Smith Wedding' }), 'Smith Wedding')
})

test('getDisplayName surfaces the parent name for a _Thumbnails folder', () => {
  assert.equal(
    getDisplayName({ name: '_Thumbnails', nativePath: '/photos/Ceremony/_Thumbnails' }),
    'Ceremony'
  )
})

test('getDisplayName handles Windows-style separators', () => {
  assert.equal(
    getDisplayName({ name: '_thumbnails', nativePath: 'C:\\photos\\Reception\\_thumbnails' }),
    'Reception'
  )
})

// ─── _hashPage ───────────────────────────────────────────────────────────────
test('_hashPage changes when a photo adjustment changes', () => {
  const base = { templatePath: '/t.psd', photos: [{ filePath: '/a.jpg', orient: 'h', baseName: 'a' }] }
  const adjusted = { templatePath: '/t.psd', photos: [{ filePath: '/a.jpg', orient: 'h', baseName: 'a', adjust: { exposure: 20 } }] }
  assert.notEqual(_hashPage(base), _hashPage(adjusted))
})

test('_hashPage is stable for identical input (drives the render cache)', () => {
  const p = { templatePath: '/t.psd', photos: [{ filePath: '/a.jpg', orient: 'v', rotation: 90, baseName: 'a' }] }
  assert.equal(_hashPage(p), _hashPage(JSON.parse(JSON.stringify(p))))
})

test('_hashPage distinguishes placement (zoom/pan) edits', () => {
  const a = { templatePath: '/t', photos: [{ filePath: '/a', orient: 'h', baseName: 'a', placement: { scale: 1 } }] }
  const b = { templatePath: '/t', photos: [{ filePath: '/a', orient: 'h', baseName: 'a', placement: { scale: 2 } }] }
  assert.notEqual(_hashPage(a), _hashPage(b))
})

// ─── _parseExifDateFromBuffer ────────────────────────────────────────────────
// Build a minimal big-endian JPEG with an APP1/EXIF block carrying one
// DateTimeOriginal (0x9003) tag, to exercise the parser end-to-end.
function buildJpegWithExifDate(dateStr /* "YYYY:MM:DD HH:MM:SS" */) {
  const tiffHeader = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]) // 'MM', 42, IFD0 @ 8
  // IFD0: 1 entry -> ExifIFD pointer (0x8769)
  const ifd0 = Buffer.alloc(2 + 12 + 4)
  ifd0.writeUInt16BE(1, 0)
  ifd0.writeUInt16BE(0x8769, 2)   // tag
  ifd0.writeUInt16BE(4, 4)        // type LONG
  ifd0.writeUInt32BE(1, 6)        // count
  const exifIfdOffset = 8 + ifd0.length
  ifd0.writeUInt32BE(exifIfdOffset, 10) // value/offset field (entry byte 8 = buffer pos 10)
  // Exif IFD: 1 entry -> DateTimeOriginal (0x9003), ASCII, 20 bytes, value offset after IFD
  const exifIfd = Buffer.alloc(2 + 12 + 4)
  exifIfd.writeUInt16BE(1, 0)
  exifIfd.writeUInt16BE(0x9003, 2)
  exifIfd.writeUInt16BE(2, 4)     // type ASCII
  exifIfd.writeUInt32BE(20, 6)    // count
  const valOffset = exifIfdOffset + exifIfd.length
  exifIfd.writeUInt32BE(valOffset, 10) // value/offset field (entry byte 8 = buffer pos 10)
  const valBuf = Buffer.from(dateStr + '\0'.repeat(20 - dateStr.length), 'ascii')
  const tiff = Buffer.concat([tiffHeader, ifd0, exifIfd, valBuf])
  const exifPayload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff])
  const app1 = Buffer.alloc(4)
  app1[0] = 0xFF; app1[1] = 0xE1
  app1.writeUInt16BE(exifPayload.length + 2, 2) // segment size includes the 2 size bytes
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, exifPayload, Buffer.from([0xFF, 0xD9])])
}

test('_parseExifDateFromBuffer reads DateTimeOriginal from a real APP1 block', () => {
  const jpeg = buildJpegWithExifDate('2026:07:04 13:45:30')
  const ts = _parseExifDateFromBuffer(jpeg)
  assert.equal(ts, new Date('2026-07-04T13:45:30').getTime())
})

test('_parseExifDateFromBuffer returns null for a non-JPEG buffer', () => {
  assert.equal(_parseExifDateFromBuffer(Buffer.from([0x00, 0x01, 0x02, 0x03])), null)
})

test('_parseExifDateFromBuffer returns null for a JPEG with no EXIF date', () => {
  const plain = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])
  assert.equal(_parseExifDateFromBuffer(plain), null)
})

// ─── _proofTemplatePreviewPath ───────────────────────────────────────────────
test('_proofTemplatePreviewPath decodes a file: url to a filesystem path', () => {
  assert.equal(
    _proofTemplatePreviewPath({ url: 'file:///Users/x/My%20Albums/t.jpg' }),
    '/Users/x/My Albums/t.jpg'
  )
})

test('_proofTemplatePreviewPath returns null without a url or for non-file urls', () => {
  assert.equal(_proofTemplatePreviewPath({}), null)
  assert.equal(_proofTemplatePreviewPath(null), null)
  assert.equal(_proofTemplatePreviewPath({ url: 'https://example.com/t.jpg' }), null)
})

// ─── _isEditingTarget ────────────────────────────────────────────────────────
test('_isEditingTarget is true for text-entry controls', () => {
  for (const tag of ['INPUT', 'SELECT', 'TEXTAREA']) {
    assert.equal(_isEditingTarget({ tagName: tag }), true)
  }
  assert.equal(_isEditingTarget({ tagName: 'DIV', isContentEditable: true }), true)
})

test('_isEditingTarget is falsy for non-editing targets and null', () => {
  // Note: returns undefined (not literal false) for a plain element, matching
  // the original `… || t.isContentEditable`; callers use it in boolean context.
  assert.ok(!_isEditingTarget({ tagName: 'DIV' }))
  assert.ok(!_isEditingTarget({ tagName: 'BUTTON' }))
  assert.equal(_isEditingTarget(null), false)
})

// ─── _compactPage / _hydratePage (undo-redo snapshot fidelity) ───────────────
test('_compactPage keeps only the structural skeleton (id + orient, template ref)', () => {
  const page = {
    template: { id: 't1', _generative: false, url: 'file:///x.jpg', _frames: [1, 2] },
    photos: [
      { id: 'p1', orient: 'h', url: 'file:///a.jpg', baseName: 'a', adjust: { exposure: 5 } },
      { id: 'p2', orient: 'v', url: 'file:///b.jpg', baseName: 'b' },
    ],
  }
  const c = _compactPage(page)
  assert.deepEqual(c, {
    template: { id: 't1', generative: false, spec: null },
    photos: [{ id: 'p1', orient: 'h' }, { id: 'p2', orient: 'v' }],
  })
  // The heavy fields (url/adjust/baseName/_frames) must be dropped.
  assert.ok(!('url' in c.photos[0]))
})

test('_compactPage handles null / empty pages', () => {
  assert.deepEqual(_compactPage(null), { template: null, photos: [] })
  assert.deepEqual(_compactPage({}), { template: null, photos: [] })
})

test('compact → hydrate round-trips template id and photo id/orient', () => {
  const templateLibrary = [{ id: 't1', name: 'Grid', _frames: [1, 2, 3] }]
  const photoCache = { p1: { url: 'file:///a.jpg' }, p2: { url: 'file:///b.jpg' } }
  const page = {
    template: templateLibrary[0],
    photos: [{ id: 'p1', orient: 'h' }, { id: 'p2', orient: 'v' }],
  }
  const restored = _hydratePage(_compactPage(page), templateLibrary, photoCache)
  assert.equal(restored.template.id, 't1')
  assert.equal(restored.template.name, 'Grid') // re-linked to the live library object
  assert.deepEqual(restored.photos.map(p => [p.id, p.orient, p.url]), [
    ['p1', 'h', 'file:///a.jpg'],
    ['p2', 'v', 'file:///b.jpg'],
  ])
})

test('_hydratePage rebuilds a generative template ref when not in the library', () => {
  const restored = _hydratePage(
    { template: { id: 'gen_grid_1', generative: true, spec: { rows: 2, cols: 3 } }, photos: [] },
    [], {}
  )
  assert.equal(restored.template.id, 'gen_grid_1')
  assert.equal(restored.template._generative, true)
  assert.deepEqual(restored.template._spec, { rows: 2, cols: 3 })
})

test('_hydratePage yields empty url when a photo is missing from the cache', () => {
  const restored = _hydratePage({ template: null, photos: [{ id: 'ghost', orient: 'h' }] }, [], {})
  assert.equal(restored.photos[0].url, '')
  assert.equal(restored.photos[0].id, 'ghost')
})
