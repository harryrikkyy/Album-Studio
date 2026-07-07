// renamer_naming.js
//
// Pure naming logic for the Renamer feature. No Electron, no filesystem, no
// DOM — just functions that turn UI state into base names. This is the
// "contract" from docs/notes/renamer-design.md §2/§4, ported to plain CommonJS so it can
// be required by both the main process and the renderer (nodeIntegration is
// on) and unit-tested in isolation.
//
// Naming rules:
//   first sheet           -> "00"            (half sheet, exactly one)
//   last sheet            -> "zz"            (half sheet, exactly one)
//   page sheet (folder)   -> "<folder> (NN)" (2-digit, 1-based, grid order)
//   page sheet (custom)   -> "<custom>_NNN"  (3-digit)
//   special-lamination    -> "<pageBase>--------<Effect>" (8 dashes)
//   cover pad             -> "ZZZ--<folder>--<Lam>--<Size>--<N>+1"
//                            where N = 1 + (page sheet count)

const pad2 = (n) => (n < 10 ? `0${n}` : String(n))
const pad3 = (n) => String(n).padStart(3, '0')

const countPageSheets = (tiles) =>
  tiles.reduce((acc, t) => (t.role === 'page' ? acc + 1 : acc), 0)

function coverPadBaseName(folderName, lamination, size, pageSheetCount) {
  const n = 1 + pageSheetCount
  return `ZZZ--${folderName}--${lamination}--${size}--${n}+1`
}

function pageBaseName(folderName, sequence, effect, customPageName) {
  const custom = (customPageName || '').trim()
  const base = custom
    ? `${custom}_${pad3(sequence)}`
    : `${folderName} (${pad2(sequence)})`
  return effect ? `${base}--------${effect}` : base
}

/**
 * Compute the assigned base name for every tile in grid order. Drives the
 * live UI labels. A `cover` tile with no config produces baseName === null.
 *
 * @param {{folderName:string, tiles:Array<{path:string,role:string,effect?:string|null}>,
 *          coverPad?:{lamination:string,size:string}|null,
 *          customPageName?:string|null}} input
 * @returns {Array<{path:string, baseName:string|null, role:string}>}
 */
function computeAssignedNames(input) {
  const pageSheetCount = countPageSheets(input.tiles)
  let pageSeq = 0
  return input.tiles.map((tile) => {
    let baseName = null
    switch (tile.role) {
      case 'first':
        baseName = '00'
        break
      case 'last':
        baseName = 'zz'
        break
      case 'cover':
        baseName = input.coverPad
          ? coverPadBaseName(
              input.folderName,
              input.coverPad.lamination,
              input.coverPad.size,
              pageSheetCount
            )
          : null
        break
      case 'page':
      default:
        pageSeq += 1
        baseName = pageBaseName(
          input.folderName,
          pageSeq,
          tile.effect,
          input.customPageName
        )
        break
    }
    return { path: tile.path, baseName, role: tile.role }
  })
}

/**
 * Produce the apply-to-disk operations (omits tiles whose name is null,
 * e.g. an unconfigured cover).
 * @returns {Array<{fromPath:string, toBaseName:string}>}
 */
function computeRenames(input) {
  return computeAssignedNames(input)
    .filter((n) => n.baseName !== null)
    .map((n) => ({ fromPath: n.path, toBaseName: n.baseName }))
}

module.exports = {
  pad2,
  pad3,
  countPageSheets,
  coverPadBaseName,
  pageBaseName,
  computeAssignedNames,
  computeRenames,
}
