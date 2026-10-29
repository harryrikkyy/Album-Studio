import test from 'node:test'
import assert from 'node:assert/strict'
import { plural, relativeTime, shortPath, signature, templateLabel } from '../src/format.ts'
import { fileUrl } from '../src/bridge.ts'

test('plural counts with thousands separators', () => {
  assert.equal(plural(1, 'spread'), '1 spread')
  assert.equal(plural(23, 'spread'), '23 spreads')
  assert.equal(plural(1200, 'photo'), '1,200 photos')
  assert.equal(plural(2, 'person', 'people'), '2 people')
})

test('relative time reads naturally', () => {
  const now = new Date('2026-10-10T12:00:00Z')
  assert.equal(relativeTime('2026-10-10T11:59:40Z', now), 'just now')
  assert.equal(relativeTime('2026-10-10T11:50:00Z', now), '10 min ago')
  assert.equal(relativeTime('2026-10-10T07:00:00Z', now), '5 h ago')
  assert.equal(relativeTime('2026-10-09T10:00:00Z', now), 'yesterday')
  assert.equal(relativeTime('2026-10-06T12:00:00Z', now), '4 days ago')
  assert.equal(relativeTime('2026-08-01T12:00:00Z', now), '1 Aug')
  assert.equal(relativeTime('2025-08-01T12:00:00Z', now), '1 Aug 2025')
  assert.equal(relativeTime(null, now), '')
  assert.equal(relativeTime('not a date', now), '')
})

test('signature and labels', () => {
  assert.equal(signature(6, 1), '6 H · 1 V')
  assert.equal(signature(0, 8), '8 V')
  assert.equal(signature(0, 0), 'Empty')
  assert.equal(templateLabel('1h7v_0003 (2).psd'), '1h7v_0003 (2)', 'a numbered variant is a different design')
  assert.equal(templateLabel(null), 'No template')
  assert.equal(shortPath('/Volumes/Harry/ALBUM BOOKINGS/Sai BFA/Wedding Album', 2), '…/Sai BFA/Wedding Album')
  assert.equal(shortPath('/a/b', 2), '/a/b')
})

test('local files become as:// URLs, each path part encoded', () => {
  assert.equal(
    fileUrl("/Volumes/Harry/Album !/PSD's/Page 1#.jpg"),
    "as://file/Volumes/Harry/Album%20!/PSD's/Page%201%23.jpg",
  )
  assert.equal(fileUrl(null), undefined)
})
