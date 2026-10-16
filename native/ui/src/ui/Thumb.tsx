// Thumb.tsx — a photo's thumbnail as the user turned it. A quarter turn swaps the box the image
// is sized to (the wrapper is a size container), so the turned picture still covers its frame.

import { fileUrl } from '../bridge'
import { ImageOff } from 'lucide-preact'
import { useEffect, useState } from 'preact/hooks'
import { turnOf } from '../plan_logic'
import type { Photo } from '../types'

export function Thumb({ p, alt = '', lazy = true }: { p: Photo; alt?: string; lazy?: boolean }) {
  const t = turnOf(p)
  const [failed, setFailed] = useState(false)
  // A refreshed album retries a failed thumbnail even if its path did not change.
  useEffect(() => setFailed(false), [p])
  return (
    <span class={`thumb ${t ? `thumb--turn${t}` : ''}`}>
      {failed ? <span class="thumb__missing" role="img" aria-label={`${p.base}: thumbnail unavailable`} title="Thumbnail unavailable. Reconnect its drive or reopen the album to try again."><ImageOff size={18} aria-hidden="true" /><span>Preview unavailable</span></span> : <img src={fileUrl(p.thumb)} alt={alt} loading={lazy ? 'lazy' : undefined} decoding="async" draggable={false} onError={() => setFailed(true)} />}
    </span>
  )
}
