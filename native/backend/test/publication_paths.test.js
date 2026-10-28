'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { assertPublicationParent } = require('../lib/publication_paths')

const refused = { code: 'PUBLICATION_PRIVATE_PATH' }

test('ordinary folders accept saves, including names that merely contain album-studio', () => {
  for (const folder of ['/Users/ana/Albums/Client', '/Volumes/Work/My.album-studio', '/Volumes/Work/album-studio']) {
    assert.doesNotThrow(() => assertPublicationParent(folder))
  }
})

test('the managed sheets folder accepts saves in any letter case', () => {
  for (const folder of ['/Users/ana/Out/.album-studio/sheets', '/Users/ana/Out/.Album-Studio/Sheets']) {
    assert.doesNotThrow(() => assertPublicationParent(folder))
  }
})

test('private metadata refuses saves at any depth and in any letter case', () => {
  for (const folder of [
    '/Users/ana/Out/.album-studio',
    '/Users/ana/Out/.album-studio/sheets/old',
    '/Users/ana/Out/.album-studio/render-history',
    '/Users/ana/Out/.album-studio-publications/history',
    '/Users/ana/Out/.ALBUM-STUDIO-PUBLICATIONS/history',
    '/Volumes/Work/.album-studio-old/Client',
  ]) assert.throws(() => assertPublicationParent(folder), refused, folder)
})
