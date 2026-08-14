// Shared domain types — the core shapes the renderer + main process pass around.
// Type-only (.d.ts): never imported at runtime, purely for `tsc` checking via
// JSDoc `import('...')` references. Intentionally permissive today (the objects
// are dynamic); tighten field-by-field as modules migrate to strict types.

export interface Frame {
  name: string
  x: number
  y: number
  w: number
  h: number
}

export interface Template {
  id?: string
  name?: string
  url?: string
  folderId?: string
  file?: unknown
  h?: number
  v?: number
  _generative?: boolean
  _spec?: unknown
  _canvas?: { w: number; h: number }
  _frames?: Frame[]
  /** The template's real PSD layer tree, cached alongside the frames. */
  _psdLayers?: unknown[]
}

export interface Photo {
  id?: string
  orient?: string
  url?: string
  filePath?: string
  baseName?: string
  rotation?: number
  adjust?: unknown
  placement?: unknown
  folderId?: string
}

export interface Page {
  template?: Template | null
  photos?: Photo[]
}

/** The minimal per-photo reference stored in an undo/redo snapshot. */
export interface PhotoRef {
  id?: string
  orient?: string
}

/** A page compacted for the undo/redo stack (skeleton, no heavy fields). */
export interface CompactPage {
  template: null | { id?: string; generative?: boolean; spec?: unknown }
  photos: PhotoRef[]
}

/**
 * The persisted workspace: folder-token lists + per-photo edit maps. This is
 * what localStorage `adt_workspace` and the saved project `.json` carry.
 * Loaded data may pre-date a field, so consumers guard with `|| {}` / `|| []`.
 */
/**
 * A per-page override of one template PSD layer. `dx`/`dy` are canvas-pixel
 * offsets and `sx`/`sy` scale multipliers relative to the layer's own bounds,
 * so they map straight onto Photoshop's translate()/resize() at export.
 */
export interface LayerEdit {
  hidden?: boolean
  opacity?: number
  dx?: number
  dy?: number
  sx?: number
  sy?: number
}

export interface ProjectData {
  imageTokens?: unknown[]
  templateTokens?: unknown[]
  wallpaperTokens?: unknown[]
  pngTokens?: unknown[]
  maskTokens?: unknown[]
  highResTokens?: unknown[]
  wpHighResTokens?: unknown[]
  outputToken?: unknown
  imageRotations?: Record<string, number>
  imageAdjustments?: Record<string, unknown>
  imagePlacements?: Record<string, unknown>
  /**
   * Page-level edits, keyed by page number. The per-photo maps above are keyed
   * by photo id so they follow a photo between pages; overlays and background
   * belong to the page itself.
   */
  pageOverlays?: Record<number, unknown[]>
  pageBackgrounds?: Record<number, string>
  /** Per-page overrides of the template's own PSD layers (hide/show, opacity). */
  pageLayerEdits?: Record<number, Record<string, LayerEdit>>
}

/**
 * One undo/redo stack entry: the compact structural snapshot of the undoable
 * core taken by _historySnapshot before each mutate().
 */
export interface HistorySnapshot {
  label: string
  albumPages: Record<string, CompactPage>
  totalActivePages: number
  imageRotations: Record<string, number>
  currentPage: number
}

/** The subset of a page that feeds the render-cache hash. */
export interface HashablePage {
  templatePath?: string
  photos: Photo[]
  /** Page overlay layers — baked into the output, so they affect the hash. */
  overlays?: unknown[] | null
  pageBackground?: string | null
  /**
   * Template canvas size, when the frame-extraction cache has it. Used only to
   * rasterize overlays at the page's true resolution for the Photoshop build.
   */
  canvasWidth?: number | null
  canvasHeight?: number | null
  /** Per-page overrides of the template's own PSD layers. */
  layerEdits?: Record<string, LayerEdit> | null
  /** The template's layer tree — only needed to translate layer ids. */
  psdLayers?: unknown[] | null
}

/** Progress counters for the render batch currently being worked. */
export interface RenderStats {
  total: number
  done: number
  skipped: number
  failed: number
  cancelled: boolean
}

/** buildExportData's product: the page range queueRender consumes. */
export interface ExportData {
  outputPath: string
  pages: Record<string, HashablePage>
}

/** One unit of work in the render queue. */
export interface RenderJob {
  pageNum: number
  outputPath: string
  pageData: HashablePage
}
