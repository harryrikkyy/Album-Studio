// Reconstruct or validate the exact engine dependency without changing an existing checkout.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { publishNewDirectory } from './publish-new-directory.mjs'
import { nativeContracts } from './generate-native-contracts.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const DEFAULT_PIN = join(ROOT, 'native/scripts/engine/pin.json')
export const DEFAULT_ENGINE = join(ROOT, 'native/photocraft')
export const NODE_GATE_SCRIPT = 'test:strict' // all three suites, with coverage limits
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const present = (path) => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw new Error(`${executable} did not finish: ${result.error.message}`)
  if (result.status !== 0)
    throw new Error(`${executable} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`)
  return (result.stdout || '').trim()
}

function git(args, engine, extra = {}) {
  return command('git', ['-C', engine, ...args], extra)
}

export function readPin(file = DEFAULT_PIN) {
  const pin = JSON.parse(readFileSync(file, 'utf8'))
  const hash = (value, length) => typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
  if (
    pin.schema !== 1 ||
    !hash(pin.commit, 40) ||
    !hash(pin.baseCommit, 40) ||
    !hash(pin.bundleSha256, 64) ||
    !hash(pin.cargoLockSha256, 64) ||
    !/^\d+\.\d+\.\d+$/.test(pin.rustToolchain) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(pin.sourceDate) ||
    !Array.isArray(pin.features) ||
    pin.features.some((value) => !/^[a-z0-9_-]+$/.test(value))
  )
    throw new Error('The engine pin manifest is invalid.')
  const remote = new URL(pin.upstreamRepository)
  if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash)
    throw new Error('Engine source must use a credential-free HTTPS URL.')
  if (
    typeof pin.bundle !== 'string' ||
    ['.', '..'].includes(pin.bundle) ||
    isAbsolute(pin.bundle) ||
    pin.bundle.includes('/') ||
    pin.bundle.includes('\\')
  )
    throw new Error('Engine bundle must be beside its manifest.')
  const bundleRef = pin.bundleRef ?? 'refs/heads/album-studio'
  if (typeof bundleRef !== 'string' || !bundleRef.startsWith('refs/heads/'))
    throw new Error('Engine bundle ref must name a fully qualified branch.')
  command('git', ['check-ref-format', bundleRef])
  if (pin.contractsVersion !== undefined && pin.contractsVersion !== 1)
    throw new Error('The native contracts version is unsupported.')
  const bundle = resolve(dirname(file), pin.bundle)
  if (sha256(bundle) !== pin.bundleSha256)
    throw new Error('The pinned engine bundle checksum does not match. Restore the tracked bundle before setup.')
  return { ...pin, bundle, bundleRef }
}

export function validateEngine({ engine = DEFAULT_ENGINE, manifest = DEFAULT_PIN } = {}) {
  const pin = readPin(manifest)
  if (!existsSync(engine) || !lstatSync(engine).isDirectory())
    throw new Error(`Engine checkout missing at ${engine}. Run node native/scripts/engine.mjs setup.`)
  const root = realpathSync(engine)
  if (realpathSync(git(['rev-parse', '--show-toplevel'], engine)) !== root)
    throw new Error('The engine directory is not its own Git checkout.')
  const head = git(['rev-parse', 'HEAD'], engine)
  if (head !== pin.commit)
    throw new Error(
      `Engine revision drift: expected ${pin.commit}, found ${head}. Existing checkout was preserved; move or back it up before running setup.`,
    )
  if (git(['status', '--porcelain=v1', '--untracked-files=no'], engine))
    throw new Error('Engine has tracked changes. Commit or preserve those changes; setup/build will not discard them.')
  if (sha256(join(engine, 'Cargo.lock')) !== pin.cargoLockSha256)
    throw new Error('Engine Cargo.lock does not match the root pin.')
  if (!existsSync(join(engine, 'apps/album-studio/Cargo.toml')))
    throw new Error('The pinned checkout does not contain Album Studio.')
  git(['bundle', 'verify', pin.bundle], engine)
  if (pin.contractsVersion === 1) {
    for (const [name, expected] of nativeContracts(ROOT)) {
      const file = join(engine, 'apps/album-studio/src/contracts', name)
      if (!existsSync(file) || !readFileSync(file).equals(Buffer.from(expected)))
        throw new Error(
          `Native canonical contract drift: ${name}. Regenerate and review a new engine pin; the current checkout was preserved.`,
        )
    }
  }
  return {
    engine: root,
    commit: head,
    rustToolchain: pin.rustToolchain,
    cargoLockSha256: pin.cargoLockSha256,
    features: pin.features,
  }
}

