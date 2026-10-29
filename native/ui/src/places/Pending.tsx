// Pending.tsx — the places whose engine isn't wired into the new app yet. They say exactly what
// they will do, so nothing pretends to work.

import type { Place } from '../state'

const COPY: Partial<Record<Place, { title: string; text: string; items: string[] }>> = {
  deliver: {
    title: 'Deliver',
    text: 'Print-ready sheets and client proofs, built by PhotoCraft without Photoshop.',
    items: [
      'Render spreads to PSD (all, or the ones you pick)',
      'JPEG high and low resolution',
      'Proof PDF of the low-resolution JPEGs',
      'Client gallery',
      'Progress for every job, even while you keep working',
    ],
  },
  library: {
    title: 'Library',
    text: 'Your templates, wallpapers, PNG frames and masks, organised as collections.',
    items: [
      'Add or remove collections',
      'Previews for every template',
      'Match templates to a spread’s photos',
      'Saved layouts',
    ],
  },
  tools: {
    title: 'Tools',
    text: 'The utilities around an album.',
    items: [
      'Renamer for print-lab naming',
      'Best-picks curation',
      'Thumbnails for new photo folders',
      'Retouch actions',
    ],
  },
}

export function Pending({ which }: { which: Place }) {
  const c = COPY[which]
  if (!c) return null
  return (
    <section class="place place--pending" aria-labelledby="pending-title">
      <header class="place__head">
        <div>
          <h1 id="pending-title" class="place__title">
            {c.title}
          </h1>
          <p class="place__sub">{c.text}</p>
        </div>
      </header>
      <div class="pending">
        <p class="pending__lead">Being moved into the new Album Studio. Until then, use the current app for these:</p>
        <ul class="pending__list">
          {c.items.map((i) => (
            <li>{i}</li>
          ))}
        </ul>
      </div>
    </section>
  )
}
