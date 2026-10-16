// bridge.ts — the interface's only door to the outside: the native shell and, through it, the
// background helper. Every call is asynchronous; replies match requests by id.

import { validateDefinition, validateEvent, validateReply, validateRequest } from '../../contracts/runtime.js'
import type { Definitions, EventData, EventName, MethodName, MethodParams, MethodResult } from '../../contracts/types'

type FailureReply = Definitions['FailureReply']
export class RemoteError extends Error {
  readonly code: string
  readonly details: Omit<FailureReply, 'id' | 'ok'>
  constructor(reply: FailureReply) {
    super(reply.error)
    const { id: _id, ok: _ok, ...details } = reply
    this.name = 'RemoteError'; this.code = reply.code ?? 'OPERATION_FAILED'; this.details = details
  }
}

declare global {
  interface Window {
    ipc?: { postMessage(message: string): void }
    __asReply?: (reply: unknown) => void
    __asEvent?: (event: unknown) => void
    /** Where local files are served from: the shell's as://file, or the browser preview's /file. */
    __asFileBase?: string
  }
}

/** True inside Album Studio's window; false in a plain browser (design previews, tests). */
export const inShell = typeof window !== 'undefined' && !!window.ipc

const pending = new Map<number, { method: MethodName; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>()
let nextId = 1
const MAX_PENDING = 128
const MAX_TIMEOUT = 6 * 60 * 60_000
const listeners = new Map<string, Set<(data: unknown) => void>>()
const protocolListeners = new Set<(error: Error) => void>()

/** Surface channel errors without passing unvalidated payloads to workflow listeners. */
export function onProtocolError(fn: (error: Error) => void): () => void { protocolListeners.add(fn); return () => protocolListeners.delete(fn) }
function protocolError(error: unknown) {
  const failure = error instanceof Error ? error : new Error('Album Studio returned an unsupported message.')
  for (const fn of protocolListeners) { try { fn(failure) } catch (error) { console.error('Protocol error listener failed', error) } }
}

if (typeof window !== 'undefined') {
  window.__asReply = (reply) => {
    let envelope
    try { envelope = validateDefinition('ReplyEnvelope', reply) }
    catch (error) {
      // An invalid id cannot be matched safely. Settle all waiters visibly rather than
      // leaving them hanging until long operation timeouts expire.
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error as Error) }
      pending.clear(); protocolError(error); return
    }
    const p = pending.get(envelope.id)
    if (!p) return
    pending.delete(envelope.id)
    clearTimeout(p.timer)
    try {
      const validated = validateReply(p.method, envelope)
      if (validated.ok) p.resolve(validated.result)
      else p.reject(new RemoteError(validated))
    } catch (error) { p.reject(error as Error); protocolError(error) }
  }
  window.__asEvent = (e) => {
    let validated
    try { validated = validateEvent(e) } catch (error) { protocolError(error); return }
    const data = validated.data === undefined ? {} : validated.data
    for (const fn of listeners.get(validated.event) ?? []) { try { fn(data) } catch (error) { protocolError(error) } }
    for (const fn of listeners.get('*') ?? []) { try { fn(validated) } catch (error) { protocolError(error) } }
  }
}

/** Call a shell or helper method. Rejects with a user-readable message. */
export function call<M extends MethodName>(method: M, ...args: {} extends MethodParams<M> ? [params?: MethodParams<M>, timeoutMs?: number] : [params: MethodParams<M>, timeoutMs?: number]): Promise<MethodResult<M>>
export function call(method: MethodName, params: object = {}, timeoutMs = 120_000): Promise<unknown> {
  if (!inShell) return Promise.reject(new Error('Album Studio’s engine isn’t running (this page is open outside the app).'))
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT) return Promise.reject(new Error('Choose a request timeout from 1 ms to six hours.'))
  if (pending.size >= MAX_PENDING) return Promise.reject(new Error('Too many requests are running. Wait for a current operation to finish.'))
  if (nextId > Number.MAX_SAFE_INTEGER) { if (pending.size) return Promise.reject(new Error('Wait for current requests before continuing.')); nextId = 1 }
  return new Promise((resolve, reject) => {
    const id = nextId++
    const request = validateRequest({ id, method, params }), text = JSON.stringify(request)
    if (new TextEncoder().encode(text).byteLength > 8 * 1024 * 1024) { reject(new Error('This request exceeds the supported 8 MiB limit.')); return }
    const timer = window.setTimeout(() => {
      pending.delete(id)
      reject(new Error(`No answer from Album Studio after ${Math.round(timeoutMs / 1000)} s (${method}).`))
    }, timeoutMs)
    pending.set(id, { method, resolve, reject, timer })
    try { window.ipc!.postMessage(text) }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error) }
  })
}

/** Listen for an unsolicited event (progress, completion). Returns the unsubscribe function. */
export function onEvent<E extends EventName>(name: E, fn: (data: EventData<E>) => void): () => void
export function onEvent(name: '*', fn: (data: unknown) => void): () => void
export function onEvent(name: string, fn: (data: never) => void): () => void {
  const set = listeners.get(name) ?? new Set()
  const listener = fn as (data: unknown) => void
  set.add(listener)
  listeners.set(name, set)
  return () => set.delete(listener)
}

/** A local image (thumbnail, proof, preview) as a URL the web view can load. */
export function fileUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  const base = (typeof window !== 'undefined' && window.__asFileBase) || 'as://file'
  return base + path.split('/').map(encodeURIComponent).join('/')
}
