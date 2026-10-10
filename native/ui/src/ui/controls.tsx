// controls.tsx — the shared control vocabulary. Every screen uses these, so a button looks and
// behaves the same everywhere.

import type { ButtonHTMLAttributes, ComponentChildren } from 'preact'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'md' | 'sm'
  icon?: ComponentChildren
  busy?: boolean
}

export function Button({ variant = 'secondary', size = 'md', icon, busy, children, class: cls, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      class={`btn btn--${variant} btn--${size} ${busy ? 'is-busy' : ''} ${cls ?? ''}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {icon ? <span class="btn__icon" aria-hidden="true">{icon}</span> : null}
      {children ? <span class="btn__label">{children}</span> : null}
    </button>
  )
}

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { label: string; pressed?: boolean }

/** An icon-only button. `label` is required: it is the accessible name and the tooltip. */
export function IconButton({ label, pressed, children, class: cls, ...rest }: IconButtonProps) {
  return (
    <button type="button" class={`icon-btn ${cls ?? ''}`} aria-label={label} title={label} aria-pressed={pressed} {...rest}>
      {children}
    </button>
  )
}

export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string
  value: T
  options: { value: T; label: string; title?: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          role="radio"
          aria-checked={o.value === value}
          class={`segmented__item ${o.value === value ? 'is-on' : ''}`}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Keyboard shortcut glyphs, e.g. <Kbd keys={['⌘', 'K']} />. */
export function Kbd({ keys }: { keys: string[] }) {
  return (
    <span class="kbd" aria-hidden="true">
      {keys.map((k) => <kbd>{k}</kbd>)}
    </span>
  )
}
