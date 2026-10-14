'use strict'
const Module = require('module'), path = require('path'), cp = require('child_process')
const repo = process.cwd(), original = Module._extensions['.js']
const files = new Set(['album','jobs','sheets','render','deliver','proofs','storage'].map(name => path.join(repo, 'native/backend/lib', `${name}.js`)))
Module._extensions['.js'] = (module, filename) => {
  if (!files.has(filename)) return original(module, filename)
  const relative = path.relative(repo, filename)
  module._compile(cp.execFileSync('git', ['show', `d6c1501:${relative}`], { cwd: repo, encoding: 'utf8' }), filename)
}
