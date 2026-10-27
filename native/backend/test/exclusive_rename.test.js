'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('./fixtures')
const { renameExclusive, helperCandidates } = require('../lib/exclusive_rename')

function withEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]))
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
}

test('a substituted engine does not hide the real rename helper', async t => {
  const real = process.env.ALBUM_STUDIO_RENAME_CLI
  if (!real || !fs.existsSync(real)) return t.skip('ALBUM_STUDIO_RENAME_CLI does not name a built helper')
  const root = tmpdir(); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const build = path.join(root, 'home/Library/Caches/AlbumStudioBuild/target/release')
  fs.mkdirSync(build, { recursive: true }); fs.symlinkSync(real, path.join(build, 'album-studio-rename-exclusive'))
  fs.mkdirSync(path.join(root, 'fake-engine'))
  const fakeEngine = path.join(root, 'fake-engine/photocraft-cli')
  withEnv(t, { ALBUM_STUDIO_RENAME_CLI: undefined, HOME: path.join(root, 'home'), ALBUM_STUDIO_PHOTOCRAFT_CLI: fakeEngine })
  fs.writeFileSync(path.join(root, 'from'), 'bytes')
  await renameExclusive(path.join(root, 'from'), path.join(root, 'to'))
  assert.equal(fs.readFileSync(path.join(root, 'to'), 'utf8'), 'bytes')
  assert.equal(fs.existsSync(path.join(root, 'from')), false)
})

test('the bundled and development helpers come before the configured engine folder', t => {
  withEnv(t, { ALBUM_STUDIO_RENAME_CLI: undefined, HOME: '/Users/studio', ALBUM_STUDIO_PHOTOCRAFT_CLI: '/opt/engine/photocraft-cli' })
  assert.deepEqual(helperCandidates(), [
    path.resolve(__dirname, '../../../../bin/album-studio-rename-exclusive'),
    '/Users/studio/Library/Caches/AlbumStudioBuild/target/release/album-studio-rename-exclusive',
    '/opt/engine/album-studio-rename-exclusive',
  ])
  withEnv(t, { ALBUM_STUDIO_RENAME_CLI: '/opt/helpers/rename' })
  assert.deepEqual(helperCandidates(), ['/opt/helpers/rename'])
})

test('a missing helper names where it looked and preserves the source', async t => {
  const root = tmpdir(); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const missing = path.join(root, 'no-such-helper')
  withEnv(t, { ALBUM_STUDIO_RENAME_CLI: missing })
  fs.writeFileSync(path.join(root, 'from'), 'bytes')
  const namesWhereItLooked = error => error.message.includes(missing) && /ALBUM_STUDIO_RENAME_CLI/.test(error.message)
  await assert.rejects(renameExclusive(path.join(root, 'from'), path.join(root, 'to')), namesWhereItLooked)
  assert.equal(fs.readFileSync(path.join(root, 'from'), 'utf8'), 'bytes')
})
