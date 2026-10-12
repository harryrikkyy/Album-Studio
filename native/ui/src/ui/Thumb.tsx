// Thumb.tsx — a photo's thumbnail as the user turned it. A quarter turn swaps the box the image
// is sized to (the wrapper is a size container), so the turned picture still covers its frame.

import { fileUrl } from '../bridge'
import { turnOf } from '../plan_logic'
import type { Photo } from '../types'

export function Thumb({ p, alt = '', lazy = true }: { p: Photo; alt?: string; lazy?: boolean }) {
  const t = turnOf(p)
  return (
    <span class={`thumb ${t ? `thumb--turn${t}` : ''}`}>
      <img src={fileUrl(p.thumb)} alt={alt} loading={lazy ? 'lazy' : undefined} decoding="async" draggable={false} />
    </span>
  )
}
