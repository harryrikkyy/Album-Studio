// Physical namespace capabilities shared by output and file-publication adapters.
// Markers serialize cooperating actors; they never adopt existing customer files.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { acquireProjectLease } = require('./project_lock')
const exclusive = require('./exclusive_rename')
const { assertPublicationParent } = require('./publication_paths')
const sameNode = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino
const stat = file => fs.promises.lstat(file, { bigint: true }).catch(error => { if (error.code === 'ENOENT') return null; throw error })
function uncertain(file) {
  const error = new Error(`The output namespace ${file} changed or has unexpected ownership evidence. All existing files were preserved; review it before retrying.`)
  error.code = 'OUTPUT_LOCK_UNCERTAIN'
  return error
}
async function directory(requested, create) {
  if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw new Error('Choose an absolute existing folder for the print sheets.')
  if (create) await fs.promises.mkdir(requested, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const folder = await fs.promises.realpath(requested), identity = await stat(folder)
  if (!identity || !identity.isDirectory() || identity.isSymbolicLink()) throw uncertain(requested)
  return { requested, folder, identity }
}
async function readMarker(file, bytes) {
  const before = await stat(file)
  if (!before) return null
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(bytes.length) || before.mode & 0o222n) throw uncertain(file)
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = await handle.stat({ bigint: true }), buffer = Buffer.alloc(bytes.length + 1)
    if (!sameNode(before, opened)) throw uncertain(file)
    let length = 0
    while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, length); if (!read.bytesRead) break; length += read.bytesRead }
    const after = await handle.stat({ bigint: true }), named = await stat(file)
    if (!sameNode(opened, after) || !sameNode(after, named) || !buffer.subarray(0, length).equals(bytes) || after.mode & 0o222n || named.mode & 0o222n) throw uncertain(file)
    return after
  } finally { await handle.close() }
}
async function syncDirectory(folder) {
  const handle = await fs.promises.open(folder, 'r')
  try { await handle.sync() } catch (error) { if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EISDIR'].includes(error.code)) throw error }
  finally { await handle.close() }
}
async function marker(context, scope, { create = true } = {}) {
  if (!['sheets', 'delivery', 'files'].includes(scope)) throw new Error('Unknown storage namespace scope.')
  const file = path.join(context.folder, `.album-studio-namespace-${scope}.json`)
  const bytes = Buffer.from(JSON.stringify({ version: 1, scope }))
  let identity = await readMarker(file, bytes)
  if (!identity && !create) throw uncertain(file)
  if (!identity) {
    const temporary = path.join(context.folder, `.album-studio-namespace-${crypto.randomUUID()}.part.json`)
    const handle = await fs.promises.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(bytes); await handle.chmod(0o400); await handle.sync() } finally { await handle.close() }
    const temporaryIdentity = await readMarker(temporary, bytes)
    if (!temporaryIdentity) throw uncertain(temporary)
    try { await exclusive.renameExclusive(temporary, file) } catch (error) {
      // Preserve any uncertain or losing private marker. Never replace the stable namespace.
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
        const moved = !await stat(temporary) && sameNode(temporaryIdentity, await readMarker(file, bytes))
        if (!moved) { error.message += ` Output marker retained at ${temporary}.`; throw error }
      }
    }
    await syncDirectory(context.folder)
    identity = await readMarker(file, bytes)
  }
  return { ...context, scope, file, bytes, markerIdentity: identity }
}
async function acquireNamespaceGroup(contexts, { validateExtra } = {}) {
  if (!Array.isArray(contexts) || !contexts.length || contexts.length > 10000 || validateExtra !== undefined && typeof validateExtra !== 'function') throw new Error('Namespace acquisition requires bounded contexts and an optional validation callback.')
  const all = [...new Map(contexts.map(context => [context.file, context])).values()].sort((a, b) => a.file.localeCompare(b.file)), held = []
  const release = async () => {
    let failure
    for (const item of [...held].reverse()) {
      try { await item.lease.release() } catch (error) { if (failure) failure.message += ` ${error.message}`; else failure = error }
    }
    if (failure) throw failure
  }
  try {
    for (const context of all) held.push({ context, lease: await acquireProjectLease(context.file, { kind: context.kind || `namespace-${context.scope}` }) })
    const group = { async assertOwned() {
      for (const { context, lease } of held) {
        await lease.assertOwned()
        const resolved = await directory(context.requested, false), current = await readMarker(context.file, context.bytes)
        if (resolved.folder !== context.folder || !sameNode(resolved.identity, context.identity) || !sameNode(current, context.markerIdentity)) throw uncertain(context.file)
      }
      if (validateExtra) await validateExtra()
    }, async coversNamespace(requested, scope) {
      const resolved = await directory(requested, false)
      const context = held.find(item => item.context.scope === scope && item.context.folder === resolved.folder)?.context
      if (!context) return false
      if (!sameNode(resolved.identity, context.identity)) throw uncertain(requested)
      await this.assertOwned()
      return true
    }, async assertDirectory(requested, scope) {
      if (!await this.coversNamespace(requested, scope)) throw uncertain(requested)
    }, release }
    await group.assertOwned()
    return group
  } catch (error) {
    try { await release() } catch (cleanup) { error.message += ` Namespace release also failed: ${cleanup.message}` }
    throw error
  }
}

