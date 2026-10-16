// project.js — edits to an album: operations on its project.json, atomic saves with a backup of
// the previous version, and undo/redo.
//
// The file keeps the Electron app's format (albumPages keyed "1".."N", totalActivePages,
// page-keyed edit maps in workspace), so the current app still opens albums edited here.
// Edits to one album run one at a time, in the order they arrive.

'use strict'

const path = require('path')
const { openAlbum } = require('./album')
const { canonicalProject, acquireProjectLease, serializeProject } = require('./project_lock')
const { saveProject, recoverProject, readProjectSnapshot } = require('./project_transaction')
const { newSpreadId, relinkRoot } = require('./identity')
const { planAlbum } = require('./autofill')
const { firstUsable, offPageFrames } = require('./template_check')
const { commonShape, listTemplates, shapeOf } = require('./templates')
const { LIMITS, pageCount, validateProject, validateOperations } = require('./project_domain')

/** Workspace maps keyed by spread number: they move with their spread. */
const PAGE_KEYED = ['pageOverlays', 'pageLayerEdits', 'pageBackgrounds']
const HISTORY_LIMIT = 100

const histories = new Map() // canonical project file → { undo, redo, revision }

// ── file I/O ────────────────────────────────────────────────────────────────

async function readProject(file) {
  const snapshot = await readProjectSnapshot(file)
  validateProject(snapshot.data)
  return snapshot
}

/** Write atomically; the version being replaced is kept as project.json.bak. */
async function writeProject(file, data, revision, lease) {
  validateProject(data)
  data.savedAt = new Date().toISOString()
  return (await saveProject(file, data, revision, { assertOwned: () => lease.assertOwned() })).revision
}

/** The workspace object; very old projects saved it bare, at the top level (as restoreWorkspace reads it). */
function workspaceOf(d) {
  return d.workspace || d
}

// ── pages as an array ───────────────────────────────────────────────────────

const emptyPage = (id = newSpreadId()) => ({ id, photos: [], template: null })

function pagesOf(d) {
  const total = pageCount(d)
  const out = []
  for (let n = 1; n <= total; n++) {
    const p = (d.albumPages || {})[n] || (d.albumPages || {})[String(n)]
    out.push(p ? { ...p, photos: [...(p.photos || [])] } : emptyPage())
  }
  return out
}

function setPages(d, pages) {
  const list = pages.length ? pages : [emptyPage()]
  if (list.length > LIMITS.SPREADS) throw new Error(`The album exceeds the supported ${LIMITS.SPREADS}-spread limit. Split it into smaller projects before retrying.`)
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
    output: ws.outputToken ?? null,
    photoFolders: ws.imageTokens || [],
    collections: ws.templateTokens || [],
    rotations: ws.imageRotations || {},
    placements: ws.imagePlacements || {},
    adjustments: ws.imageAdjustments || {},
    identityRoots: ws.identity && ws.identity.roots,
  })
}

