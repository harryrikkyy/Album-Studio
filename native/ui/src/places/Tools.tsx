// Tools.tsx — jobs around the album that aren't the album itself: naming an order for the print
// lab, picking the best photos of a shoot.

import { Sparkles, Tag } from 'lucide-preact'
import { signal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { BestPicks } from './tools/BestPicks'
import { LabNaming } from './tools/LabNaming'

type ToolId = 'lab' | 'picks'
const TOOLS: { id: ToolId; label: string; hint: string; icon: ComponentChildren }[] = [
  { id: 'lab', label: 'Lab naming', hint: 'Name an order’s sheets for the print lab', icon: <Tag size={16} /> },
  { id: 'picks', label: 'Best picks', hint: 'Narrow a shoot to its sharpest, best-exposed photos', icon: <Sparkles size={16} /> },
]

const tool = signal<ToolId>('lab')

export function Tools() {
  return (
    <section class="place place--tools" aria-label="Tools">
      <nav class="tools-nav" aria-label="Tools">
        <h1 class="tools-nav__title">Tools</h1>
        {TOOLS.map((t) => (
          <button type="button" class={`tools-nav__item ${tool.value === t.id ? 'is-current' : ''}`} aria-current={tool.value === t.id ? 'page' : undefined} onClick={() => (tool.value = t.id)}>
            <span class="tools-nav__icon" aria-hidden="true">{t.icon}</span>
            <span><span class="tools-nav__label">{t.label}</span><span class="tools-nav__hint">{t.hint}</span></span>
          </button>
        ))}
      </nav>
      <div class="tools-body">{tool.value === 'lab' ? <LabNaming /> : <BestPicks />}</div>
    </section>
  )
}
