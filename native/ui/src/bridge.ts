// bridge.ts — the interface's only door to the outside: the native shell and, through it, the
// background helper. Every call is asynchronous; replies match requests by id.

type Reply = { id: number; ok: boolean; result?: unknown; error?: string }
type ShellEvent = { event: string; data?: unknown }

declare global {
  interface Window {
    ipc?: { postMessage(message: string): void }
    __asReply?: (reply: Reply) => void
    __asEvent?: (event: ShellEvent) => void
    /** Where local files are served from: the shell's as://file, or the browser preview's /file. */
    __asFileBase?: string
  }
}

/** True inside Album Studio's window; false in a plain browser (design previews, tests). */
export const inShell = typeof window !== 'undefined' && !!window.ipc

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>()
let nextId = 1

if (typeof window !== 'undefined') {
  window.__asReply = (reply) => {
    const p = pending.get(reply.id)
    if (!p) return
    pending.delete(reply.id)
    clearTimeout(p.timer)
    if (reply.ok) p.resolve(reply.result)
    else p.reject(new Error(reply.error || 'Something went wrong.'))
  }
  window.__asEvent = (e) => {
    for (const fn of listeners.get(e.event) ?? []) fn(e.data)
    for (const fn of listeners.get('*') ?? []) fn(e)
  }
}

/** Call a shell or helper method. Rejects with a user-readable message. */
export function call<T = unknown>(method: string, params: object = {}, timeoutMs = 120_000): Promise<T> {
  if (!inShell) return Promise.reject(new Error('Album Studio’s engine isn’t running (this page is open outside the app).'))
  return new Promise<T>((resolve, reject) => {
    const id = nextId++
    const timer = window.setTimeout(() => {
      pending.delete(id)
      reject(new Error(`No answer from Album Studio after ${Math.round(timeoutMs / 1000)} s (${method}).`))
    }, timeoutMs)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    window.ipc!.postMessage(JSON.stringify({ id, method, params }))
  })
}

const listeners = new Map<string, Set<(data: unknown) => void>>()

/** Listen for an unsolicited event (progress, completion). Returns the unsubscribe function. */
export function onEvent(name: string, fn: (data: unknown) => void): () => void {
  const set = listeners.get(name) ?? new Set()
  set.add(fn)
  listeners.set(name, set)
  return () => set.delete(fn)
}

/** A local image (thumbnail, proof, preview) as a URL the web view can load. */
export function fileUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  const base = (typeof window !== 'undefined' && window.__asFileBase) || 'as://file'
  return base + path.split('/').map(encodeURIComponent).join('/')
}
