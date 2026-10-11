import test from 'node:test'
import assert from 'node:assert/strict'
import { changedSpreads, describeSlots, filterTemplates, rangeSelect, slotsOf, templateFits, type Template } from '../src/plan_logic.ts'
import type { Album, Photo, Spread } from '../src/types.ts'

const photo = (id: string, orient: 'h' | 'v'): Photo => ({ id, base: id, folder: '/f', thumb: `/f/${id}.jpg`, original: null, orient, width: null, height: null, usedOn: [] })
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
