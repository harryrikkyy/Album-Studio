// Built-in focal-point detector.
//
// Returns a normalized focal point ({ x, y, confidence } in 0..1) for a
// photo. The proof renderer biases its smart-crop toward this point rather
// than using sharp's attention strategy alone, which keeps faces from being
// cropped out of vertical frames in wedding portraits.
//
// Algorithm — three cheap signals fused on a 64×64 grayscale + chroma
// thumbnail (one decode, three derived stats):
//
//   1. Skin-tone density: YCbCr-based gate that fires on typical skin
//      ranges. Cheaper than face detection and works across all skin tones.
//   2. Edge density: Laplacian magnitude per cell — detail tends to live
//      where the subject is.
//   3. Saliency: sharp's built-in attention region (one extra call).
//
// Each signal contributes a 2D weight grid; the focal point is the
// weighted centroid. Confidence reflects how concentrated the weight is —
// a flat scene returns low confidence and the renderer falls back to
// center-crop.

// Cache keyed on (filePath + rotation) so a photo rotated 90° gets a new
// focal point. Plain filePath caching would silently use the pre-rotation
// answer.
const _focalCache = new Map()

function _cacheKey(filePath, rotation) {
  return `${filePath}|${rotation || 0}`
}

// Conservative skin-tone gate in YCbCr space. Numbers are from the standard
// Garcia/Tziritas paper, widened slightly to catch warmer skin tones common
// in bridal portraits where lighting is mixed.
function isSkinYCbCr(y, cb, cr) {
  return y > 60 && cb > 77 && cb < 130 && cr > 130 && cr < 180
}

async function focalPoint(filePath, opts) {
  const rotation = opts?.rotation || 0
  const key = _cacheKey(filePath, rotation)
  if (_focalCache.has(key)) return _focalCache.get(key)

  const sharp = require('sharp')
  const TILE = 64

  let result = null
  try {
    // 1. Decode once at 64×64 RGB. We derive luma + chroma + edges from this.
    const small = await sharp(filePath, { failOn: 'none' })
      .rotate(rotation)
      .resize(TILE, TILE, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })
    const data = small.data // length = TILE*TILE*3
    const w = small.info.width
    const h = small.info.height

    // Build per-cell weights for skin and edges.
    const cells = w * h
    const skin = new Float32Array(cells)
    const edge = new Float32Array(cells)

    // Build a luma channel for edge detection.
    const luma = new Uint8Array(cells)
    for (let i = 0; i < cells; i++) {
      const r = data[i * 3]
      const g = data[i * 3 + 1]
      const b = data[i * 3 + 2]
      // BT.601 luma
      const y = (77 * r + 150 * g + 29 * b) >> 8
      // BT.601 chroma
      const cb = ((-43 * r - 85 * g + 128 * b) >> 8) + 128
      const cr = ((128 * r - 107 * g - 21 * b) >> 8) + 128
      luma[i] = y
      skin[i] = isSkinYCbCr(y, cb, cr) ? 1 : 0
    }

    // 4-neighbor Laplacian magnitude per cell.
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        const v = -4 * luma[i] + luma[i - 1] + luma[i + 1] + luma[i - w] + luma[i + w]
        edge[i] = Math.abs(v)
      }
    }

    // 2. sharp.attention region for saliency. One extra call but it returns
    // structural info instead of just a thumbnail.
    //
    // CAREFUL: sharp's `attentionX` / `attentionY` are returned in the
    // SOURCE image's pixel coordinates, not the thumbnail's. We normalize
    // to 0..1 first, then convert back into thumbnail space when blending
    // with our centroid.
    let salNX = 0.5, salNY = 0.5, salWeight = 0
    try {
      const att = await sharp(filePath, { failOn: 'none' })
        .rotate(rotation)
        .resize(TILE, TILE, { fit: 'cover', position: sharp.strategy.attention })
        .toBuffer({ resolveWithObject: true })
      if (att.info.attentionX != null && att.info.attentionY != null) {
        // sharp's metadata pre-resize gives us the source size needed to
        // normalize. Cheap call — sharp caches metadata internally.
        const meta = await sharp(filePath, { failOn: 'none' }).rotate(rotation).metadata()
        if (meta.width && meta.height) {
          salNX = att.info.attentionX / meta.width
          salNY = att.info.attentionY / meta.height
          salWeight = 1
        }
      }
    } catch { /* attention not available — skip */ }

    // Combine signals — weighted centroid of (skin*3 + edge_norm*1) plus a
    // soft pull toward the saliency region.
    let edgeMax = 1
    for (let i = 0; i < cells; i++) if (edge[i] > edgeMax) edgeMax = edge[i]

    let sumW = 0, sumX = 0, sumY = 0
    let skinSum = 0, edgeSum = 0
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const i = py * w + px
        const e = edge[i] / edgeMax
        const wgt = skin[i] * 3 + e
        if (wgt > 0) {
          sumW += wgt
          sumX += wgt * (px + 0.5)
          sumY += wgt * (py + 0.5)
          skinSum += skin[i]
          edgeSum += e
        }
      }
    }

    let cx, cy, confidence
    if (sumW < 1e-6) {
      // Nothing to pin on — fall back to saliency only, with low confidence
      // so the renderer's smart-crop path is bypassed in favor of center
      // crop. We don't fabricate confidence here.
      if (salWeight) {
        cx = salNX * w
        cy = salNY * h
        confidence = 0.1
      } else {
        cx = w / 2
        cy = h / 2
        confidence = 0
      }
    } else {
      // Centroid from skin + edges, blended with saliency at 25%.
      const centroidX = sumX / sumW
      const centroidY = sumY / sumW
      cx = salWeight ? centroidX * 0.75 + (salNX * w) * 0.25 : centroidX
      cy = salWeight ? centroidY * 0.75 + (salNY * h) * 0.25 : centroidY

      // Confidence: high when skin density is concentrated and edges are
      // strong. Capped to 1.
      const skinFraction = skinSum / cells
      const edgeFraction = edgeSum / cells
      confidence = Math.min(1, skinFraction * 4 + edgeFraction * 0.8)
    }

    result = {
      x: Math.max(0, Math.min(1, cx / w)),
      y: Math.max(0, Math.min(1, cy / h)),
      confidence: Math.max(0, Math.min(1, confidence)),
    }
  } catch (e) {
    // Don't propagate — the dispatcher just sees null and the renderer falls
    // back to its default crop strategy.
    result = null
  }

  _focalCache.set(key, result)
  return result
}

module.exports = { focalPoint }
