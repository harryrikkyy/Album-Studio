'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  pad2,
  pad3,
  countPageSheets,
  coverPadBaseName,
  pageBaseName,
  computeAssignedNames,
  computeRenames,
} = require('../src/renamer_naming')

test('pad2 / pad3 zero-pad to fixed widths', () => {
  assert.equal(pad2(0), '00')
  assert.equal(pad2(9), '09')
  assert.equal(pad2(10), '10')
  assert.equal(pad2(123), '123') // does not truncate
  assert.equal(pad3(7), '007')
  assert.equal(pad3(42), '042')
  assert.equal(pad3(100), '100')
})

test('countPageSheets counts only page-role tiles', () => {
  const tiles = [
    { role: 'first' },
    { role: 'page' },
    { role: 'page' },
    { role: 'cover' },
    { role: 'last' },
  ]
  assert.equal(countPageSheets(tiles), 2)
  assert.equal(countPageSheets([]), 0)
})

test('pageBaseName: folder scheme uses 2-digit sequence', () => {
  assert.equal(pageBaseName('Smith', 3, null, null), 'Smith (03)')
})

test('pageBaseName: custom scheme uses 3-digit sequence', () => {
  assert.equal(pageBaseName('Smith', 3, null, 'Wedding'), 'Wedding_003')
})

test('pageBaseName: lamination effect appends 8 dashes + effect', () => {
  assert.equal(pageBaseName('Smith', 1, 'Matte', null), 'Smith (01)--------Matte')
  assert.equal(
    pageBaseName('Smith', 1, 'Gloss', 'Wedding'),
    'Wedding_001--------Gloss'
  )
})

test('coverPadBaseName encodes folder/lam/size and N+1 where N = pages + 1', () => {
  // 4 page sheets -> N = 5 -> "5+1"
  assert.equal(
    coverPadBaseName('Smith', 'Matte', '12x12', 4),
    'ZZZ--Smith--Matte--12x12--5+1'
  )
})

test('computeAssignedNames assigns first/last/page in grid order', () => {
  const out = computeAssignedNames({
    folderName: 'Smith',
    customPageName: null,
    coverPad: null,
    tiles: [
      { path: '/a', role: 'first' },
      { path: '/b', role: 'page' },
      { path: '/c', role: 'page' },
      { path: '/d', role: 'last' },
    ],
  })
  assert.deepEqual(out.map((n) => n.baseName), ['00', 'Smith (01)', 'Smith (02)', 'zz'])
})

test('computeAssignedNames: unconfigured cover yields baseName null', () => {
  const out = computeAssignedNames({
    folderName: 'Smith',
    coverPad: null,
    tiles: [{ path: '/cover', role: 'cover' }, { path: '/p', role: 'page' }],
  })
  assert.equal(out[0].baseName, null)
  assert.equal(out[1].baseName, 'Smith (01)')
})

test('computeAssignedNames: configured cover uses page count for N+1', () => {
  const out = computeAssignedNames({
    folderName: 'Smith',
    coverPad: { lamination: 'Matte', size: '12x12' },
    tiles: [
      { path: '/cover', role: 'cover' },
      { path: '/p1', role: 'page' },
      { path: '/p2', role: 'page' },
    ],
  })
  // 2 page sheets -> N = 3 -> "3+1"
  assert.equal(out[0].baseName, 'ZZZ--Smith--Matte--12x12--3+1')
})

test('computeRenames drops null-named tiles and maps to ops', () => {
  const ops = computeRenames({
    folderName: 'Smith',
    coverPad: null,
    tiles: [
      { path: '/cover', role: 'cover' }, // null -> dropped
      { path: '/a', role: 'first' },
      { path: '/b', role: 'page' },
    ],
  })
  assert.deepEqual(ops, [
    { fromPath: '/a', toBaseName: '00' },
    { fromPath: '/b', toBaseName: 'Smith (01)' },
  ])
})
