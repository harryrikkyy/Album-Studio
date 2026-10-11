// account_logic.ts — what the window says about the Creative Hubb account: why it can't open,
// what to do next, and how long the subscription has left. Pure, so it is tested on its own.

export type BlockedReason = 'not_activated' | 'expired' | 'wrong_machine' | 'wrong_account' | 'no_internet' | 'error'

export interface Account {
  state: 'signedOut' | 'allowed' | 'blocked'
  /** Whether this copy has the sign-in settings (Google and Firebase). */
  configured: boolean
  email?: string
  name?: string
  daysLeft?: number
  /** Allowed by the licence saved on this Mac, without reaching Creative Hubb. */
  offline?: boolean
  reason?: BlockedReason
  /** The Mac the licence is tied to (wrong_machine). */
  machineName?: string
  message?: string
  /** A developer run with the check skipped. */
  bypass?: boolean
}

export interface Explanation {
  title: string
  text: string
  /** "Check again" helps: something may have changed at Creative Hubb's end or the network's. */
  retry: boolean
}

export function explainBlocked(a: Account): Explanation {
  const who = a.email || 'this account'
  switch (a.reason) {
    case 'not_activated':
      return { title: 'Your account isn’t active yet', text: `You’re signed in as ${who}. Creative Hubb activates new accounts; once they have, choose Check again.`, retry: true }
    case 'expired':
      return { title: 'Your subscription has ended', text: `The subscription for ${who} has expired. Contact Creative Hubb to renew it, then choose Check again.`, retry: true }
    case 'wrong_machine':
      return {
        title: 'This licence is in use on another computer',
        text: `The licence for ${who} is tied to ${a.machineName ? `“${a.machineName}”` : 'another computer'}. Ask Creative Hubb to move it to this Mac.`,
        retry: true,
      }
    case 'wrong_account':
      return { title: 'The licence on this Mac is for another account', text: 'Connect to the internet and sign in with the account you want to use.', retry: false }
    case 'no_internet':
      return { title: 'Album Studio can’t reach Creative Hubb', text: 'There’s no internet connection, and no licence saved on this Mac yet. Connect, then choose Check again.', retry: true }
    default:
      return { title: 'The subscription check didn’t finish', text: a.message || 'Something went wrong while checking your subscription. Try again in a moment.', retry: true }
  }
}

/** A warning when the subscription ends within a week; null otherwise. */
export function expiryNote(daysLeft: number | undefined): string | null {
  if (daysLeft === undefined || daysLeft > 7) return null
  if (daysLeft <= 0) return 'Your subscription ends today. Contact Creative Hubb to renew it.'
  return `Your subscription ends in ${daysLeft === 1 ? '1 day' : `${daysLeft} days`}. Contact Creative Hubb to renew it.`
}

/** One line for Settings: how the subscription stands. */
export function subscriptionLine(a: Account): string {
  if (a.bypass) return 'Developer run: the subscription check is skipped.'
  const days = a.daysLeft ?? 0
  const left = days > 365 ? 'over a year left' : days === 1 ? '1 day left' : days <= 0 ? 'ends today' : `${days} days left`
  return a.offline ? `Active, ${left} · checked against the licence saved on this Mac (offline)` : `Active, ${left}`
}
