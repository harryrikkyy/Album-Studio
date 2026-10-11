// collect-backend.mjs — what the background helper needs at run time, for packaging: every
// JavaScript file reachable by require() from native/backend/server.js (its own code and the
// shared modules in src/), and the npm packages they use with their dependencies.
//
//   node native/scripts/collect-backend.mjs   → JSON { files: [...repo-relative], packages: [...] }
//
// Static: lazily required files count too (a require inside a function still ships). `electron`
// is never packaged, should an old module still mention it.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const ENTRY = join(ROOT, 'native/backend/server.js')
const SKIP = new Set(['electron'])
const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))

function resolveFile(base) {
  for (const c of [base, `${base}.js`, `${base}.json`, join(base, 'index.js')]) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

// Files read at run time rather than required: the licence verification key.
const DATA = ['src/license_public_key.pem']

const files = new Set(DATA.map((f) => join(ROOT, f)))
const packages = new Set()
const queue = [ENTRY]
while (queue.length) {
  const file = queue.pop()
  if (files.has(file)) continue
  files.add(file)
  if (!file.endsWith('.js')) continue
  const src = readFileSync(file, 'utf8')
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1]
    if (BUILTIN.has(spec) || BUILTIN.has(spec.split('/')[0])) continue
    if (spec.startsWith('.')) {
      const hit = resolveFile(resolve(dirname(file), spec))
      if (hit && !relative(ROOT, hit).startsWith('node_modules')) queue.push(hit)
    } else {
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (!SKIP.has(name)) packages.add(name)
    }
  }
}

// Dependency closure of the packages (installed optional ones too: sharp's platform binaries).
const closure = new Set()
const pending = [...packages]
while (pending.length) {
  const name = pending.pop()
  if (closure.has(name) || SKIP.has(name)) continue
  const pj = join(ROOT, 'node_modules', name, 'package.json')
  if (!existsSync(pj)) continue
  closure.add(name)
  const meta = JSON.parse(readFileSync(pj, 'utf8'))
  for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) {
    if (existsSync(join(ROOT, 'node_modules', dep, 'package.json'))) pending.push(dep)
  }
}

process.stdout.write(JSON.stringify({ files: [...files].map((f) => relative(ROOT, f)).sort(), packages: [...closure].sort() }, null, 1))
