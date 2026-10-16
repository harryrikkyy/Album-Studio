/** Bound the mounted photo grid while keeping selection and search in full album order. */
export const PHOTO_PAGE_SIZE = 120

export function photoWindow<T extends { base: string }>(photos: readonly T[], query: string, page: number) {
  const text = query.trim().toLocaleLowerCase()
  const matches = text ? photos.filter(p => p.base.toLocaleLowerCase().includes(text)) : photos
  const pages = Math.max(1, Math.ceil(matches.length / PHOTO_PAGE_SIZE))
  const index = Math.min(pages - 1, Math.max(0, Math.floor(page) || 0))
  const offset = index * PHOTO_PAGE_SIZE
  return { matches, pages, index, offset, visible: matches.slice(offset, offset + PHOTO_PAGE_SIZE) }
}

/** Focus moves without changing the multi-selection; Home/End can reach the entire result. */
export function photoKeyIndex(key: string, index: number, total: number): number | null {
  if (!total) return null
  const next = key === 'Home' ? 0 : key === 'End' ? total - 1
    : key === 'ArrowRight' || key === 'ArrowDown' ? index + 1
      : key === 'ArrowLeft' || key === 'ArrowUp' ? index - 1
        : key === 'PageDown' ? index + PHOTO_PAGE_SIZE : key === 'PageUp' ? index - PHOTO_PAGE_SIZE : null
  return next === null ? null : Math.max(0, Math.min(total - 1, next))
}
