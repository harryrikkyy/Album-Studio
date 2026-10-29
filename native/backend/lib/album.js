// album.js — reads a saved Album Studio project into the model the new interface uses.
//
// A project is a folder holding project.json (or, for old projects, a single .json file). Its
// photos and templates are referenced by folder ("tokens"); the ids inside it are derived from
// display names as the Electron app derived them when uniquely attributable:
//   photo     "img_" + sanitize(<folder display name> + "_" + <thumbnail file name>)
//   template  "tpl_" + sanitize(<template folder name> + "_" + <psd file name>)
// where sanitize() turns every non-alphanumeric character into "_", and a photo folder's display
// name is the master folder's name even when its _Thumbnails subfolder is what got loaded.

'use strict'

const fs = require('fs')
const path = require('path')
const { jpegSize } = require('./jpeg_size')
const { canonicalProject } = require('./project_lock')
const { readProjectSnapshot } = require('./project_transaction')
const { migrateProject, pageCount } = require('./project_domain')
const { prepareSourceAliases } = require('./source_roots')
const { listTemplates } = require('./templates')
const {
  sanitize,
  registryOf,
  assignAssetIds,
  referenceIndex,
  resolveReference,
  fileFromUrl,
  ensureSpreadIds,
} = require('./identity')

const IMAGE_EXT = /\.(jpe?g|png|tiff?|webp|heic|heif)$/i
const RAW_PREF = /\.(tiff?|cr2|cr3|raw|nef|arw|dng|rw2|orf|raf|psd|psb)$/i

async function exists(p) {
  try {
    await fs.promises.access(p)
    return true
  } catch (_) {
    return false
  }
}

async function readdirSafe(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (_) {
    return []
  }
}

