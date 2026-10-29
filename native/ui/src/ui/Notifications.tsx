// Keep notifications in the active dialog's top layer, including errors from a folder picker.
import { CircleAlert, CircleCheck, Info, X } from 'lucide-preact'
import { createPortal } from 'preact/compat'
import { useEffect, useState } from 'preact/hooks'
import { dismissToast, toasts } from '../state'

export function Notifications() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const sync = () =>
      setHost([...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1) ?? document.body)
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] })
    sync()
    return () => observer.disconnect()
  }, [])
  if (!host) return null
  return createPortal(
    <div class="toasts" role="region" aria-label="Notifications">
      {toasts.value.map((t) => (
        <div class={`toast toast--${t.kind}`} key={t.id} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span class="toast__icon" aria-hidden="true">
            {t.kind === 'error' ? (
              <CircleAlert size={16} />
            ) : t.kind === 'ok' ? (
              <CircleCheck size={16} />
            ) : (
              <Info size={16} />
            )}
          </span>
          <span class="toast__text">{t.text}</span>
          <button
            type="button"
            class="icon-btn icon-btn--sm"
            aria-label={`Dismiss: ${t.text}`}
            onClick={() => dismissToast(t.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>,
    host,
  )
}
