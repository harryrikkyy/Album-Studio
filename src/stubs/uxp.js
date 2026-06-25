const { ipcRenderer } = require('electron')
const nodefs = require('fs')
const path = require('path')

function buildFolderObject(folderPath) {
  return {
    name: path.basename(folderPath),
    nativePath: folderPath,
    isFolder: true,
    isFile: false,
    // Async, no statSync per-entry — uses dirent for type detection.
    // The previous version did a sync readdir + a sync stat per item, which
    // froze the renderer thread for the duration of any folder load.
    getEntries: async () => {
      const items = await nodefs.promises.readdir(folderPath, { withFileTypes: true })
      return items.map(d => {
        const fullPath = path.join(folderPath, d.name)
        if (d.isDirectory()) return buildFolderObject(fullPath)
        return {
          name: d.name,
          nativePath: fullPath,
          isFile: true,
          isFolder: false,
          url: 'file://' + fullPath
        }
      })
    },
    getEntry: async (subName) => {
      const subPath = path.join(folderPath, subName)
      try {
        await nodefs.promises.access(subPath)
      } catch (_) {
        throw new Error('Not found: ' + subName)
      }
      return buildFolderObject(subPath)
    }
  }
}

module.exports = {
  storage: {
    localFileSystem: {
      getFolder: async () => {
        const folderPath = await ipcRenderer.invoke('pick-folder')
        if (!folderPath) return null
        return buildFolderObject(folderPath)
      },
      createPersistentToken: async (folder) => folder.nativePath,
      getEntryForToken: async (token) => {
        if (!nodefs.existsSync(token)) return null
        return buildFolderObject(token)
      },
      
      getEntryForPersistentToken: async (token) => {
        if (!nodefs.existsSync(token)) return null
        return buildFolderObject(token)
      },


      getFileForSaving: async (defaultName) => {
        const filePath = await ipcRenderer.invoke('pick-file-save', defaultName)
        if (!filePath) return null
        return {
            write: (content) => nodefs.writeFileSync(filePath, content, 'utf8'),
            nativePath: filePath
        }
        },
        getFileForOpening: async () => {
        const filePath = await ipcRenderer.invoke('pick-file-open')
        if (!filePath) return null
        return {
            read: () => nodefs.readFileSync(filePath, 'utf8'),
            nativePath: filePath
        }
        },

    }
  }
}