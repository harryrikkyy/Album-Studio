// account.ts — the Creative Hubb account: whether Album Studio may open, signing in (in the
// browser) and out. The helper refuses album work until the check passes; this decides what the
// window shows.

import { effect, signal } from '@preact/signals'
import { call, inShell } from './bridge'
import { expiryNote, type Account } from './account_logic'
import { toast } from './state'

/** null while the first check runs. */
export const account = signal<Account | null>(null)
/** True while the user signs in in their browser. */
export const signingIn = signal(false)
/** The last sign-in failure, shown on the sign-in screen. */
export const accountError = signal<string | null>(null)
export const checking = signal(false)

function settle(a: Account) {
  const was = account.value?.state
  account.value = a
  if (a.state === 'allowed' && was !== 'allowed') {
    const note = expiryNote(a.daysLeft)
    if (note && !a.bypass) toast('info', note, 9000)
  }
}

export async function checkAccount(refresh = false): Promise<void> {
  // The interface opened in a browser for development has no helper and nothing to check.
  if (!inShell) {
    settle({ state: 'allowed', configured: true, bypass: true, daysLeft: 999 })
    return
  }
  checking.value = true
  try {
    settle(await call('account.status', refresh ? { refresh } : {}, 60_000))
  } catch (e) {
    settle({ state: 'blocked', reason: 'error', message: (e as Error).message, configured: true })
  } finally {
    checking.value = false
  }
}

export async function signIn(): Promise<void> {
  accountError.value = null
  signingIn.value = true
  try {
    settle(await call('account.signIn', {}, 200_000))
    void call('shell.activate').catch(() => {})
  } catch (e) {
    const m = (e as Error).message
    if (!/cancelled/i.test(m)) accountError.value = m
  } finally {
    signingIn.value = false
  }
}

export function cancelSignIn(): void {
  void call('account.cancelSignIn').catch(() => {})
}

export async function retryAccount(): Promise<void> {
  accountError.value = null
  checking.value = true
  try {
    settle(await call('account.retry', {}, 60_000))
  } catch (e) {
    accountError.value = (e as Error).message
  } finally {
    checking.value = false
  }
}

export async function signOut(): Promise<void> {
  try {
    settle(await call('account.signOut'))
  } catch (e) {
    toast('error', (e as Error).message)
  }
}

/** Resolves once the account lets the app open (deep links wait for it). */
export function whenAllowed(): Promise<void> {
  return new Promise((resolve) => {
    const stop = effect(() => {
      if (account.value?.state === 'allowed') {
        queueMicrotask(() => stop())
        resolve()
      }
    })
  })
}
