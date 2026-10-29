'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { assignAssetIds, referenceIndex, resolveReference } = require('../lib/identity')

const rootPath = path.join(path.parse(process.cwd()).root, 'identity-fixture')
function candidate(folder, legacyId = 'img_DCIM_A_jpg', rootId) {
  return { id: legacyId, folder, thumb: path.join(folder, 'A.jpg'), ...(rootId ? { identityRootId: rootId } : {}) }
}
test('duplicate physical locators count once when deciding whether a legacy ID is attributable', () => {
  const real = path.join(rootPath, 'real', 'DCIM'),
    alias = path.join(rootPath, 'alias', 'DCIM'),
    legacy = 'img_DCIM_A_jpg'
  const registry = { version: 1, roots: { root_same: { kind: 'photo', path: real } }, assets: {} }
  const assigned = assignAssetIds(
    [candidate(real, legacy, 'root_same'), candidate(alias, legacy, 'root_same')],
    'photo',
    registry,
  )
  assert.equal(assigned.length, 1)
  assert.equal(assigned[0].id, legacy)
  assert.equal(Object.keys(registry.assets).length, 1)
})

for (const reservedBy of ['legacyId', 'legacyAliases', 'assetId'])
  test(`an absent historical ${reservedBy} reserves its identifier against a new unrelated asset`, () => {
    const old = path.join(rootPath, 'old', 'DCIM'),
      current = path.join(rootPath, 'new', 'DCIM'),
      legacy = 'img_DCIM_A_jpg'
    const previousId = reservedBy === 'assetId' ? legacy : 'img_saved_hash',
      previousLegacy = reservedBy === 'legacyAliases' ? 'img_other_legacy' : legacy
    const registry = {
      version: 1,
      roots: { root_old: { kind: 'photo', path: old }, root_new: { kind: 'photo', path: current } },
      assets: {
        [previousId]: {
          kind: 'photo',
          rootId: 'root_old',
          relativePath: 'A.jpg',
          legacyId: previousLegacy,
          ...(reservedBy === 'legacyAliases' ? { legacyAliases: [legacy] } : {}),
        },
      },
    }
    const assigned = assignAssetIds([candidate(current, legacy, 'root_new')], 'photo', registry)
    assert.equal(assigned.length, 1)
    assert.notEqual(assigned[0].id, legacy)
    assert.equal(registry.assets[previousId].rootId, 'root_old')
    const resolved = resolveReference(
      { id: legacy },
      assigned,
      'photo',
      registry,
      referenceIndex(assigned, 'photo', registry),
    )
    assert.equal(resolved.asset, undefined, 'a missing historical reference must never select the new photograph')
    assert.equal(resolved.conflict && resolved.conflict.reason, 'ambiguous-reference')
  })

test('historical aliases belonging to the same locator preserve its established ID', () => {
  const folder = path.join(rootPath, 'existing', 'DCIM'),
    legacy = 'img_DCIM_A_jpg',
    saved = 'img_saved_hash'
  const registry = {
    version: 1,
    roots: { root_saved: { kind: 'photo', path: folder } },
    assets: {
      [saved]: {
        kind: 'photo',
        rootId: 'root_saved',
        relativePath: 'A.jpg',
        legacyId: legacy,
        legacyAliases: ['img_former_alias'],
      },
    },
  }
  const assigned = assignAssetIds([candidate(folder, legacy, 'root_saved')], 'photo', registry)
  assert.equal(assigned[0].id, saved)
  assert.deepEqual(registry.assets[saved].legacyAliases, ['img_former_alias'])
})