/** Discover existing managed scopes only for serialization, never album/file adoption.
 * Ancestor identity is rechecked while held; a newly appearing scope invalidates the
 * capability instead of silently rebasing an already prepared publication. */
async function managedScopes(parents) {
  const contexts = new Map()
  for (const parent of parents) {
    let folder = await fs.promises.realpath(parent)
    for (;;) {
      for (const scope of ['sheets', 'delivery']) {
        const file = path.join(folder, `.album-studio-namespace-${scope}.json`)
        if (await stat(file)) contexts.set(file, await marker(await directory(folder, false), scope, { create: false }))
      }
      const ancestor = path.dirname(folder)
      if (ancestor === folder) break
      folder = ancestor
    }
  }
  return [...contexts.values()]
}
/** File publishers reserve physical parents plus existing enclosing managed scopes. */
async function acquirePublicationDirectories(targets, { enclosing } = {}) {
  if (enclosing !== undefined && (!enclosing || typeof enclosing.coversNamespace !== 'function')) throw new Error('An enclosing namespace capability must prove its held scopes.')
  if (!Array.isArray(targets) || !targets.length || targets.length > 10000 || targets.some(file => typeof file !== 'string' || file.length > 32768 || file.includes('\0') || !file.isWellFormed() || !path.isAbsolute(file))) throw new Error('File publication requires bounded absolute targets.')
  const parents = [...new Set(targets.map(file => path.dirname(file)))], contexts = []
  for (const parent of parents) {
    const resolved = await directory(parent, false)
    assertPublicationParent(resolved.folder)
    contexts.push(await marker(resolved, 'files'))
  }
  const managed = await managedScopes(parents), additional = [], covered = []
  for (const context of managed) {
    if (enclosing && await enclosing.coversNamespace(context.folder, context.scope)) covered.push(context)
    else additional.push(context)
  }
  const group = await acquireNamespaceGroup([...contexts, ...additional], { validateExtra: async () => {
    const current = await managedScopes(parents)
    if (current.length !== managed.length || current.some(item => !managed.some(prior => prior.file === item.file && sameNode(prior.markerIdentity, item.markerIdentity) && sameNode(prior.identity, item.identity)))) throw uncertain(parents.join(', '))
    for (const context of covered) if (!await enclosing.coversNamespace(context.folder, context.scope)) throw uncertain(context.folder)
  } })
  return { assertOwned: () => group.assertOwned(), assertTarget: file => group.assertDirectory(path.dirname(file), 'files'), release: () => group.release(), async managedDirectories() { await group.assertOwned(); return managed.map(({ folder, scope }) => ({ folder, scope })) } }
}
module.exports = { directory, marker, acquireNamespaceGroup, acquirePublicationDirectories }
