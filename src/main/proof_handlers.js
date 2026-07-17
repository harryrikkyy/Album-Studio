// proof_handlers.js — fast sharp/libvips rendering (no Photoshop).
//
// Extracted from app.js (Phase: app.js split). Renders page composites via
// sharp in the main process — the renderer process stays free for UI work.

const { ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const guards = require('../ipc_guards')
const proofRenderer = require('../proof_renderer')
const telemetry = require('../telemetry')

function registerProofHandlers() {
  // ── PROOF RENDER (FAST, NO PHOTOSHOP) ──────────────────────
  // Renders one or more page composites via sharp/libvips. Returns per-job
  // results so the renderer can update Tab 7 cards as they complete.
  ipcMain.handle('render-proof', async (event, job) => {
    job = guards.reqObject(job, 'job', 'render-proof')
    const result = await proofRenderer.renderPageProof(job)
    telemetry.event('proof_render', {
      ok: result.ok,
      ms: result.ms,
      pages: 1,
      photos: job.photos?.length || 0,
    })
    return result
  })

  ipcMain.handle('render-proofs-batch', async (event, jobs) => {
    jobs = guards.reqArray(jobs, 'jobs', 'render-proofs-batch', { max: 5000 })
    const t0 = Date.now()
    const results = await proofRenderer.renderProofBatch(jobs, (r, idx, total) => {
      // Stream progress to the renderer that requested the batch. Best-effort —
      // if the window is closed mid-render the send simply no-ops.
      try { event.sender.send('proof-progress', { idx, total, result: r }) } catch (_) {}
    })
    telemetry.event('proof_render_batch', {
      pages: jobs.length,
      durationMs: Date.now() - t0,
      failed: results.filter(r => !r.ok).length,
    })
    return results
  })

  // Final composite render — generative templates skip Photoshop entirely and
  // produce a high-quality JPEG via libvips. Used by the renderer's queue worker
  // when it sees a page whose template is a generative one (templatePath null
  // or starts with 'gen_').
  ipcMain.handle('render-final-composite', async (event, job) => {
    job = guards.reqObject(job, 'job', 'render-final-composite')
    const result = await proofRenderer.renderFinalComposite(job)
    telemetry.event('final_composite', {
      ok: result.ok,
      ms: result.ms,
      photos: job.photos?.length || 0,
    })
    return result
  })

  // ── BAKE ADJUSTED SOURCE ───────────────────────────────────
  // Applies the SAME non-destructive adjustments as the live preview to a
  // full-resolution source and writes an adjusted copy. The Photoshop build
  // then places this copy instead of the original, so the delivered PSD matches
  // the on-screen preview pixel-for-pixel. EXIF orientation + ICC are preserved
  // (withMetadata, no rotate/autoOrient here) so Photoshop treats the copy
  // exactly like the original — colour ops are orientation-invariant.
  ipcMain.handle('bake-adjusted-source', async (event, payload) => {
    payload = guards.reqObject(payload, 'payload', 'bake-adjusted-source')
    const { srcPath, adjust, outDir } = payload || {}
    if (!srcPath || !adjust) return { ok: false, error: 'missing srcPath/adjust' }
    try {
      const { getSharp } = require('../sharp_config')
      const sharp = getSharp()
      fs.mkdirSync(outDir, { recursive: true })
      const base = path.basename(srcPath).replace(/\.[^.]+$/, '')
      const rand = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
      const out = path.join(outDir, `${base}_adj_${rand}.jpg`)
      let pipe = sharp(srcPath, { failOn: 'none' })
      pipe = proofRenderer.applyAdjust(sharp, pipe, adjust)
      await pipe
        .withMetadata() // keep orientation tag + ICC so PS places it identically
        .jpeg({ quality: 95, mozjpeg: true })
        .toFile(out)
      return { ok: true, path: out }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
}

module.exports = { registerProofHandlers }
