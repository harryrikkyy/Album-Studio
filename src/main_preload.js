// main_preload.js — bridge for the main app window.
//
// Runs in an isolated preload context (contextIsolation:true,
// nodeIntegration:false, sandbox:false so this file can use node's fs) and
// exposes the narrow `native` surface the bundled renderer consumes through
// its require() shims (src/shims/*): allowlisted IPC, a small file-system
// API, and a couple of environment facts. The renderer itself has no Node
// access — the esbuild bundle's `fs`/`os`/`electron` imports resolve to the
// shims, which all land here.
const { contextBridge, ipcRenderer } = require('electron')
const fs = require('fs')
const os = require('os')

// Every invoke channel the main process registers (mirror of the registry in
// src/shared/ipc.d.ts). A renamed or new channel must be added here or the
// renderer's call is rejected.
const INVOKE_CHANNELS = new Set([
  'actions-list', 'actions-run', 'bake-adjusted-source', 'batch-thumbnails',
  'build-page', 'build-pages-batch', 'check-license', 'curation-analyze',
  'curation-curate', 'curation-export', 'editor-apply', 'editor-get-spread',
  'editor-goto', 'editor-open', 'editor-swap', 'export-album',
  'export-open-docs', 'export-proof-gallery', 'extract-template-frames',
  'generative-catalog', 'generative-regen', 'get-license', 'google-sign-in',
  'inject-photo', 'jpeg-export', 'launch-app', 'library-add',
  'library-delete-layout', 'library-list', 'library-load-layout',
  'library-remove', 'library-save-layout', 'open-external',
  'open-in-photoshop', 'pick-file-open', 'pick-file-save', 'pick-folder',
  'place-clipped', 'place-masked-frame', 'place-png-frame', 'place-wallpaper',
  'plugins-list', 'plugins-reload', 'plugins-set-enabled',
  'project-pick-open', 'project-pick-save', 'project-read', 'project-write',
  'quit-app', 'renamer-apply-renames', 'renamer-list-dir',
  'renamer-list-images', 'renamer-open', 'renamer-pick-folder',
  'renamer-status', 'render-final-composite', 'render-proof',
  'render-proofs-batch', 'resize-psds', 'run-jsx', 'sign-out', 'swap-images',
  'telemetry-event', 'telemetry-paths', 'thumbnails-generate',
  'tools-bar-close', 'tools-bar-open', 'tools-bar-set-height',
  'tools-bar-set-interactive', 'tools-bar-status'
])

const SEND_CHANNELS = new Set(['start-native-drag'])

// Push channels the main process sends TO this window.
const ON_CHANNELS = new Set([
  'curation-progress', 'editor-changes', 'editor-goto', 'editor-swap',
  'jpeg-export-progress', 'proof-progress', 'resize-psds-progress',
  'thumbs-progress',
])

/** @param {Set<string>} allow @param {string} channel */
function check(allow, channel) {
  if (!allow.has(channel)) throw new Error(`[preload] channel not allowed: ${channel}`)
}

const plainDirent = (d) => ({ name: d.name, isDirectory: d.isDirectory(), isFile: d.isFile() })

contextBridge.exposeInMainWorld('native', {
  invoke: (channel, ...args) => { check(INVOKE_CHANNELS, channel); return ipcRenderer.invoke(channel, ...args) },
  send: (channel, ...args) => { check(SEND_CHANNELS, channel); ipcRenderer.send(channel, ...args) },
  on: (channel, cb) => {
    check(ON_CHANNELS, channel)
    // The raw IpcRendererEvent never crosses into the main world.
    ipcRenderer.on(channel, (_e, ...args) => cb(...args))
  },

  // The file-system slice the renderer actually uses (see src/shims/fs.js).
  // contextBridge calls are synchronous, so the *Sync variants behave like
  // node's. Stats and dirents cross the bridge as plain objects.
  fs: {
    existsSync: (p) => fs.existsSync(p),
    statSync: (p) => { const s = fs.statSync(p); return { isDirectory: s.isDirectory(), isFile: s.isFile(), size: s.size, mtimeMs: s.mtimeMs } },
    readdirSync: (p) => fs.readdirSync(p),
    readdirSyncTypes: (p) => fs.readdirSync(p, { withFileTypes: true }).map(plainDirent),
    rmSync: (p, opts) => fs.rmSync(p, { recursive: !!(opts && opts.recursive), force: !!(opts && opts.force) }),
    readdir: (p) => fs.promises.readdir(p),
    readdirTypes: async (p) => (await fs.promises.readdir(p, { withFileTypes: true })).map(plainDirent),
    access: (p) => fs.promises.access(p),
    // Read the first maxLen bytes of a file (EXIF sniffing). Returns a
    // Uint8Array — structured clone keeps it a typed array in the main world.
    readFileSlice: async (p, maxLen) => {
      const handle = await fs.promises.open(p, 'r')
      try {
        const buf = Buffer.alloc(maxLen)
        const { bytesRead } = await handle.read(buf, 0, maxLen, 0)
        return new Uint8Array(buf.buffer, 0, bytesRead)
      } finally {
        await handle.close()
      }
    },
  },

  paths: { tmpdir: os.tmpdir() },
  // Set only when the (non-packaged) main process launched us with --e2e.
  isE2E: process.argv.includes('--e2e'),
})
