// renamer.js
//
// Main-process side of the Renamer feature. Owns:
//   • the dedicated Renamer window
//   • listing images in an order folder (jpg/jpeg/png/psd/psb) with small
//     base64 thumbnails + pixel dimensions
//   • a collision-safe two-phase rename
//   • PSD/PSB embedded-JPEG thumbnail extraction (no PSD decoder needed)
//
// Kept dependency-free (uses the app's existing sharp for raster thumbs).
// See renamer-design.md.

const { BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { getSharp } = require('./sharp_config')

const RASTER_EXT = /\.(jpe?g|png)$/i
const PSD_EXT = /\.(psd|psb)$/i
const THUMB_EDGE = 240 // px, longest edge for grid thumbnails

let _win = null

// ── Window ────────────────────────────────────────────────────
function openRenamerWindow() {
  if (_win && !_win.isDestroyed()) {
    _win.show()
    _win.focus()
    return _win
  }
  _win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    title: 'Renamer — Album Toolkit',
    backgroundColor: '#0b0c20',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })
  _win.loadFile(path.join(__dirname, 'renamer.html'))
  _win.on('closed', () => { _win = null })
  return _win
}

function isOpen() {
  return !!(_win && !_win.isDestroyed())
}

// ── Natural sort (so "(2)" precedes "(10)") ───────────────────
function naturalCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

// ── PSD/PSB embedded JPEG thumbnail (Image Resource id 1036) ──
// Returns a Buffer of JPEG bytes, or null if the file has no embedded
// thumbnail (e.g. saved without "Maximize Compatibility").
function extractPsdThumbnailJpeg(filePath) {
  let fd = null
  try {
    fd = fs.openSync(filePath, 'r')
    const head = Buffer.alloc(26)
    if (fs.readSync(fd, head, 0, 26, 0) < 26) return null
    if (head.toString('ascii', 0, 4) !== '8BPS') return null

    let pos = 26
    const read = (len) => {
      const buf = Buffer.alloc(len)
      const got = fs.readSync(fd, buf, 0, len, pos)
      pos += got
      return got === len ? buf : null
    }

    // Color Mode Data: length(4) + data
    let b = read(4)
    if (!b) return null
    pos += b.readUInt32BE(0)

    // Image Resources: length(4), then 8BIM blocks
    b = read(4)
    if (!b) return null
    const resourcesEnd = pos + b.readUInt32BE(0)

    while (pos < resourcesEnd) {
      const sig = read(4)
      if (!sig || sig.toString('ascii') !== '8BIM') break
      const idBuf = read(2)
      if (!idBuf) break
      const resId = idBuf.readUInt16BE(0)

      // Pascal name: length byte + name, padded to even total length.
      const nameLenBuf = read(1)
      if (!nameLenBuf) break
      const nameLen = nameLenBuf.readUInt8(0)
      const nameFieldTotal = nameLen + 1
      const namePad = nameFieldTotal % 2 === 0 ? 0 : 1
      if (nameLen + namePad > 0) { if (!read(nameLen + namePad)) break }

      const sizeBuf = read(4)
      if (!sizeBuf) break
      let dataSize = sizeBuf.readUInt32BE(0)
      const dataStart = pos

      if (resId === 1036 || resId === 1033) {
        // thumbnail resource header is 28 bytes; remainder is the JPEG.
        const HEADER = 28
        if (dataSize > HEADER) {
          const jpegLen = dataSize - HEADER
          const jpeg = Buffer.alloc(jpegLen)
          fs.readSync(fd, jpeg, 0, jpegLen, dataStart + HEADER)
          return jpeg
        }
        return null
      }

      // Advance to next block; resource data is padded to even length.
      if (dataSize % 2 === 1) dataSize += 1
      pos = dataStart + dataSize
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch (_) {} }
  }
}

// PSD/PSB width/height live in the header at bytes 18..22 (height) and
// 14..18 (width), big-endian uint32.
function readPsdDimensions(filePath) {
  let fd = null
  try {
    fd = fs.openSync(filePath, 'r')
    const head = Buffer.alloc(22)
    if (fs.readSync(fd, head, 0, 22, 0) < 22) return { width: 0, height: 0 }
    if (head.toString('ascii', 0, 4) !== '8BPS') return { width: 0, height: 0 }
    const height = head.readUInt32BE(14)
    const width = head.readUInt32BE(18)
    return { width, height }
  } catch {
    return { width: 0, height: 0 }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch (_) {} }
  }
}

