// Cooperating operations reserve physical output namespaces independently of project paths.
// Generic namespace ownership lives below the project/output adapter.
'use strict'
const path = require('path')
const { readProjectSnapshot } = require('./project_transaction')
const { directory, marker, acquireNamespaceGroup } = require('./namespace_lock')
async function contexts(output, delivery) {
  const sheet = await directory(output, true)
  await require('./output_paths').validateOutputPaths(output)
  const all = [await marker(sheet, 'sheets')]
  // Preserve the logical parent used by the existing delivery folder layout.
  if (delivery) all.push(await marker(await directory(path.dirname(output), false), 'delivery'))
  return all
}
async function acquireOutputLease(output, { delivery = false, kind = 'output' } = {}) {
  const all = await contexts(output, delivery)
  for (const context of all) context.kind = `${kind}-${context.scope}`
  const group = await acquireNamespaceGroup(all, { validateExtra: () => require('./output_paths').validateOutputPaths(output) })
  return { output, delivery, assertOwned: () => group.assertOwned(), async assertFor(requested, needsDelivery = false) {
    if (needsDelivery && !delivery) throw new Error('This operation has no lease for its delivery folder.')
    await group.assertDirectory(requested, 'sheets')
    if (needsDelivery) await group.assertDirectory(path.dirname(requested), 'delivery')
  }, release: () => group.release() }
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
  require('./project_domain').validateProject(data)
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
    require('./project_domain').validateProject(data)
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
