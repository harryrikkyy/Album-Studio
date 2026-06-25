# UI/UX Implementation Tasks

Atomic, sequential, prioritized **high-impact layout + ergonomics first**, then incremental polish. Each task is independently shippable and gated by `npm run typecheck && npm run lint` plus a visual check on all 5 themes. Finding IDs reference `ui-ux-design-system.md`.

Legend: 🟥 high impact · 🟧 medium · 🟦 low · ⏱ effort · ⚠ risk

---

## Phase A — Foundations (low risk, unblock everything, do first)

- [ ] **A.1** Lift all inline styles in `index.html` (`width:50%`, `flex:1`, resizer styles, box borders) into named classes in `style.css`. No visual change — pure refactor. 🟧 ⏱M ⚠low — *(1.3)*
- [ ] **A.2** Add component tokens: `--select-ring`, `--select-glow`, elevation ladder (`--elev-rest/hover/active` as shadow+transform), one motion curve/duration var. 🟧 ⏱S ⚠low — *(2.2, 4.2)*
- [ ] **A.3** Adopt the system-UI font stack app-wide (body currently Helvetica Neue); apply the 3-level type ramp to toolbars, folder rows, section titles. 🟦 ⏱S ⚠low — *(5.2)*
- [ ] **A.4** Build reusable CSS components: `.chip`, `.skeleton` (shimmer), `.dropzone` (drag target outline), `.rail` scaffold. No wiring yet — just the styles. 🟧 ⏱M ⚠low — *(2.3, 3.2)*

## Phase B — Command bar & visible constraints (high impact, contained)

- [ ] **B.1** Segment Tab 1's top `.row` into labeled clusters **[Generate] · [Page] · [View]** with dividers. 🟥 ⏱M ⚠low — *(1.2)*
- [ ] **B.2** Move **Clear Album** out of the primary row into an overflow (⋯) menu; keep its confirm dialog. Removes the destructive-next-to-constructive hazard. 🟥 ⏱S ⚠low — *(1.2)*
- [ ] **B.3** Collapse Min/Max/Desired/Chronological into an **Auto-fill settings popover** on a split Auto-Fill button. 🟧 ⏱M ⚠med — *(1.2)*
- [ ] **B.4** Surface the page **H/V signature + match count chip** on the Page region header, color-coded (green = matches, amber = none). Reuse `.chip`. 🟥 ⏱S ⚠low — *(3.2)*

## Phase C — Loading / empty / drop feedback (high perceived-quality)

- [ ] **C.1** Replace bare `.placeholder-text` with real **empty states** (icon + one line + primary action button) in every grid + rail. 🟧 ⏱M ⚠low — *(2.3)*
- [ ] **C.2** **Skeleton shimmer cards** at reserved size while thumbnails decode (Tab 1 source, Tab 6, templates). Ties into the virtualization attach. 🟧 ⏱M ⚠med — *(2.3)*
- [ ] **C.3** **Drop-zone highlighting**: during any drag, the valid destination (current Page, storyboard card, green box) gets an accent dashed outline. 🟥 ⏱M ⚠med — *(2.3)*
- [ ] **C.4** **Inline progress bar** at the top of the affected panel for auto-fill / EXIF sort / proofs / folder load, reusing the JPEG-export progress component. 🟧 ⏱M ⚠low — *(4.1)*

## Phase D — Interaction unification (settle the grammar)

- [ ] **D.1** Unify **selection visuals** across source thumbs / green tiles / storyboard tiles using the `--select-*` tokens + optional ✓ corner badge. 🟧 ⏱M ⚠med — *(2.2)*
- [ ] **D.2** Make **drag the universal verb**: enable real pointer-drag from the Source pool onto the current Page / storyboard, keeping double-click as a documented shortcut. Unify the drop indicator visual. 🟥 ⏱L ⚠high — *(2.1)* — do AFTER D.1.
- [ ] **D.3** Standardize **hover elevation** (rest/hover/active ladder from A.2) on all interactive elements incl. plain buttons. 🟦 ⏱S ⚠low — *(4.2)*

## Phase E — The big relayout (highest impact, highest risk — staged)

