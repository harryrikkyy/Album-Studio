// Project-format policy and bounded business inputs. No filesystem access or cloning:
// validate first, then apply only explicit legacy normalizations to the caller's object.
'use strict'
const path = require('path')
const LIMITS = Object.freeze({
  SPREADS: 10000,
  PHOTOS_PER_SPREAD: 1000,
  PHOTO_REFERENCES: 1000000,
  OPERATIONS: 1000,
  FOLDERS: 1000,
  MAP_ENTRIES: 250000,
  STRING_LENGTH: 32768,
  ID_LENGTH: 1024,
})
const FOLDERS = [
  'imageTokens',
  'templateTokens',
  'wallpaperTokens',
  'pngTokens',
  'maskTokens',
  'highResTokens',
  'wpHighResTokens',
]
const MAPS = [
  'imageRotations',
  'imagePlacements',
  'imageAdjustments',
  'pageOverlays',
  'pageBackgrounds',
  'pageLayerEdits',
  'sheetOwnership',
]
const OP_NAMES = Object.freeze([
  'setPhotos',
  'addPhoto',
  'swapPhotos',
  'movePhoto',
  'removePhoto',
  'replacePhoto',
  'setTemplate',
  'fitTemplate',
  'rotatePhotos',
  'placePhoto',
  'adjustPhoto',
  'setOutputFolder',
  'setPhotoFolders',
  'setCollections',
  'relinkFolder',
  'clearSpread',
  'insertSpread',
  'removeSpread',
  'moveSpread',
  'autoFill',
])
function invalid(field, detail, code = 'PROJECT_INVALID') {
  const error = new Error(
    `Invalid project ${field}: ${detail}. Preserve the original project and correct this field or restore its backup before retrying.`,
  )
  error.code = code
  error.field = field
  return error
}
function object(value, field) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid(field, 'expected an object')
  return value
}
function integer(value, field, minimum, maximum, legacy = false) {
  const number = legacy && typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < minimum || number > maximum)
    throw invalid(
      field,
      `expected a finite integer from ${minimum} to ${maximum}`,
      typeof number === 'number' && number > maximum ? 'PROJECT_LIMIT' : 'PROJECT_INVALID',
    )
  return number
}
function string(value, field, maximum = LIMITS.STRING_LENGTH) {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.includes('\0'))
    throw invalid(field, `expected a nonempty string within the ${maximum}-character limit`)
  return value
}
function identifier(value, field) {
  string(value, field, LIMITS.ID_LENGTH)
  if (Object.prototype.hasOwnProperty.call(Object.prototype, value) || value === 'prototype')
    throw invalid(field, 'reserved object member is not an asset identity')
  return value
}
function absolute(value, field) {
  string(value, field)
  if (!path.isAbsolute(value)) throw invalid(field, 'expected an absolute source/output path')
  return value
}
function array(value, field, maximum) {
  if (!Array.isArray(value)) throw invalid(field, 'expected an array')
  if (value.length > maximum) throw invalid(field, `exceeds the supported ${maximum}-item limit`, 'PROJECT_LIMIT')
  return value
}
function map(value, field) {
  object(value, field)
  if (Object.keys(value).length > LIMITS.MAP_ENTRIES)
    throw invalid(field, `exceeds the supported ${LIMITS.MAP_ENTRIES}-entry limit`, 'PROJECT_LIMIT')
  return value
}
function folders(value, field) {
  array(value, field, LIMITS.FOLDERS).forEach((entry, i) => absolute(entry, `${field}[${i}]`))
}
function finite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(field, 'expected a finite number')
}
function edits(workspace) {
  for (const [id, value] of Object.entries(workspace.imageRotations || {})) finite(value, `imageRotations.${id}`)
  for (const key of ['imagePlacements', 'imageAdjustments'])
    for (const [id, value] of Object.entries(workspace[key] || {})) {
      object(value, `${key}.${id}`)
      const fields =
        key === 'imagePlacements'
          ? ['scale', 'ox', 'oy']
          : ['exposure', 'contrast', 'saturation', 'warmth', 'tint', 'fade', 'clarity', 'sharpen', 'blur', 'vignette']
      for (const field of fields) if (value[field] !== undefined) finite(value[field], `${key}.${id}.${field}`)
      if (key === 'imageAdjustments' && value.bw !== undefined && typeof value.bw !== 'boolean')
        throw invalid(`${key}.${id}.bw`, 'expected a boolean')
    }
}
function validateIdentity(identity) {
  object(identity, 'identity')
  if (integer(identity.version, 'identity.version', 1, Number.MAX_SAFE_INTEGER, true) !== 1)
    throw invalid('identity.version', 'requires a newer identity registry reader', 'PROJECT_VERSION_UNSUPPORTED')
  map(identity.roots, 'identity.roots')
  map(identity.assets, 'identity.assets')
  for (const [id, root] of Object.entries(identity.roots)) {
    object(root, `identity.roots.${id}`)
    if (!/^root_[a-zA-Z0-9_-]+$/.test(id) || !['photo', 'template'].includes(root.kind))
      throw invalid('identity registry', 'invalid root identity or kind')
    absolute(root.path, `identity.roots.${id}.path`)
    if (root.canonicalPath !== undefined) absolute(root.canonicalPath, `identity.roots.${id}.canonicalPath`)
    if (root.aliases !== undefined) folders(root.aliases, `identity.roots.${id}.aliases`)
  }
  const seen = new Set()
  for (const [id, asset] of Object.entries(identity.assets)) {
    object(asset, `identity.assets.${id}`)
    if (
      !['photo', 'template'].includes(asset.kind) ||
      !new RegExp(`^${asset.kind === 'photo' ? 'img' : 'tpl'}_[a-zA-Z0-9_-]+$`).test(id) ||
      !Object.prototype.hasOwnProperty.call(identity.roots, asset.rootId) ||
      identity.roots[asset.rootId].kind !== asset.kind
    )
      throw invalid('identity registry', 'invalid asset identity or root association')
    string(asset.legacyId, `identity.assets.${id}.legacyId`, LIMITS.ID_LENGTH)
    string(asset.relativePath, `identity.assets.${id}.relativePath`)
    const relative = path.normalize(asset.relativePath)
    if (
      path.isAbsolute(asset.relativePath) ||
      relative === '.' ||
      relative === '..' ||
      relative.startsWith('..' + path.sep)
    )
      throw invalid('identity registry', 'asset lies outside its saved root')
    if (asset.legacyAliases !== undefined)
      array(asset.legacyAliases, `identity.assets.${id}.legacyAliases`, LIMITS.FOLDERS).forEach((a) =>
        string(a, 'legacy alias', LIMITS.ID_LENGTH),
      )
    const locator = JSON.stringify([asset.kind, asset.rootId, relative])
    if (seen.has(locator)) throw invalid('identity registry', 'duplicate asset locator')
    seen.add(locator)
  }
  return identity
}

