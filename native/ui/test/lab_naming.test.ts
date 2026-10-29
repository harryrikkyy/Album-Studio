import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeAssignedNames,
  computeRenames,
  coverPadBaseName,
  matchStandardSize,
  pageBaseName,
  readBack,
  type NamingTile,
} from '../src/lab_naming.ts'

const tiles = (roles: NamingTile['role'][]): NamingTile[] => roles.map((role, i) => ({ path: `/o/${i}.jpg`, role }))

test('first is 00, last is zz, pages number 1..N in order', () => {
  const names = computeAssignedNames({
    folderName: '256',
    tiles: tiles(['page', 'first', 'page', 'last', 'page']),
  }).map((n) => n.baseName)
  assert.deepEqual(names, ['256 (01)', '00', '256 (02)', 'zz', '256 (03)'])
})

test('the cover pad: N is one more than the page sheets, then +1', () => {
  assert.equal(coverPadBaseName('256', 'Standard', '12x36', 30), 'ZZZ--256--Standard--12x36--31+1')
  const t = tiles(['first', 'page', 'page', 'cover', 'last'])
  assert.equal(
    computeAssignedNames({ folderName: '7', tiles: t, coverPad: { lamination: 'Matte', size: '12x30' } })[3]!.baseName,
    'ZZZ--7--Matte--12x30--3+1',
  )
  assert.equal(computeAssignedNames({ folderName: '7', tiles: t })[3]!.baseName, null, 'no pad settings yet: no name')
  assert.equal(computeRenames({ folderName: '7', tiles: t }).length, 4, 'and it is left out of the renames')
})

test('custom names, effects', () => {
  assert.equal(pageBaseName('256', 7, null, 'page'), 'page_007')
  assert.equal(pageBaseName('256', 7, null, '  '), '256 (07)', 'a blank custom name means the folder name')
  assert.equal(pageBaseName('256', 1, 'Glitter'), '256 (01)--------Glitter')
})

test('the standard size nearest the sheet’s proportions', () => {
  assert.equal(matchStandardSize(10800, 3600), '12x36')
  assert.equal(matchStandardSize(3600, 9000), '12x30')
  assert.equal(matchStandardSize(0, 0), null)
})

test('a folder renamed before opens as it was left', () => {
  const r = readBack([
    { path: '/o/a.jpg', baseName: '256 (02)--------Foil' },
    { path: '/o/b.jpg', baseName: 'zz' },
    { path: '/o/c.jpg', baseName: '00' },
    { path: '/o/d.jpg', baseName: 'ZZZ--256--Velvet--12x30--4+1' },
    { path: '/o/e.jpg', baseName: '256 (01)' },
    { path: '/o/f.jpg', baseName: 'IMG_0001' },
  ])
  assert.deepEqual(
    r.tiles.map((t) => [t.path.slice(3, 4), t.role, t.effect ?? null]),
    [
      ['c', 'first', null],
      ['e', 'page', null],
      ['a', 'page', 'Foil'],
      ['f', 'page', null],
      ['b', 'last', null],
      ['d', 'cover', null],
    ],
  )
  assert.deepEqual([r.folderName, r.coverPad, r.customPageName], ['256', { lamination: 'Velvet', size: '12x30' }, null])
  assert.equal(
    readBack([
      { path: '/x', baseName: 'page_003' },
      { path: '/y', baseName: 'zz' },
    ]).customPageName,
    'page',
  )
  const fresh = readBack([
    { path: '/a', baseName: 'Page_001' },
    { path: '/b', baseName: 'Page_002' },
  ])
  assert.deepEqual(
    [fresh.customPageName, fresh.folderName, fresh.tiles.map((t) => t.role)],
    [null, null, ['page', 'page']],
    'Album Studio exports are not lab names',
  )
})