export function setupEngine({ engine = DEFAULT_ENGINE, manifest = DEFAULT_PIN, baseRepository } = {}) {
  const pin = readPin(manifest)
  // Existing checkouts are validated only. No fetch, reset, checkout or cleanup can affect them.
  if (present(engine)) return validateEngine({ engine, manifest })
  if (baseRepository && /^[a-z][a-z0-9+.-]*:\/\//i.test(baseRepository)) {
    const remote = new URL(baseRepository)
    if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash)
      throw new Error('Base mirror must use a credential-free HTTPS URL or a local checkout.')
  }
  // Fetch runs inside staging; resolve local mirrors before changing its working folder.
  const repository =
    baseRepository && !/^[a-z][a-z0-9+.-]*:\/\//i.test(baseRepository)
      ? resolve(baseRepository)
      : baseRepository || pin.upstreamRepository
  const parent = dirname(resolve(engine))
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, '.photocraft-setup-'))
  const fetchEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
  for (const key of Object.keys(fetchEnv))
    if (/^GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(key)) delete fetchEnv[key]
  try {
    git(['init', '--quiet'], staging)
    git(
      [
        '-c',
        'credential.helper=',
        '-c',
        'http.extraheader=',
        'fetch',
        '--depth=1',
        '--no-tags',
        repository,
        pin.baseCommit,
      ],
      staging,
      { env: fetchEnv },
    )
    if (git(['rev-parse', 'FETCH_HEAD'], staging) !== pin.baseCommit)
      throw new Error('The fetched upstream base does not match the pin.')
    git(['bundle', 'verify', pin.bundle], staging)
    git(['fetch', '--no-tags', pin.bundle, pin.bundleRef], staging)
    git(['checkout', '--quiet', '--detach', pin.commit], staging)
    validateEngine({ engine: staging, manifest })
    publishNewDirectory(staging, engine)
    return validateEngine({ engine, manifest })
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true })
  }
}

export function validateToolchain(pin) {
  const rustc = command('rustc', ['--version'])
  const cargo = command('cargo', ['--version'])
  if (!rustc.startsWith(`rustc ${pin.rustToolchain} `) || !cargo.startsWith(`cargo ${pin.rustToolchain} `)) {
    throw new Error(
      `Build needs Rust/Cargo ${pin.rustToolchain}. Install that toolchain and put it on PATH; existing builds were preserved.`,
    )
  }
  return { rustc, cargo }
}

export function buildEngine({ engine = DEFAULT_ENGINE, manifest = DEFAULT_PIN, targetDir } = {}) {
  const pinDigest = sha256(manifest)
  const pin = readPin(manifest)
  const state = validateEngine({ engine, manifest })
  const tools = validateToolchain(pin)
  const target = resolve(targetDir || process.env.CARGO_TARGET_DIR || join(engine, 'target/album-studio-pinned'))
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: target,
    PHOTOCRAFT_BUILD_SHA: pin.commit,
    PHOTOCRAFT_BUILD_DATE: pin.sourceDate,
  }
  const args = ['build', '--release', '--locked', '-p', 'album-studio', '-p', 'photocraft-cli']
  if (pin.features.length) args.push('--features', pin.features.join(','))
  command('cargo', args, { cwd: engine, env, stdio: 'inherit', timeout: 60 * 60 * 1000 })
  if (sha256(manifest) !== pinDigest)
    throw new Error(
      'The engine pin changed during compilation. Outputs were preserved but are not verified; rebuild from a stable pin.',
    )
  validateEngine({ engine, manifest })
  const rename = buildRenameHelper(target)
  const cli = join(target, 'release/photocraft-cli')
  const version = command(cli, ['--version'])
  if (!version.includes(pin.commit.slice(0, 9)))
    throw new Error('The compiled engine did not report the pinned source revision.')
  return { ...state, ...tools, cli, shell: join(target, 'release/album-studio'), version, rename }
}

