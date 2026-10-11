import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PICKS, choose, groupDuplicates, hamming, pickKey, type Scored } from '../src/picks_logic.ts'

const p = (base: string, o: Partial<Scored> = {}): Scored => ({
  thumb: `/f/_Thumbnails/${base}.jpg`, base, folder: '/f', orient: 'h', sharpness: 150, exposure: 0.8, blackPct: 0, whitePct: 0, hash: '0000000000000000', ...o,
})

test('hamming counts differing bits', () => {
  assert.equal(hamming('0000000000000000', '0000000000000000'), 0)
  assert.equal(hamming('0000000000000000', 'f00000000000000f'), 8)
})

test('blurry and badly exposed frames are dropped; the sharpest of a burst is kept', () => {
  const shoot = [
    p('01', { hash: 'ffffffffffffffff', sharpness: 120 }),
    p('02', { hash: 'fffffffffffffffe', sharpness: 200 }), // same burst, sharper
    p('03', { sharpness: 20 }), // blurry
    p('04', { exposure: 0.1, hash: '00000000ffffffff' }), // too dark
    p('05', { hash: '00000000ffffffff' }),
  ]
  const r = choose(shoot, DEFAULT_PICKS)
  assert.deepEqual(r.keep.map((x) => x.base), ['02', '05'])
  assert.deepEqual([...r.drop].sort(), [['/f/01', 'duplicate'], ['/f/03', 'blur'], ['/f/04', 'exposure']])
})

test('duplicates are only looked for among nearby frames', () => {
  const same = 'ffffffffffffffff'
  const far = [p('001', { hash: same }), ...Array.from({ length: 20 }, (_, i) => p(String(i + 2).padStart(3, '0'), { hash: (i % 2 ? '0f' : 'f0').repeat(8) })), p('099', { hash: same })]
  const groups = groupDuplicates(far, 8, 12)
  assert.equal(groups.find((g) => g.rep.base === '001')!.members.length, 1, 'the same look hours later is a new moment')
})

test('caps keep the best of each orientation, and your own choices win', () => {
  const shoot = [p('a', { sharpness: 100, hash: '1111111111111111' }), p('b', { sharpness: 300, hash: '2222222222222222' }), p('c', { orient: 'v', hash: '4444444444444444' })]
  const capped = choose(shoot, { ...DEFAULT_PICKS, targetH: 1 })
  assert.deepEqual(capped.keep.map((x) => x.base), ['b', 'c'])
  assert.equal(capped.drop.get('/f/a'), 'cap')
  const yours = new Map([[pickKey(shoot[0]!), true], [pickKey(shoot[2]!), false]])
  const r = choose(shoot, { ...DEFAULT_PICKS, targetH: 1 }, yours)
  assert.deepEqual(r.keep.map((x) => x.base), ['a', 'b'])
  assert.equal(r.drop.get('/f/c'), 'yours')
})
