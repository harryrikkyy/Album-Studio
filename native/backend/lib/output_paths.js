// Managed descendants must be real directories under a canonical root. A selected root
// alias is supported; intermediate cache/proof aliases are never adopted as service data.
'use strict'
const fs = require('fs')
const path = require('path')
/** @typedef {import('../../contracts/runtime').RecoverableError} RecoverableError */
const MAX_ENTRIES = 100000
const MAX_DEPTH = 64
const OUTPUT_DIRECTORIES = ['raw', 'adjusted', 'sheets', 'previews', 'render-history', 'delivery-history']
const recoveryName = (name) =>
  /^(?:render-[a-f0-9-]{36}$|delivery-[a-zA-Z0-9_-]+$|\.render-prepare-|\.album-studio-derived-|\.source-)/.test(name)
const sameNode = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino
const stat = (file) =>
  fs.promises.lstat(file, { bigint: true }).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
function uncertain(file, detail = 'changed, is a symlink, or is not the expected regular file/directory') {
  /** @type {RecoverableError & { path?: string }} */
  const error = new Error(
    `The managed output/proof path ${file} ${detail}. All existing bytes and recovery histories were preserved. Inspect this path before retrying.`,
  )
  error.code = 'OUTPUT_PATH_UNCERTAIN'
  error.path = file
  return error
}
async function rootOf(requested, create) {
  if (typeof requested !== 'string' || !path.isAbsolute(requested))
    throw new Error('Choose an absolute output or album directory.')
  if (create)
    await fs.promises.mkdir(requested, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error
    })
  const root = await fs.promises.realpath(requested),
    identity = await stat(root)
  if (!identity || !identity.isDirectory() || identity.isSymbolicLink()) throw uncertain(requested)
  return { requested, root, identity }
}
async function managedDirectory(file, create = false) {
  if (create)
    await fs.promises.mkdir(file, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error
    })
  const identity = await stat(file)
  if (!identity) return null
  if (!identity.isDirectory() || identity.isSymbolicLink() || (await fs.promises.realpath(file)) !== file)
    throw uncertain(file)
  return identity
}
async function assertDirectory(file, expected) {
  const actual = await managedDirectory(file)
  if (expected ? !sameNode(actual, expected) : actual) throw uncertain(file)
}
async function assertRoot(context) {
  if (
    (await fs.promises.realpath(context.requested)) !== context.root ||
    !sameNode(await managedDirectory(context.root), context.identity)
  )
    throw uncertain(context.requested)
}

/** No files are decoded, adopted, followed through symlinks, removed, or pruned. */
async function inspectTree(folder, identity, budget, depth = 0) {
  if (depth > MAX_DEPTH) throw uncertain(folder, `exceeds the bounded ${MAX_DEPTH}-level path verification limit`)
  await assertDirectory(folder, identity)
  const names = (await fs.promises.readdir(folder)).sort(),
    descendants = []
  for (const name of names) {
    if (++budget.entries > MAX_ENTRIES)
      throw uncertain(folder, `exceeds the bounded ${MAX_ENTRIES}-entry path verification limit`)
    // Check the parent again before any access through its name. This is a boundary
    // check, not an atomic guarantee against uncoordinated external filesystem edits.
    await assertDirectory(folder, identity)
    const file = path.join(folder, name),
      info = await stat(file)
    if (!info || info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw uncertain(file)
    if (info.isDirectory()) {
      const verified = await managedDirectory(file)
      descendants.push(file, ...(await inspectTree(file, verified, budget, depth + 1)))
    }
  }
  await assertDirectory(folder, identity)
  if (JSON.stringify((await fs.promises.readdir(folder)).sort()) !== JSON.stringify(names)) throw uncertain(folder)
  return descendants
}

/**
 * Canonical root aliases are allowed. create initializes only root + metadata, never
 * recovery trees. Returned identities describe validation boundaries, not a lease.
 */
async function validateOutputPaths(output, { create = false } = {}) {
  const context = await rootOf(output, create),
    metadata = path.join(context.root, '.album-studio')
  const metadataIdentity = await managedDirectory(metadata, create),
    directories = {},
    budget = { entries: 0 }
  if (metadataIdentity) {
    const names = await fs.promises.readdir(metadata)
    for (const name of names)
      if (OUTPUT_DIRECTORIES.includes(name) || recoveryName(name)) await managedDirectory(path.join(metadata, name))
    await inspectTree(metadata, metadataIdentity, budget)
  }
  for (const name of OUTPUT_DIRECTORIES) {
    const file = path.join(metadata, name),
      identity = metadataIdentity ? await managedDirectory(file) : null
    // Clearing an ordinary cache can remove its regular files. Nested directories may
    // contain interrupted source/recovery snapshots or unknown data and are preserved.
    const descendants = identity
      ? (await fs.promises.readdir(file, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(file, entry.name))
      : []
    if (metadataIdentity) await assertDirectory(file, identity)
    directories[name] = { path: file, identity, descendantDirectories: descendants }
  }
  await assertDirectory(metadata, metadataIdentity)
  await assertRoot(context)
  return {
    root: context.root,
    rootIdentity: context.identity,
    metadata,
    metadataIdentity,
    directories,
    inspectedEntries: budget.entries,
  }
}

/** Proof publication/removal must validate before reading a manifest or moving a preview. */
async function validateProofPaths(albumRoot, { create = false } = {}) {
  const context = await rootOf(albumRoot, false),
    proofs = path.join(context.root, 'proofs')
  const proofsIdentity = await managedDirectory(proofs, create),
    pages = path.join(proofs, 'pages'),
    history = path.join(proofs, '.album-studio-history')
  const pagesIdentity = proofsIdentity ? await managedDirectory(pages, create) : null
  const historyIdentity = proofsIdentity ? await managedDirectory(history) : null,
    budget = { entries: 0 }
  if (pagesIdentity) await inspectTree(pages, pagesIdentity, budget)
  if (historyIdentity) await inspectTree(history, historyIdentity, budget)
  await assertDirectory(pages, pagesIdentity)
  await assertDirectory(history, historyIdentity)
  await assertDirectory(proofs, proofsIdentity)
  await assertRoot(context)
  return {
    root: context.root,
    rootIdentity: context.identity,
    proofs,
    pages,
    history,
    proofsIdentity,
    pagesIdentity,
    historyIdentity,
    inspectedEntries: budget.entries,
  }
}

module.exports = { validateOutputPaths, validateProofPaths }
