// Cooperating backend operations reserve physical output namespaces, independently of which
// project requested them. Namespace markers do not assign or adopt existing customer files.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { acquireProjectLease } = require('./project_lock')
const { readProjectSnapshot } = require('./project_transaction')
const exclusive = require('./exclusive_rename')
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
async function marker(context, scope) {
  const file = path.join(context.folder, `.album-studio-namespace-${scope}.json`)
  const bytes = Buffer.from(JSON.stringify({ version: 1, scope }))
  let identity = await readMarker(file, bytes)
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
async function contexts(output, delivery) {
  const sheet = await directory(output, true)
  await require('./output_paths').validateOutputPaths(output)
  const all = [await marker(sheet, 'sheets')]
  // Keep existing path semantics for a symlinked sheet folder: JPEGs are beside its logical
  // path, which can differ from the physical sheet folder's parent. Lock that actual parent.
  if (delivery) all.push(await marker(await directory(path.dirname(output), false), 'delivery'))
  return all.sort((a, b) => a.file.localeCompare(b.file))
}
async function acquireOutputLease(output, { delivery = false, kind = 'output' } = {}) {
  const all = await contexts(output, delivery), held = []
  const release = async () => {
    let failure
    for (const item of [...held].reverse()) {
      try { await item.lease.release() } catch (error) { if (failure) failure.message += ` ${error.message}`; else failure = error }
    }
    if (failure) throw failure
  }
  try {
    for (const context of all) {
      const lease = await acquireProjectLease(context.file, { kind: `${kind}-${context.scope}` })
      held.push({ context, lease })
    }
    const group = { output, delivery, async assertOwned() {
      for (const { context, lease } of held) {
        await lease.assertOwned()
        const resolved = await directory(context.requested, false), current = await readMarker(context.file, context.bytes)
        if (resolved.folder !== context.folder || !sameNode(resolved.identity, context.identity) || !sameNode(current, context.markerIdentity)) throw uncertain(context.file)
      }
      await require('./output_paths').validateOutputPaths(output)
    }, async assertFor(requested, needsDelivery = false) {
      if (needsDelivery && !delivery) throw new Error('This operation has no lease for its delivery folder.')
      const sheet = held.find(x => x.context.scope === 'sheets').context
      if ((await directory(requested, false)).folder !== sheet.folder) throw uncertain(requested)
      if (needsDelivery) {
        const parent = held.find(x => x.context.scope === 'delivery').context
        if ((await directory(path.dirname(requested), false)).folder !== parent.folder) throw uncertain(path.dirname(requested))
      }
      await this.assertOwned()
    }, release }
    await group.assertOwned()
    return group
  } catch (error) {
    try { await release() } catch (cleanup) { error.message += ` Output lease release also failed: ${cleanup.message}` }
    throw error
  }
}
function attachOutputLease(project, outputs) {
  const original = project.assertOwned, previous = project.outputNamespace
  if (previous) throw new Error('The project already holds an output namespace lease.')
  project.outputNamespace = outputs
  project.assertOwned = async () => { await original(); await outputs.assertOwned() }
  return () => { project.assertOwned = original; if (previous) project.outputNamespace = previous; else delete project.outputNamespace }
}
async function acquireProjectOutputs(project, options = {}) {
  await project.assertOwned()
  const { data } = await readProjectSnapshot(project.file), ws = data.workspace || data
  const output = ws.outputToken || path.join(project.folder, 'exports')
  const group = await acquireOutputLease(output, options)
  try {
    await project.assertOwned()
    // Interrupted publication can leave either public name absent. Recover while both
    // namespaces are held, before any reader interprets missing ownership as a new album.
    await require('./render_transaction').recoverRenders({ albumFile: project.file, outputFolder: output }, {
      assertOwned: () => project.assertOwned(), assertOutput: requested => group.assertFor(requested),
    })
    try { await require('./sheets').readRenderCache(output, { albumFile: project.file }) }
    catch (error) { if (!options.allowForeignCache || error.code !== 'OUTPUT_OWNED_BY_OTHER') throw error }
    return group
  } catch (error) { try { await group.release() } catch (release) { error.message += ` ${release.message}` }; throw error }
}
async function withProjectOutputs(project, work, options = {}) {
  if (project.outputNamespace) {
    const { data } = await readProjectSnapshot(project.file), ws = data.workspace || data
    await project.outputNamespace.assertFor(ws.outputToken || path.join(project.folder, 'exports'), !!options.delivery)
    return work(project.outputNamespace)
  }
  const outputs = await acquireProjectOutputs(project, options), restore = attachOutputLease(project, outputs)
  let result, failure
  try { result = await work(outputs) } catch (error) { failure = error }
  restore()
  try { await outputs.release() } catch (release) { if (failure) failure.message += ` Output lease release also failed: ${release.message}`; else failure = release }
  if (failure) throw failure
  return result
}
module.exports = { acquireOutputLease, acquireProjectOutputs, attachOutputLease, withProjectOutputs }
