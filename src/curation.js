// curation.js
//
// Photo curation engine. Runs in the Electron main process so we can use
// sharp/libvips for the heavy stats. Reduces 2,000 raw photos to a curated
// set of ~200–300 keepers based on:
//   - Sharpness (Laplacian-of-Gaussian variance proxy via sharp's image stats)
//   - Exposure (histogram distribution; flags very dark / very bright / blown)
//   - Near-duplicate clustering (perceptual hash, dHash variant)
//   - Orientation (so the user can hit aspect-ratio targets like "30 H, 30 V")
//
// Speed > pixel-perfect accuracy. Every photo is decoded once at a small
// thumbnail size, all features computed from that thumbnail. A 2,000-photo
// shoot processes in 30–90 seconds on a modern Mac.

const fs = require('fs')
const path = require('path')

let _sharp = null
function getSharp() {
  if (_sharp) return _sharp
  // Routed through the central sharp config (bounded concurrency + cache).
  _sharp = require('./sharp_config').getSharp()
  return _sharp
}

// Extensions sharp can decode reliably. RAW is intentionally excluded — for
// curation we expect the user to point at JPEG previews / proxies.
const READABLE_EXT = /\.(jpe?g|png|tiff?|webp|heic|heif|avif)$/i

// ─── feature extraction ──────────────────────────────────────────────────────
//
// Per-photo we build:
//   {
//     filePath, baseName, ext,
//     orient: 'h' | 'v',
//     sharpness: number,   // higher = sharper. ~80 is a reasonable cutoff.
//     exposureScore: number, // 0..1, 1 = ideal mid-tone distribution
//     blackPct, whitePct,  // % of pixels clipped at 0/255
//     pHash: bigint as hex // 64-bit dHash for perceptual dedup
//   }

// Single 32×32 grayscale read powers sharpness + dHash, plus we re-use the
// raw buffer to compute a histogram for exposure. Three features per file
// off one decode is what makes this fast enough for 2,000-photo shoots.
async function extractFeatures(sharp, filePath) {
  // Grayscale 32×32 — large enough for a usable Laplacian variance, small
  // enough that decode dominates I/O instead of pixel work.
  const small = await sharp(filePath, { failOn: 'none' })
    .rotate() // honors EXIF orientation so portrait photos don't get hashed wrong
    .grayscale()
    .resize(32, 32, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const data = small.data // 32*32 = 1024 bytes
  const w = small.info.width
  const h = small.info.height

  // Sharpness: variance of the Laplacian (4-neighbour discrete kernel). High
  // variance = more high-frequency content = sharper. Blurry shots cluster
  // near zero; well-focused shots run 100+ on this scale.
  let sumLap = 0, sumLapSq = 0, n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = -4 * data[i] + data[i - 1] + data[i + 1] + data[i - w] + data[i + w]
      sumLap += lap
      sumLapSq += lap * lap
      n++
    }
  }
  const mean = sumLap / n
  const sharpness = Math.max(0, sumLapSq / n - mean * mean)

  // Exposure: 32-bin histogram, then score how close the distribution is to a
  // healthy mid-tone bias. Penalize heavy clipping at either end.
  const hist = new Uint32Array(32)
  for (let i = 0; i < data.length; i++) hist[data[i] >> 3]++

  // Clip percentages: bottom 1 bin = "black-clipped", top 1 bin = "white-clipped".
  const blackPct = hist[0] / data.length
  const whitePct = hist[31] / data.length

  // Convert histogram to a probability distribution and compute a simple
  // "is the distribution centered" score. 1.0 = perfect, 0 = all in one bin.
  // Implemented as 1 minus the normalized distance from the mid-bin weight.
  let totalWeight = 0
  let weightedBin = 0
  for (let b = 0; b < 32; b++) {
    totalWeight += hist[b]
    weightedBin += b * hist[b]
  }
  const meanBin = weightedBin / totalWeight // 0..31
  const centeredness = 1 - Math.abs(meanBin - 15.5) / 15.5
  // Penalize clipping aggressively — a clipped highlight ruins a portrait.
  const exposureScore = Math.max(0, centeredness - blackPct - whitePct * 1.5)

  // Perceptual hash (dHash). 8×8 grayscale, then 8×9 to compare adjacent
  // pixels horizontally → 64 bits.
  // Re-read at 9×8 because dHash is comparison-based; doing it off the 32×32
  // would lose accuracy.
  const dh = await sharp(filePath, { failOn: 'none' })
    .rotate()
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer()
  let pHash = 0n
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = dh[y * 9 + x]
      const right = dh[y * 9 + x + 1]
      pHash = (pHash << 1n) | (left > right ? 1n : 0n)
    }
  }

  // Original dimensions (pre-rotate) so we know orientation. Since .rotate()
  // applies EXIF, sharp's metadata after rotate gives the visual dims.
  const meta = await sharp(filePath, { failOn: 'none' }).rotate().metadata()
  const orient = meta.width >= meta.height ? 'h' : 'v'

  return {
    filePath,
    baseName: path.basename(filePath, path.extname(filePath)),
    ext: path.extname(filePath).slice(1).toLowerCase(),
    width: meta.width,
    height: meta.height,
    orient,
    sharpness,
    exposureScore,
    blackPct,
    whitePct,
    pHash: pHash.toString(16).padStart(16, '0'),
  }
}

