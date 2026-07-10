// @ts-check
// shims/path.js — what `require('path')` resolves to inside the bundled
// main-window renderer (esbuild --alias). Minimal POSIX implementation —
// the app is macOS-only until Phase 7; the Windows port revisits this.

/** @param {string} p */
function normalize(p) {
  const abs = p.startsWith('/')
  const parts = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop()
      else if (!abs) parts.push('..')
    } else parts.push(seg)
  }
  const out = parts.join('/')
  return abs ? '/' + out : (out || '.')
}

/** @param {...string} segs */
function join(...segs) {
  return normalize(segs.filter(Boolean).join('/'))
}

/** @param {string} p @param {string} [ext] */
function basename(p, ext) {
  const b = p.replace(/\/+$/, '').split('/').pop() || ''
  return (ext && b.endsWith(ext)) ? b.slice(0, -ext.length) : b
}

/** @param {string} p */
function dirname(p) {
  const trimmed = p.replace(/\/+$/, '')
  const i = trimmed.lastIndexOf('/')
  if (i === -1) return '.'
  if (i === 0) return '/'
  return trimmed.slice(0, i)
}

/** @param {string} p */
function extname(p) {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i)
}

/** @param {string} p */
function isAbsolute(p) {
  return p.startsWith('/')
}

module.exports = { normalize, join, basename, dirname, extname, isAbsolute, sep: '/' }
