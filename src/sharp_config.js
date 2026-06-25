// sharp_config.js
//
// Single point of truth for libvips/sharp tuning. Both the proof renderer
// and the curation engine import sharp through here so concurrency and the
// operation cache are configured identically and exactly once.
//
// Why this matters for performance & memory:
//   - sharp.concurrency() bounds the libvips threadpool. Left at the default
//     (≈ CPU core count) a 200-page proof or 2,000-photo curation run can
//     spin up far more in-flight decode threads than the machine has memory
//     headroom for, producing the "memory spike" symptom.
//   - sharp.cache() bounds the libvips operation/file cache. The default can
//     retain decoded buffers for large RAW/TIFF inputs longer than we want.
//     We cap it so peak RSS stays predictable on big batches.

let _sharp = null

function getSharp() {
  if (_sharp) return _sharp
  _sharp = require('sharp')

  // 4 worker threads is a sweet spot: enough to keep a multi-core Mac busy
  // during a batch, low enough that peak memory on 6000×4000 RAW JPEGs stays
  // bounded. Tunable in one place if we ever profile a different optimum.
  try { _sharp.concurrency(4) } catch (_) {}

  // Bound the libvips cache. items = max cached operations, memory = MB,
  // files = max open file descriptors. Keeps a 2,000-photo run from letting
  // the cache balloon.
  try { _sharp.cache({ memory: 200, items: 100, files: 0 }) } catch (_) {}

  return _sharp
}

module.exports = { getSharp }
