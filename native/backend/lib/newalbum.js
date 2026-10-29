// newalbum.js — starting an album: look at the chosen folders, suggest template collections from
// earlier albums, then create the project (thumbnails, project.json in the Electron app's format,
// and optionally a first auto-filled plan).

'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { openAlbum } = require('./album')
const exclusiveRename = require('./exclusive_rename')
const { updateAlbum, migrateAlbum } = require('./project')
const { newSpreadId } = require('./identity')
const { validateCreateInput, validateOperations, validateProject } = require('./project_domain')
const { listRecent, rememberAlbum } = require('./recent')
const { listTemplates } = require('./templates')
const { ensureThumbnails, surveyFolder } = require('./thumbs')

/** Characters macOS Finder or the Electron app can't take in a folder name. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what a folder name can't hold
const BAD_NAME = /[/:\\\u0000-\u001f]/

/** What is in each folder: photos, RAWs, thumbnails still to make, a few thumbnails to show. */
async function inspectFolders({ paths }) {
  if (!Array.isArray(paths)) throw new Error('missing `paths`')
  return Promise.all(
    paths.map(async (p) => {
      const s = await surveyFolder(p)
      return {
        path: s.path,
        name: s.name,
        exists: s.exists,
        photos: s.photos,
        raws: s.raws,
        thumbs: s.thumbs,
        missing: s.missing.length,
        samples: s.samples.slice(0, 6),
      }
    }),
  )
}

/** Template collections used by recent albums, most used first, with their template counts. */
async function knownCollections() {
  const uses = new Map() // collection → album names
  for (const r of await listRecent()) {
    if (!r.available) continue
    try {
      const d = JSON.parse(await fs.promises.readFile(path.join(r.path, 'project.json'), 'utf8'))
      for (const c of (d.workspace || d).templateTokens || []) {
        if (!uses.has(c)) uses.set(c, [])
        uses.get(c).push(r.name)
      }
    } catch (_) {
      /* an album that can't be read just doesn't vote */
    }
  }
  const list = await Promise.all(
    [...uses].map(async ([p, albums]) => {
      const exists = await fs.promises.access(p).then(
        () => true,
        () => false,
      )
      const templates = exists ? (await listTemplates([p])).length : 0
      return { path: p, name: path.basename(p), exists, templates, albums }
    }),
  )
  return list.sort((a, b) => b.albums.length - a.albums.length || a.name.localeCompare(b.name))
}

/** Template counts of folders the user picked as collections. */
async function inspectCollections({ paths }) {
  if (!Array.isArray(paths)) throw new Error('missing `paths`')
  return Promise.all(
    paths.map(async (p) => {
      const exists = await fs.promises.stat(p).then(
        (s) => s.isDirectory(),
        () => false,
      )
      return {
        path: p,
        name: path.basename(p),
        exists,
        templates: exists ? (await listTemplates([p])).length : 0,
        albums: [],
      }
    }),
  )
}

/** A suggested name and place for an album of these photo folders. */
function suggestAlbum({ photoFolders }) {
  const first = (photoFolders || [])[0]
  if (!first) return { name: 'New Album', parent: null }
  const base = path.basename(first)
  const name = base.replace(/(^|[\s_-])([a-z])/g, (_, s, c) => s + c.toUpperCase()) + ' Album'
  return { name, parent: path.dirname(first) }
}

let creating = null

/**
 * Create an album. Thumbnails first (progress as `album.creating` events), then the project,
 * then (optionally) a first plan of `spreads` spreads.
 * @param {{ name: string, parent: string, photoFolders: string[], templateCollections: string[],
 *   outputFolder?: string|null, autoFill?: { desiredSheets: number, chronological?: boolean } | null }} p
 * @param {{ emit: (event: string, data: object) => void }} ctx
 */