/** Resolve a project path (folder or legacy .json) to its JSON file and folder. */
async function locateProject(p) {
  const st = await fs.promises.stat(p).catch(() => null)
  if (!st) {
    try {
      return await canonicalProject(p)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    throw new Error(`No project at ${p}. The drive may be disconnected, or the project moved.`)
  }
  if (st.isDirectory()) {
    const file = path.join(p, 'project.json')
    if (!(await exists(file))) {
      try {
        return await canonicalProject(file)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      throw new Error(`${path.basename(p)} isn't an Album Studio project (no project.json).`)
    }
    return canonicalProject(file)
  }
  return canonicalProject(p)
}

/**
 * Photos of one source folder: thumbnails (from _Thumbnails when present), originals, and each
 * thumbnail's current pixel size. Directory stamps cannot prove member contents unchanged:
 * an in-place thumbnail edit must be observed on the next album read.
 */
async function scanPhotoFolder(master) {
  const thumbDir = path.join(master, '_Thumbnails')
  return scanPhotoFolderUncached(master, thumbDir)
}

async function scanPhotoFolderUncached(master, thumbDir) {
  const display = path.basename(master)
  const hasThumbs = await exists(thumbDir)
  const masterEntries = (await readdirSafe(master)).filter((e) => e.isFile() && !e.name.startsWith('.'))
  // Originals by lower-case base name; RAW/TIFF preferred over a same-named JPEG, as getTrueFile does.
  const originals = new Map()
  for (const e of masterEntries) {
    const base = e.name.replace(/\.[^.]+$/, '').toLowerCase()
    const prev = originals.get(base)
    if (!prev || (!RAW_PREF.test(prev) && RAW_PREF.test(e.name))) originals.set(base, e.name)
  }
  const listed = hasThumbs
    ? (await readdirSafe(thumbDir)).filter((e) => e.isFile() && IMAGE_EXT.test(e.name) && !e.name.startsWith('.'))
    : masterEntries.filter((e) => IMAGE_EXT.test(e.name))
  const photos = await Promise.all(
    listed.map(async (e) => {
      const base = e.name.replace(/\.[^.]+$/, '')
      const orig = originals.get(base.toLowerCase())
      const thumb = path.join(hasThumbs ? thumbDir : master, e.name)
      const size = await jpegSize(thumb)
      return {
        id: 'img_' + sanitize(display + '_' + e.name),
        base,
        folder: master,
        thumb,
        original: orig ? path.join(master, orig) : null,
        width: size ? size.width : null,
        height: size ? size.height : null,
      }
    }),
  )
  photos.sort((a, b) => a.base.localeCompare(b.base, undefined, { numeric: true }))
  return { path: master, name: display, exists: await exists(master), hasThumbs, photos }
}

async function templatePreview(tpl, resolved) {
  const fromSaved = fileFromUrl(tpl.url)
  if (fromSaved && (await exists(fromSaved))) return fromSaved
  if (!resolved) return null
  if (resolved.preview && (await exists(resolved.preview))) return resolved.preview
  const guess = path.join(resolved.sourceRoot, 'Thumbnails', String(tpl.name || '').replace(/\.psd$/i, '.jpg'))
  return (await exists(guess)) ? guess : null
}

async function proofFor(folder, n) {
  const num = String(n).padStart(3, '0')
  for (const name of [`live_page_${num}.jpg`, `page_${num}.jpg`]) {
    const p = path.join(folder, 'proofs', 'pages', name)
    if (await exists(p)) return p
  }
  return null
}

/**
 * @param {{path: string}} params  a project folder (or a legacy .json file)
 */
async function openAlbum({ path: projectPath }, options = {}) {
  if (!projectPath) throw new Error('missing `path`')
  const { file, folder } = await locateProject(projectPath)
  let data
  try {
    data = options.data || (await readProjectSnapshot(file)).data
  } catch (e) {
    throw new Error(`${path.basename(file)} couldn't be read: ${e.message}`)
  }
  migrateProject(data)
  const ws = data.workspace || data
  const registry = registryOf(data)
  const legacyPositions = new Set(
    Object.entries(data.albumPages || {})
      .filter(([, page]) => !page.id)
      .map(([n]) => Number(n)),
  )
  // Read-only opens derive repeatable legacy IDs; a subsequent atomic edit persists them.
  ensureSpreadIds(data, { seed: file })
  const pages = data.albumPages || {}
  const spreadCount = pageCount(data)

  // Photos: every folder in the project, in parallel.
  const folders = await Promise.all([...new Set(ws.imageTokens || [])].map(scanPhotoFolder))
  const sources = await prepareSourceAliases(
    folders.flatMap((f) => f.photos),
    'photo',
    registry,
  )
  const assets = assignAssetIds(sources.candidates, 'photo', registry)
  /** @type {Record<string, any>} */
  const photos = {}
  for (const p of assets) photos[p.id] = { ...p, orient: null, usedOn: [] }

  // Templates referenced by spreads → their PSD and preview.
  const identityConflicts = [...sources.conflicts]
  // The album model needs identities and paths, not every template's canvas size. Still
  // inventory the folders on each read; fitting/autofill request verified dimensions separately.
  const catalogue = await listTemplates(ws.templateTokens || [], registry, {
    dimensions: false,
    onConflict: (conflict) => identityConflicts.push(conflict),
  })
  const photoIndex = referenceIndex(assets, 'photo', registry)
  const templateIndex = referenceIndex(catalogue, 'template', registry)
  const blockedAliases = new Set()
  // Old per-photo adjustments cannot be assigned by an ambiguous display-name alias. Include
  // absent registry records in the check so removing a folder cannot transfer its edits.
  for (const key of ['imageRotations', 'imagePlacements', 'imageAdjustments']) {
    const edits = ws[key] || {}
    for (const id of Object.keys(edits)) {
      if (registry.assets[id]) continue
      const matches = Object.entries(registry.assets).filter(
        ([, a]) => a.kind === 'photo' && (a.legacyId === id || (a.legacyAliases || []).includes(id)),
      )
      if (matches.length === 1) {
        if (edits[matches[0][0]] !== undefined && JSON.stringify(edits[matches[0][0]]) !== JSON.stringify(edits[id])) {
          blockedAliases.add(id)
          identityConflicts.push({
            kind: 'photo',
            id,
            reason: 'conflicting-alias-adjustment',
            field: key,
            candidates: [matches[0][0]],
          })
          continue
        }
        edits[matches[0][0]] ??= edits[id]
        delete edits[id]
      } else if (matches.length > 1)
        identityConflicts.push({
          kind: 'photo',
          id,
          reason: 'ambiguous-adjustment',
          field: key,
          candidates: matches.map(([assetId]) => assetId),
        })
    }
  }

  const rotations = ws.imageRotations || {}
  const placements = ws.imagePlacements || {}
  const adjustments = ws.imageAdjustments || {}
  const spreads = []
  for (let n = 1; n <= spreadCount; n++) {
    const page = pages[n] || pages[String(n)] || { photos: [], template: null }
    for (const p of page.photos || []) {
      const { asset, conflict, id } = blockedAliases.has(p.id)
        ? {}
        : resolveReference(p, assets, 'photo', registry, photoIndex)
      if (conflict) identityConflicts.push({ ...conflict, n })
      if (asset) p.id = asset.id
      else if (id) p.id = id
      const ph = asset && photos[asset.id]
      if (ph) {
        ph.usedOn.push(n)
        if (p.orient) ph.orient = p.orient
      }
    }
    const ids = (page.photos || []).map((p) => p.id)
    const tpl = page.template
    const resolution = tpl ? resolveReference(tpl, catalogue, 'template', registry, templateIndex) : {}
    if (resolution.conflict) identityConflicts.push({ ...resolution.conflict, n })
    const resolved = resolution.asset || null
    if (resolved) tpl.id = resolved.id
    else if (resolution.id) tpl.id = resolution.id
    spreads.push({
      id: page.id,
      n,
      photoIds: ids,
      missingPhotos: ids.filter((id) => !photos[id]).length,
      template: tpl
        ? {
            id: tpl.id,
            name: tpl.name || null,
            h: tpl.h ?? null,
            v: tpl.v ?? null,
            file: resolved ? resolved.file : null,
            preview: await templatePreview(tpl, resolved),
          }
        : null,
      proof: await proofFor(folder, n),
      sheet: await require('./sheets').resolveSpreadSheet(ws, folder, legacyPositions.has(n) ? null : page.id, n, file),
      edited: Boolean((ws.pageOverlays || {})[n] || (ws.pageLayerEdits || {})[n] || (ws.pageBackgrounds || {})[n]),
    })
  }

  // The user's turn (0, 90, 180, 270, clockwise), and the orientation of photos no spread
  // recorded: from the thumbnail's size and that turn.
  for (const ph of Object.values(photos)) {
    ph.rotation = (((Number(rotations[ph.id]) || 0) % 360) + 360) % 360
    ph.placement = placements[ph.id] || null
    ph.adjust = adjustments[ph.id] || null
    if (ph.orient || !ph.width || !ph.height) continue
    const quarter = ph.rotation === 90 || ph.rotation === 270
    const landscape = ph.width >= ph.height
    ph.orient = landscape !== quarter ? 'h' : 'v'
  }

  const used = Object.values(photos).filter((p) => p.usedOn.length).length
  return {
    path: folder,
    file,
    name: path.basename(folder),
    savedAt: data.savedAt || null,
    outputFolder: ws.outputToken || null,
    photoFolders: folders.map(({ photos: list, ...f }) => ({ ...f, count: list.length })),
    templateCollections: (ws.templateTokens || []).map((d) => ({ path: d, name: path.basename(d) })),
    spreads,
    photos,
    pool: assets.map((p) => p.id),
    identityConflicts,
    stats: {
      spreads: spreadCount,
      photos: Object.keys(photos).length,
      used,
      planned: spreads.filter((s) => s.photoIds.length).length,
    },
  }
}

module.exports = { openAlbum, locateProject, sanitize }
