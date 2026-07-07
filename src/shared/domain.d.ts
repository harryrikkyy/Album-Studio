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
  _generative?: boolean
  _spec?: unknown
  _canvas?: { w: number; h: number }
  _frames?: Frame[]
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

/** The subset of a page that feeds the render-cache hash. */
export interface HashablePage {
  templatePath?: string
  photos: Photo[]
}

/** One unit of work in the render queue. */
export interface RenderJob {
  pageNum: number
  outputPath: string
  pageData: HashablePage
}
