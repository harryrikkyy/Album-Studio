/** Whole-album delivery requires every spread; PDF-only also requires fresh review JPEGs. */
export function canDeliver(states: readonly string[] | null, kinds: { jpegs: boolean; pdf: boolean }, busy = false, rendering = false): boolean {
  if (busy || rendering || !states?.length || !kinds.jpegs && !kinds.pdf) return false
  if (states.some((state) => !['ready', 'todo', 'stale'].includes(state))) return false
  return kinds.jpegs || states.every((state) => state === 'ready')
}
