// types.ts — the album model the background helper returns (native/backend/lib/album.js).

export type Orient = 'h' | 'v'

export interface Photo {
  id: string
  base: string
  folder: string
  thumb: string
  original: string | null
  orient: Orient | null
  width: number | null
  height: number | null
  /** The user's turn, clockwise: 0, 90, 180 or 270. */
  rotation: number
  usedOn: number[]
}

export interface SpreadTemplate {
  id: string
  name: string | null
  h: number | null
  v: number | null
  file: string | null
  preview: string | null
}

export interface Spread {
  n: number
  photoIds: string[]
  missingPhotos: number
  template: SpreadTemplate | null
  proof: string | null
  sheet: string | null
  edited: boolean
}

export interface PhotoFolder {
  path: string
  name: string
  exists: boolean
  hasThumbs: boolean
  count: number
}

export interface Album {
  path: string
  file: string
  name: string
  savedAt: string | null
  outputFolder: string | null
  photoFolders: PhotoFolder[]
  templateCollections: { path: string; name: string }[]
  spreads: Spread[]
  photos: Record<string, Photo>
  pool: string[]
  stats: { spreads: number; photos: number; used: number; planned: number }
}

export interface RecentAlbum {
  path: string
  name: string
  openedAt: string
  spreads: number
  photos: number
  cover: string | null
  available: boolean
}
