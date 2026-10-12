// album.js — reads a saved Album Studio project into the model the new interface uses.
//
// A project is a folder holding project.json (or, for old projects, a single .json file). Its
// photos and templates are referenced by folder ("tokens"); the ids inside it are derived from
// display names exactly as the Electron app derived them, so ids keep matching across apps:
//   photo     "img_" + sanitize(<folder display name> + "_" + <thumbnail file name>)
//   template  "tpl_" + sanitize(<template folder name> + "_" + <psd file name>)
// where sanitize() turns every non-alphanumeric character into "_", and a photo folder's display
// name is the master folder's name even when its _Thumbnails subfolder is what got loaded.

'use strict'

const fs = require('fs')
const path = require('path')
const { jpegSize } = require('./jpeg_size')

const sanitize = (s) => s.replace(/[^a-zA-Z0-9]/g, '_')
const IMAGE_EXT = /\.(jpe?g|png|tiff?|webp|heic|heif)$/i
const RAW_PREF = /\.(tiff?|cr2|cr3|raw|nef|arw|dng|rw2|orf|raf|psd|psb)$/i

async function exists(p) {
  try { await fs.promises.access(p); return true } catch (_) { return false }
}

async function readdirSafe(dir) {
  try { return await fs.promises.readdir(dir, { withFileTypes: true }) } catch (_) { return [] }
}

/** Resolve a project path (folder or legacy .json) to its JSON file and folder. */
async function locateProject(p) {
  const st = await fs.promises.stat(p).catch(() => null)
  if (!st) throw new Error(`No project at ${p}. The drive may be disconnected, or the project moved.`)
  if (st.isDirectory()) {
    const file = path.join(p, 'project.json')
    if (!(await exists(file))) throw new Error(`${path.basename(p)} isn't an Album Studio project (no project.json).`)
    return { file, folder: p }
  }
  return { file: p, folder: path.dirname(p) }
}

async function mtimeOf(p) {
  const st = await fs.promises.stat(p).catch(() => null)
  return st ? st.mtimeMs : 0
}

/** Folder scans by folder path; reused until the folder (or its _Thumbnails) changes. */
const folderCache = new Map()

/**
 * Photos of one source folder: thumbnails (from _Thumbnails when present), originals, and each
 * thumbnail's pixel size. Cached until a file is added, removed or renamed in either folder
 * (which changes the folder's modification time), so an edit doesn't rescan thousands of photos.
 */
async function scanPhotoFolder(master) {
  const thumbDir = path.join(master, '_Thumbnails')
  const key = `${await mtimeOf(master)}|${await mtimeOf(thumbDir)}`
  const hit = folderCache.get(master)
  if (hit && hit.key === key) return hit.result
  const result = await scanPhotoFolderUncached(master, thumbDir)
  folderCache.set(master, { key, result })
  return result
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
  const photos = await Promise.all(listed.map(async (e) => {
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
  }))
  photos.sort((a, b) => a.base.localeCompare(b.base, undefined, { numeric: true }))
  return { path: master, name: display, exists: await exists(master), hasThumbs, photos }
}

/** Template PSDs of one collection folder (recursive), keyed by template id. */
async function scanTemplateFolder(dir, index) {
  const display = path.basename(dir)
  const walk = async (d) => {
    for (const e of await readdirSafe(d)) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) await walk(full)
      else if (/\.psd$/i.test(e.name)) index.set('tpl_' + sanitize(display + '_' + e.name), { file: full, collection: dir })
    }
  }
  await walk(dir)
}

function fileFromUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return null
  try { return decodeURIComponent(new URL(url).pathname) } catch (_) { return null }
}

async function templatePreview(tpl, resolved) {
  const fromSaved = fileFromUrl(tpl.url)
  if (fromSaved && (await exists(fromSaved))) return fromSaved
  if (!resolved) return null
  const guess = path.join(resolved.collection, 'Thumbnails', tpl.name.replace(/\.psd$/i, '.jpg'))
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

/** The rendered print sheet in the output folder (`Page_NNN.psd`), when it exists. */
async function sheetFor(outputFolder, n) {
  if (!outputFolder) return null
  const p = path.join(outputFolder, `Page_${String(n).padStart(3, '0')}.psd`)
  return (await exists(p)) ? p : null
}

/**
 * @param {{path: string}} params  a project folder (or a legacy .json file)
 */
async function openAlbum({ path: projectPath }) {
  if (!projectPath) throw new Error('missing `path`')
  const { file, folder } = await locateProject(projectPath)
  let data
  try {
    data = JSON.parse(await fs.promises.readFile(file, 'utf8'))
  } catch (e) {
    throw new Error(`${path.basename(file)} couldn't be read: ${e.message}`)
  }
  const ws = data.workspace || data
  const pages = data.albumPages || {}
  const spreadCount = Number(data.totalActivePages) || Object.keys(pages).length || 0

  // Photos: every folder in the project, in parallel.
  const folders = await Promise.all((ws.imageTokens || []).map(scanPhotoFolder))
  /** @type {Record<string, any>} */
  const photos = {}
  for (const f of folders) for (const p of f.photos) photos[p.id] = { ...p, orient: null, usedOn: [] }

  // Templates referenced by spreads → their PSD and preview.
  const tplIndex = new Map()
  await Promise.all((ws.templateTokens || []).map((d) => scanTemplateFolder(d, tplIndex)))

  const rotations = ws.imageRotations || {}
  const spreads = []
  for (let n = 1; n <= spreadCount; n++) {
    const page = pages[n] || pages[String(n)] || { photos: [], template: null }
    const ids = (page.photos || []).map((p) => p.id)
    for (const p of page.photos || []) {
      const ph = photos[p.id]
      if (ph) { ph.usedOn.push(n); if (p.orient) ph.orient = p.orient }
    }
    const tpl = page.template
    const resolved = tpl ? tplIndex.get(tpl.id) || null : null
    spreads.push({
      n,
      photoIds: ids,
      missingPhotos: ids.filter((id) => !photos[id]).length,
      template: tpl ? {
        id: tpl.id,
        name: tpl.name || null,
        h: tpl.h ?? null,
        v: tpl.v ?? null,
        file: resolved ? resolved.file : null,
        preview: await templatePreview(tpl, resolved),
      } : null,
      proof: await proofFor(folder, n),
      sheet: await sheetFor(ws.outputToken, n),
      edited: Boolean((ws.pageOverlays || {})[n] || (ws.pageLayerEdits || {})[n] || (ws.pageBackgrounds || {})[n]),
    })
  }

  // The user's turn (0, 90, 180, 270, clockwise), and the orientation of photos no spread
  // recorded: from the thumbnail's size and that turn.
  for (const ph of Object.values(photos)) {
    ph.rotation = ((Number(rotations[ph.id]) || 0) % 360 + 360) % 360
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
    pool: folders.flatMap((f) => f.photos.map((p) => p.id)),
    stats: { spreads: spreadCount, photos: Object.keys(photos).length, used, planned: spreads.filter((s) => s.photoIds.length).length },
  }
}

module.exports = { openAlbum, sanitize }
