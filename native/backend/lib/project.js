// project.js — edits to an album: operations on its project.json, atomic saves with a backup of
// the previous version, and undo/redo.
//
// The file keeps the Electron app's format (albumPages keyed "1".."N", totalActivePages,
// page-keyed edit maps in workspace), so the current app still opens albums edited here.
// Edits to one album run one at a time, in the order they arrive.

'use strict'

const fs = require('fs')
const { openAlbum } = require('./album')
const { planAlbum } = require('./autofill')
const { listTemplates } = require('./templates')

/** Workspace maps keyed by spread number: they move with their spread. */
const PAGE_KEYED = ['pageOverlays', 'pageLayerEdits', 'pageBackgrounds']
const HISTORY_LIMIT = 100

const histories = new Map() // project file → { undo: string[], redo: string[] }
const queues = new Map()    // project file → the tail of its edit chain

// ── file I/O ────────────────────────────────────────────────────────────────

async function readProject(file) {
  return JSON.parse(await fs.promises.readFile(file, 'utf8'))
}

/** Write atomically; the version being replaced is kept as project.json.bak. */
async function writeProject(file, data) {
  data.savedAt = new Date().toISOString()
  const tmp = `${file}.tmp-${process.pid}`
  await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2))
  await fs.promises.copyFile(file, `${file}.bak`).catch(() => {})
  await fs.promises.rename(tmp, file)
}

/** The workspace object; very old projects saved it bare, at the top level (as restoreWorkspace reads it). */
function workspaceOf(d) {
  return d.workspace || d
}

// ── pages as an array ───────────────────────────────────────────────────────

const emptyPage = () => ({ photos: [], template: null })

function pagesOf(d) {
  const total = Math.max(1, Number(d.totalActivePages) || Object.keys(d.albumPages || {}).length || 1)
  const out = []
  for (let n = 1; n <= total; n++) {
    const p = (d.albumPages || {})[n] || (d.albumPages || {})[String(n)]
    out.push(p ? { ...p, photos: [...(p.photos || [])] } : emptyPage())
  }
  return out
}

function setPages(d, pages) {
  const list = pages.length ? pages : [emptyPage()]
  d.albumPages = {}
  list.forEach((p, i) => { d.albumPages[i + 1] = p })
  d.totalActivePages = list.length
}

/** Move the page-keyed edit maps: `to(n)` gives a spread's new number, or null to drop it. */
function remapKeyed(d, to) {
  const ws = workspaceOf(d)
  for (const key of PAGE_KEYED) {
    const old = ws[key]
    if (!old) continue
    const next = {}
    for (const [k, v] of Object.entries(old)) {
      const n = to(Number(k))
      if (n) next[n] = v
    }
    ws[key] = next
  }
}

function snapshot(d) {
  const ws = workspaceOf(d)
  return JSON.stringify({
    albumPages: d.albumPages || {},
    totalActivePages: d.totalActivePages || 1,
    keyed: Object.fromEntries(PAGE_KEYED.map((k) => [k, ws[k] || {}])),
  })
}

function restore(d, snap) {
  const s = JSON.parse(snap)
  d.albumPages = s.albumPages
  d.totalActivePages = s.totalActivePages
  const ws = workspaceOf(d)
  for (const k of PAGE_KEYED) ws[k] = s.keyed[k]
}

// ── operations ──────────────────────────────────────────────────────────────

function photoEntry(model, id) {
  const p = model.photos[id]
  if (!p) throw new Error(`That photo isn't in this album's folders any more (${id}).`)
  return { id, url: 'file://' + p.thumb, orient: p.orient || 'h' }
}

function templateEntry(t, previous) {
  const e = { id: t.id, name: t.name, h: t.h, v: t.v, url: t.preview ? 'file://' + t.preview : '' }
  if (previous && previous.id === t.id && previous.folderId) e.folderId = previous.folderId
  return e
}

function checkSpread(pages, n) {
  if (!Number.isInteger(n) || n < 1 || n > pages.length) throw new Error(`There is no spread ${n} (the album has ${pages.length}).`)
}

/** Remove a photo from every spread except `keep`. */
function removeEverywhere(pages, id, keep) {
  pages.forEach((p, i) => {
    if (i + 1 !== keep) p.photos = p.photos.filter((x) => x.id !== id)
  })
}

