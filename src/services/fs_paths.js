// @ts-check
// services/fs_paths.js — the renderer's folder/paths service, replacing the
// old UXP storage.localFileSystem stubs (Phase 2). Folder "entries" keep the
// UXP-era object shape ({ name, nativePath, isFolder/isFile, url,
// getEntries, getEntry }) because every loader engine consumes it. A folder
// "token" is simply the folder's absolute path — the name survives from the
// UXP API and is kept because saved projects persist tokens (outputToken,
// imageTokens, …) that must keep working.

const nodefs = require('fs')
const path = require('path')

/**
 * @typedef {object} FolderEntry
 * @property {string} name
 * @property {string} nativePath
 * @property {boolean} isFolder
 * @property {boolean} isFile
 * @property {string} [url]
 * @property {() => Promise<FolderEntry[]>} getEntries
 * @property {(subName: string) => Promise<FolderEntry>} getEntry
 */

/**
 * Wrap an absolute folder path in the entry object the loaders consume.
 * Async, no statSync per-entry — uses dirent for type detection. (The old
 * UXP-era version did a sync readdir + a sync stat per item, which froze
 * the renderer thread for the duration of any folder load.)
 * @param {string} folderPath
 * @returns {FolderEntry}
 */
function folderEntry(folderPath) {
  return {
    name: path.basename(folderPath),
    nativePath: folderPath,
    isFolder: true,
    isFile: false,
    getEntries: async () => {
      const items = await nodefs.promises.readdir(folderPath, { withFileTypes: true })
      return items.map(d => {
        const fullPath = path.join(folderPath, d.name)
        if (d.isDirectory()) return folderEntry(fullPath)
        return {
          name: d.name,
          nativePath: fullPath,
          isFile: true,
          isFolder: false,
          url: 'file://' + fullPath,
          getEntries: async () => { throw new Error('Not a folder: ' + fullPath) },
          getEntry: async () => { throw new Error('Not a folder: ' + fullPath) },
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
      return folderEntry(subPath)
    }
  }
}

/**
 * @param {(channel: string, ...args: any[]) => Promise<any>} invoke IPC invoke
 */
function createFsPaths(invoke) {
  return {
    folderEntry,

    /** Native folder picker → FolderEntry (null when cancelled). */
    pickFolder: async () => {
      const folderPath = await invoke('pick-folder')
      return folderPath ? folderEntry(folderPath) : null
    },

    /** @param {FolderEntry} folder */
    tokenForFolder: async (folder) => folder.nativePath,

    /** Resolve a persisted token back to an entry (null if it no longer exists). */
    entryForToken: async (/** @type {string} */ token) => {
      if (!nodefs.existsSync(token)) return null
      return folderEntry(token)
    },
  }
}

module.exports = { createFsPaths, folderEntry }
