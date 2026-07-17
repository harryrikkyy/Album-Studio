'use strict'

// ⚡ Single idempotent "apply album state → view" function.
//
// Rebuilds the `.used` markers (and clears stale opacity) on Tab 1 source
// thumbnails and Tab 6 photo cards purely from albumPages. Previously this
// loop was copy-pasted at ~6 call sites (history apply, refreshTab,
// clear-album, restore, …) and the partial copies drifted, causing
// stale-marker bugs. Every mutation path now funnels through this.
//
// DOM-owning and store-reading; injected into the feature modules that mutate
// the album (album_pages, folder_refresh, workspace_actions) exactly as it was
// when this lived inline in main.js. Exercised by the undo-redo and workspace
// E2E specs.
function createViewSync(store) {
    function syncViewToState() {
        // 1. Clear every source thumbnail (Tab 1) + photo card (Tab 6).
        document.querySelectorAll('.thumb-red').forEach((img) => {
            img.classList.remove('used')
            img.style.opacity = '1'
        })
        document.querySelectorAll('#photosGrid .wp-card').forEach((c) => c.classList.remove('used'))

        // 2. Re-mark everything currently placed in the album.
        Object.values(store.get('albumPages')).forEach((page) => {
            if (!page || !page.photos) return
            page.photos.forEach((p) => {
                const r = document.getElementById(p.id)
                if (r) r.classList.add('used')
                const c = document.getElementById('pt_' + p.id)
                if (c) c.classList.add('used')
            })
        })
    }

    return { syncViewToState }
}

module.exports = { createViewSync }
