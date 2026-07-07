// editor_preload.js — bridge for the Spread Editor window.
//
// Runs in an isolated preload context (contextIsolation:true, nodeIntegration:
// false) with Node access, and exposes ONLY the handful of IPC channels the
// editor renderer needs over a frozen contextBridge surface. The renderer can
// no longer `require('electron')` or reach any Node module directly, which
// closes the main-world RCE surface while keeping the exact same behavior.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('editorAPI', {
  // main → get the current spread payload the main app pushed for editing.
  getSpread: () => ipcRenderer.invoke('editor-get-spread'),
  // editor → main: navigate to another spread (main rebuilds + pushes back).
  goto: (msg) => ipcRenderer.invoke('editor-goto', msg),
  // editor → main: swap two photos between frames on the current page.
  swap: (msg) => ipcRenderer.invoke('editor-swap', msg),
  // editor → main: persist placement/adjustment changes for the current page.
  apply: (msg) => ipcRenderer.invoke('editor-apply', msg),
  // main → editor: a fresh spread payload is available; the renderer re-pulls
  // via getSpread(). The payload is intentionally not forwarded — the renderer
  // ignores it today and re-invokes getSpread() — and the raw IpcRendererEvent
  // is never exposed to the main world.
  onSpreadUpdated: (cb) => {
    ipcRenderer.on('editor-spread-updated', () => { cb() })
  },
})
