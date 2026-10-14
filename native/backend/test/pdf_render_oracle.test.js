'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const sharp = require('../../../src/sharp_config').getSharp()
const { tmpdir } = require('./fixtures')
const { grayGammaProfile, icc } = require('./color_edge_fixtures')
const { writeJpegPdf } = require('../lib/pdf')

function addGrayProfile(jpeg) {
  const data = Buffer.concat([Buffer.from('ICC_PROFILE\0'), Buffer.from([1, 1]), grayGammaProfile()]), marker = Buffer.alloc(4)
  marker.writeUInt16BE(0xffe2); marker.writeUInt16BE(data.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), marker, data, jpeg.subarray(2)])
}

test('independent Poppler rendering matches perceptual ICC proof colours and page pixels', async (t) => {
  const dir = tmpdir(), width = 192, height = 96, raw = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i++) raw.set(i % width < width / 2 ? [180, 50, 20] : [20, 150, 210], i * 3)
  const sources = [], pages = [], names = ['srgb', 'p3', 'gray', 'cmyk', 'srgb-progressive']
  for (const name of names) {
    const pipeline = sharp(raw, { raw: { width, height, channels: 3 } })
    const bytes = name === 'gray'
      ? addGrayProfile(await pipeline.toColourspace('b-w').jpeg({ quality: 100 }).toBuffer())
      : await pipeline.withIccProfile(name === 'srgb-progressive' ? 'srgb' : name).jpeg({ quality: 100, progressive: name === 'srgb-progressive' }).toBuffer()
    const file = path.join(dir, `${name}.jpg`)
    fs.writeFileSync(file, bytes); sources.push(bytes); pages.push({ path: file, ppi: 72 })
  }
  const pdf = path.join(dir, 'proof.pdf'), prefix = path.join(dir, 'render'), displayProfile = path.join(dir, 'display-srgb.icc')
  fs.writeFileSync(displayProfile, await icc('srgb'))
  await writeJpegPdf(pdf, pages)
  // An independent PDF renderer must exercise the actual ICCBased streams, JPEG
  // decode and xrefs. It is a required verifier, never replaced by a writer mock.
  const renderer = process.env.ALBUM_STUDIO_PDFTOPPM || 'pdftoppm'
  const result = spawnSync(renderer, ['-r', '72', '-displayprofile', displayProfile, '-png', pdf, prefix], { encoding: 'utf8', timeout: 30000 })
  assert.equal(result.status, 0, `Poppler pdftoppm is required for PDF colour verification. Install it with brew install poppler (macOS) or apt-get install poppler-utils (Linux), or set ALBUM_STUDIO_PDFTOPPM to its executable: ${result.error || result.stderr}`)
  const version = spawnSync(renderer, ['-v'], { encoding: 'utf8', timeout: 5000 })
  const evidence = { pdf, renderer: (version.stdout + version.stderr).trim(), displayProfile, pixels: [width, height], policy: 'perceptual source ICC to explicit sRGB display', patches: [] }
  for (let i = 0; i < names.length; i++) {
    const png = path.join(dir, `render-${i + 1}.png`)
    const actual = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const expected = await sharp(sources[i]).withIccProfile('srgb').removeAlpha().raw().toBuffer()
    assert.deepEqual([actual.info.width, actual.info.height], [width, height])
    for (const x of [40, 150]) {
      const at = (40 * width + x) * 3, got = [...actual.data.subarray(at, at + 3)], want = [...expected.subarray(at, at + 3)]
      evidence.patches.push({ source: names[i], x, actual: got, expected: want, delta: want.map((v, c) => Math.abs(v - got[c])) })
    }
  }
  const evidenceFile = path.join(dir, 'evidence.json')
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2))
  t.diagnostic(`Independent PDF rendering evidence: ${evidenceFile}`)
  for (const patch of evidence.patches) assert.ok(patch.delta.every((v) => v <= 3), `${patch.source} patch ${patch.x}: rendered ${patch.actual}, expected perceptual ${patch.expected}`)
})