function restore(d, snap) {
  const s = JSON.parse(snap)
  d.albumPages = s.albumPages
  d.totalActivePages = s.totalActivePages
  const ws = workspaceOf(d)
  for (const k of PAGE_KEYED) ws[k] = s.keyed[k]
  if (s.output) ws.outputToken = s.output
  else delete ws.outputToken
  if (s.photoFolders) ws.imageTokens = s.photoFolders
  if (s.collections) ws.templateTokens = s.collections
  if (s.rotations) ws.imageRotations = s.rotations
  if (s.placements) ws.imagePlacements = s.placements
  if (s.adjustments) ws.imageAdjustments = s.adjustments
  if (s.identityRoots && ws.identity) ws.identity.roots = { ...ws.identity.roots, ...s.identityRoots }
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

/**
 * A template for `h` landscape and `v` portrait photos in the album's page `shape`, picked at
 * random (`rng`) from the same collection as `like` when it has one, skipping templates with a
 * frame parked off the page (its photo wouldn't show). Null when the catalogue has none.
 */
async function pickFitting(catalogue, { h, v, like, except, rng, shape }) {
  const choices = catalogue.filter((t) => t.h === h && t.v === v && t.id !== except && (!shape || !shapeOf(t) || shapeOf(t) === shape))
  if (!choices.length) return null
  const same = like ? choices.filter((t) => t.sourceRoot && like.sourceRoot ? t.sourceRoot === like.sourceRoot : t.collection === like.collection) : []
  const pool = same.length ? same : choices
  const i = Math.floor(rng() * pool.length)
  const order = [...pool.slice(i), ...pool.slice(0, i)]
  return (await firstUsable(order)) || order[0]
}

/**
 * The album's page shape: the one most of its spreads' templates have, else the one most of its
 * collections' templates have (a new album). Null when no size is known.
 */
async function albumShape(ctx) {
  const catalogue = await ctx.templates()
  const byId = new Map(catalogue.map((t) => [t.id, t]))
  const used = ctx.pages.map((p) => p.template && byId.get(p.template.id)).filter(Boolean)
  return commonShape(used, catalogue) ?? commonShape(catalogue)
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
    const known = cur && catalogue.find((t) => t.id === cur.id)
    const t = await pickFitting(catalogue, { h, v, like: known, except: cur && cur.id, rng: ctx.rng, shape: await albumShape(ctx) })
    if (!t) {
      ;(ctx.report.noTemplate ??= []).push({ n, h, v })
      return
    }
    page.template = templateEntry(t, cur)
    // `auto`: chosen because the photos changed (worth telling the user), not asked for.
    ;(ctx.report.templates ??= []).push({ n, name: t.name, auto: !another })
  },

  /**
   * Turn photos by `by` degrees, clockwise (90, 180 or 270; -90 turns left), on top of any turn
   * they have: everywhere they appear, in previews and print sheets. Kept as the Electron app does
   * (workspace.imageRotations); a quarter turn swaps landscape and portrait on every spread.
   */
  rotatePhotos(ctx, { ids, by }) {
    const turn = (((Number(by) || 0) % 360) + 360) % 360
    if (![90, 180, 270].includes(turn)) throw new Error('Photos turn in quarter turns: 90°, 180° or 270°.')
    if (!Array.isArray(ids) || !ids.length) throw new Error('Choose the photos to turn.')
    const ws = workspaceOf(ctx.d)
    const rotations = (ws.imageRotations = { ...(ws.imageRotations || {}) })
    for (const id of new Set(ids)) {
      if (!ctx.model.photos[id]) throw new Error(`That photo isn't in this album's folders any more (${id}).`)
      const next = ((Number(rotations[id]) || 0) + turn) % 360
      if (next) rotations[id] = next
      else delete rotations[id]
      if (turn === 180) continue
      for (const page of ctx.pages) {
        for (const e of page.photos) if (e.id === id) e.orient = e.orient === 'v' ? 'h' : 'v'
      }
    }
  },

  /**
   * How a photo sits in its frame: `scale` ≥ 1 zooms in on the cover fit, `ox`/`oy` ∈ [-1, 1] pan
   * across what is cropped (1 = its right/bottom edge); no values (or 1, 0, 0) fits it again.
   * Kept as the Electron app does (workspace.imagePlacements, per photo), so it applies wherever the
   * photo appears, in previews and print sheets.
   */
  placePhoto(ctx, { id, scale, ox, oy }) {
    if (!ctx.model.photos[id]) throw new Error(`That photo isn't in this album's folders any more (${id}).`)
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0))
    const round = (v) => Math.round(v * 1000) / 1000
    const p = { scale: round(clamp(scale ?? 1, 1, 5)), ox: round(clamp(ox, -1, 1)), oy: round(clamp(oy, -1, 1)) }
    const ws = workspaceOf(ctx.d)
    const placements = (ws.imagePlacements = { ...(ws.imagePlacements || {}) })
    if (p.scale === 1 && !p.ox && !p.oy) delete placements[id]
    else placements[id] = p
  },

  /**
   * A photo's colour: sliders in [-100, 100] (exposure, contrast, saturation, warmth, tint, fade,
   * clarity, sharpen, blur, vignette) and `bw`; all zero / missing restores it. Kept as the Electron
   * app does (workspace.imageAdjustments, per photo): previews apply it, print sheets bake it in.
   */
  adjustPhoto(ctx, { id, adjust }) {
    if (!ctx.model.photos[id]) throw new Error(`That photo isn't in this album's folders any more (${id}).`)
    const SLIDERS = ['exposure', 'contrast', 'saturation', 'warmth', 'tint', 'fade', 'clarity', 'sharpen', 'blur', 'vignette']
    const a = {}
    for (const k of SLIDERS) {
      const v = Math.round(Math.max(-100, Math.min(100, Number((adjust || {})[k]) || 0)))
      if (v) a[k] = v
    }
    if ((adjust || {}).bw) a.bw = true
    const ws = workspaceOf(ctx.d)
    const all = (ws.imageAdjustments = { ...(ws.imageAdjustments || {}) })
    if (Object.keys(a).length) all[id] = a
    else delete all[id]
  },

  /** Where print sheets are saved (the JPEG folders and the PDF go next to it). */
  setOutputFolder(ctx, { folder }) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Choose a folder for the print sheets.')
    workspaceOf(ctx.d).outputToken = folder
  },

  /**
   * The album's photo folders, in order. Photos of a folder taken away stay on their spreads
   * (shown as missing) until they are replaced, so nothing is lost if it was a mistake.
   */
  setPhotoFolders(ctx, { folders }) {
    if (!Array.isArray(folders) || !folders.length || !folders.every((f) => typeof f === 'string' && path.isAbsolute(f))) {
      throw new Error('An album needs at least one photo folder.')
    }
    workspaceOf(ctx.d).imageTokens = [...new Set(folders)]
  },

  /** The template collections the album draws from. */
  setCollections(ctx, { collections }) {
    if (!Array.isArray(collections) || !collections.every((f) => typeof f === 'string' && path.isAbsolute(f))) {
      throw new Error('Choose template collection folders.')
    }
    workspaceOf(ctx.d).templateTokens = [...new Set(collections)]
  },

  /** Relinking is explicit: a new folder list alone cannot claim an old folder's assets. */
  relinkFolder(ctx, { kind, from, to }) {
    if (!['photo', 'template'].includes(kind) || !path.isAbsolute(from || '') || !path.isAbsolute(to || '')) throw new Error('Choose the old and new source folders to relink.')
    const ws = workspaceOf(ctx.d)
    const key = kind === 'photo' ? 'imageTokens' : 'templateTokens'
    if (!(ws[key] || []).includes(from)) throw new Error('That source folder is not in this album.')
    relinkRoot(ctx.d, kind, from, to)
    ws[key] = [...new Set(ws[key].map((folder) => folder === from ? to : folder))]
  },

  clearSpread(ctx, { n }) {
    checkSpread(ctx.pages, n)
    ctx.pages[n - 1] = emptyPage(ctx.pages[n - 1].id)
    const ws = workspaceOf(ctx.d)
    for (const key of PAGE_KEYED) if (ws[key]) delete ws[key][n]
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
    if ((ctx.model.identityConflicts || []).some(c => ['physical-source-alias', 'conflicting-alias-adjustment'].includes(c.reason))) throw new Error('Two source aliases refer to the same physical files with different saved identities or edits. Choose the original source folder in Album Settings before auto-fill; all saved IDs and edits were preserved.')
    // `ids`: only these photos (Best picks); otherwise every photo of the album.
    const ids = Array.isArray(opts && opts.ids) ? ctx.model.pool.filter((id) => opts.ids.includes(id)) : ctx.model.pool
    const photos = ids.map((id) => ctx.model.photos[id]).filter(Boolean)
    const catalogue = await ctx.templates()
    // One page shape for the whole album: the one it has now (or its collections mostly have).
    const shape = await albumShape(ctx)
    const sameShape = catalogue.filter((t) => !shape || !shapeOf(t) || shapeOf(t) === shape)
    const planned = await planAlbum(photos, sameShape, opts || {}, ctx.rng)
    // A template with a frame parked off the page would hide a photo: swap it for another that
    // fits (checked a few at a time; each template is read once, then cached).
    const pages = planned.pages.filter((p) => p.template)
    for (let i = 0; i < pages.length; i += 4) {
      await Promise.all(pages.slice(i, i + 4).map(async (p) => {
        if (!(await offPageFrames(p.template.file)).length) return
        const other = await pickFitting(sameShape, { h: p.template.h, v: p.template.v, like: p.template, except: p.template.id, rng: ctx.rng, shape })
        if (other) p.template = other
      }))
    }
    ctx.pages.length = 0
    for (const p of planned.pages) {
      ctx.pages.push({ id: newSpreadId(), photos: p.photoIds.map((id) => photoEntry(ctx.model, id)), template: p.template ? templateEntry(p.template) : null })
    }
    for (const key of PAGE_KEYED) workspaceOf(ctx.d)[key] = {}
    ctx.report.autoFill = { spreads: planned.pages.length, withoutTemplate: planned.unmatched, cappedTo: planned.cappedTo }
  },
}