async function createAlbum(p, { emit }) {
  validateCreateInput(p)
  if (creating) throw new Error('An album is already being created.')
  const name = String(p.name || '').trim()
  if (!name) throw new Error('Give the album a name.')
  if (BAD_NAME.test(name) || name === '.' || name === '..') throw new Error('An album name can’t contain / : or \\.')
  if (!p.parent) throw new Error('Choose where to save the album.')
  const parentOk = await fs.promises.stat(p.parent).then(
    (s) => s.isDirectory(),
    () => false,
  )
  if (!parentOk) throw new Error(`The folder ${p.parent} isn’t there. The drive may be disconnected.`)
  const folder = path.join(p.parent, name)
  if (
    await fs.promises.access(path.join(folder, 'project.json')).then(
      () => true,
      () => false,
    )
  ) {
    throw new Error(`There is already an album called “${name}” there. Open it from Albums, or choose another name.`)
  }
  const photoFolders = [...new Set(p.photoFolders || [])]
  if (!photoFolders.length) throw new Error('Add at least one photo folder.')
  for (const f of photoFolders) {
    if (
      !(await fs.promises.stat(f).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    )
      throw new Error(`The photo folder ${f} isn’t there.`)
    if (path.resolve(f) === path.resolve(folder))
      throw new Error('The album can’t be saved inside its own photo folder with the same name.')
  }
  const collections = [...new Set(p.templateCollections || [])]
  if (p.autoFill && !collections.length) throw new Error('Auto-fill needs at least one template collection.')

  const job = { cancelled: false }
  creating = job
  try {
    // 1. Thumbnails, folder by folder.
    const thumbFailures = []
    for (let i = 0; i < photoFolders.length; i++) {
      const f = photoFolders[i]
      emit('album.creating', {
        stage: 'thumbs',
        folder: path.basename(f),
        index: i + 1,
        folders: photoFolders.length,
        done: 0,
        total: 0,
      })
      const r = await ensureThumbnails(
        f,
        (pr) =>
          emit('album.creating', {
            stage: 'thumbs',
            folder: path.basename(f),
            index: i + 1,
            folders: photoFolders.length,
            ...pr,
          }),
        job,
      )
      thumbFailures.push(...r.failed)
    }

    // 2. The project, as the Electron app writes it.
    emit('album.creating', { stage: 'project' })
    const outputFolder = p.outputFolder || path.join(folder, 'exports')
    await fs.promises.mkdir(path.join(folder, 'proofs'), { recursive: true })
    await fs.promises.mkdir(outputFolder, { recursive: true })
    const project = {
      version: 1,
      savedAt: new Date().toISOString(),
      workspace: {
        imageTokens: photoFolders,
        templateTokens: collections,
        wallpaperTokens: [],
        pngTokens: [],
        maskTokens: [],
        highResTokens: [],
        wpHighResTokens: [],
        imageRotations: {},
        imageAdjustments: {},
        imagePlacements: {},
        pageOverlays: {},
        pageBackgrounds: {},
        pageLayerEdits: {},
        outputToken: outputFolder,
      },
      albumPages: { 1: { id: newSpreadId(), photos: [], template: null } },
      totalActivePages: 1,
      renderHashes: {},
    }
    validateProject(project)
    const temporary = path.join(folder, `.project-${crypto.randomUUID()}.json`)
    let handle
    try {
      handle = await fs.promises.open(temporary, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(project, null, 2))
      await handle.sync()
      await handle.close()
      handle = null
      // Another creator can publish after the initial existence check while thumbnails are
      // being made. Publication must atomically refuse its project rather than replace it.
      await exclusiveRename.renameExclusive(temporary, path.join(folder, 'project.json'))
    } finally {
      if (handle) await handle.close()
      await fs.promises.unlink(temporary).catch(() => {})
    }

    // 3. A first plan.
    let report = null
    if (p.autoFill) {
      emit('album.creating', { stage: 'plan', spreads: p.autoFill.desiredSheets })
      const r = await updateAlbum({
        album: folder,
        ops: [
          {
            op: 'autoFill',
            mode: 'desired',
            desiredSheets: p.autoFill.desiredSheets,
            chronological: p.autoFill.chronological !== false,
          },
        ],
      })
      report = r.report
    }
    const album = await migrateAlbum({ album: folder })
    await rememberAlbum(album)
    return { album, report, thumbFailures: thumbFailures.slice(0, 20), thumbFailed: thumbFailures.length }
  } finally {
    creating = null
  }
}

/**
 * Change an album's photo folders and template collections (one undo step). Folders new to the
 * album get their missing thumbnails first, with progress as `album.folders` events.
 * @param {{ album: string, photoFolders?: string[], templateCollections?: string[] }} p
 */
async function setAlbumFolders(p, { emit }) {
  if (!p.album) throw new Error('missing `album`')
  const requested = []
  if (p.photoFolders !== undefined) requested.push({ op: 'setPhotoFolders', folders: p.photoFolders })
  if (p.templateCollections !== undefined) requested.push({ op: 'setCollections', collections: p.templateCollections })
  if (requested.length) validateOperations(requested)
  const before = await openAlbum({ path: p.album })
  const ops = []
  if (Array.isArray(p.photoFolders)) {
    const known = new Set(before.photoFolders.map((f) => f.path))
    const added = p.photoFolders.filter((f) => !known.has(f))
    for (let i = 0; i < added.length; i++) {
      const f = added[i]
      if (
        !(await fs.promises.stat(f).then(
          (st) => st.isDirectory(),
          () => false,
        ))
      )
        throw new Error(`The photo folder ${f} isn’t there.`)
      emit('album.folders', {
        stage: 'thumbs',
        folder: path.basename(f),
        index: i + 1,
        folders: added.length,
        done: 0,
        total: 0,
      })
      await ensureThumbnails(f, (pr) =>
        emit('album.folders', {
          stage: 'thumbs',
          folder: path.basename(f),
          index: i + 1,
          folders: added.length,
          ...pr,
        }),
      )
    }
    ops.push({ op: 'setPhotoFolders', folders: p.photoFolders })
  }
  if (Array.isArray(p.templateCollections)) ops.push({ op: 'setCollections', collections: p.templateCollections })
  if (!ops.length) throw new Error('Nothing to change.')
  return updateAlbum({ album: p.album, ops })
}

module.exports = { inspectFolders, inspectCollections, knownCollections, suggestAlbum, createAlbum, setAlbumFolders }
