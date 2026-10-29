'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createVerifiedFileReader } = require('../lib/verified_file')
const { createPublicationIO } = require('../lib/publication_io')

const changed = (what) => new Error(`The ${what} changed during the test.`)
const readRecord = createVerifiedFileReader({ label: 'Test', changed })
const { copyDetached } = createPublicationIO({ subject: 'test', changed, readRecord })

test('a detached copy keeps its source stamp when the source mtime sits just past a half millisecond', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'as-publication-io-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  // utimes takes float seconds, which resolve to 2^-22 s (about 240 ns) at this epoch. The first
  // such time past each half millisecond is where a float round trip can land just under it.
  const second = 1793247034,
    step = 2 ** -22,
    rejected = []
  for (let ms = 0; ms < 100; ms++) {
    const time = second + Math.ceil((ms + 0.5) / 1000 / step) * step,
      source = path.join(root, `source-${ms}`)
    fs.writeFileSync(source, 'snapshot bytes')
    fs.utimesSync(source, time, time)
    const record = await readRecord(source)
    await copyDetached(source, path.join(root, `copy-${ms}`), record).catch(() => rejected.push(record.stamp))
  }
  assert.deepEqual(rejected, [], 'every copy keeps its source stamp')
})
