// format.ts — small, pure text helpers (tested in test/format.test.ts).

/** "1 spread", "23 spreads". */
export function plural(n: number, one: string, many = one + 's'): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else a date. */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const s = Math.round((now.getTime() - t.getTime()) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 7) return `${d} days ago`
  return t.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: t.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  })
}

/** The orientation signature of a spread: "6 H · 1 V". */
export function signature(h: number, v: number): string {
  const parts: string[] = []
  if (h) parts.push(`${h} H`)
  if (v) parts.push(`${v} V`)
  return parts.join(' · ') || 'Empty'
}

/** A file path shortened to its last `keep` parts: "…/Wedding Album/exports". */
export function shortPath(p: string | null | undefined, keep = 2): string {
  if (!p) return ''
  const parts = p.split('/').filter(Boolean)
  return parts.length <= keep ? p : '…/' + parts.slice(-keep).join('/')
}

/**
 * A template file name without its extension. A " (2)" suffix stays: in real collections it marks
 * a different design with the same frame layout, and without it the two look like one template.
 */
export function templateLabel(name: string | null | undefined): string {
  if (!name) return 'No template'
  return name.replace(/\.psd$/i, '')
}
