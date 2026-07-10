// tools_bar_preload.js — bridge for the floating tools-bar window.
//
// Runs in an isolated preload context (contextIsolation:true, nodeIntegration:
// false) with Node access, and exposes ONLY the tools-bar IPC channels over a
// frozen contextBridge surface. The renderer can no longer `require('electron')`
// or reach any Node module directly.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('toolsBarAPI', {
  setHeight: (px) => ipcRenderer.invoke('tools-bar-set-height', px),
  setInteractive: (interactive) => ipcRenderer.invoke('tools-bar-set-interactive', interactive),
  close: () => ipcRenderer.invoke('tools-bar-close'),
  listActions: (opts) => ipcRenderer.invoke('actions-list', opts),
  runAction: (payload) => ipcRenderer.invoke('actions-run', payload),
  swapImages: () => ipcRenderer.invoke('swap-images'),
  exportOpenDocs: (scope) => ipcRenderer.invoke('export-open-docs', scope),
})
