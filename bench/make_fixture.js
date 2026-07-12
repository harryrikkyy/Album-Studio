#!/usr/bin/env node
// bench/make_fixture.js — generate the synthetic large-album fixture used by
// the Phase 4 benchmarks (bench/fixture/, gitignored):
//   photos/     N source JPEGs (3000×2000-ish, varied colors + noise so JPEG
//               decode cost is realistic, ~2 per page)
//   template.jpg  a 2400×1200 template preview backdrop
//   project-<P>.json  an app project with P pages referencing the photos
//
//   node bench/make_fixture.js [pages=200]

const fs = require('fs')
const path = require('path')
const { getSharp } = require('../src/sharp_config')

const PAGES = parseInt(process.argv[2] || '200', 10)
const ROOT = path.join(__dirname, 'fixture')
const PHOTO_DIR = path.join(ROOT, 'photos')

async function main() {
  const sharp = getSharp()
  fs.mkdirSync(PHOTO_DIR, { recursive: true })

  const photoCount = PAGES * 2
  console.log(`generating ${photoCount} photos for ${PAGES} pages…`)
  const t0 = Date.now()
  for (let i = 0; i < photoCount; i++) {
    const p = path.join(PHOTO_DIR, `photo_${String(i).padStart(4, '0')}.jpg`)
    if (fs.existsSync(p)) continue
    const landscape = i % 2 === 0
    // Noise (not a flat fill) so decode/scale cost resembles real photos.
    await sharp({
      create: {
        width: landscape ? 3000 : 2000,
        height: landscape ? 2000 : 3000,
        channels: 3,
        noise: { type: 'gaussian', mean: 80 + (i * 7) % 120, sigma: 30 },
      },
    }).jpeg({ quality: 88 }).toFile(p)
    if (i % 50 === 49) console.log(`  ${i + 1}/${photoCount}`)
  }

  // 600px thumbnails — the album pages reference THESE (mirrors the real
  // app, where page/photo urls point at _Thumbnails JPEGs, not originals).
  const THUMB_DIR = path.join(ROOT, 'thumbs')
  fs.mkdirSync(THUMB_DIR, { recursive: true })
  for (let i = 0; i < photoCount; i++) {
    const src = path.join(PHOTO_DIR, `photo_${String(i).padStart(4, '0')}.jpg`)
    const dst = path.join(THUMB_DIR, `photo_${String(i).padStart(4, '0')}.jpg`)
    if (fs.existsSync(dst)) continue
    await sharp(src).resize(600, 600, { fit: 'inside' }).jpeg({ quality: 80 }).toFile(dst)
    if (i % 100 === 99) console.log(`  thumbs ${i + 1}/${photoCount}`)
  }

  const tpl = path.join(ROOT, 'template.jpg')
  if (!fs.existsSync(tpl)) {
    await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: { r: 245, g: 240, b: 232 } },
    }).jpeg({ quality: 90 }).toFile(tpl)
  }

  // App-shaped project (same layout as e2e/fixtures/sample-project.json).
  const albumPages = {}
  for (let pg = 1; pg <= PAGES; pg++) {
    const a = (pg - 1) * 2, b = a + 1
    albumPages[pg] = {
      template: {
        id: 'tpl_bench_1h1v', folderId: 'tplFld_bench', name: 'bench_1h1v.psd',
        h: 1, v: 1, url: 'file://' + tpl,
      },
      photos: [
        { id: `img_bench_${a}`, orient: 'h', url: 'file://' + path.join(ROOT, 'thumbs', `photo_${String(a).padStart(4, '0')}.jpg`) },
        { id: `img_bench_${b}`, orient: 'v', url: 'file://' + path.join(ROOT, 'thumbs', `photo_${String(b).padStart(4, '0')}.jpg`) },
      ],
    }
  }
  const project = {
    version: 2,
    savedAt: new Date().toISOString(),
    workspace: {},
    albumPages,
    totalActivePages: PAGES,
    renderHashes: {},
  }
  const out = path.join(ROOT, `project-${PAGES}.json`)
  fs.writeFileSync(out, JSON.stringify(project))
  console.log(`fixture ready in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${out}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
