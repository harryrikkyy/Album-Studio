# Renamer — Design Document (portable)

A self-contained design for the **Renamer**: a visual, drag-and-drop workspace
that renames a folder of album sheets to a print naming convention. This doc is
written to be reusable in another project — it specifies the behavior, the pure
naming logic, the backend (file + image services), and the UI, independent of
the surrounding app.

---

## 1. Purpose

Given a single **order folder** of image files (JPEG/PNG) plus optional
Photoshop files (PSD/PSB), let an operator:

1. Pick the **first** sheet, **last** sheet, and **cover pad** by clicking.
2. Auto-number the remaining **page sheets** in visual order.
3. **Drag to reorder** sheets — numbering recomputes live.
4. Tag a page sheet with a **special lamination effect** via right-click.
5. Choose between **folder-name** numbering and a **custom prefix**.
6. Click **Rename All** to apply the names to disk (collision-safe).

The operator always sees a **live preview** of each file's new name before
committing.

---

## 2. Naming rules (the contract)

Let `folder` = the order folder name (e.g. `256`). The `.jpg/.jpeg/.png/.psd`
extension is **never** part of the base name; it is preserved on disk.

| Role | Base name | Notes |
|------|-----------|-------|
| First sheet | `00` | A half-sheet. Exactly one. |
| Last sheet | `zz` | A half-sheet. Exactly one. |
| Page sheet (folder mode) | `<folder> (NN)` | `NN` = 2-digit, 1-based, in grid order: `256 (01)`, `256 (02)`… |
| Page sheet (custom mode) | `<custom>_NNN` | `NNN` = 3-digit: `page_001`, `page_002`… |
| Special-lamination page | `<pageBase>--------<Effect>` | 8 dashes; e.g. `256 (01)--------Glitter` |
| Cover pad | `ZZZ--<folder>--<Lamination>--<Size>--<N>+1` | uppercase `ZZZ`, `--` separators, literal `+1` |

### Cover-pad count `N`

`N = 1 + (number of page sheets, excluding 00, zz, and the cover pad)`.

Rationale: `00` and `zz` are two half-sheets that together count as **1** full
sheet; each page sheet counts as 1; the cover pad is the literal `+1`.

Example: folder `256`, lamination `Standard`, size `12x36`, with **30** page
sheets → `N = 1 + 30 = 31` → filename:

```
ZZZ--256--Standard--12x36--31+1
```

### Reordering

When a sheet is dragged to a new position, only the **page-sheet** sequence
numbers recompute (1-based over page sheets in the new order). `00`, `zz`, and
the cover pad keep their roles wherever they sit.

---

## 3. Architecture

```
┌──────────────────────────── Renderer (React) ────────────────────────────┐
│  RenamerPage (state: tiles, roles, effects, cover config, naming mode)    │
│    ├── FolderTree            (lazy, recursive folder nav)                 │
│    ├── RenamerToolbar        (Select First/Last/Cover, mode toggle, Rename)│
│    ├── DnD grid of SortableTile (thumbnail + live name + role/effect badge)│
│    ├── CoverPadDialog        (lamination + size + live name preview)      │
│    └── EffectContextMenu     (right-click special effects)                │
│                                                                           │
│  Pure logic:  lib/renamerNaming.ts   (no React, unit-tested)              │
│  Thumbnails:  <img src="media://image?p=<abs path>">                      │
└───────────────────────────────────────────────────────────────────────────┘
                         │  window.api.renamer.*  (typed IPC bridge)
┌──────────────────────────── Main process ────────────────────────────────┐
│  listOrderFolders()  listImages(folder)  applyRenames(folder, ops)        │
│  media:// protocol   →  serves local image bytes (path-constrained)       │
│                          PSD/PSB → embedded JPEG thumbnail                 │
└───────────────────────────────────────────────────────────────────────────┘
```

Principles:
- **Pure core, thin shell.** All naming is pure functions in `renamerNaming.ts`;
  the renderer holds UI state; the main process does file I/O.
- **Security boundary.** The image protocol only serves paths inside the
  configured albums root; renames only touch files inside the target folder.
- **Live preview.** Names are computed from UI state on every render; nothing is
  written until **Rename All**.

---

## 4. Pure naming module (`renamerNaming.ts`)

The heart of the feature — copy this verbatim into the new project.

