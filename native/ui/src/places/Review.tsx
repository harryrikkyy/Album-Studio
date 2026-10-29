// Review.tsx — every spread at once, large: check the album's flow before delivering it.

import { ImageOff } from 'lucide-preact'
import { plural, templateLabel } from '../format'
import { proofUrl } from '../edit'
import { album, goToSpread, place } from '../state'

export function Review() {
  const a = album.value!
  return (
    <section class="place place--review" aria-labelledby="review-title">
      <header class="place__head">
        <div>
          <h1 id="review-title" class="place__title">
            Review
          </h1>
          <p class="place__sub">{plural(a.spreads.length, 'spread')} · click a spread to work on it</p>
        </div>
      </header>
      <ol class="review-grid">
        {a.spreads.map((s, i) => (
          <li key={s.n}>
            <button
              type="button"
              class="review-card"
              onClick={() => {
                goToSpread(i)
                place.value = 'plan'
              }}
              aria-label={`Spread ${s.n}: ${plural(s.photoIds.length, 'photo')}, ${templateLabel(s.template?.name)}`}
            >
              <span class="review-card__img">
                {s.proof ? (
                  <img src={proofUrl(s)} alt="" loading="lazy" decoding="async" />
                ) : (
                  <ImageOff size={22} strokeWidth={1.4} />
                )}
              </span>
              <span class="review-card__cap">
                <span class="review-card__n">{s.n}</span>
                <span class="review-card__meta">
                  {plural(s.photoIds.length, 'photo')} · {templateLabel(s.template?.name)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
