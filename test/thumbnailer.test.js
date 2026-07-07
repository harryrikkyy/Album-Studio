'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { SHARP_DECODABLE, RAW_EXT, THUMB_MAX_EDGE } = require('../src/thumbnailer')

test('SHARP_DECODABLE matches the fast-lane formats', () => {
  for (const name of ['a.jpg', 'b.JPEG', 'c.png', 'd.tif', 'e.tiff', 'f.webp', 'g.heic', 'h.heif', 'i.avif']) {
    assert.ok(SHARP_DECODABLE.test(name), `${name} should be sharp-decodable`)
  }
})

test('SHARP_DECODABLE does not claim RAW formats', () => {
  for (const name of ['a.cr2', 'b.nef', 'c.arw', 'd.dng']) {
    assert.ok(!SHARP_DECODABLE.test(name), `${name} must not go down the fast lane`)
  }
})

test('RAW_EXT matches the Camera-Raw lane formats', () => {
  for (const name of ['a.cr2', 'b.CR3', 'c.nef', 'd.arw', 'e.dng', 'f.rw2', 'g.orf', 'h.raf', 'i.srw']) {
    assert.ok(RAW_EXT.test(name), `${name} should route to the RAW lane`)
  }
})

test('the two lanes are mutually exclusive (no file matches both)', () => {
  const samples = ['x.jpg', 'x.cr2', 'x.png', 'x.dng', 'x.webp', 'x.nef']
  for (const s of samples) {
    assert.ok(!(SHARP_DECODABLE.test(s) && RAW_EXT.test(s)), `${s} matched both lanes`)
  }
})

test('classification ignores non-image files', () => {
  for (const name of ['notes.txt', 'project.json', 'thumb', '.DS_Store']) {
    assert.ok(!SHARP_DECODABLE.test(name) && !RAW_EXT.test(name))
  }
})

test('proxy contract constant is the documented 400px longest edge', () => {
  assert.equal(THUMB_MAX_EDGE, 400)
})