```ts
export type SheetRole = 'first' | 'last' | 'cover' | 'page'

export interface NamingTile {
  path: string                 // absolute file path → becomes fromPath
  role: SheetRole              // default 'page'
  effect?: string | null       // special lamination, page sheets only
}

export interface CoverPadConfig { lamination: string; size: string }

export interface NamingInput {
  folderName: string
  tiles: NamingTile[]          // current grid order
  coverPad?: CoverPadConfig | null
  customPageName?: string | null   // set → "<custom>_NNN"; empty → "<folder> (NN)"
}

export interface RenameOp { fromPath: string; toBaseName: string }

export const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n))
export const pad3 = (n: number) => String(n).padStart(3, '0')

export const countPageSheets = (tiles: NamingTile[]) =>
  tiles.reduce((acc, t) => (t.role === 'page' ? acc + 1 : acc), 0)

export function coverPadBaseName(
  folderName: string, lamination: string, size: string, pageSheetCount: number
): string {
  const n = 1 + pageSheetCount
  return `ZZZ--${folderName}--${lamination}--${size}--${n}+1`
}

export function pageBaseName(
  folderName: string, sequence: number,
  effect?: string | null, customPageName?: string | null
): string {
  const custom = customPageName?.trim()
  const base = custom ? `${custom}_${pad3(sequence)}` : `${folderName} (${pad2(sequence)})`
  return effect ? `${base}--------${effect}` : base
}

export function computeAssignedNames(input: NamingInput) {
  const pageSheetCount = countPageSheets(input.tiles)
  let pageSeq = 0
  return input.tiles.map((tile) => {
    let baseName: string | null = null
    switch (tile.role) {
      case 'first': baseName = '00'; break
      case 'last':  baseName = 'zz'; break
      case 'cover':
        baseName = input.coverPad
          ? coverPadBaseName(input.folderName, input.coverPad.lamination,
                             input.coverPad.size, pageSheetCount)
          : null
        break
      case 'page':
        pageSeq += 1
        baseName = pageBaseName(input.folderName, pageSeq, tile.effect, input.customPageName)
        break
    }
    return { path: tile.path, baseName, role: tile.role }
  })
}

export function computeRenames(input: NamingInput): RenameOp[] {
  return computeAssignedNames(input)
    .filter((n): n is { path: string; baseName: string; role: SheetRole } => n.baseName !== null)
    .map((n) => ({ fromPath: n.path, toBaseName: n.baseName }))
}
```

`computeAssignedNames` drives the **live UI labels**; `computeRenames` produces
the **apply-to-disk** ops (omitting a cover tile that has no config yet).

---

## 5. Backend API (IPC contract)

Expose these on `window.api.renamer` (Electron `contextBridge` over
`ipcRenderer.invoke` → `ipcMain.handle`):

```ts
interface OrderFolder { name: string; path: string }
interface ImageItem {
  path: string; fileName: string; baseName: string; ext: string
  width: number; height: number      // pixels; 0 if unreadable
}
interface RenameOp { fromPath: string; toBaseName: string }
interface ApplyRenamesResult { ok: boolean; renamed: number; error?: string }

renamer.listImages(folderPath): Promise<ImageItem[]>          // include .psd/.psb here
renamer.applyRenames(folderPath, ops: RenameOp[]): Promise<ApplyRenamesResult>
renamer.mediaUrl(path): string   // pure helper → "media://image?p=<encodeURIComponent(path)>"
// (plus a folder-tree lister: fs.listDir(path) → { entries: {name, path, isDir}[] })
```

### `listImages` (main)
- Enumerate `.jpg/.jpeg/.png` and (for the Renamer) `.psd/.psb`.
- Read pixel dimensions with a pure-JS reader (e.g. `image-size`); on failure
  leave `width/height = 0`.
- Natural-sort by file name (so `(2)` precedes `(10)`).

### `applyRenames` (main) — collision-safe two-phase
Targets can collide with existing source names (e.g. swapping `00`↔`01`), so:
1. Filter ops to files **inside** `folderPath`; drop no-op renames.
2. **Phase 1:** move every source to a unique temp name
   (`.tmp-<stamp>-<i>-<rand><ext>`).
3. **Phase 2:** move each temp to `<toBaseName><originalExt>`.
4. Return the count. Preserve each file's original extension.

### `media://` protocol (main) — display local images under contextIsolation
- Register the scheme **privileged** (`supportFetchAPI, stream, secure`,
  `bypassCSP`) **before** app ready; add `media:` to the renderer CSP `img-src`.
- Handler: parse `?p=`, `decodeURIComponent`, **reject paths outside the albums
  root** (403), then:
  - `.psd/.psb` → return the embedded JPEG thumbnail (see §7); 404 if none.
  - otherwise → `net.fetch(pathToFileURL(path))`.