const OPS = {
  /** The spread's photos, in order (slots fill by orientation, in this order). */
  setPhotos(ctx, { n, photoIds }) {
    checkSpread(ctx.pages, n)
    ctx.pages[n - 1].photos = (photoIds || []).map((id) => photoEntry(ctx.model, id))
  },

  /**
   * Put photos on a spread at `index` (or the end), in the order given. They move off any other
   * spread unless `copy` is set (a photo may appear on several spreads, as in the Electron app).
   */
  addPhoto(ctx, { n, id, ids, index, copy }) {
    checkSpread(ctx.pages, n)
    const list = ids || [id]
    const entries = list.map((x) => photoEntry(ctx.model, x))
    if (!copy) for (const x of list) removeEverywhere(ctx.pages, x, n)
    const rest = ctx.pages[n - 1].photos.filter((p) => !list.includes(p.id))
    const at = Number.isInteger(index) ? Math.max(0, Math.min(rest.length, index)) : rest.length
    rest.splice(at, 0, ...entries)
    ctx.pages[n - 1].photos = rest
  },

  /** Two photos of one spread trade places (and so frames, when they lie the same way). */
  swapPhotos(ctx, { n, a, b }) {
    checkSpread(ctx.pages, n)
    const list = ctx.pages[n - 1].photos
    const i = list.findIndex((x) => x.id === a)
    const j = list.findIndex((x) => x.id === b)
    if (i < 0 || j < 0) throw new Error('That photo is no longer on this spread.')
    ;[list[i], list[j]] = [list[j], list[i]]
  },

  /** Move a photo within its spread (photos fill frames of their orientation in this order). */
  movePhoto(ctx, { n, id, index }) {
    checkSpread(ctx.pages, n)
    const list = ctx.pages[n - 1].photos
    const from = list.findIndex((x) => x.id === id)
    if (from < 0) throw new Error('That photo is no longer on this spread.')
    const [entry] = list.splice(from, 1)
    list.splice(Math.max(0, Math.min(list.length, index)), 0, entry)
  },

  removePhoto(ctx, { n, id }) {
    checkSpread(ctx.pages, n)
    ctx.pages[n - 1].photos = ctx.pages[n - 1].photos.filter((x) => x.id !== id)
  },

  /**
   * `newId` takes `oldId`'s place on spread n. If `newId` was on another spread, `oldId` takes its
   * place there (a swap); otherwise `oldId` goes back to the unused photos.
   */
  replacePhoto(ctx, { n, oldId, newId }) {
    checkSpread(ctx.pages, n)
    if (oldId === newId) return
    const here = ctx.pages[n - 1].photos
    const i = here.findIndex((x) => x.id === oldId)
    if (i < 0) throw new Error('That photo is no longer on this spread.')
    const otherIdx = ctx.pages.findIndex((p, k) => k !== n - 1 && p.photos.some((x) => x.id === newId))
    if (otherIdx >= 0) {
      const there = ctx.pages[otherIdx].photos
      const j = there.findIndex((x) => x.id === newId)
      there[j] = photoEntry(ctx.model, oldId)
    }
    const dup = here.findIndex((x) => x.id === newId)
    here[i] = photoEntry(ctx.model, newId)
    if (dup >= 0 && dup !== i) here.splice(dup, 1)
  },

  async setTemplate(ctx, { n, templateId }) {
    checkSpread(ctx.pages, n)
    const t = (await ctx.templates()).find((x) => x.id === templateId)
    if (!t) throw new Error('That template isn’t in this album’s collections.')
    ctx.pages[n - 1].template = templateEntry(t, ctx.pages[n - 1].template)
  },

  /**
   * Give the spread a template with exactly its photos' frames, when its own doesn't fit. Picks at
   * random among the fitting ones, from the current template's collection when it has any. With
   * `another`, always changes to a different fitting template ("Shuffle").
   */
  async fitTemplate(ctx, { n, another }) {
    checkSpread(ctx.pages, n)
    const page = ctx.pages[n - 1]
    const h = page.photos.filter((p) => p.orient === 'h').length
    const v = page.photos.length - h
    const cur = page.template
    if (!page.photos.length) return
    if (!another && cur && cur.h === h && cur.v === v) return
    const catalogue = await ctx.templates()
    const choices = catalogue.filter((t) => t.h === h && t.v === v && (!cur || t.id !== cur.id))
    if (!choices.length) {
      ;(ctx.report.noTemplate ??= []).push({ n, h, v })
      return
    }
    const known = cur && catalogue.find((t) => t.id === cur.id)
    const same = known ? choices.filter((t) => t.collection === known.collection) : []
    const pool = same.length ? same : choices
    const t = pool[Math.floor(ctx.rng() * pool.length)]
    page.template = templateEntry(t, cur)
    // `auto`: chosen because the photos changed (worth telling the user), not asked for.
    ;(ctx.report.templates ??= []).push({ n, name: t.name, auto: !another })
  },

  clearSpread(ctx, { n }) {
    checkSpread(ctx.pages, n)
    ctx.pages[n - 1] = emptyPage()
  },

  /** A new empty spread at position `at` (1 … N+1). */
  insertSpread(ctx, { at }) {
    const pos = Math.max(1, Math.min(ctx.pages.length + 1, Number(at) || ctx.pages.length + 1))
    ctx.pages.splice(pos - 1, 0, emptyPage())
    remapKeyed(ctx.d, (k) => (k >= pos ? k + 1 : k))
  },

  removeSpread(ctx, { n }) {
    checkSpread(ctx.pages, n)
    if (ctx.pages.length === 1) {
      ctx.pages[0] = emptyPage()
      remapKeyed(ctx.d, () => null)
      return
    }
    ctx.pages.splice(n - 1, 1)
    remapKeyed(ctx.d, (k) => (k === n ? null : k > n ? k - 1 : k))
  },

  moveSpread(ctx, { from, to }) {
    checkSpread(ctx.pages, from)
    checkSpread(ctx.pages, to)
    if (from === to) return
    const [page] = ctx.pages.splice(from - 1, 1)
    ctx.pages.splice(to - 1, 0, page)
    remapKeyed(ctx.d, (k) => {
      if (k === from) return to
      if (from < to && k > from && k <= to) return k - 1
      if (from > to && k >= to && k < from) return k + 1
      return k
    })
  },

  /** Re-plan the whole album from all its photos (undoable as one step). */
  async autoFill(ctx, opts) {
    const photos = ctx.model.pool.map((id) => ctx.model.photos[id]).filter(Boolean)
    const planned = await planAlbum(photos, await ctx.templates(), opts || {}, ctx.rng)
    ctx.pages.length = 0
    for (const p of planned.pages) {
      ctx.pages.push({ photos: p.photoIds.map((id) => photoEntry(ctx.model, id)), template: p.template ? templateEntry(p.template) : null })
    }
    ctx.report.autoFill = { spreads: planned.pages.length, withoutTemplate: planned.unmatched, cappedTo: planned.cappedTo }
  },
}

