'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  escapeHtml,
  _generativePreviewSvg,
  getPanelHeaderHTML,
  getDisplayName,
  _hashPage,
  _proofTemplatePreviewPath,
  _isEditingTarget,
  _compactPage,
  _hydratePage,
} = require('../src/renderer_pure')
const { parseExifDateFromBuffer } = require('../src/exif_date')

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

// Overlays change no photo field at all, so without them in the hash an edited
// caption would be served from the render cache and never reach the page.
test('_hashPage changes when a page overlay changes', () => {
  const photos = [{ filePath: '/a.jpg', orient: 'h', baseName: 'a' }]
  const bare = { templatePath: '/t.psd', photos }
  const captioned = { templatePath: '/t.psd', photos, overlays: [{ id: 'o', type: 'text', text: 'Hello' }] }
  const edited = { templatePath: '/t.psd', photos, overlays: [{ id: 'o', type: 'text', text: 'Goodbye' }] }
  assert.notEqual(_hashPage(bare), _hashPage(captioned))
  assert.notEqual(_hashPage(captioned), _hashPage(edited))
})

test('_hashPage changes when the page background changes', () => {
  const photos = [{ filePath: '/a.jpg', orient: 'h', baseName: 'a' }]
  assert.notEqual(
    _hashPage({ templatePath: '/t.psd', photos }),
    _hashPage({ templatePath: '/t.psd', photos, pageBackground: '#ffffff' })
  )
})

test('_hashPage distinguishes placement (zoom/pan) edits', () => {
  const a = { templatePath: '/t', photos: [{ filePath: '/a', orient: 'h', baseName: 'a', placement: { scale: 1 } }] }
  const b = { templatePath: '/t', photos: [{ filePath: '/a', orient: 'h', baseName: 'a', placement: { scale: 2 } }] }
  assert.notEqual(_hashPage(a), _hashPage(b))
})

// ─── parseExifDateFromBuffer ────────────────────────────────────────────────
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

test('parseExifDateFromBuffer reads DateTimeOriginal from a real APP1 block', () => {
  const jpeg = buildJpegWithExifDate('2026:07:04 13:45:30')
  const ts = parseExifDateFromBuffer(jpeg)
  assert.equal(ts, new Date('2026-07-04T13:45:30').getTime())
})

test('parseExifDateFromBuffer returns null for a non-JPEG buffer', () => {
  assert.equal(parseExifDateFromBuffer(Buffer.from([0x00, 0x01, 0x02, 0x03])), null)
})

test('parseExifDateFromBuffer returns null for a JPEG with no EXIF date', () => {
  const plain = Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])
  assert.equal(parseExifDateFromBuffer(plain), null)
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
  for (const tag of ['INPUT', 'TEXTAREA']) {
    assert.equal(_isEditingTarget({ tagName: tag }), true)
  }
  assert.equal(_isEditingTarget({ tagName: 'DIV', isContentEditable: true }), true)
})

