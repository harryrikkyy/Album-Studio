import test from 'node:test'
import assert from 'node:assert/strict'
import { albumShape, changedSpreads, colourMatrix, commonShape, describeSlots, filterTemplates, panBy, placementLayout, rangeSelect, seenAspect, selectionSlots, shapeOf, slotsOf, templateFits, turnOf, type Template } from '../src/plan_logic.ts'
import type { Album, Photo, Spread } from '../src/types.ts'

const photo = (id: string, orient: 'h' | 'v'): Photo => ({ id, base: id, folder: '/f', thumb: `/f/${id}.jpg`, original: null, orient, width: null, height: null, rotation: 0, usedOn: [] })
const spread = (n: number, photoIds: string[], tpl: { id: string; h: number; v: number } | null): Spread => ({
  n,
  photoIds,
  missingPhotos: 0,
  template: tpl ? { ...tpl, name: `${tpl.id}.psd`, file: null, preview: null } : null,
  proof: null,
  sheet: null,
  edited: false,
})
const album = (spreads: Spread[]): Album => ({
  path: '/a', file: '/a/project.json', name: 'A', savedAt: null, outputFolder: null, photoFolders: [], templateCollections: [],
  spreads,
  photos: { a: photo('a', 'h'), b: photo('b', 'v'), c: photo('c', 'h') },
  pool: ['a', 'b', 'c'],
  stats: { spreads: spreads.length, photos: 3, used: 0, planned: 0 },
})

test('slots count landscape and portrait photos; photos gone from disk are not counted', () => {
  const a = album([spread(1, ['a', 'b', 'c', 'gone'], null)])
  assert.deepEqual(slotsOf(a, a.spreads[0]!), { h: 2, v: 1 })
})

test('a template fits when it has exactly the photos’ frames', () => {
  const a = album([spread(1, ['a', 'b'], { id: 't', h: 1, v: 1 }), spread(2, ['a', 'c'], { id: 't', h: 1, v: 1 }), spread(3, ['a'], null)])
  assert.equal(templateFits(a, a.spreads[0]!), true)
  assert.equal(templateFits(a, a.spreads[1]!), false)
  assert.equal(templateFits(a, a.spreads[2]!), null, 'no template: no verdict')
})

test('changed spreads: different photos or template than the spread that was there', () => {
  const before = album([spread(1, ['a'], { id: 't1', h: 1, v: 0 }), spread(2, ['b'], { id: 't2', h: 0, v: 1 })])
  const after = album([spread(1, ['a'], { id: 't1', h: 1, v: 0 }), spread(2, ['b', 'c'], { id: 't2', h: 1, v: 1 }), spread(3, [], null)])
  assert.deepEqual(changedSpreads(before, after), [2, 3])
  const moved = album([spread(1, ['b'], { id: 't2', h: 0, v: 1 }), spread(2, ['a'], { id: 't1', h: 1, v: 0 })])
  assert.deepEqual(changedSpreads(before, moved), [1, 2], 'a move changes both places')
  assert.deepEqual(changedSpreads(null, before), [1, 2])
})

test('shift-click selects the run between the anchor and the click, either way', () => {
  const list = ['a', 'b', 'c', 'd', 'e']
  assert.deepEqual(rangeSelect(list, 'b', 'd'), ['b', 'c', 'd'])
  assert.deepEqual(rangeSelect(list, 'd', 'b'), ['b', 'c', 'd'])
  assert.deepEqual(rangeSelect(list, null, 'c'), ['c'])
  assert.deepEqual(rangeSelect(list, 'gone', 'c'), ['c'])
  assert.deepEqual(rangeSelect(list, 'a', 'zz'), [])
})

test('templates filter by fit, collection and every search word', () => {
  const t = (name: string, collection: string, h: number, v: number): Template => ({ id: name, name, file: `/${name}`, preview: null, collection, h, v })
  const all = [t('2h1v_0001.psd', 'A', 2, 1), t('2h1v_0019.psd', 'B', 2, 1), t('3h0v_0002.psd', 'A', 3, 0)]
  const q = { fits: true, h: 2, v: 1, collection: null, text: '' }
  assert.deepEqual(filterTemplates(all, q).map((x) => x.name), ['2h1v_0001.psd', '2h1v_0019.psd'])
  assert.deepEqual(filterTemplates(all, { ...q, collection: 'A' }).map((x) => x.name), ['2h1v_0001.psd'])
  assert.deepEqual(filterTemplates(all, { ...q, fits: false, text: '00 2h' }).map((x) => x.name), ['2h1v_0001.psd', '2h1v_0019.psd'])
  assert.deepEqual(filterTemplates(all, { ...q, fits: false, text: '0019' }).map((x) => x.name), ['2h1v_0019.psd'])
})

test('slots read as words', () => {
  assert.equal(describeSlots(2, 1), '2 landscape + 1 portrait')
  assert.equal(describeSlots(0, 3), '3 portrait')
  assert.equal(describeSlots(0, 0), 'no photos')
})