// ── public ──────────────────────────────────────────────────────────────────

/** Hold one canonical project lease for the complete operation, including migration/readback.
 * A job passes its existing capability; nested migration must not queue behind its caller.
 */
async function withProjectLease(albumPath, work, { lease: provided, kind = 'edit' } = {}) {
  const location = await canonicalProject(albumPath)
  // A supported current file must be validated before creating lease metadata. A missing
  // public name may still belong to a bounded pending save, which is recovered under lease.
  try { await readProject(location.file) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const run = async () => {
    if (provided && provided.file !== location.file) throw new Error('The project lease belongs to another album.')
    if (!provided) require('./jobs').assertProjectIdle(location.file, location.folder)
    const lease = provided || await acquireProjectLease(location, { kind })
    let result, failure
    try {
      await lease.assertOwned()
      await recoverProject(location.file, { assertOwned: () => lease.assertOwned() })
      await readProject(location.file)
      result = await work({ ...location, lease })
    } catch (error) { failure = error }
    if (!provided) {
      try { await lease.release() } catch (release) {
        if (failure) { failure.message += ` Project lease release also failed: ${release.message}`; failure.releaseError = release }
        else failure = release
      }
    }
    if (failure) throw failure
    return result
  }
  return provided ? run() : serializeProject(location.file, run)
}

function historyOf(file, revision) {
  if (!histories.has(file)) histories.set(file, { undo: [], redo: [], revision: null })
  const h = histories.get(file)
  // Another helper/editor may have saved after our last operation. Its revision must never
  // inherit undo snapshots from this process's earlier project state.
  if (revision && h.revision && revision !== h.revision) { h.undo.length = 0; h.redo.length = 0 }
  if (revision) h.revision = revision
  return h
}

/**
 * Apply operations to an album and save it. All operations of one call are one undo step.
 * @param {{ album: string, ops: {op: string}[] }} p
 * @param {{ rng?: () => number }} [opts]
 */
async function updateAlbum({ album: albumPath, ops }, opts = {}) {
  if (!albumPath) throw new Error('missing `album`')
  if (!Array.isArray(ops) || !ops.length) throw new Error('missing `ops`')
  validateOperations(ops)
  return withProjectLease(albumPath, async ({ file, folder, lease }) => {
    const { data: d, revision } = await readProject(file)
    const h = historyOf(file, revision)
    const original = JSON.stringify(d)
    const model = await prepare(d, file, folder)
    const before = snapshot(d)
    let templates = null
    const ctx = {
      d,
      model,
      pages: pagesOf(d),
      rng: opts.rng || Math.random,
      report: {},
      templates: async () => (templates ??= await listTemplates(workspaceOf(d).templateTokens, workspaceOf(d).identity)),
    }
    for (const o of ops) {
      const fn = Object.prototype.hasOwnProperty.call(OPS, o.op) ? OPS[o.op] : null
      if (!fn) throw new Error(`unknown album operation \`${o.op}\``)
      await fn(ctx, o)
      if (['setPhotoFolders', 'setCollections', 'relinkFolder'].includes(o.op)) {
        setPages(d, ctx.pages)
        ctx.model = await openAlbum({ path: file }, { data: d })
        ctx.pages = pagesOf(d)
        templates = null
      }
    }
    setPages(d, ctx.pages)
    const changed = snapshot(d) !== before
    if (changed || JSON.stringify(d) !== original) {
      await lease.assertOwned()
      h.revision = await writeProject(file, d, revision, lease)
    }
    if (changed) {
      h.undo.push(before)
      if (h.undo.length > HISTORY_LIMIT) h.undo.shift()
      h.redo.length = 0
    }
    return { album: await openAlbum({ path: albumPath }), report: ctx.report, ...historyState(file) }
  })
}

function historyState(file) {
  const h = historyOf(file)
  return { canUndo: h.undo.length > 0, canRedo: h.redo.length > 0 }
}

async function step(albumPath, from, to) {
  return withProjectLease(albumPath, async ({ file, lease }) => {
    const { data: d, revision } = await readProject(file)
    const h = historyOf(file, revision)
    const snap = h[from].at(-1)
    if (snap) {
      const before = snapshot(d)
      restore(d, snap)
      await lease.assertOwned()
      h.revision = await writeProject(file, d, revision, lease)
      h[from].pop()
      h[to].push(before)
    }
    return { album: await openAlbum({ path: albumPath }), changed: !!snap, ...historyState(file) }
  })
}

/** Used by render/export before numbering can change: migration is one atomic project save. */
async function prepare(data, file, folder) {
  const model = await openAlbum({ path: file }, { data })
  await require('./sheets').adoptLegacySheets(data, folder)
  return model
}

async function migrateAlbum({ album: albumPath }, { lease } = {}) {
  if (!albumPath) throw new Error('missing `album`')
  return withProjectLease(albumPath, async ({ file, folder, lease: held }) => {
    const { data, revision } = await readProject(file)
    const h = historyOf(file, revision)
    const before = JSON.stringify(data)
    await prepare(data, file, folder)
    if (JSON.stringify(data) !== before) { await held.assertOwned(); h.revision = await writeProject(file, data, revision, held) }
    return openAlbum({ path: albumPath })
  }, { lease, kind: 'migration' })
}

const undo = ({ album }) => step(album, 'undo', 'redo')
const redo = ({ album }) => step(album, 'redo', 'undo')

module.exports = { updateAlbum, undo, redo, migrateAlbum, withProjectLease }