---

## 6. UI behavior

**Layout:** resizable left folder tree (remembered width) + workspace grid.

**Pick modes:** clicking `Select First/Last/Cover` arms a mode; the next tile
click assigns that role (uniqueness enforced — assigning a role demotes the
previous holder back to `page`). Selecting the cover opens the **Cover Pad
dialog**.

**Cover Pad dialog:** radio list of lamination types + a size dropdown
(pre-selected from the image's detected `WxH` when it matches a standard size,
else the first standard size, with override), and a **live preview** of the
resulting `ZZZ--…--N+1` name. Apply commits the `cover` role + config.

**Naming mode toggle + box:** ON = folder name (`256 (01)`); OFF = enable the
text box, type `page` → `page_001`. The live tile labels update instantly.

**Drag reorder:** use a sortable DnD lib (e.g. `@dnd-kit/sortable`) keyed by file
path; on drop, reorder the tiles array → numbering recomputes via
`computeAssignedNames`.

**Right-click effects:** on a `page` tile only, show a menu of configured
effects + "Clear effect"; sets `tile.effect`.

**Rename All:** `computeRenames(...)` → `renamer.applyRenames(folder, ops)` →
on success reload the folder; surface errors.

**Tiles** show: thumbnail (object-contain), the **live base name**, the original
file name, and badges (`00` / `zz` / `COVER` / effect).

---

## 7. PSD/PSB thumbnails

Browsers can't render PSD in `<img>`. Photoshop embeds a JPEG preview in the
file's **Image Resources** section (resource id `1036`, `kJpegRGB`). Extract it
without decoding the whole file:

1. Read the 26-byte header; verify signature `8BPS`.
2. Skip Color Mode Data: `len(4) + data`.
3. Read Image Resources: `len(4)`, then scan `8BIM` blocks for id `1036`
   (or legacy `1033`).
4. In the thumbnail resource, skip the 28-byte header → the remaining bytes are
   the JPEG. Return them.

Serve those bytes as `image/jpeg` from the `media://` handler. In the renderer,
use an `<img>` wrapper with an **onError fallback** to a "PSD" placeholder so
files saved without "Maximize Compatibility" (no thumbnail) degrade gracefully.

---

## 8. Edge cases

- **Empty folder / no images:** show a friendly empty state.
- **Cover with no config:** its name is `null` and it is omitted from
  `applyRenames` until configured.
- **Custom name empty/whitespace:** treated as folder-name mode.
- **Odd page counts / reorder:** numbering is always contiguous `1..N` over
  page sheets in grid order.
- **Name collisions on apply:** handled by the two-phase temp rename.
- **Unreadable image dimensions:** `0×0`; size dropdown defaults to first
  standard size.
- **Path traversal:** media protocol + renames are constrained to the
  albums/order folder.

---

## 9. Correctness properties (suggested tests)

1. First→`00`, last→`zz`; page sheets are `1..N` contiguous in grid order.
2. Cover name = `ZZZ--<folder>--<lam>--<size>--<1+pageCount>+1` (literal `+1`).
   Verify the canonical example `256/Standard/12x36/30 → ...--31+1`.
3. Custom mode → `<custom>_NNN` (3-digit); folder mode → `<folder> (NN)` (2-digit).
4. Effect appends `--------<Effect>` to the page base.
5. Reordering renumbers contiguously; roles are preserved.
6. A cover tile with no config yields `null` / is omitted from ops.
7. `applyRenames` is collision-safe (swap `00`↔`01` succeeds).

The pure module makes 1–6 trivial unit tests (no Electron, no filesystem).

---

## 10. Dependencies (reference implementation)

- `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` — drag reorder
- `image-size` — pure-JS pixel dimensions (no native build)
- Electron `protocol.handle` + `net.fetch` — local image serving
- (no image library needed for PSD thumbnails — raw resource parse)

---

## 11. Porting checklist

- [ ] Copy `renamerNaming.ts` and its tests.
- [ ] Implement `listImages` (+ PSD inclusion) and `applyRenames` (two-phase).
- [ ] Register the `media://` protocol (privileged + CSP + path guard + PSD thumb).
- [ ] Build the folder tree, toolbar, sortable grid, cover dialog, effect menu.
- [ ] Wire the live-preview labels from `computeAssignedNames`.
- [ ] Provide the configurable lists: lamination types, standard sizes, effects.
```
