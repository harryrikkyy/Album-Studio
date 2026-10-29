import test from 'node:test'
import assert from 'node:assert/strict'
import { PHOTO_PAGE_SIZE, photoKeyIndex, photoWindow } from '../src/pool_logic.ts'

const photos = Array.from({ length: 6000 }, (_, i) => ({
  id: `p${i}`,
  base: `Wedding_${String(i + 1).padStart(4, '0')}.jpg`,
}))

test('a 6000-photo shoot has bounded pages with no missing or duplicated photos', () => {
  const first = photoWindow(photos, '', 0),
    all = []
  assert.equal(first.pages, 50)
  assert.equal(first.visible.length, PHOTO_PAGE_SIZE)
  for (let page = 0; page < first.pages; page++) {
    const result = photoWindow(photos, '', page)
    assert.ok(result.visible.length <= PHOTO_PAGE_SIZE)
    all.push(...result.visible)
  }
  assert.deepEqual(all, photos)
})
test('filename search is case insensitive, trims whitespace, and clamps a formerly later page', () => {
  const result = photoWindow(photos, '  WEDDING_6000  ', 49)
  assert.deepEqual(result.visible, [photos[5999]])
  assert.equal(result.index, 0)
  assert.equal(result.pages, 1)
  assert.equal(photoWindow(photos, 'missing', 49).visible.length, 0)
  assert.equal(photoWindow([], '', 0).index, 0)
  assert.equal(photoWindow(photos, '', -5).index, 0)
})
test('keyboard navigation reaches across page boundaries and the whole shoot without wrapping', () => {
  assert.equal(photoKeyIndex('ArrowRight', 119, 6000), 120)
  assert.equal(photoKeyIndex('ArrowLeft', 120, 6000), 119)
  assert.equal(photoKeyIndex('PageDown', 0, 6000), 120)
  assert.equal(photoKeyIndex('PageUp', 120, 6000), 0)
  assert.equal(photoKeyIndex('Home', 5999, 6000), 0)
  assert.equal(photoKeyIndex('End', 0, 6000), 5999)
  assert.equal(photoKeyIndex('ArrowRight', 5999, 6000), 5999)
  assert.equal(photoKeyIndex('ArrowUp', 0, 6000), 0)
  assert.equal(photoKeyIndex('End', 0, 0), null)
  assert.equal(photoKeyIndex('Enter', 2, 6000), null)
})
