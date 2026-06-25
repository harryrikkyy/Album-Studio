const { ipcRenderer } = require('electron')

const fakeDoc = {
  layers: [],
  activeLayers: [],
  width: 0,
  height: 0,
  id: 1
}

module.exports = {
  app: {
    showAlert: (msg) => alert(msg),
    activeDocument: null,
    open: async (fileObj) => {
      const filePath = fileObj.nativePath || fileObj
      await ipcRenderer.invoke('open-in-photoshop', filePath)
      const doc = Object.assign({}, fakeDoc, { id: Date.now() })
      module.exports.app.activeDocument = doc
      return {
        ...doc,
        duplicate: async (name) => {
          module.exports.app.activeDocument = Object.assign({}, fakeDoc)
          return module.exports.app.activeDocument
        }
      }
    }
  },
  core: {
    executeAsModal: async (fn) => {
      try { await fn() } catch(e) { alert('Error: ' + e.message) }
    }
  },
  action: {
    batchPlay: async (actions) => {
      // batchPlay is now handled per-operation via dedicated IPC handlers
      return []
    }
  }
}