test('_isEditingTarget is false for controls you operate rather than type into', () => {
  // A focused slider, checkbox or select used to count as "typing", which
  // switched every global shortcut off after a single click on one.
  assert.equal(_isEditingTarget({ tagName: 'SELECT' }), false)
  for (const type of ['range', 'checkbox', 'radio', 'color']) {
    assert.equal(_isEditingTarget({ tagName: 'INPUT', type }), false, type)
  }
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

// ─── parsePageSpec ───────────────────────────────────────────────────────────
// Selective export: "the client changed three spreads" must not mean
// re-rendering the whole album.

const { parsePageSpec } = require('../src/renderer_pure')

test('parsePageSpec reads a plain list', () => {
  assert.deepEqual(parsePageSpec('1, 3, 9', 20).pages, [1, 3, 9])
})

test('parsePageSpec expands ranges, in either direction', () => {
  assert.deepEqual(parsePageSpec('9-12', 20).pages, [9, 10, 11, 12])
  assert.deepEqual(parsePageSpec('12-9', 20).pages, [9, 10, 11, 12], 'reversed range is the same span')
})

test('parsePageSpec mixes lists and ranges, sorted and deduped', () => {
  assert.deepEqual(parsePageSpec('9-11, 1, 3, 10', 20).pages, [1, 3, 9, 10, 11])
})

test('parsePageSpec tolerates spacing, newlines and dash styles', () => {
  assert.deepEqual(parsePageSpec('  1 ,3\n9 – 10 ', 20).pages, [1, 3, 9, 10])
})

test('parsePageSpec DROPS out-of-range pages instead of clamping', () => {
  // Clamping "1-999" would silently render the whole album — exactly the
  // surprise selective export exists to prevent.
  const r = parsePageSpec('1-999', 5)
  assert.deepEqual(r.pages, [1, 2, 3, 4, 5])
  assert.ok(r.outOfRange.length > 0, 'the overshoot must be reported')
  const z = parsePageSpec('0, 7', 5)
  assert.deepEqual(z.pages, [])
  assert.deepEqual(z.outOfRange, [0, 7])
})

test('parsePageSpec reports what it could not read', () => {
  const r = parsePageSpec('1, banana, 3', 20)
  assert.deepEqual(r.pages, [1, 3])
  assert.deepEqual(r.invalid, ['banana'])
})

test('parsePageSpec on empty input selects nothing', () => {
  for (const v of ['', '   ', ',,', null, undefined]) {
    assert.deepEqual(parsePageSpec(v, 20).pages, [], `input: ${JSON.stringify(v)}`)
  }
})

test('parsePageSpec refuses an absurd range rather than looping', () => {
  const r = parsePageSpec('1-99999999', 20)
  assert.deepEqual(r.pages, [])
  assert.deepEqual(r.invalid, ['1-99999999'])
})

// ─── effectiveOrientation ────────────────────────────────────────────────────
// Getting this wrong sends a portrait photo into a landscape frame, where it
// is cropped to ribbons.

const { effectiveOrientation } = require('../src/renderer_pure')
const { planAutoFillCounts } = require('../src/autofill_counts')

test('effectiveOrientation reads the decoded pixels when unrotated', () => {
  assert.equal(effectiveOrientation(4000, 3000, 0), 'h')
  assert.equal(effectiveOrientation(3000, 4000, 0), 'v')
  assert.equal(effectiveOrientation(2000, 2000, 0), 'h', 'square counts as horizontal')
})

test('effectiveOrientation flips on a quarter turn, not a half turn', () => {
  assert.equal(effectiveOrientation(4000, 3000, 90), 'v')
  assert.equal(effectiveOrientation(4000, 3000, 270), 'v')
  assert.equal(effectiveOrientation(4000, 3000, 180), 'h', '180 keeps the aspect')
  assert.equal(effectiveOrientation(3000, 4000, 90), 'h')
})

test('effectiveOrientation normalises odd rotation values', () => {
  assert.equal(effectiveOrientation(4000, 3000, 450), 'v', '450 === 90')
  assert.equal(effectiveOrientation(4000, 3000, -90), 'v')
  assert.equal(effectiveOrientation(4000, 3000, undefined), 'h')
})

// ─── planAutoFillCounts ──────────────────────────────────────────────────────
// The invariant that matters: every photo is placed exactly once, and the
// planner always terminates.

test('planAutoFillCounts places every photo exactly once — range mode', () => {
  for (const total of [1, 5, 17, 100, 999]) {
    const r = planAutoFillCounts(total, { mode: 'range', min: 4, max: 6 })
    assert.equal(r.error, null)
    assert.equal(r.counts.reduce((a, b) => a + b, 0), total, `total ${total}`)
  }
})

test('planAutoFillCounts keeps range counts within bounds, bar the remainder', () => {
  const r = planAutoFillCounts(100, { mode: 'range', min: 4, max: 6 })
  const body = r.counts.slice(0, -1)
  for (const c of body) assert.ok(c >= 4 && c <= 6, `count ${c} outside 4..6`)
  assert.ok(r.counts[r.counts.length - 1] <= 6, 'last page takes what is left')
})

test('planAutoFillCounts spreads evenly across exactly N sheets — desired mode', () => {
  const r = planAutoFillCounts(100, { mode: 'desired', desiredSheets: 8 })
  assert.equal(r.counts.length, 8)
  assert.equal(r.counts.reduce((a, b) => a + b, 0), 100)
  // 100/8 = 12.5, so every sheet is 12 or 13 and never further apart.
  assert.ok(Math.max(...r.counts) - Math.min(...r.counts) <= 1, 'sheets differ by at most one')
})

test('planAutoFillCounts caps sheets at the photo count', () => {
  const r = planAutoFillCounts(3, { mode: 'desired', desiredSheets: 40 })
  assert.equal(r.counts.length, 3, 'no empty sheets')
  assert.equal(r.cappedTo, 3, 'and it says so, so the UI can tell the user')
  assert.deepEqual(r.counts, [1, 1, 1])
})

test('planAutoFillCounts divides exactly when it can', () => {
  const r = planAutoFillCounts(24, { mode: 'desired', desiredSheets: 6 })
  assert.deepEqual(r.counts, [4, 4, 4, 4, 4, 4])
  assert.equal(r.cappedTo, null)
})

test('the desired-mode remainder is spread, not front-loaded', () => {
  // Deterministic rng that reverses the shuffle, so the +1 lands on the LAST
  // sheets. Front-loading was the behaviour this shuffle exists to avoid.
  const r = planAutoFillCounts(10, { mode: 'desired', desiredSheets: 4 }, () => 0.999999)
  assert.equal(r.counts.reduce((a, b) => a + b, 0), 10)
  assert.equal(r.counts.filter((c) => c === 3).length, 2, 'two sheets get the +1')
})

// ── the hang ──
// min = max = 0 passed the old validation (0 > 0 is false), pushed 0 forever
// and never decremented `remaining`: the app froze and the array grew until
// it ran out of memory.

test('planAutoFillCounts refuses min=max=0 instead of looping forever', () => {
  const r = planAutoFillCounts(50, { mode: 'range', min: 0, max: 0 })
  assert.deepEqual(r.counts, [])
  assert.match(r.error, /at least 1/)
})

test('planAutoFillCounts survives a zero minimum with a usable maximum', () => {
  const r = planAutoFillCounts(50, { mode: 'range', min: 0, max: 5 })
  assert.equal(r.error, null)
  assert.equal(r.counts.reduce((a, b) => a + b, 0), 50)
  for (const c of r.counts) assert.ok(c >= 1, 'a page never takes zero photos')
})

test('planAutoFillCounts rejects negative bounds rather than growing `remaining`', () => {
  const r = planAutoFillCounts(50, { mode: 'range', min: -5, max: -1 })
  assert.deepEqual(r.counts, [])
  assert.ok(r.error)
})

test('planAutoFillCounts terminates even with a hostile rng', () => {
  // An rng pinned at 0 would make every draw the minimum; pinned at 1, the
  // maximum. Neither may stall the loop.
  for (const rng of [() => 0, () => 1, () => NaN]) {
    const r = planAutoFillCounts(37, { mode: 'range', min: 1, max: 5 }, rng)
    assert.equal(r.counts.reduce((a, b) => a + b, 0), 37)
  }
})

test('planAutoFillCounts reports bad input instead of guessing', () => {
  assert.match(planAutoFillCounts(0, { mode: 'range', min: 1, max: 5 }).error, /No photos/)
  assert.match(planAutoFillCounts(10, { mode: 'range', min: 9, max: 2 }).error, /Invalid/)
  assert.match(planAutoFillCounts(10, { mode: 'desired', desiredSheets: 0 }).error, /desired sheets/)
  assert.match(planAutoFillCounts(10, { mode: 'desired', desiredSheets: NaN }).error, /desired sheets/)
})

// ─── parseBatchResult ────────────────────────────────────────────────────────
// The render cache is persistent, so a page wrongly marked "rendered" is
// skipped forever — the user gets no file and no way to retry without
// clearing the cache by hand. Anything not clearly a success must fail.

const { parseBatchResult } = require('../src/renderer_pure')

test('parseBatchResult accepts a clean batch', () => {
  assert.deepEqual(parseBatchResult('OK 12/12', ['001']), { fatal: null, failed: [] })
  assert.deepEqual(parseBatchResult('OK 1/1', ['001']), { fatal: null, failed: [] })
})

test('parseBatchResult names the pages that failed in a partial batch', () => {
  const r = parseBatchResult('PARTIAL 10/12: 003,007', ['001', '003', '007'])
  assert.equal(r.fatal, null)
  assert.deepEqual(r.failed, ['003', '007'])
})

test('parseBatchResult surfaces a fatal error message', () => {
  assert.match(parseBatchResult('BATCH_ERROR: template not found', ['001']).fatal, /template not found/)
  assert.match(parseBatchResult('BUILD_PAGE_ERROR: no frames', ['001']).fatal, /no frames/)
})

test('parseBatchResult treats anything unrecognised as a total failure', () => {
  // Photoshop can return an empty string or a stray warning. Taking that as
  // success is what let a batch that produced nothing mark every page cached.
  for (const junk of ['', undefined, null, 'undefined', 'some warning', 42]) {
    const r = parseBatchResult(junk, ['001', '002'])
    assert.ok(r.fatal, `should be fatal for ${JSON.stringify(junk)}`)
    assert.deepEqual(r.failed, ['001', '002'], 'and no page may be considered done')
  }
})

test('parseBatchResult tolerates surrounding whitespace', () => {
  assert.deepEqual(parseBatchResult('  OK 3/3\n', ['001']), { fatal: null, failed: [] })
})
