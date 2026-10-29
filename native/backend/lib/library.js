// library.js — the user's template collections across albums: the ones their albums use, plus any
// added here, and which of them new albums start with. Kept in the app's data folder
// (library.json); it remembers folders only, and never copies, moves or deletes them.

'use strict'

const fs = require('fs')
const path = require('path')
const { writeAtomic } = require('./cache')
const { listRecent } = require('./recent')
const { listTemplates } = require('./templates')

const file = () => path.join(require('./recent').dataDir(), 'library.json')

async function readLibrary() {
  try {
    const d = JSON.parse(await fs.promises.readFile(file(), 'utf8'))
    return {
      added: Array.isArray(d.added) ? d.added : [],
      hidden: Array.isArray(d.hidden) ? d.hidden : [],
      defaults: Array.isArray(d.defaults) ? d.defaults : null,
    }
  } catch (_) {
    return { added: [], hidden: [], defaults: null }
  }
}

/** Collections used by recent albums: path → album names. */
async function usedByAlbums() {
  const uses = new Map()
  for (const r of await listRecent()) {
    if (!r.available) continue
    try {
      const d = JSON.parse(await fs.promises.readFile(path.join(r.path, 'project.json'), 'utf8'))
      for (const c of (d.workspace || d).templateTokens || []) {
        if (!uses.has(c)) uses.set(c, [])
        uses.get(c).push(r.name)
      }
    } catch (_) {
      /* an unreadable album just doesn't count */
    }
  }
  return uses
}

/**
 * Every collection the library knows, with its template count, the albums using it, and
 * whether new albums start with it (`isDefault`; all of them until the user chooses).
 */
async function libraryCollections() {
  const lib = await readLibrary()
  const uses = await usedByAlbums()
  const paths = [...new Set([...uses.keys(), ...lib.added])].filter((p) => !lib.hidden.includes(p))
  const list = await Promise.all(
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
        albums: uses.get(p) || [],
        isDefault: lib.defaults ? lib.defaults.includes(p) : true,
      }
    }),
  )
  list.sort((a, b) => b.albums.length - a.albums.length || a.name.localeCompare(b.name))
  return { collections: list, defaultsChosen: !!lib.defaults }
}

/** Add collections to the library (they show even before an album uses them). */
async function addCollections({ paths }) {
  if (!Array.isArray(paths)) throw new Error('missing `paths`')
  const lib = await readLibrary()
  for (const p of paths) {
    if (!lib.added.includes(p)) lib.added.push(p)
    lib.hidden = lib.hidden.filter((h) => h !== p)
  }
  await save(lib)
  return libraryCollections()
}

/** Take a collection out of the library's list (its folder is left alone). */
async function removeCollection({ path: p }) {
  const lib = await readLibrary()
  lib.added = lib.added.filter((a) => a !== p)
  if (!lib.hidden.includes(p)) lib.hidden.push(p)
  if (lib.defaults) lib.defaults = lib.defaults.filter((d) => d !== p)
  await save(lib)
  return libraryCollections()
}

/** Which collections new albums start with. */
async function setDefaults({ paths }) {
  if (!Array.isArray(paths)) throw new Error('missing `paths`')
  const lib = await readLibrary()
  lib.defaults = [...new Set(paths)]
  await save(lib)
  return libraryCollections()
}

async function save(lib) {
  await writeAtomic(file(), JSON.stringify(lib, null, 2))
}

/** One collection's templates (for browsing). */
async function collectionTemplates({ path: p }) {
  if (!p) throw new Error('missing `path`')
  return listTemplates([p])
}

module.exports = { libraryCollections, addCollections, removeCollection, setDefaults, collectionTemplates, readLibrary }
