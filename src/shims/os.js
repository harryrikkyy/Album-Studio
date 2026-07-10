// @ts-check
// shims/os.js — what `require('os')` resolves to inside the bundled
// main-window renderer (esbuild --alias).

module.exports = {
  tmpdir: () => /** @type {any} */ (window).native.paths.tmpdir,
}
