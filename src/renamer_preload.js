// renamer_preload.js — bridge for the Renamer window.
//
// Runs in an isolated preload context (contextIsolation:true, nodeIntegration:
// false) with Node access, and exposes ONLY the four renamer IPC channels plus
// the pure naming functions over a frozen contextBridge surface. The renderer
// can no longer `require('electron')` or reach any Node module directly.
// contextBridge deep-clones arguments/results, which is fine here: the naming
// module takes and returns plain data.
const { contextBridge, ipcRenderer } = require('electron')
const naming = require('./renamer_naming')

contextBridge.exposeInMainWorld('renamerAPI', {
  pickFolder: () => ipcRenderer.invoke('renamer-pick-folder'),
  listDir: (dirPath) => ipcRenderer.invoke('renamer-list-dir', dirPath),
  listImages: (dirPath) => ipcRenderer.invoke('renamer-list-images', dirPath),
  applyRenames: (payload) => ipcRenderer.invoke('renamer-apply-renames', payload),
  naming: {
    computeAssignedNames: (input) => naming.computeAssignedNames(input),
    countPageSheets: (tiles) => naming.countPageSheets(tiles),
    coverPadBaseName: (folderName, lamination, size, pageCount) =>
      naming.coverPadBaseName(folderName, lamination, size, pageCount),
    computeRenames: (input) => naming.computeRenames(input),
  },
})