// ── public ──────────────────────────────────────────────────────────────────

/** Run `fn` after every earlier edit of the same project has finished. */
function serialize(file, fn) {
  const prev = queues.get(file) || Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(file, next.catch(() => {}))
  return next
}

function historyOf(file) {
  if (!histories.has(file)) histories.set(file, { undo: [], redo: [] })
  return histories.get(file)
}

/**
 * Apply operations to an album and save it. All operations of one call are one undo step.
 * @param {{ album: string, ops: {op: string}[] }} p
 * @param {{ rng?: () => number }} [opts]
 */
async function updateAlbum({ album: albumPath, ops }, opts = {}) {
  if (!albumPath) throw new Error('missing `album`')
  if (!Array.isArray(ops) || !ops.length) throw new Error('missing `ops`')
  const model = await openAlbum({ path: albumPath })
  return serialize(model.file, async () => {
    const d = await readProject(model.file)
    const before = snapshot(d)
    let templates = null
    const ctx = {
      d,
      model,
      pages: pagesOf(d),
      rng: opts.rng || Math.random,
      report: {},
      templates: async () => (templates ??= await listTemplates(workspaceOf(d).templateTokens)),
    }
    for (const o of ops) {
      const fn = Object.prototype.hasOwnProperty.call(OPS, o.op) ? OPS[o.op] : null
      if (!fn) throw new Error(`unknown album operation \`${o.op}\``)
      await fn(ctx, o)
    }
    setPages(d, ctx.pages)
    if (snapshot(d) !== before) {
      const h = historyOf(model.file)
      h.undo.push(before)
      if (h.undo.length > HISTORY_LIMIT) h.undo.shift()
      h.redo.length = 0
      await writeProject(model.file, d)
    }
    return { album: await openAlbum({ path: albumPath }), report: ctx.report, ...historyState(model.file) }
  })
}

function historyState(file) {
  const h = historyOf(file)
  return { canUndo: h.undo.length > 0, canRedo: h.redo.length > 0 }
}

async function step(albumPath, from, to) {
  const model = await openAlbum({ path: albumPath })
  return serialize(model.file, async () => {
    const h = historyOf(model.file)
    const snap = h[from].pop()
    if (snap) {
      const d = await readProject(model.file)
      h[to].push(snapshot(d))
      restore(d, snap)
      await writeProject(model.file, d)
    }
    return { album: await openAlbum({ path: albumPath }), changed: !!snap, ...historyState(model.file) }
  })
}

const undo = ({ album }) => step(album, 'undo', 'redo')
const redo = ({ album }) => step(album, 'redo', 'undo')

module.exports = { updateAlbum, undo, redo }