/** Accept legacy version-zero/missing and explicit digit strings; future versions are refused. */
function inspectProject(data) {
  object(data, 'root')
  const version = data.version === undefined ? 0 : integer(data.version, 'version', 0, Number.MAX_SAFE_INTEGER, true)
  if (version > 1)
    throw invalid(
      'version',
      `version ${version} requires a newer Album Studio; this reader supports version 1`,
      'PROJECT_VERSION_UNSUPPORTED',
    )
  const pending = [],
    set = (target, key, value) => {
      if (target[key] !== value) pending.push([target, key, value])
    }
  const workspace = data.workspace === undefined ? data : object(data.workspace, 'workspace')
  const pages = data.albumPages === undefined ? {} : object(data.albumPages, 'albumPages')
  const keys = Object.keys(pages)
  if (keys.length > LIMITS.SPREADS)
    throw invalid('albumPages', `exceeds the supported ${LIMITS.SPREADS}-spread limit`, 'PROJECT_LIMIT')
  let highest = 0,
    references = 0
  const spreadIds = new Set()
  for (const key of keys) {
    if (!/^[1-9]\d*$/.test(key)) throw invalid(`albumPages.${key}`, 'expected a positive page-number key')
    highest = Math.max(highest, integer(Number(key), `albumPages.${key}`, 1, LIMITS.SPREADS))
    const page = object(pages[key], `albumPages.${key}`),
      photos = page.photos == null ? [] : page.photos
    if (page.id !== undefined && page.id !== null && page.id !== '') {
      if (
        typeof page.id !== 'string' ||
        page.id.length > 200 ||
        !/^spread_[a-zA-Z0-9_-]+$/.test(page.id) ||
        spreadIds.has(page.id)
      )
        throw invalid(`albumPages.${key}.id`, 'invalid or duplicate spread identity')
      spreadIds.add(page.id)
    }
    array(photos, `albumPages.${key}.photos`, LIMITS.PHOTOS_PER_SPREAD)
    references += photos.length
    if (references > LIMITS.PHOTO_REFERENCES)
      throw invalid(
        'albumPages photos',
        `exceeds the supported ${LIMITS.PHOTO_REFERENCES}-reference limit`,
        'PROJECT_LIMIT',
      )
    for (const [i, photo] of photos.entries()) {
      object(photo, `albumPages.${key}.photos[${i}]`)
      identifier(photo.id, `albumPages.${key}.photos[${i}].id`)
      if (photo.orient !== undefined && !['h', 'v'].includes(photo.orient))
        throw invalid(`albumPages.${key}.photos[${i}].orient`, 'expected h or v')
      if (photo.url !== undefined && photo.url !== '') string(photo.url, `albumPages.${key}.photos[${i}].url`)
    }
    if (page.template != null) {
      object(page.template, `albumPages.${key}.template`)
      identifier(page.template.id, `albumPages.${key}.template.id`)
      for (const field of ['h', 'v'])
        if (page.template[field] !== undefined && page.template[field] !== null)
          set(
            page.template,
            field,
            integer(page.template[field], `albumPages.${key}.template.${field}`, 0, LIMITS.PHOTOS_PER_SPREAD, true),
          )
    }
    if (page.photos == null) set(page, 'photos', photos)
  }
  const supplied =
    data.totalActivePages === undefined
      ? 0
      : integer(data.totalActivePages, 'totalActivePages spread count', 0, LIMITS.SPREADS, true)
  const total = supplied || highest || 1
  if (highest > total)
    throw invalid(
      'totalActivePages spread count',
      `page ${highest} lies outside the declared active count ${total}; no page data was discarded`,
    )
  for (const key of FOLDERS) if (workspace[key] != null) folders(workspace[key], key)
  if (workspace.outputToken != null) absolute(workspace.outputToken, 'outputToken')
  for (const key of MAPS) if (workspace[key] !== undefined) map(workspace[key], key)
  edits(workspace)
  if (workspace.identity !== undefined) {
    validateIdentity(workspace.identity)
    set(workspace.identity, 'version', 1)
  }
  set(data, 'version', 1)
  set(data, 'totalActivePages', total)
  if (data.albumPages === undefined) set(data, 'albumPages', pages)
  return { data, workspace, total, pending }
}
function validateProject(data) {
  inspectProject(data)
  return data
}
function migrateProject(data) {
  const inspected = inspectProject(data)
  for (const [target, key, value] of inspected.pending) target[key] = value
  return data
}
function pageCount(data) {
  return inspectProject(data).total
}

