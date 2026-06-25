// colormatch.js — proof-vs-export color/layout match harness
//
// Validates the gating assumption for the Live Design Engine (see
// docs/ideas/live-design-engine.md): does the libvips proof composite match
// the Photoshop final export closely enough that an on-screen preview can be
// trusted as ground truth?
//
// Compares two rendered images of the SAME spread and reports objective
// metrics + a diff heatmap, so the decision isn't eyeballed:
//   • per-channel mean ABSOLUTE error  (overall difference magnitude)
//   • per-channel mean SIGNED error     (systematic shift == colour-profile/
//                                         gamma mismatch signature)
//   • RMSE, max delta, % pixels over a visible threshold
//   • ICC profile / colourspace of each input (the prime suspect)
//
// Usage (must run under Electron's Node — sharp is built for the Electron ABI):
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/colormatch.js <reference> <candidate> [--out <dir>] [--threshold N]
//
//   <reference>  the Photoshop export (the ground truth)
//   <candidate>  the libvips proof composite
//
// Exit code 0 = strong match, 1 = differences worth investigating, 2 = error.

const fs = require('fs')
const path = require('path')

let sharp
try {
  // Reuse the project's tuned sharp (concurrency/cache); falls back to bare.
  sharp = require('../src/sharp_config').getSharp()
} catch (_) {
  try { sharp = require('sharp') } catch (e) {
    console.error('Could not load sharp. Run under Electron:\n  ELECTRON_RUN_AS_NODE=1 npx electron scripts/colormatch.js <ref> <cand>')
    process.exit(2)
  }
}

function parseArgs(argv) {
  const args = { _: [], out: null, threshold: 10 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') args.out = argv[++i]
    else if (a === '--threshold') args.threshold = parseInt(argv[++i], 10) || 10
    else args._.push(a)
  }
  return args
}

async function loadInfo(file) {
  const meta = await sharp(file).metadata()
  return {
    file,
    width: meta.width,
    height: meta.height,
    space: meta.space,
    channels: meta.channels,
    hasProfile: !!meta.icc,
    density: meta.density,
  }
}

