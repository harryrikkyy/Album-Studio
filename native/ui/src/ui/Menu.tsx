// Menu.tsx — a button that opens a short list of commands. Closes on a choice, Escape, or a click
// elsewhere; arrow keys move between items, as in a native menu.

import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

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

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    list.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const onKey = (e: KeyboardEvent) => {
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); root.current?.querySelector<HTMLButtonElement>('.menu__trigger')?.focus() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); buttons[(i + 1) % buttons.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus() }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation()
  }

  return (
    <div class="menu" ref={root}>
      <button
        type="button"
        class="icon-btn menu__trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {icon}
      </button>
      {open ? (
        <div class="menu__list" role="menu" ref={list} onKeyDown={onKey}>
          {items.map((it) => (
            <>
              {it.separatorBefore ? <div class="menu__sep" role="separator" /> : null}
              <button
                type="button"
                role="menuitem"
                class={`menu__item ${it.danger ? 'is-danger' : ''}`}
                disabled={it.disabled}
                onClick={() => { setOpen(false); it.onSelect() }}
              >
                <span class="menu__icon" aria-hidden="true">{it.icon}</span>
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
