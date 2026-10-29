// Menu.tsx — a button that opens a short list of commands. Closes on a choice, Escape, or a click
// elsewhere; arrow keys move between items, as in a native menu.

import type { ComponentChildren } from 'preact'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'

export interface MenuItem {
  label: string
  onSelect: () => void
  icon?: ComponentChildren
  hint?: string
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
}

export function Menu({ label, icon, items }: { label: string; icon: ComponentChildren; items: MenuItem[] }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const firstFocus = useRef<'first' | 'last'>('first')
  const id = useId()

  const close = (restore = false) => {
    setOpen(false)
    if (restore) trigger.current?.focus()
  }
  useLayoutEffect(() => {
    if (!open) return
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    buttons?.[firstFocus.current === 'last' ? buttons.length - 1 : 0]?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const onKey = (e: KeyboardEvent) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Tab') {
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      e.stopPropagation()
      buttons[e.key === 'Home' ? 0 : buttons.length - 1]?.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      buttons[(i + 1) % buttons.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation()
  }

  return (
    <div
      class="menu"
      ref={root}
      onFocusOut={(e) => {
        if (e.relatedTarget && !root.current?.contains(e.relatedTarget as Node)) close()
      }}
    >
      <button
        ref={trigger}
        type="button"
        class="icon-btn menu__trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          firstFocus.current = 'first'
          setOpen(!open)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          e.preventDefault()
          e.stopPropagation()
          firstFocus.current = e.key === 'ArrowUp' ? 'last' : 'first'
          setOpen(true)
        }}
      >
        {icon}
      </button>
      {open ? (
        // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- the items carry focus; their keys bubble here
        <div class="menu__list" role="menu" aria-label={label} id={id} ref={list} onKeyDown={onKey}>
          {items.map((it) => (
            <>
              {it.separatorBefore ? <div class="menu__sep" role="separator" /> : null}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                class={`menu__item ${it.danger ? 'is-danger' : ''}`}
                disabled={it.disabled}
                onClick={() => {
                  close(true)
                  it.onSelect()
                }}
              >
                <span class="menu__icon" aria-hidden="true">
                  {it.icon}
                </span>
                <span class="menu__label">{it.label}</span>
                {it.hint ? <span class="menu__hint">{it.hint}</span> : null}
              </button>
            </>
          ))}
        </div>
      ) : null}
    </div>
  )
}
