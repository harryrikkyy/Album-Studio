// template_check.js — whether a template shows every photo it takes. Now and then a designer
// leaves a frame parked outside the page (Market PSD's 5h1v_0010 has its portrait frame past the
// right edge); a photo placed there would not be seen. Templates picked automatically (fitting
// templates, shuffle, auto-fill) skip those; a template chosen by hand is the user's call.
//
// Read from the PSD's layer records only (about 0.1–0.3 s), then cached per file version.

'use strict'

const fs = require('fs')
const path = require('path')
const { cacheRoot, contentFileKey, writeAtomic } = require('./cache')
const { readPsdBuffer } = require('./color')

let agpsd = null
function getAgPsd() {
  if (agpsd) return agpsd
  agpsd = require('ag-psd')
  agpsd.initializeCanvas((w, h) => ({
    width: w,
    height: h,
    getContext: () => ({
      createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }),
    }),
  }))
  return agpsd
}

/** Visible frames with less than half their area on the page, given the canvas size. */
function framesOffPage(width, height, frames) {
  return frames
    .filter((f) => {
      if (f.hidden || !(f.w > 0) || !(f.h > 0)) return false
      const ix = Math.max(0, Math.min(width, f.x + f.w) - Math.max(0, f.x))
      const iy = Math.max(0, Math.min(height, f.y + f.h) - Math.max(0, f.y))
      return (ix * iy) / (f.w * f.h) < 0.5
    })
    .map((f) => f.name)
}

const memo = new Map()

/**
 * Names of the template's photo frames that are mostly off the page ([] when all show). A file
 * that can't be read counts as fine: the render reports it properly.
 * @param {string} psdPath
 * @returns {Promise<string[]>}
 */
async function offPageFrames(psdPath) {
  const st = await fs.promises.stat(psdPath).catch(() => null)
  if (!st) return []
  const key = await contentFileKey(psdPath)
  if (memo.has(key)) return memo.get(key)
  const file = path.join(cacheRoot(), 'templates', key, 'frames-check-1.json')
  const job = (async () => {
    try {
      return JSON.parse(await fs.promises.readFile(file, 'utf8')).off
    } catch (_) {
      /* not checked yet */
    }
    try {
      const { collectFrames } = require('./psd_template')
      const psd = getAgPsd().readPsd(await readPsdBuffer(psdPath), {
        skipLayerImageData: true,
        skipCompositeImageData: true,
        skipThumbnail: true,
      })
      const off = framesOffPage(psd.width, psd.height, collectFrames(psd.children))
      if ((await contentFileKey(psdPath)) !== key) throw new Error('The template changed during its frame check.')
      await writeAtomic(file, JSON.stringify({ off }))
      return off
    } catch (_) {
      return []
    }
  })()
  memo.set(key, job)
  try {
    return await job
  } finally {
    memo.delete(key)
  }
}

/**
 * The first of `candidates` (tried in this order, at most `tries`) whose frames all show; null
 * when none of those does.
 * @template {{file: string}} T
 * @param {T[]} candidates
 */
async function firstUsable(candidates, tries = 6) {
  for (const t of candidates.slice(0, tries)) {
    if (!(await offPageFrames(t.file)).length) return t
  }
  return null
}

module.exports = { offPageFrames, framesOffPage, firstUsable }
