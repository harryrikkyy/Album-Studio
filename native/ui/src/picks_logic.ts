// picks_logic.ts — choosing a shoot's best photos from their scores (tested in
// test/picks_logic.test.ts). The rules are the Electron app's curation engine (src/curation.js):
// drop blurry and badly exposed frames, keep the sharpest of each group of near-duplicates, then
// optionally cap landscape and portrait counts. One change: duplicates are looked for among
// nearby frames only (a burst), so two similar-looking moments hours apart aren't merged.

export interface Scored {
  thumb: string
  base: string
  folder: string
  orient: 'h' | 'v'
  sharpness: number
  exposure: number
  blackPct: number
  whitePct: number
  hash: string
  error?: string
}

export interface PickOptions {
  minSharpness: number
  minExposure: number
  /** Bits of the 64-bit picture hash two frames may differ by and still be "the same". */
  dupThreshold: number
  /** How many frames back a duplicate may be. */
  window: number
  targetH: number | null
  targetV: number | null
}

export const DEFAULT_PICKS: PickOptions = {
  minSharpness: 80,
  minExposure: 0.25,
  dupThreshold: 8,
  window: 12,
  targetH: null,
  targetV: null,
}

export type Reason = 'blur' | 'exposure' | 'duplicate' | 'cap' | 'error' | 'yours'
export interface Picked {
  keep: Scored[]
  drop: Map<string, Reason>
  groups: number
}

const key = (p: Scored) => `${p.folder}/${p.base}`

/** Bits that differ between two 16-hex-digit hashes. */
export function hamming(a: string, b: string): number {
  let d = 0
  for (let i = 0; i < 16; i++) {
    let v = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)
    while (v) {
      d += v & 1
      v >>= 1
    }
  }
  return d
}

/** Groups of near-duplicates among nearby frames; the sharpest frame represents each group. */
export function groupDuplicates(
  list: Scored[],
  threshold: number,
  window: number,
): { rep: Scored; members: Scored[]; last: number }[] {
  const groups: { rep: Scored; members: Scored[]; last: number }[] = []
  list.forEach((p, i) => {
    const near = groups.find((g) => i - g.last <= window && hamming(p.hash, g.rep.hash) <= threshold)
    if (near) {
      near.members.push(p)
      near.last = i
      if (p.sharpness > near.rep.sharpness) near.rep = p
    } else groups.push({ rep: p, members: [p], last: i })
  })
  return groups
}

/**
 * The picks. `yours`: photos the user kept (true) or dropped (false) by hand, which win over the
 * rules. Photos are taken in shoot order (folder, then file name).
 */
export function choose(all: Scored[], o: PickOptions, yours: ReadonlyMap<string, boolean> = new Map()): Picked {
  const drop = new Map<string, Reason>()
  const ordered = all
    .slice()
    .sort((a, b) => a.folder.localeCompare(b.folder) || a.base.localeCompare(b.base, undefined, { numeric: true }))
  const survivors: Scored[] = []
  for (const p of ordered) {
    if (p.error) drop.set(key(p), 'error')
    else if (p.sharpness < o.minSharpness) drop.set(key(p), 'blur')
    else if (p.exposure < o.minExposure) drop.set(key(p), 'exposure')
    else survivors.push(p)
  }
  const groups = groupDuplicates(survivors, o.dupThreshold, o.window)
  let keep: Scored[] = []
  for (const g of groups) {
    keep.push(g.rep)
    for (const m of g.members) if (m !== g.rep) drop.set(key(m), 'duplicate')
  }
  if (o.targetH != null || o.targetV != null) {
    const quality = (p: Scored) => p.sharpness * p.exposure
    const capped: Scored[] = []
    for (const orient of ['h', 'v'] as const) {
      const cap = orient === 'h' ? o.targetH : o.targetV
      const these = keep.filter((p) => p.orient === orient).sort((a, b) => quality(b) - quality(a))
      const kept = cap == null ? these : these.slice(0, cap)
      for (const p of these.slice(kept.length)) drop.set(key(p), 'cap')
      capped.push(...kept)
    }
    keep = capped
  }
  // The user's own choices last.
  const keepSet = new Set(keep.map(key))
  for (const p of ordered) {
    const want = yours.get(key(p))
    if (want === true && !keepSet.has(key(p))) {
      keepSet.add(key(p))
      drop.delete(key(p))
    }
    if (want === false && keepSet.has(key(p))) {
      keepSet.delete(key(p))
      drop.set(key(p), 'yours')
    }
  }
  return { keep: ordered.filter((p) => keepSet.has(key(p))), drop, groups: groups.length }
}

export { key as pickKey }
