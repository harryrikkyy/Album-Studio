/** One ordered operation queue; the album association is part of each operation. */
export function albumQueue<A>(current: () => A | null) {
  let chain: Promise<unknown> = Promise.resolve()
  return function enqueue<T>(work: (album: A) => Promise<T>): Promise<T | null> {
    const album = current()
    if (!album) return Promise.resolve(null)
    const run = () => work(album)
    const next = chain.then(run, run)
    chain = next.catch(() => {})
    return next
  }
}
