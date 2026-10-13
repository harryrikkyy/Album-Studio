// Publish a completed directory on the same filesystem, without replacing an older result.
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdtempSync, openSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const present = (path) => { try { lstatSync(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }

function exclusiveRename(from, to) {
  const dir = mkdtempSync(join(tmpdir(), 'album-studio-publish-'))
  const binary = join(dir, 'rename-exclusive')
  const source = fileURLToPath(new URL('./rename-exclusive.c', import.meta.url))
  try {
    const compiled = spawnSync('cc', ['-O2', '-Wall', '-Wextra', '-Werror', source, '-o', binary], { encoding: 'utf8', timeout: 60_000 })
    if (compiled.error || compiled.status !== 0) throw new Error(`Atomic publisher requires the platform C compiler: ${compiled.error?.message || compiled.stderr}`)
    const result = spawnSync(binary, [from, to], { encoding: 'utf8', timeout: 20_000 })
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr.trim())
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

export function publishNewDirectory(staging, destination) {
  const from = resolve(staging), to = resolve(destination)
  if (!lstatSync(from).isDirectory()) throw new Error('Publication source must be a real directory.')
  const fromReal = realpathSync(from)
  const parent = realpathSync(dirname(to))
  if (fromReal === to || !relative(fromReal, parent).startsWith('..')) throw new Error('Publication destination must be outside the staging directory.')
  if (statSync(from).dev !== statSync(parent).dev) throw new Error('Atomic publication requires staging and destination on the same filesystem.')
  const key = createHash('sha256').update(join(parent, basename(to))).digest('hex').slice(0, 24)
  const lock = join(parent, `.album-studio-publish-${key}.lock`)
  let fd
  try { fd = openSync(lock, 'wx', 0o600) } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another publication or an interrupted publication owns ${lock}. Inspect it before retrying.`)
    throw error
  }
  const ownLock = statSync(lock)
  try {
    writeFileSync(fd, JSON.stringify({ schema: 1, pid: process.pid, staging: from, destination: to }) + '\n')
    if (present(to)) throw new Error(`Destination already exists and was preserved: ${to}. Choose a new output path.`)
    exclusiveRename(from, to)
    return to
  } finally {
    closeSync(fd)
    const current = present(lock) && statSync(lock)
    if (current && current.dev === ownLock.dev && current.ino === ownLock.ino) unlinkSync(lock)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: publish-new-directory.mjs <completed-stage-directory> <new-destination>')
    process.stdout.write(publishNewDirectory(process.argv[2], process.argv[3]) + '\n')
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