// ─── duplicate clustering ─────────────────────────────────────────────────────
// Hamming distance between two hex pHashes. <8 bits different ≈ same scene.
function hamming(a, b) {
  let d = 0
  // 16 hex chars × 4 bits = 64 bits.
  for (let i = 0; i < 16; i++) {
    let v = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (v) { d += v & 1; v >>= 1 }
  }
  return d
}

// Greedy clustering. Each new photo is added to the first cluster whose
// representative is within `threshold` Hamming distance. Cheap (O(n*c)) and
// good enough — wedding bursts dedupe to 5–10 clusters per scene.
function clusterDuplicates(features, threshold = 8) {
  const clusters = []
  for (const f of features) {
    let added = false
    for (const c of clusters) {
      if (hamming(f.pHash, c.rep.pHash) <= threshold) {
        c.members.push(f)
        // Keep the sharpest member as the cluster representative.
        if (f.sharpness > c.rep.sharpness) c.rep = f
        added = true
        break
      }
    }
    if (!added) clusters.push({ rep: f, members: [f] })
  }
  return clusters
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Scan a folder of photos and extract features for each.
 *
 * @param {string} folderPath
 * @param {(progress: { done, total, file }) => void} onProgress
 * @returns {Promise<Array>}
 */
async function analyzeFolder(folderPath, onProgress) {
  const sharp = getSharp()
  const entries = fs.readdirSync(folderPath, { withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && READABLE_EXT.test(e.name))
    .map((e) => path.join(folderPath, e.name))
    .sort()

  const total = files.length
  const results = []
  // Sequential — sharp already saturates cores per-image and parallelizing
  // would balloon RAM with 5,000-photo shoots.
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    try {
      const feat = await extractFeatures(sharp, file)
      results.push(feat)
    } catch (e) {
      // Don't let one bad JPEG sink the whole run — record a stub and move on.
      results.push({
        filePath: file,
        baseName: path.basename(file, path.extname(file)),
        ext: path.extname(file).slice(1).toLowerCase(),
        orient: 'h',
        sharpness: 0,
        exposureScore: 0,
        blackPct: 0,
        whitePct: 0,
        pHash: '0000000000000000',
        error: e.message,
      })
    }
    if (onProgress && (i % 5 === 0 || i === files.length - 1)) {
      try { onProgress({ done: i + 1, total, file }) } catch {}
    }
  }
  return results
}

/**
 * Curate a feature set into a recommended subset.
 *
 * @param {Array} features          - output of analyzeFolder()
 * @param {object} options
 * @param {number} options.minSharpness   - drop photos below this Laplacian variance (default 80)
 * @param {number} options.minExposure    - drop photos below this exposure score (default 0.25)
 * @param {number} options.dupThreshold   - Hamming threshold for "near-duplicate" (default 8)
 * @param {number} [options.targetH]      - cap horizontal keepers
 * @param {number} [options.targetV]      - cap vertical keepers
 * @param {boolean} [options.preferSharpFromCluster=true] - keep only the sharpest from each cluster
 */
function curate(features, options = {}) {
  const opts = {
    minSharpness: 80,
    minExposure: 0.25,
    dupThreshold: 8,
    preferSharpFromCluster: true,
    ...options,
  }

  // Pass 1: drop hard rejects (decode error, blurry, badly exposed).
  const droppedBlur = []
  const droppedExposure = []
  const droppedError = []
  const survivors = []
  for (const f of features) {
    if (f.error) { droppedError.push(f); continue }
    if (f.sharpness < opts.minSharpness) { droppedBlur.push(f); continue }
    if (f.exposureScore < opts.minExposure) { droppedExposure.push(f); continue }
    survivors.push(f)
  }

  // Pass 2: cluster near-duplicates and keep the best per cluster.
  const clusters = clusterDuplicates(survivors, opts.dupThreshold)
  const droppedDuplicates = []
  let keepers = []
  for (const c of clusters) {
    if (opts.preferSharpFromCluster) {
      keepers.push(c.rep)
      for (const m of c.members) if (m !== c.rep) droppedDuplicates.push(m)
    } else {
      keepers.push(...c.members)
    }
  }

  // Pass 3: orientation caps. If the user asked for at most N horizontal +
  // M vertical, take the best of each.
  if (opts.targetH != null || opts.targetV != null) {
    const sortByQuality = (a, b) =>
      b.sharpness * b.exposureScore - a.sharpness * a.exposureScore
    const byOrient = { h: [], v: [] }
    for (const k of keepers) byOrient[k.orient].push(k)
    byOrient.h.sort(sortByQuality)
    byOrient.v.sort(sortByQuality)
    const cappedH = opts.targetH != null ? byOrient.h.slice(0, opts.targetH) : byOrient.h
    const cappedV = opts.targetV != null ? byOrient.v.slice(0, opts.targetV) : byOrient.v
    keepers = [...cappedH, ...cappedV]
  }

  // Sort final keepers by chronology if filenames look chronological,
  // otherwise alphabetic. Wedding shoots almost always sort right by filename.
  keepers.sort((a, b) =>
    a.baseName.localeCompare(b.baseName, undefined, { numeric: true })
  )

  return {
    keepers,
    stats: {
      total: features.length,
      kept: keepers.length,
      droppedBlur: droppedBlur.length,
      droppedExposure: droppedExposure.length,
      droppedDuplicates: droppedDuplicates.length,
      droppedError: droppedError.length,
      clusters: clusters.length,
    },
    drops: {
      blur: droppedBlur,
      exposure: droppedExposure,
      duplicates: droppedDuplicates,
      error: droppedError,
    },
  }
}

/**
 * Copy curated keepers into a `_Selected` subfolder next to the source.
 */
function exportKeepers(keepers, sourceFolder) {
  const dest = path.join(sourceFolder, '_Selected')
  fs.mkdirSync(dest, { recursive: true })
  let copied = 0
  for (const k of keepers) {
    const target = path.join(dest, path.basename(k.filePath))
    try {
      fs.copyFileSync(k.filePath, target)
      copied++
    } catch {}
  }
  return { dest, copied }
}

module.exports = {
  analyzeFolder,
  curate,
  exportKeepers,
  // Exposed for tests / future face-detection integration.
  hamming,
  clusterDuplicates,
}
