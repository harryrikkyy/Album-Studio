// @ts-check
// shims/electron.js — what `require('electron')` resolves to inside the
// bundled main-window renderer (esbuild --alias). Delegates to the
// allowlisted `native` bridge exposed by src/main_preload.js, so every
// existing ipcRenderer call site works unchanged with no Node access.

module.exports = {
  ipcRenderer: {
    invoke: (/** @type {string} */ channel, /** @type {any[]} */ ...args) => /** @type {any} */ (window).native.invoke(channel, ...args),
    send: (/** @type {string} */ channel, /** @type {any[]} */ ...args) => /** @type {any} */ (window).native.send(channel, ...args),
    // Renderer listeners keep their (event, ...args) signature; the event is
    // a stub — the preload never forwards the real IpcRendererEvent.
    on: (/** @type {string} */ channel, /** @type {Function} */ listener) => /** @type {any} */ (window).native.on(channel, (/** @type {any[]} */ ...args) => listener({ channel }, ...args)),
  },
}