export function buildRenameHelper(target) {
  const source = join(ROOT, 'native/scripts/rename-exclusive.c'),
    digest = sha256(source)
  const binary = join(resolve(target), 'release/album-studio-rename-exclusive')
  mkdirSync(dirname(binary), { recursive: true })
  command('cc', ['-O2', '-Wall', '-Wextra', '-Werror', `-DALBUM_STUDIO_RENAME_SHA="${digest}"`, source, '-o', binary])
  if (!command(binary, ['--version']).includes(digest))
    throw new Error('Atomic helper build does not report its source checksum.')
  return binary
}

export function assertNoSkippedTap(text, { expectedSuites = 1 } = {}) {
  const summaries = [...text.matchAll(/^# skipped (\d+)\s*$/gm)].map((match) => Number(match[1]))
  if (summaries.length !== expectedSuites)
    throw new Error(`Expected ${expectedSuites} complete test summaries, found ${summaries.length}.`)
  if (summaries.some((count) => count !== 0))
    throw new Error('The test gate rejected skipped tests. Build the pinned real engine before testing.')
}

export function runNodeGate({ engine = DEFAULT_ENGINE, manifest = DEFAULT_PIN, targetDir } = {}) {
  const state = validateEngine({ engine, manifest })
  const pin = readPin(manifest)
  const target = resolve(targetDir || process.env.CARGO_TARGET_DIR || join(engine, 'target/album-studio-pinned'))
  const cli = join(target, 'release/photocraft-cli')
  const version = command(cli, ['--version'])
  if (!version.includes(pin.commit.slice(0, 9)))
    throw new Error('Node integration gate requires a freshly built, provenance-tagged pinned engine.')
  const rename = join(target, 'release/album-studio-rename-exclusive')
  if (!command(rename, ['--version']).includes(sha256(join(ROOT, 'native/scripts/rename-exclusive.c'))))
    throw new Error('Node integration gate requires the current atomic file helper.')
  runNodeSuites({ cli, rename })
  return { ...state, cli, tests: 'all Node suites completed without skipped tests' }
}

/** Runs the strict gate script against a verified engine and helper; any skipped or missing suite fails. */
export function runNodeSuites({ cli, rename }) {
  const result = spawnSync('npm', ['run', NODE_GATE_SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, ALBUM_STUDIO_PHOTOCRAFT_CLI: cli, ALBUM_STUDIO_RENAME_CLI: rename },
  })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error || result.status !== 0)
    throw new Error(`Node test gate failed: ${result.error?.message || `exit ${result.status}`}`)
  assertNoSkippedTap(result.stdout, { expectedSuites: 3 })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation = 'check', ...args] = process.argv.slice(2)
  const options = {}
  try {
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i],
        value = args[i + 1]
      if (!value || !['--engine', '--manifest', '--target-dir', '--base-repository'].includes(flag))
        throw new Error(`Unknown or incomplete option ${flag}.`)
      options[
        {
          '--engine': 'engine',
          '--manifest': 'manifest',
          '--target-dir': 'targetDir',
          '--base-repository': 'baseRepository',
        }[flag]
      ] = flag === '--base-repository' ? value : resolve(value)
    }
    const operations = {
      check: validateEngine,
      setup: setupEngine,
      build: buildEngine,
      'build-rename': () =>
        buildRenameHelper(
          options.targetDir ||
            process.env.CARGO_TARGET_DIR ||
            join(options.engine || DEFAULT_ENGINE, 'target/album-studio-pinned'),
        ),
      'test-node': runNodeGate,
      pin: () => readPin(options.manifest),
    }
    if (!operations[operation]) throw new Error('Use engine.mjs check, setup, build, test-node or pin.')
    process.stdout.write(JSON.stringify(operations[operation](options), null, 2) + '\n')
  } catch (error) {
    process.stderr.write(`Album Studio engine gate: ${error.message}\n`)
    process.exitCode = 1
  }
}