test('a turned photo is seen the other way round; a selection counts its landscape and portrait photos', () => {
  const p = { width: 300, height: 200, orient: 'h' as const, rotation: 0 }
  assert.equal(seenAspect(p), 1.5)
  assert.equal(seenAspect({ ...p, rotation: 90 }), 200 / 300, 'a quarter turn: portrait')
  assert.equal(seenAspect({ ...p, rotation: 180 }), 1.5, 'a half turn keeps the shape')
  assert.equal(seenAspect({ ...p, width: null, height: null, orient: 'v' }), 2 / 3, 'no size: by orientation')
  assert.deepEqual([turnOf({ rotation: -90 }), turnOf({ rotation: 450 }), turnOf({ rotation: 0 })], [270, 90, 0])
  const a = album([])
  assert.deepEqual(selectionSlots(a, ['a', 'b', 'c', 'gone']), { h: 2, v: 1 })
})

test('turning a photo changes the picture of every spread it is on', () => {
  const prev = album([spread(1, ['a', 'b'], { id: 't', h: 1, v: 1 }), spread(2, ['c'], null)])
  const next: Album = { ...prev, photos: { ...prev.photos, b: { ...prev.photos.b!, rotation: 90 } } }
  assert.deepEqual(changedSpreads(prev, next), [1])
})

test('an album keeps to one page shape: its spreads’ templates decide, else its catalogue', () => {
  const t = (id: string, width: number, height: number): Template => ({ id, name: `${id}.psd`, file: `/t/${id}.psd`, preview: null, collection: 'C', h: 1, v: 0, width, height })
  const wide = t('wide', 7200, 2400)
  const wideHiRes = t('wide2', 10800, 3600)
  const tall = t('tall', 7200, 4500)
  assert.equal(shapeOf(wide), shapeOf(wideHiRes), 'another resolution, the same shape')
  assert.equal(shapeOf({ width: null, height: 100 }), null)
  assert.equal(commonShape([wide, tall, tall]), shapeOf(tall))
  const a = album([spread(1, ['a'], { id: 'wide', h: 1, v: 0 }), spread(2, ['c'], { id: 'wide2', h: 1, v: 0 }), spread(3, [], null)])
  assert.equal(albumShape(a, [wide, wideHiRes, tall, tall, tall]), 3, 'what the spreads use, not what the catalogue has most of')
  assert.equal(albumShape(album([spread(1, [], null)]), [wide, tall, tall]), 1.6, 'a new album: the catalogue’s most common shape')
  const tie = album([spread(1, ['a'], { id: 'tall', h: 1, v: 0 }), spread(2, ['c'], { id: 'wide', h: 1, v: 0 })])
  assert.equal(albumShape(tie, [wide, wideHiRes, tall]), 3, 'a tie goes to the shape the catalogue has most of')
  const fits = filterTemplates([wide, wideHiRes, tall], { fits: true, h: 1, v: 0, collection: null, text: '', shape: 3 })
  assert.deepEqual(fits.map((x) => x.id), ['wide', 'wide2'])
})

test('a photo covers its frame, zooms on that, and pans across what is cropped, as the sheets do', () => {
  // A 300×200 photo in a 100×100 frame: covered at height, 150 wide, 50 cropped.
  const fit = placementLayout(100, 100, 300, 200, null)
  assert.deepEqual(fit, { left: -25, top: -0, width: 150, height: 100, overflowX: 50, overflowY: 0 })
  assert.equal(placementLayout(100, 100, 300, 200, { scale: 1, ox: 1, oy: 0 }).left, -50, 'ox 1: its right edge shows')
  assert.equal(placementLayout(100, 100, 300, 200, { scale: 1, ox: -1, oy: 0 }).left, -0, 'ox -1: its left edge')
  const z = placementLayout(100, 100, 300, 200, { scale: 2, ox: 0, oy: 0 })
  assert.deepEqual([z.width, z.height, z.left, z.top], [300, 200, -100, -50], 'zoom ×2 about the centre')
  // Dragging the picture right shows more of its left side: ox goes down.
  assert.deepEqual(panBy({ scale: 1, ox: 0, oy: 0 }, 10, 0, 50, 0), { scale: 1, ox: -0.4, oy: 0 })
  assert.deepEqual(panBy({ scale: 1, ox: 0, oy: 0 }, -500, 30, 50, 0), { scale: 1, ox: 1, oy: 0 }, 'stops at the edge; no overflow, no pan')
})

test('the live colour look follows the sliders', () => {
  assert.equal(colourMatrix(null), null)
  assert.equal(colourMatrix({ exposure: 0, contrast: 0 }), null, 'all zero: no filter')
  const ex = colourMatrix({ exposure: 100 })!
  assert.deepEqual([ex[0], ex[6], ex[12], ex[18]], [2, 2, 2, 1], '+100 exposure: one stop brighter')
  const bw = colourMatrix({ bw: true })!
  assert.deepEqual(bw.slice(0, 3), bw.slice(5, 8), 'black & white: every channel the same mix')
  const warm = colourMatrix({ warmth: 100 })!
  assert.ok(warm[0]! > 1 && warm[12]! < 1, 'warmer: more red, less blue')
  const hard = colourMatrix({ contrast: 100 })!
  assert.deepEqual([hard[0], hard[4]], [2, -0.5], 'contrast pivots on mid-grey')
})
