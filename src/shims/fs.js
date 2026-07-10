// @ts-check
// shims/fs.js — what `require('fs')` resolves to inside the bundled
// main-window renderer (esbuild --alias). Exactly the slice of fs the
// renderer modules use, delegating to the preload bridge. Stats and dirents
// cross the bridge as plain objects and are re-wrapped to node's method
// shape here.

const nfs = () => /** @type {any} */ (window).native.fs

const wrapDirent = (/** @type {{name: string, isDirectory: boolean, isFile: boolean}} */ d) => ({
  name: d.name,
  isDirectory: () => d.isDirectory,
  isFile: () => d.isFile,
})

module.exports = {
  existsSync: (/** @type {string} */ p) => nfs().existsSync(p),
  statSync: (/** @type {string} */ p) => {
    const s = nfs().statSync(p)
    return { ...s, isDirectory: () => s.isDirectory, isFile: () => s.isFile }
  },
  readdirSync: (/** @type {string} */ p, /** @type {{withFileTypes?: boolean}} */ opts) => (opts && opts.withFileTypes)
    ? nfs().readdirSyncTypes(p).map(wrapDirent)
    : nfs().readdirSync(p),
  rmSync: (/** @type {string} */ p, /** @type {object} */ opts) => nfs().rmSync(p, opts),
  promises: {
    readdir: (/** @type {string} */ p, /** @type {{withFileTypes?: boolean}} */ opts) => (opts && opts.withFileTypes)
      ? nfs().readdirTypes(p).then((/** @type {any[]} */ ds) => ds.map(wrapDirent))
      : nfs().readdir(p),
    access: (/** @type {string} */ p) => nfs().access(p),
    // Bridge extension (not a real node API): read the first maxLen bytes.
    // photo_sources uses it for EXIF sniffing when bundled.
    readFileSlice: (/** @type {string} */ p, /** @type {number} */ maxLen) => nfs().readFileSlice(p, maxLen),
  },
}
