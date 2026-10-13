const fs = require('fs')
const path = require('path')
const Module = require('module')
const { execFileSync } = require('child_process')
const root = '/Volumes/Harry/works/albumStudio-photocraft'
const filename = path.join(root, 'native/backend/lib/psd_template.js')
const code = execFileSync('git', ['show', 'HEAD:native/backend/lib/psd_template.js'], { cwd: root, encoding: 'utf8' })
const previous = new Module(filename)
previous.filename = filename
previous.paths = Module._nodeModulePaths(path.dirname(filename))
previous._compile(code, filename)
require.cache[filename] = previous
