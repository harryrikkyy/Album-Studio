// lab_naming.ts — the print lab's naming convention for an order folder (tested in
// test/lab_naming.test.ts). Ported from the Electron app's renamer_naming.js, whose rules are the
// contract (docs/notes/renamer-design.md §2):
//
//   first sheet          → "00"                       (a half sheet, exactly one)
//   last sheet           → "zz"                       (a half sheet, exactly one)
//   page sheet           → "<name> (NN)"              (2-digit, 1-based, in order)
//   page sheet (custom)  → "<custom>_NNN"             (3-digit)
//   special lamination   → "<page name>--------<Effect>"  (8 dashes)
//   cover pad            → "ZZZ--<name>--<Lamination>--<Size>--<N>+1", N = 1 + page sheets

export type SheetRole = 'first' | 'last' | 'cover' | 'page'
export interface NamingTile {
  path: string
  role: SheetRole
  effect?: string | null
}
export interface CoverPad {
  lamination: string
  size: string
}
export interface NamingInput {
  folderName: string
  tiles: NamingTile[]
  coverPad?: CoverPad | null
  customPageName?: string | null
}
export interface RenameOp {
  fromPath: string
  toBaseName: string
}

export const LAMINATIONS = ['Standard', 'Matte', 'Glossy', 'Velvet', 'Luster']
export const SIZES = ['12x36', '12x30', '12x24', '10x30', '10x24', '8x24', '12x18', '10x20']
export const EFFECTS = ['Glitter', 'Foil', 'Emboss', 'Spot UV', 'Metallic']

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n))
const pad3 = (n: number) => String(n).padStart(3, '0')

export const countPageSheets = (tiles: NamingTile[]) => tiles.reduce((n, t) => (t.role === 'page' ? n + 1 : n), 0)

export function coverPadBaseName(folderName: string, lamination: string, size: string, pageSheetCount: number): string {
  return `ZZZ--${folderName}--${lamination}--${size}--${1 + pageSheetCount}+1`
}

export function pageBaseName(
  folderName: string,
  sequence: number,
  effect?: string | null,
  customPageName?: string | null,
): string {
  const custom = (customPageName || '').trim()
  const base = custom ? `${custom}_${pad3(sequence)}` : `${folderName} (${pad2(sequence)})`
  return effect ? `${base}--------${effect}` : base
}

/** Every tile's name, in order; a cover without its pad settings has none yet. */
export function computeAssignedNames(input: NamingInput): { path: string; baseName: string | null; role: SheetRole }[] {
  const pages = countPageSheets(input.tiles)
  let seq = 0
  return input.tiles.map((t) => {
    let baseName: string | null = null
    if (t.role === 'first') baseName = '00'
    else if (t.role === 'last') baseName = 'zz'
    else if (t.role === 'cover')
      baseName = input.coverPad
        ? coverPadBaseName(input.folderName, input.coverPad.lamination, input.coverPad.size, pages)
        : null
    else baseName = pageBaseName(input.folderName, ++seq, t.effect, input.customPageName)
    return { path: t.path, baseName, role: t.role }
  })
}

/** The renames to apply (a cover without settings is left as it is). */
export function computeRenames(input: NamingInput): RenameOp[] {
  return computeAssignedNames(input)
    .filter((n): n is { path: string; baseName: string; role: SheetRole } => n.baseName !== null)
    .map((n) => ({ fromPath: n.path, toBaseName: n.baseName }))
}

/** The standard size whose proportions are nearest the sheet's (sheets are wide). */
export function matchStandardSize(w: number, h: number): string | null {
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  if (!short) return null
  const ratio = long / short
  let best: string | null = null
  let delta = Infinity
  for (const s of SIZES) {
    const m = /^(\d+)x(\d+)$/.exec(s)
    if (!m) continue
    const r = Math.max(+m[1]!, +m[2]!) / Math.min(+m[1]!, +m[2]!)
    if (Math.abs(r - ratio) < delta) {
      delta = Math.abs(r - ratio)
      best = s
    }
  }
  return best
}

/**
 * A folder renamed before: roles, order, effect, cover pad and naming mode read back from the
 * names, so it opens as it was left. Files with other names are pages after the known ones, in
 * their own order.
 */
export function readBack(files: { path: string; baseName: string }[]): {
  tiles: NamingTile[]
  coverPad: CoverPad | null
  customPageName: string | null
  folderName: string | null
} {
  // Only a folder with a 00, a zz or a cover pad was named for the lab; Album Studio's own
  // "Page_001"… exports must not read as custom-named pages.
  if (!files.some((f) => f.baseName === '00' || f.baseName === 'zz' || f.baseName.startsWith('ZZZ--'))) {
    return {
      tiles: files.map((f) => ({ path: f.path, role: 'page' as const })),
      coverPad: null,
      customPageName: null,
      folderName: null,
    }
  }
  const tiles: (NamingTile & { order: number })[] = []
  let coverPad: CoverPad | null = null
  let customPageName: string | null = null
  let folderName: string | null = null
  let unknown = 10_000
  for (const f of files) {
    const b = f.baseName
    const [page, effect] = b.split('--------') as [string, string | undefined]
    let m: RegExpExecArray | null
    if (b === '00') tiles.push({ path: f.path, role: 'first', order: -1 })
    else if (b === 'zz') tiles.push({ path: f.path, role: 'last', order: 1e9 })
    else if ((m = /^ZZZ--(.+)--([^-]+)--([^-]+)--(\d+)\+1$/.exec(b))) {
      tiles.push({ path: f.path, role: 'cover', order: 1e9 + 1 })
      folderName ??= m[1]!
      coverPad = { lamination: m[2]!, size: m[3]! }
    } else if ((m = /^(.+) \((\d{2,})\)$/.exec(page))) {
      folderName ??= m[1]!
      tiles.push({ path: f.path, role: 'page', effect: effect ?? null, order: Number(m[2]) })
    } else if ((m = /^(.+)_(\d{3})$/.exec(page))) {
      customPageName ??= m[1]!
      tiles.push({ path: f.path, role: 'page', effect: effect ?? null, order: Number(m[2]) })
    } else tiles.push({ path: f.path, role: 'page', order: unknown++ })
  }
  tiles.sort((a, b) => a.order - b.order)
  return { tiles: tiles.map(({ order: _o, ...t }) => t), coverPad, customPageName, folderName }
}