// Decode to a fixed WxH, flattened on white, 3-channel sRGB, raw bytes.
async function rawRGB(file, width, height) {
  const { data } = await sharp(file, { failOn: 'none' })
    .resize(width, height, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return data // Uint8, length = width*height*3
}

// Mean absolute error after a light blur on BOTH images — isolates structural
// difference from high-frequency edge/resolution noise.
async function blurredMAE(fileA, fileB, width, height) {
  const dec = (f) => sharp(f, { failOn: 'none' })
    .resize(width, height, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .removeAlpha()
    .blur(1.2)
    .raw()
    .toBuffer()
  const [a, b] = await Promise.all([dec(fileA), dec(fileB)])
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args._.length < 2) {
    console.error('Usage: ELECTRON_RUN_AS_NODE=1 npx electron scripts/colormatch.js <reference> <candidate> [--out dir] [--threshold N]')
    process.exit(2)
  }
  const [refPath, candPath] = args._
  for (const p of [refPath, candPath]) {
    if (!fs.existsSync(p)) { console.error('Not found:', p); process.exit(2) }
  }

  const refInfo = await loadInfo(refPath)
  const candInfo = await loadInfo(candPath)

  // Canonical comparison size = the SMALLER image's dimensions (downscale the
  // larger one to match). Comparing at the larger size would upscale a low-res
  // proof and the resulting blur — not real divergence — would dominate the
  // error. Downscaling the sharp one makes both equally soft, isolating true
  // colour/layout differences.
  const refPixels = refInfo.width * refInfo.height
  const candPixels = candInfo.width * candInfo.height
  const small = refPixels <= candPixels ? refInfo : candInfo
  const W = small.width
  const H = small.height
  const ref = await rawRGB(refPath, W, H)
  const cand = await rawRGB(candPath, W, H)

  const n = W * H
  const thr = args.threshold
  let sumAbs = [0, 0, 0]
  let sumSigned = [0, 0, 0]
  let sumSq = [0, 0, 0]
  let maxDelta = 0
  let overThreshold = 0

  // Diff heatmap: per-pixel max-channel delta, written as grayscale.
  const heat = Buffer.alloc(n)

  for (let i = 0, p = 0; i < ref.length; i += 3, p++) {
    let pixMax = 0
    for (let c = 0; c < 3; c++) {
      const d = cand[i + c] - ref[i + c] // signed
      const ad = Math.abs(d)
      sumSigned[c] += d
      sumAbs[c] += ad
      sumSq[c] += d * d
      if (ad > pixMax) pixMax = ad
    }
    if (pixMax > maxDelta) maxDelta = pixMax
    if (pixMax > thr) overThreshold++
    heat[p] = Math.min(255, pixMax)
  }

  const mae = sumAbs.map((s) => s / n)
  const signed = sumSigned.map((s) => s / n)
  const rmse = sumSq.map((s) => Math.sqrt(s / n))
  const overallMAE = (mae[0] + mae[1] + mae[2]) / 3
  const overPct = (overThreshold / n) * 100
  const maxSignedBias = Math.max(...signed.map(Math.abs))

  // Edge-vs-structural check: re-compare with a light blur on BOTH. If the
  // error collapses, the residual is high-frequency (resolution / JPEG /
  // resampling at edges) — harmless for a preview. If it stays high, the
  // difference is structural (layout/crop/colour) — the kind that matters.
  const blurMae = await blurredMAE(refPath, candPath, W, H)

  // ── Report ──────────────────────────────────────────────────
  const fmt = (a) => a.map((v) => v.toFixed(2)).join(' / ')
  console.log('\n── colormatch ─────────────────────────────────────')
  console.log('reference :', refInfo.file)
  console.log('            ', `${refInfo.width}×${refInfo.height}  space=${refInfo.space}  icc=${refInfo.hasProfile ? 'embedded' : 'none'}  ${refInfo.density || '?'}dpi`)
  console.log('candidate :', candInfo.file)
  console.log('            ', `${candInfo.width}×${candInfo.height}  space=${candInfo.space}  icc=${candInfo.hasProfile ? 'embedded' : 'none'}  ${candInfo.density || '?'}dpi`)
  console.log('compared at:', `${W}×${H}  (both resized to the smaller image)`)
  console.log('────────────────────────────────────────────────────')
  console.log('mean ABS error  R/G/B :', fmt(mae), ' (0–255)')
  console.log('mean SIGNED err R/G/B :', fmt(signed), ' (cand − ref; systematic shift = profile/gamma)')
  console.log('RMSE            R/G/B :', fmt(rmse))
  console.log('overall MAE           :', overallMAE.toFixed(2))
  console.log('max channel delta     :', maxDelta)
  console.log(`pixels Δ>${thr}            :`, overPct.toFixed(2) + '%')
  console.log('MAE after blur (both) :', blurMae.toFixed(2), ' (≪ MAE ⇒ residual is edges/resolution, not structure)')
  console.log('────────────────────────────────────────────────────')

  // ── Diagnosis heuristics ─────────────────────────────────────
  if (refInfo.space !== candInfo.space) {
    console.log('⚠ colourspace differs (' + refInfo.space + ' vs ' + candInfo.space + ') — likely a conversion gap.')
  }
  if (refInfo.hasProfile !== candInfo.hasProfile && maxSignedBias > 2) {
    console.log('⚠ one image has an embedded ICC profile and the other does not — a prime cause of the colour shift above.')
  }
  if (maxSignedBias > 4) {
    console.log(`⚠ systematic colour shift detected (≈${maxSignedBias.toFixed(1)} on one channel). This is a profile/gamma mismatch, not noise — fixable by aligning colour management.`)
  }

  // Verdict. Judged on what actually matters for a faithful preview:
  //   • colour alignment (signed bias near zero)
  //   • overall magnitude (MAE)
  //   • whether the residual is structural or just edge/resolution (blurMae)
  // Raw "% pixels over threshold" is deliberately NOT a hard gate: comparing
  // a soft proof against a sharp downscaled export always inflates it without
  // meaning the layout/colour differ.
  const colorAligned = maxSignedBias < 3
  const structural = blurMae > 6 // error survives a blur ⇒ real structural diff
  let verdict, code
  if (overallMAE < 4 && colorAligned) {
    verdict = '✅ STRONG MATCH — preview is faithful to the final.'
    code = 0
  } else if (colorAligned && !structural) {
    verdict = `🟢 MATCH — colour + layout align; residual (MAE ${overallMAE.toFixed(1)}, blur ${blurMae.toFixed(1)}) is resolution/edge detail, harmless for a preview.`
    code = 0
  } else if (overallMAE < 12 && colorAligned) {
    verdict = '🟡 CLOSE — minor structural residual; usable, worth a glance at the heatmap.'
    code = 1
  } else {
    verdict = '🔴 DIVERGENT — preview ≠ final today. Resolve colour management / layout before building on it.'
    code = 1
  }
  console.log('verdict:', verdict)

  // ── Write diff artifacts ─────────────────────────────────────
  if (args.out) {
    fs.mkdirSync(args.out, { recursive: true })
    const heatPath = path.join(args.out, 'diff-heatmap.png')
    await sharp(heat, { raw: { width: W, height: H, channels: 1 } }).png().toFile(heatPath)
    // Side-by-side: reference | candidate, both at reference size.
    const sbsPath = path.join(args.out, 'side-by-side.png')
    const refPng = await sharp(refPath).resize(W, H, { fit: 'fill' }).png().toBuffer()
    const candPng = await sharp(candPath).resize(W, H, { fit: 'fill' }).png().toBuffer()
    await sharp({ create: { width: W * 2 + 8, height: H, channels: 3, background: '#000' } })
      .composite([{ input: refPng, left: 0, top: 0 }, { input: candPng, left: W + 8, top: 0 }])
      .png()
      .toFile(sbsPath)
    console.log('\nwrote:', heatPath)
    console.log('wrote:', sbsPath)
  } else {
    console.log('\n(tip: add --out <dir> to write a diff heatmap + side-by-side)')
  }
  console.log('')
  process.exit(code)
}

main().catch((e) => { console.error('colormatch failed:', e.message); process.exit(2) })
