// build.mjs — bundles the interface for the shell's web view: src/main.tsx → dist/app.js + app.css.
// `--watch` rebuilds on change (reload the window with ⌘R in development builds).

import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/main.tsx'],
  outdir: 'dist',
  entryNames: 'app',
  bundle: true,
  format: 'iife',
  target: ['safari15'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  sourcemap: true,
  minify: !watch,
  legalComments: 'linked',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
} else {
  await esbuild.build(options)
}