async function makeThumbDataUrl(input) {
  // input is either a file path (raster) or a Buffer of JPEG bytes (PSD).
  const sharp = getSharp()
  try {
    const buf = await sharp(input, { failOn: 'none' })
      .rotate()
      .resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer()
    return 'data:image/jpeg;base64,' + buf.toString('base64')
  } catch {
    return null
  }
}

// ── List images in a folder ───────────────────────────────────
async function listImages(folderPath) {
  let entries = []
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true })
  } catch (e) {
    return { ok: false, error: e.message, images: [] }
  }

  const names = entries
    .filter((e) => e.isFile() && (RASTER_EXT.test(e.name) || PSD_EXT.test(e.name)))
    .map((e) => e.name)
    .sort(naturalCompare)

  const images = []
  for (const fileName of names) {
    const full = path.join(folderPath, fileName)
    const ext = path.extname(fileName)
    const baseName = fileName.slice(0, fileName.length - ext.length)
    let width = 0
    let height = 0
    let thumb = null

    if (PSD_EXT.test(fileName)) {
      const dims = readPsdDimensions(full)
      width = dims.width
      height = dims.height
      const jpeg = extractPsdThumbnailJpeg(full)
      if (jpeg) thumb = await makeThumbDataUrl(jpeg)
    } else {
      try {
        const sharp = getSharp()
        const meta = await sharp(full, { failOn: 'none' }).metadata()
        // honor EXIF orientation for reported dimensions
        if (meta.orientation && meta.orientation >= 5) {
          width = meta.height || 0
          height = meta.width || 0
        } else {
          width = meta.width || 0
          height = meta.height || 0
        }
      } catch { /* leave 0x0 */ }
      thumb = await makeThumbDataUrl(full)
    }

    images.push({ path: full, fileName, baseName, ext, width, height, thumb })
  }

  return { ok: true, images, folderName: path.basename(folderPath) }
}

// ── Apply renames — collision-safe two-phase ──────────────────
async function applyRenames(folderPath, ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: true, renamed: 0 }
  }
  // Only touch files inside folderPath; drop no-ops and reject any target
  // that would escape the folder. toBaseName can include the user-typed
  // custom prefix, so a value like "../x" must not be allowed to write
  // outside the order folder (design §8: renames are constrained to the
  // order folder).
  const folderResolved = path.resolve(folderPath)
  const planned = []
  for (const op of ops) {
    if (!op || !op.fromPath || !op.toBaseName) continue
    const dir = path.dirname(op.fromPath)
    if (path.resolve(dir) !== folderResolved) continue
    const ext = path.extname(op.fromPath)
    const toPath = path.join(folderPath, op.toBaseName + ext)
    // Guard against path traversal: the target must land directly inside
    // folderPath (no subdirs, no "..").
    if (path.dirname(path.resolve(toPath)) !== folderResolved) continue
    if (path.resolve(toPath) === path.resolve(op.fromPath)) continue // no-op
    planned.push({ fromPath: op.fromPath, toPath, ext })
  }
  if (planned.length === 0) return { ok: true, renamed: 0 }

  const stamp = Date.now()
  const temps = []
  try {
    // Phase 1: move each source to a unique temp name.
    planned.forEach((p, i) => {
      const rand = Math.random().toString(36).slice(2, 8)
      const tmp = path.join(folderPath, `.tmp-${stamp}-${i}-${rand}${p.ext}`)
      fs.renameSync(p.fromPath, tmp)
      temps.push({ tmp, toPath: p.toPath })
    })
    // Phase 2: move each temp to its final name.
    let renamed = 0
    for (const t of temps) {
      fs.renameSync(t.tmp, t.toPath)
      renamed++
    }
    return { ok: true, renamed }
  } catch (e) {
    // Best-effort: leave temps in place (recoverable) and report.
    return { ok: false, error: e.message, renamed: 0 }
  }
}

module.exports = {
  openRenamerWindow,
  isOpen,
  listImages,
  applyRenames,
}
