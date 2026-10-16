/** A control keeps its own keys; window commands never act behind a modal dialog. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  return !!element && (element.isContentEditable || !!element.closest?.('input, textarea, select, [contenteditable="true"]'))
}

export function ownsNavigationKeys(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest?.('button, a, input, textarea, select, summary, [contenteditable="true"], [role="option"], [role="radio"], [role="menuitem"], [role="slider"]')
}

export function shortcutsSuspended(event: Pick<KeyboardEvent, 'defaultPrevented' | 'isComposing'>, modalOpen: boolean, allowed: boolean): boolean {
  return event.defaultPrevented || event.isComposing || modalOpen || !allowed
}

/** WebKit can tab from the last modal control to browser chrome/body. Keep both edges local. */
export function containDialogTab(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return
  const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1)
  if (!dialog) return
  const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')].filter(el => {
    if (el.tabIndex < 0 || el.matches(':disabled') || el.closest('[hidden], [inert]') || !el.getClientRects().length || getComputedStyle(el).visibility !== 'visible') return false
    if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
      const group = [...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(input => input.name === el.name && !input.matches(':disabled'))
      return (group.find(input => input.checked) ?? group[0]) === el
    }
    return true
  })
  const active = document.activeElement
  const first = controls[0], last = controls.at(-1)
  if (!first || !dialog.contains(active) || active === dialog || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault()
    const target = event.shiftKey ? last : first
    target?.focus()
    if (!first) dialog.focus()
  }
}
