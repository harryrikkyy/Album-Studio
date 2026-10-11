// SignIn.tsx — the window before Album Studio opens: the subscription check, Google sign-in (it
// happens in the browser; this screen waits for it), and why an account can't open yet.

import { LoaderCircle, LogOut, RefreshCw } from 'lucide-preact'
import { call, inShell } from '../bridge'
import { account, accountError, cancelSignIn, checking, retryAccount, signIn, signingIn, signOut } from '../account'
import { explainBlocked } from '../account_logic'
import { Button } from '../ui/controls'

/** Google's "G", as its sign-in buttons show it. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

function GoogleButton({ label = 'Sign in with Google' }: { label?: string }) {
  return (
    <button type="button" class="gbtn" onClick={() => void signIn()} disabled={signingIn.value || checking.value}>
      <GoogleMark />
      <span>{label}</span>
    </button>
  )
}

export function SignIn() {
  const a = account.value
  // The window has no title bar of its own here: the top strip moves it.
  const drag = (e: MouseEvent) => {
    if (e.button === 0 && inShell) void call('shell.dragWindow').catch(() => {})
  }

  let body
  if (!a) {
    body = <p class="signin__status" role="status"><LoaderCircle size={16} class="spin" /> Checking your subscription…</p>
  } else if (signingIn.value) {
    body = (
      <div class="signin__wait" role="status">
        <p class="signin__status"><LoaderCircle size={16} class="spin" /> Finish signing in in your browser</p>
        <p class="signin__text">Choose your Google account on the page that opened. Album Studio carries on by itself once you’re done.</p>
        <div class="signin__actions">
          <Button variant="ghost" onClick={() => void signIn()}>Open the page again</Button>
          <Button variant="ghost" onClick={cancelSignIn}>Cancel</Button>
        </div>
      </div>
    )
  } else if (a.state === 'blocked') {
    const why = explainBlocked(a)
    body = (
      <div class="signin__blocked" role="alert">
        <h2 class="signin__title">{why.title}</h2>
        <p class="signin__text">{why.text}</p>
        <div class="signin__actions">
          {why.retry && a.email ? <Button variant="primary" icon={<RefreshCw size={14} />} busy={checking.value} onClick={() => void retryAccount()}>Check again</Button> : null}
          <GoogleButton label="Use another account" />
        </div>
        {a.email ? <button type="button" class="link signin__signout" onClick={() => void signOut()}><LogOut size={13} /> Sign out of {a.email}</button> : null}
      </div>
    )
  } else if (!a.configured) {
    body = (
      <div class="signin__blocked" role="alert">
        <h2 class="signin__title">Sign-in isn’t set up in this copy</h2>
        <p class="signin__text">Its Google and Firebase settings are missing. Ask Creative Hubb for the settings file and put it in Album Studio’s folder (~/Library/Application Support/Album Studio/.env), then reopen the app.</p>
      </div>
    )
  } else {
    body = (
      <>
        <p class="signin__text">Sign in with the Google account your Creative Hubb subscription is on.</p>
        <div class="signin__actions"><GoogleButton /></div>
      </>
    )
  }

  return (
    <div class="signin">
      <div class="signin__drag" onMouseDown={drag} onDblClick={() => inShell && void call('shell.zoomWindow').catch(() => {})} />
      <main class="signin__panel">
        <h1 class="signin__brand">Album Studio</h1>
        {body}
        {accountError.value && !signingIn.value ? <p class="signin__error" role="alert">{accountError.value}</p> : null}
      </main>
      <p class="signin__foot">Your albums and photos stay on this Mac. Only your account is checked with Creative Hubb.</p>
    </div>
  )
}
