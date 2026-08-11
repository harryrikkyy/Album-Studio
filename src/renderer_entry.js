// renderer_entry.js — esbuild entry for the main-window bundle
// (dist/renderer.bundle.js). Preserves the load order of the old
// <script> tags in index.html; each file is standalone (no cross-file
// top-level globals), so bundling them as modules is behavior-identical.
require('./theme')
// Icon hydration first: <i data-icn> markers become inline SVGs before any
// module reads/clones chrome markup. Script runs at end of body, DOM is ready.
require('./ui_icons').hydrate(document)
require('./main')
require('./ui_tilt')
require('./ui_layout')
require('./ui_folders')
require('./ui_license_badge')