function validateOperations(ops) {
  array(ops, 'operations', LIMITS.OPERATIONS)
  if (!ops.length) throw invalid('operations', 'choose at least one operation')
  let references = 0
  for (const [i, operation] of ops.entries()) {
    object(operation, `operations[${i}]`)
    if (!OP_NAMES.includes(operation.op))
      throw invalid(`operations[${i}]`, `unknown album operation \`${operation.op}\``)
    for (const field of ['n', 'at'])
      if (operation[field] !== undefined)
        integer(
          operation[field],
          `operation ${operation.op}.${field} spread`,
          1,
          LIMITS.SPREADS + (field === 'at' ? 1 : 0),
        )
    if (operation.op === 'moveSpread')
      for (const field of ['from', 'to']) integer(operation[field], `operation moveSpread.${field}`, 1, LIMITS.SPREADS)
    if (operation.index !== undefined)
      integer(operation.index, `operation ${operation.op}.index`, 0, LIMITS.PHOTOS_PER_SPREAD)
    for (const field of ['photoIds', 'ids'])
      if (operation[field] !== undefined) {
        const maximum =
          field === 'photoIds' || operation.op === 'addPhoto' ? LIMITS.PHOTOS_PER_SPREAD : LIMITS.MAP_ENTRIES
        array(operation[field], `operation ${operation.op}.${field}`, maximum).forEach((id, n) =>
          identifier(id, `operation ${operation.op}.${field}[${n}]`),
        )
        references += operation[field].length
      }
    if (operation.op === 'setPhotos' && operation.photoIds === undefined)
      throw invalid('operation setPhotos.photoIds', 'expected an array')
    for (const field of ['id', 'oldId', 'newId', 'templateId', 'a', 'b'])
      if (operation[field] !== undefined) identifier(operation[field], `operation ${operation.op}.${field}`)
    if (operation.op === 'setPhotoFolders') folders(operation.folders, 'operation setPhotoFolders.folders')
    if (operation.op === 'setCollections') folders(operation.collections, 'operation setCollections.collections')
    if (operation.op === 'setOutputFolder') {
      if (typeof operation.folder !== 'string' || !path.isAbsolute(operation.folder))
        throw invalid(
          'operation setOutputFolder.folder',
          'Choose a folder for the print sheets; expected an absolute path',
        )
      absolute(operation.folder, 'operation setOutputFolder.folder')
    }
    if (operation.op === 'autoFill') {
      for (const field of ['desiredSheets', 'min', 'max'])
        if (operation[field] !== undefined)
          integer(
            operation[field],
            `operation autoFill.${field} spreads`,
            1,
            field === 'desiredSheets' ? LIMITS.SPREADS : LIMITS.PHOTOS_PER_SPREAD,
          )
    }
    for (const field of ['by', 'scale', 'ox', 'oy'])
      if (operation[field] !== undefined) finite(operation[field], `operation ${operation.op}.${field}`)
    if (operation.adjust !== undefined) {
      object(operation.adjust, 'operation adjustPhoto.adjust')
      edits({ imageAdjustments: { chosen: operation.adjust } })
    }
  }
  if (references > LIMITS.PHOTO_REFERENCES)
    throw invalid(
      'operations references',
      `exceeds the supported ${LIMITS.PHOTO_REFERENCES}-item limit`,
      'PROJECT_LIMIT',
    )
  return ops
}
function validateCreateInput(params) {
  object(params, 'creation request')
  if (params.photoFolders !== undefined) folders(params.photoFolders, 'photoFolders')
  if (params.templateCollections !== undefined) folders(params.templateCollections, 'templateCollections')
  if (params.outputFolder != null) absolute(params.outputFolder, 'outputFolder')
  if (params.autoFill != null && params.autoFill !== false) {
    object(params.autoFill, 'autoFill')
    integer(params.autoFill.desiredSheets, 'autoFill.desiredSheets spreads', 1, LIMITS.SPREADS)
  }
  return params
}

module.exports = {
  LIMITS,
  OP_NAMES,
  validateProject,
  validateIdentity,
  migrateProject,
  pageCount,
  validateOperations,
  validateCreateInput,
}
