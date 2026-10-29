// The interface consumes the canonical backend DTOs. Bounds and finite numbers are
// enforced by the bridge's runtime validator before these values enter state.
export type {
  Adjust,
  Album,
  Photo,
  PhotoFolder,
  Placement,
  RecentAlbum,
  Spread,
  SpreadTemplate,
} from '../../contracts/types'
export type Orient = 'h' | 'v'
