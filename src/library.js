// library.js
//
// Persistent user library — a per-user catalog of templates, wallpapers, PNG
// frames, masked frames, and saved layouts that lives outside any single
// album project so it can be reused across weddings.
//
// On-disk layout (under app.getPath('userData')/library):
//
//   library/
//     templates/
//       <set name>/         ← anything dropped in here is treated as a template folder
//         romantic_garden_2h2v.psd
//         romantic_garden_2h2v.jpg   ← preview sibling, optional
//         …
//     wallpapers/
//       <set name>/
//     pngs/
//       <set name>/
//     masks/
//       <set name>/
//     layouts/
//       <name>.json         ← saved page-by-page layout (album.json subset)
//
// The renderer doesn't have to know about the on-disk shape — it just calls
// `listLibrary()` and gets a structured JSON catalog back. Adding to the
// library is a folder copy. Removing is a folder delete. Saved layouts are
// JSON files that record templateId + photo orientation per page so they can
// be re-applied to a fresh photo folder.

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

const KINDS = ['templates', 'wallpapers', 'pngs', 'masks']

function libraryDir() {
  const dir = path.join(app.getPath('userData'), 'library')
  fs.mkdirSync(dir, { recursive: true })
  for (const k of KINDS) fs.mkdirSync(path.join(dir, k), { recursive: true })
  fs.mkdirSync(path.join(dir, 'layouts'), { recursive: true })
  return dir
}

// Copy a folder recursively. We do it manually because `fs.cp` with
// `{ recursive: true }` exists on modern Node but the older callback variant
// doesn't, and we want the same behavior across the board.
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else if (entry.isFile()) fs.copyFileSync(s, d)
  }
}

function _safeName(input) {
  // Filesystem-safe folder name. Squashes runs of separators so users can
  // type whatever they want and we still produce a clean folder name.
  return String(input).replace(/[^a-zA-Z0-9 _-]+/g, '').replace(/\s+/g, ' ').trim() || 'Untitled'
}

/**
 * Catalog the library — returns the user-visible structure for the renderer.
 */
function listLibrary() {
  const root = libraryDir()
  const out = { templates: [], wallpapers: [], pngs: [], masks: [], layouts: [] }
  for (const kind of KINDS) {
    const kdir = path.join(root, kind)
    for (const entry of fs.readdirSync(kdir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const setDir = path.join(kdir, entry.name)
      let count = 0
      try {
        count = fs.readdirSync(setDir).filter(f => /\.(psd|jpg|jpeg|png|tif|tiff)$/i.test(f)).length
      } catch (_) {}
      out[kind].push({ name: entry.name, path: setDir, count })
    }
  }
  // Layouts.
  const lDir = path.join(root, 'layouts')
  for (const entry of fs.readdirSync(lDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const fp = path.join(lDir, entry.name)
    let pages = 0, name = entry.name.replace(/\.json$/, '')
    try {
      const j = JSON.parse(fs.readFileSync(fp, 'utf8'))
      pages = j.pageCount || (j.pages ? Object.keys(j.pages).length : 0)
      if (j.name) name = j.name
    } catch (_) {}
    out.layouts.push({ name, file: fp, pages })
  }
  return out
}

/**
 * Copy a set of folders into the library under the given kind. `srcPaths`
 * may be an array of folders the user wants to add as a single library set,
 * or a single source folder.
 */
function addToLibrary(kind, setName, srcPaths) {
  if (!KINDS.includes(kind)) throw new Error(`unknown library kind: ${kind}`)
  const root = libraryDir()
  const dest = path.join(root, kind, _safeName(setName))
  fs.mkdirSync(dest, { recursive: true })
  const sources = Array.isArray(srcPaths) ? srcPaths : [srcPaths]
  for (const s of sources) {
    if (!fs.existsSync(s)) continue
    const stat = fs.statSync(s)
    if (stat.isDirectory()) copyDir(s, dest)
    else fs.copyFileSync(s, path.join(dest, path.basename(s)))
  }
  return { ok: true, path: dest }
}

function removeFromLibrary(kind, setName) {
  if (!KINDS.includes(kind)) throw new Error(`unknown library kind: ${kind}`)
  const target = path.join(libraryDir(), kind, _safeName(setName))
  if (!fs.existsSync(target)) return { ok: false, error: 'not found' }
  fs.rmSync(target, { recursive: true, force: true })
  return { ok: true }
}

// ─── layouts ────────────────────────────────────────────────────────────────
//
// A layout is the structural skeleton of an album (which template each page
// uses, plus per-page photo slots) decoupled from the actual photos. The user
// can save the layout from one wedding ("Standard 200pg Wedding") and apply
// it to another with a fresh photo folder; the photos auto-fill in the new
// project's chronological order using whatever orientation slots the layout
// asks for.
//
// Saved layout shape:
//   {
//     name, savedAt, pageCount,
//     pages: {
//       "1": { templateId, generator?, params?, photoSlots: [{ orient }] },
//       "2": { ... },
//     }
//   }

function saveLayout(layoutName, layoutData) {
  const safe = _safeName(layoutName)
  const file = path.join(libraryDir(), 'layouts', `${safe}.json`)
  const payload = {
    name: layoutName,
    savedAt: new Date().toISOString(),
    pageCount: Object.keys(layoutData.pages || {}).length,
    ...layoutData,
  }
  fs.writeFileSync(file, JSON.stringify(payload, null, 2))
  return { ok: true, file }
}

function loadLayout(file) {
  if (!fs.existsSync(file)) return { ok: false, error: 'layout not found' }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { ok: true, data }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function deleteLayout(file) {
  if (!fs.existsSync(file)) return { ok: false, error: 'layout not found' }
  // Constrain delete to the layouts directory so a malformed `file` can't
  // erase anything unexpected.
  const root = path.join(libraryDir(), 'layouts')
  const resolved = path.resolve(file)
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return { ok: false, error: 'refused: outside library' }
  }
  fs.unlinkSync(resolved)
  return { ok: true }
}

module.exports = {
  libraryDir,
  listLibrary,
  addToLibrary,
  removeFromLibrary,
  saveLayout,
  loadLayout,
  deleteLayout,
}
