// The IPC contract — the single source of truth for every channel the app
// passes between windows and the main process. Type-only (.d.ts): never loaded
// at runtime; it exists so `tsc` can check invoke/handle call sites as they
// migrate to typed wrappers.
//
// Coverage today: channels with characterization tests are typed precisely;
// the rest are `Loose` (args/result unknown) and tightened over time — usually
// when a handler moves into its feature module in the state-store refactor.

import type { Template } from './domain'

/** A channel not yet precisely typed. Every real channel is still listed, so
 *  this file stays the exhaustive registry of valid channel names. */
export type Loose = { args: unknown[]; result: unknown }

type Ok<T> = ({ ok: true } & T) | { ok: false; error?: string }

/** Renderer → main, request/response (ipcRenderer.invoke / ipcMain.handle). */
export interface IpcInvokeMap {
  // ── typed (have tests) ─────────────────────────────────────────────────────
  'generative-catalog': { args: []; result: Ok<{ templates: Template[] }> }
  'generative-regen': { args: [spec: unknown]; result: Ok<{ template: Template }> }
  'project-write': { args: [projectPath: string, payload: unknown]; result: Ok<{ path: string }> }
  'project-read': { args: [pathInput: string]; result: Ok<{ data: unknown; projectPath: string }> }
  'library-list': { args: []; result: Ok<{ library: unknown; dir: string }> }
  'open-external': { args: [url: string]; result: unknown }
  'telemetry-event': { args: [name: string, fields?: Record<string, unknown>]; result: unknown }

  // ── not yet typed (tighten as handlers migrate) ────────────────────────────
  'actions-list': Loose
  'actions-run': Loose
  'bake-adjusted-source': Loose
  'batch-thumbnails': Loose
  'build-page': Loose
  'build-pages-batch': Loose
  'check-license': Loose
  'curation-analyze': Loose
  'curation-curate': Loose
  'curation-export': Loose
  'editor-apply': Loose
  'editor-get-spread': Loose
  'editor-goto': Loose
  'editor-open': Loose
  'editor-swap': Loose
  'export-album': Loose
  'export-open-docs': Loose
  'export-proof-gallery': Loose
  'extract-template-frames': Loose
  'get-license': Loose
  'google-sign-in': Loose
  'inject-photo': Loose
  'jpeg-export': Loose
  'launch-app': Loose
  'library-add': Loose
  'library-delete-layout': Loose
  'library-load-layout': Loose
  'library-remove': Loose
  'library-save-layout': Loose
  'open-in-photoshop': Loose
  'pick-file-open': Loose
  'pick-file-save': Loose
  'pick-folder': Loose
  'place-clipped': Loose
  'place-masked-frame': Loose
  'place-png-frame': Loose
  'place-wallpaper': Loose
  'plugins-list': Loose
  'plugins-reload': Loose
  'plugins-set-enabled': Loose
  'project-pick-open': Loose
  'project-pick-save': Loose
  'quit-app': Loose
  'renamer-apply-renames': Loose
  'renamer-list-dir': Loose
  'renamer-list-images': Loose
  'renamer-open': Loose
  'renamer-pick-folder': Loose
  'renamer-status': Loose
  'render-final-composite': Loose
  'render-proof': Loose
  'render-proofs-batch': Loose
  'resize-psds': Loose
  'run-jsx': Loose
  'sign-out': Loose
  'swap-images': Loose
  'telemetry-paths': Loose
  'thumbnails-generate': Loose
  'tools-bar-close': Loose
  'tools-bar-open': Loose
  'tools-bar-set-height': Loose
  'tools-bar-set-interactive': Loose
  'tools-bar-status': Loose
}

export type IpcInvokeChannel = keyof IpcInvokeMap

/** Renderer → main, fire-and-forget (ipcRenderer.send / ipcMain.on). */
export interface IpcSendMap {
  'start-native-drag': { args: [paths: string[]] }
}
export type IpcSendChannel = keyof IpcSendMap

/** Main → renderer push (webContents.send / ipcRenderer.on). */
export type IpcPushChannel =
  | 'curation-progress'
  | 'jpeg-export-progress'
  | 'resize-psds-progress'
  | 'proof-progress'
  | 'thumbs-progress'
  | 'editor-changes'
  | 'editor-goto'
  | 'editor-swap'
  | 'editor-spread-updated'