- [ ] **E.1** Introduce the **Stage + Rails** structure for Tab 1 behind a view toggle (new layout opt-in, old 2×2 as fallback). Collapsible Source rail (left) + Templates rail (right) + center Page stage. 🟥 ⏱XL ⚠high — *(1.1)*
- [ ] **E.2** Rail **collapse-to-icon-strip** behavior + remembered widths (persist in projectData/localStorage). 🟧 ⏱M ⚠med — *(1.1)*
- [ ] **E.3** Page stage: switchable **Compose ↔ Preview** (or side-by-side on wide windows) so the page is the hero. 🟥 ⏱L ⚠high — *(1.1)*
- [ ] **E.4** Once validated, make Stage+Rails the default and retire the 2×2 fallback. 🟧 ⏱S ⚠med — *(1.1)*

## Phase F — Information architecture (tab consolidation)

- [ ] **F.1** Merge Tabs 2/3/4 (Wallpapers/PNG/Masked) into one **"Assets"** tab with an internal segmented control. 🟧 ⏱L ⚠med — *(3.3)*
- [ ] **F.2** Telemetry-driven decision on Tab 6 (Photos): measure usage, then fold into Source rail or keep. 🟦 ⏱M ⚠med — *(3.3)*
- [ ] **F.3** Widen + enrich **folder rail rows**: full names, count badge, accent dot, hover-revealed actions, select-all/none. 🟧 ⏱M ⚠low — *(3.1)*

## Phase G — Accessibility & polish

- [ ] **G.1** Add **non-color cues** to every state (`.used` ✓ done; add to `.selected`, `.active`, warning/error toasts via icon/border-style). 🟧 ⏱M ⚠low — *(6.1)*
- [ ] **G.2** Keyboard parity: arrow-key tile navigation in grids, Enter/Space activation, keyboard "move to page N" for reorder, storyboard keyboard nav; verify rail glyph buttons have keydown handlers. 🟧 ⏱L ⚠med — *(6.2)*
- [ ] **G.3** Contrast audit across all 5 themes (4.5:1 body / 3:1 UI); fix any translucent-glass dips. 🟦 ⏱M ⚠low — *(6.3)*
- [ ] **G.4** Inline **SVG icon sprite** for the ~12 recurring actions, replacing emoji in chrome (keep emoji in copy/toasts), each with `aria-label`. 🟦 ⏱M ⚠low — *(4.3)*
- [ ] **G.5** Rename regions by **function** (Source/Page/Preview/Templates) in all labels + comments; reserve red for destructive only. 🟧 ⏱S ⚠low — *(5.1)*

---

## Suggested execution order

```
A.1 → A.2 → A.3 → A.4              (foundations: tokens, components, no-regression refactor)
B.1 → B.2 → B.4 → B.3              (command-bar clarity + visible match constraint)
C.1 → C.4 → C.2 → C.3              (feedback: empty/progress first, then skeletons/dropzones)
D.1 → D.3 → D.2                    (unify selection + hover BEFORE drag unification)
G.5 → G.1 → G.3                    (cheap a11y + semantic renaming alongside the above)
E.1 → E.2 → E.3 → E.4              (staged Stage+Rails relayout, behind a toggle)
F.1 → F.3 → F.2                    (IA consolidation once layout is settled)
G.2 → G.4                          (keyboard parity + icon sprite polish)
```

Rationale: Phases A–C are low-risk, token-driven, and immediately raise perceived quality without touching structure. The risky structural work (D.2 drag unification, E.x relayout, F.x IA) comes only after the visual language and feedback systems are settled, so each big change lands on a stable base. Accessibility and semantic-rename tasks are cheap and interleave throughout.

---

## Definition of done (per task)

1. `npm run typecheck` and `npm run lint` green.
2. Visual check on all 5 themes (Nebula, Obsidian, Synthwave, Glass, Glass Dark).
3. Keyboard-only operability preserved or improved for the touched surface.
4. No regression to perf-critical paths (Tab 1/6 grids stay event-delegated + virtualized).
5. `prefers-reduced-motion` respected for any new motion.
6. No new inline styles or magic numbers — everything via tokens/classes.
```
