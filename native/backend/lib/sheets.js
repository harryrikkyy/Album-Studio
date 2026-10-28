// Print sheets belong to a persistent spread, independent of delivery page numbering.
'use strict'

const fs = require('fs')
const path = require('path')
const { contentVerified } = require('./inputs')
const { readProjectSnapshot } = require('./project_transaction')
const { assertFilesSettled } = require('./file_publication')
const verifiedSheetRecord = (record) => !!(contentVerified(record) && !record.unverified && /^[a-f0-9]{64}$/.test(record.sheetDigest || ''))

const workspace = (data) => data.workspace || data
const outputFolder = (ws, albumFolder) => ws.outputToken || path.join(albumFolder, 'exports')
const renderCachePath = (output) => path.join(output, '.album-studio', 'render-cache.json')
const canonicalSheetPath = (output, id) => {
  if (typeof id !== 'string' || !/^spread_[a-zA-Z0-9_-]+$/.test(id)) throw new Error('This spread has an invalid identity. Recover the album before rendering.')
  return path.join(output, '.album-studio', 'sheets', `${id}.psd`)
}
const isFile = async (file) => fs.promises.stat(file).then((s) => s.isFile(), () => false)
const inside = (folder, file) => {
  if (typeof file !== 'string') return false
  const rel = path.relative(folder, file)
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

async function readRenderCacheSnapshot(output, { albumFile } = {}) {
  await assertFilesSettled(output)
  await assertFilesSettled(path.join(output, '.album-studio', 'sheets'))
  let data, revision
  try {
    ;({ data, revision } = await readProjectSnapshot(renderCachePath(output)))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('The render record is not an object.')
    if (data.albumFile !== undefined && (typeof data.albumFile !== 'string' || !path.isAbsolute(data.albumFile))) throw new Error('The render record has an invalid project association.')
    if (data.version === 2 && (!data.spreads || typeof data.spreads !== 'object' || Array.isArray(data.spreads))) throw new Error('The render record has invalid spread entries.')
  } catch (error) {
    if (error.code === 'ENOENT') return { data: {}, revision: null }
    throw new Error(`The rendered-sheet record ${renderCachePath(output)} could not be verified: ${error.message} Its existing bytes were preserved.`)
  }
  if (albumFile && data.albumFile !== undefined) {
    const owner = await fs.promises.realpath(data.albumFile).catch(() => path.resolve(data.albumFile))
    const requested = await fs.promises.realpath(albumFile)
    if (owner !== requested) {
      const error = new Error(`The rendered-sheet folder is associated with another project at ${data.albumFile}. Preserve its files and choose a separate print-sheet folder for this project.`)
      error.code = 'OUTPUT_OWNED_BY_OTHER'
      throw error
    }
  }
  return { data, revision }
}

async function readRenderCache(output, options) { return (await readRenderCacheSnapshot(output, options)).data }

/** Freeze old numbered-file ownership before the first structural edit; never move open files. */
async function adoptLegacySheets(data, albumFolder) {
  const ws = workspace(data)
  if (ws.sheetOwnership !== undefined) return ws.sheetOwnership
  const ownership = {}
  const output = outputFolder(ws, albumFolder)
  const cache = await readRenderCache(output)
  for (const [n, page] of Object.entries(data.albumPages || {})) {
    if (!page || !page.id) continue
    const file = path.join(output, `Page_${String(Number(n)).padStart(3, '0')}.psd`)
    if (!(await isFile(file))) continue
    const old = cache[n]
    ownership[page.id] = {
      path: file,
      outputFolder: output,
      hash: typeof old === 'string' ? old : old && old.hash || null,
      sheet: old && typeof old === 'object' ? old.sheet || null : null,
      sheetDigest: old && typeof old === 'object' ? old.sheetDigest || null : null,
      // A file without a verified render record may contain irreplaceable manual work.
      unverified: !verifiedSheetRecord(old),
      adopted: true,
      legacyPosition: Number(n),
    }
  }
  ws.sheetOwnership = ownership
  return ownership
}

/** The record is owned by this spread in the CURRENT output folder; unrelated files stay unowned. */
async function ownedSheetRecord(ws, albumFolder, id, cache) {
  if (!id) return null
  const output = outputFolder(ws, albumFolder)
  const records = cache || await readRenderCache(output)
  const record = records.version === 2 && records.spreads && records.spreads[id] || (ws.sheetOwnership || {})[id]
  if (!record || !inside(output, record.path) || (record.outputFolder && path.resolve(record.outputFolder) !== path.resolve(output))) return null
  return record
}

async function resolveSpreadSheet(ws, albumFolder, id, n, albumFile) {
  try { await readRenderCache(outputFolder(ws, albumFolder), { albumFile }) } catch (error) { if (error.code === 'OUTPUT_OWNED_BY_OTHER') return null; throw error }
  const record = await ownedSheetRecord(ws, albumFolder, id)
  if (record) return await isFile(record.path) ? record.path : null
  if (!id && ws.sheetOwnership === undefined) {
    const file = path.join(outputFolder(ws, albumFolder), `Page_${String(n).padStart(3, '0')}.psd`)
    return await isFile(file) ? file : null
  }
  return null
}

module.exports = { adoptLegacySheets, canonicalSheetPath, outputFolder, ownedSheetRecord, readRenderCache, readRenderCacheSnapshot, renderCachePath, resolveSpreadSheet, verifiedSheetRecord }
