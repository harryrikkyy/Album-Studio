'use strict'

// ⚡ Reverse lookup: photoId → Set<pageNumber>.
//
// The album (albumPages) is the source of truth and lives in the store; this
// module owns only the *derived* index and the four ops that keep it in sync.
// It eliminates the O(n×m) scan in applyGlobalRotation and other placement
// queries that need "which pages is this photo on?" cheaply.
//
// Consumers (curation, folder refresh, render queue, project I/O) receive the
// individual methods injected from the composition root, exactly as they did
// when this lived inline in main.js.
function createPhotoPageMap(store) {
    const map = {}

    function add(photoId, pageNum) {
        if (!map[photoId]) map[photoId] = new Set()
        map[photoId].add(pageNum)
    }

    function remove(photoId, pageNum) {
        if (map[photoId]) map[photoId].delete(pageNum)
    }

    function clear() {
        Object.keys(map).forEach((k) => delete map[k])
    }

    // Rebuild the whole index from the current album. Page keys are strings on
    // the albumPages object; store them as numbers so callers can pass numeric
    // page numbers to remove().
    function rebuild() {
        clear()
        Object.entries(store.get('albumPages')).forEach(([pageNum, page]) => {
            if (page && page.photos) {
                page.photos.forEach((p) => add(p.id, parseInt(pageNum, 10)))
            }
        })
    }

    function get(photoId) {
        return map[photoId]
    }

    return { add, remove, clear, rebuild, get }
}

module.exports = { createPhotoPageMap }
