#!/usr/bin/env node
// bench/proof_bench.js — measure the fast proof renderer on the synthetic
// fixture (run bench/make_fixture.js first):
//   node bench/proof_bench.js [pages=20]
//
// Reports per-page latency (min/median/p95), total wall time, and peak RSS
// of this node process — the same code path the main process runs for the
// Tab 7 proof strip and the live preview.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { renderPageProof } = require('../src/proof_renderer')

const PAGES = parseInt(process.argv[2] || '20', 10)
const ROOT = path.join(__dirname, 'fixture')
const PHOTO_DIR = path.join(ROOT, 'photos')
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'albumstudio-bench-'))

// The 1h+1v layout every fixture page uses.
const FRAMES = [
  { name: 'toolkithframe1', x: 120, y: 150, w: 1300, h: 880 },
  { name: 'toolkitvframe1', x: 1540, y: 110, w: 740, h: 980 },
]

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

async function main() {
  if (!fs.existsSync(PHOTO_DIR)) {
    console.error('fixture missing — run: node bench/make_fixture.js')
    process.exit(1)
  }
  let peakRss = 0
  const rssTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 50)

  const times = []
  const t0 = Date.now()
  for (let pg = 0; pg < PAGES; pg++) {
    const a = (pg * 2) % 400, b = a + 1
    const job = {
      templatePath: path.join(ROOT, 'template.psd'), // hash key only
      templatePreviewPath: path.join(ROOT, 'template.jpg'),
      frames: FRAMES,
      canvasWidth: 2400,
      canvasHeight: 1200,
      photos: [
        { filePath: path.join(PHOTO_DIR, `photo_${String(a).padStart(4, '0')}.jpg`), orient: 'h', rotation: 0 },
        { filePath: path.join(PHOTO_DIR, `photo_${String(b).padStart(4, '0')}.jpg`), orient: 'v', rotation: 0 },
      ],
      outputPath: path.join(OUT_DIR, `proof_${pg}.jpg`),
      maxEdge: 1500,
    }
    const t = Date.now()
    const res = await renderPageProof(job)
    times.push(Date.now() - t)
    if (!res || res.ok === false) throw new Error('proof failed: ' + JSON.stringify(res))
  }
  const total = Date.now() - t0
  clearInterval(rssTimer)

  const sorted = [...times].sort((x, y) => x - y)
  console.log(JSON.stringify({
    pages: PAGES,
    total_ms: total,
    per_page_ms: { min: sorted[0], median: pct(sorted, 0.5), p95: pct(sorted, 0.95), max: sorted[sorted.length - 1] },
    pages_per_s: +(PAGES / (total / 1000)).toFixed(2),
    peak_rss_mb: Math.round(peakRss / 1024 / 1024),
  }, null, 2))
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
}

main().catch((e) => { console.error(e); process.exit(1) })
