# UI/UX Audit & Design System — Creative Hubb Album Toolkit Pro

**Author:** UI/UX + HCI audit
**Status:** Proposed — awaiting approval (no code changed)
**Scope:** Frontend layout, visual hierarchy, interaction ergonomics, micro-interactions, and accessibility across all 7 tabs, with emphasis on the Album Creation workspace (Tab 1) and the Export Studio storyboard (Tab 7).

---

## 0. What's already good (don't regress these)

An honest audit starts by protecting existing strengths:

- **Design tokens exist.** `style.css` has a real type scale (`--fs-*`), spacing scale (`--space-*`), radius scale, and a full theming layer. This is a strong foundation — the work below should *use* these tokens, never reintroduce magic numbers.
- **A real button system.** `.btn` + `--primary/--secondary/--ghost/--destructive/--warning/--render` with `:focus-visible` rings already exists and is documented in the CSS. Visual hierarchy at the component level is largely solved.
- **Five polished themes** including the Apple-Tahoe Glass pair. The color/elevation language is current.
- **Event-delegated, virtualized grids** (Tab 1 source pool, Tab 6) after the perf work — DOM is healthy.

The problems are at the **layout / information-architecture / interaction-flow** level, not the pixel-styling level.

---

## 1. The core friction: Tab 1 is four panels fighting for one screen

### Finding 1.1 — Canvas real estate is quartered `[HIGH]`
Tab 1 stacks a dense control `.row`, then a 2×2 grid of resizable boxes (Green page / Yellow preview on top; Red source / White templates on bottom), then a footer. On a 1400×900 default window, the **single most important surface — the page preview (Yellow) — gets roughly a quarter of the screen**, and the page being composed (Green) another quarter. The user's eye has to triage four competing regions simultaneously.

**HCI principle violated:** *focal point*. A creation tool should make the artifact being created the visual hero. Here the artifact (the page) competes equally with two asset browsers.

**Proposal — "Stage + Rails" layout.** Promote the page composition to a center **stage** and demote asset browsers to collapsible **rails**:
```
┌─────────────────────────────────────────────────────────┐
│  Command bar (auto-fill, page nav, view controls)        │
├──────────┬──────────────────────────────┬────────────────┤
│  SOURCE  │                              │   TEMPLATES    │
│  rail    │         PAGE STAGE           │   rail         │
│ (photos) │   (green compose + yellow    │  (filtered     │
│  collaps │    preview, switchable or     │   PSD library) │
│          │    side-by-side)             │                │
├──────────┴──────────────────────────────┴────────────────┤
│  status / match-count footer                              │
└─────────────────────────────────────────────────────────┘
```
Rails are collapsible to icon strips, returning ~70% of width to the stage when the user is reviewing rather than sourcing. This is the Lightroom / Capture One / Figma pattern: tools at the edges, artifact in the middle.

### Finding 1.2 — The command `.row` is an undifferentiated wall of controls `[HIGH]`
The top row mixes destructive (Clear Album), creative (Auto Fill), configuration (Min/Max, Desired sheets, Chronological), and navigation (Prev/Next/Add/Del page) controls in one flat strip with `gap: 3px`. There's no grouping, no hierarchy, and the destructive **Clear Album** sits one slot away from **Auto Fill**.

**HCI principles violated:** *chunking* (Miller), *spatial grouping* (Gestalt proximity), *error prevention* (destructive next to constructive).

**Proposal:**
- Segment the bar into labeled clusters with vertical dividers: **[Generate]** · **[Page]** · **[View]**.
- Move **Clear Album** out of the primary row into an overflow/⋯ menu or behind the existing confirm dialog only — it should never be a one-hop neighbor of Auto Fill.
- Collapse Min/Max/Desired/Chronological into a single **"Auto-fill settings"** popover triggered from the Auto Fill split-button, so the bar isn't carrying 5 config widgets at rest.

### Finding 1.3 — Inline styles defeat the design system `[MEDIUM]`
`style="width:50%"`, `style="flex:1"`, `style="width:5px; background:var(--resizer-bg)"` are scattered through the HTML. These bypass the token system, can't be themed, and make the layout's intent invisible to anyone reading the CSS.

**Proposal:** lift every inline style into a named class (`.stage__pane--half`, `.rail__resizer`). One source of truth, themeable, inspectable.

---

## 2. Drag-and-drop & photo interaction

### Finding 2.1 — Two different DnD mental models in one app `[HIGH]`
- **Tab 1 Source→Green** uses *double-click to pull* (a custom click-counter), not drag.
- **Tab 7 storyboard** uses real *pointer-drag* with drop indicators.
- **Green box reorder** uses HTML5 drag with `drop-before/after` markers.

A user learns "drag photos" in Tab 7, returns to Tab 1, tries to drag a source photo onto a page, and nothing happens — they have to discover double-click. Inconsistent interaction grammar is a top-tier usability failure.

**Proposal:** make **drag the universal verb** for moving a photo into/within/between containers, with double-click as a documented shortcut (drag onto current page). Unify the drop-indicator visual (the storyboard's `drop-before/after` accent bar) across Source pool, Green box, and storyboard so the affordance looks identical everywhere.

### Finding 2.2 — Selection feedback is inconsistent across surfaces `[MEDIUM]`
We fixed green-box selection (outline ring) and storyboard selection this session, but the three selectable surfaces (red thumbs `.selected` = dark-red border; green `.img-container.selected` = accent outline + glow; storyboard = accent border + ring) each look different. A user can't build one mental model of "selected."

**Proposal:** one **selection token set** — `--select-ring`, `--select-glow` — applied identically (accent outline + soft glow + optional ✓ corner badge for multi-select contexts) on every selectable tile.

### Finding 2.3 — No empty/loading/skeleton states `[MEDIUM]`
Grids show a plain `.placeholder-text` string ("Load a folder to view…") and, during load, nothing. With virtualization, off-screen cards are blank until scrolled to. There's no skeleton shimmer, no per-thumbnail spinner, no drag-target highlight on the destination page.

**Proposal:**
- **Skeleton cards** (animated shimmer at the card's reserved size) while thumbnails decode.
- **Empty states** with an icon + one-line instruction + a primary action button ("📂 Load photos"), not bare gray text.
- **Drop-zone highlighting**: when a drag is in flight, the valid destination (current page / a storyboard card) gets an accent dashed outline so the target is unambiguous.

---

## 3. Asset & template panel organization

### Finding 3.1 — The "folder rail" is cramped and low-information `[MEDIUM]`
The 110px folder panel truncates names to `displayName.substring(0,10) + '..'`, shows a checkbox + 📁 + truncated text, and has tiny 🔄/🗑️ glyph actions. For a photographer juggling 6 source folders this is hard to scan and the truncation hides which folder is which.

**Proposal:**
- Wider, full-name folder rows with a count badge ("Ceremony · 412") and a colored dot matching the rail accent.
- Hover-revealed row actions instead of always-on glyphs (reduces resting clutter).
- A "select all / none" affordance at the rail header.

### Finding 3.2 — Template match feedback is buried `[MEDIUM]`
The crucial "Matches: N (2H, 1V)" text lives in a 10px footer label most users never look at. The whole auto-fill mental model hinges on H/V counts matching a template, yet that signal is the least prominent text on screen.

**Proposal:** surface the current page's H/V signature and match count as a **prominent chip on the Page stage header** ("2H 1V · 7 templates"), color-coded green when matches exist, amber when zero. Make the core constraint visible where the user is looking.

### Finding 3.3 — Tab bar carries the whole app's modes flatly `[LOW-MEDIUM]`
Seven equally-weighted tabs (Album, Wallpapers, PNG, Masked, Tools, Photos, Export). Tabs 2/3/4 (Wallpapers/PNG/Masked) are all "asset library" variants of the same pattern; Tab 6 (Photos) duplicates Tab 1's source pool. This is mode-overload.

**Proposal (information architecture):**
- Group 2/3/4 under one **"Assets"** tab with an internal segmented control (Wallpapers / PNG / Masked) — three near-identical grids don't each need a top-level tab.
- Evaluate whether Tab 6 (Photos) earns its place or should fold into Tab 1's source rail. (Needs a usage check via the telemetry stream before removing.)
- Result: a calmer 4–5 tab bar (Album · Assets · Tools · Export, plus maybe Photos) instead of 7.

---

## 4. Micro-interactions & feedback

### Finding 4.1 — Long operations lack progress affordance in-place `[MEDIUM]`
Auto-fill, proof generation, and render show status only in the 10px footer or a transient toast. There's a render badge (good) but folder loads, EXIF sort, and proofs don't show inline progress on the surface they affect.

**Proposal:** a consistent **inline progress treatment** — a thin determinate bar at the top of the affected panel + a count — reusing the JPEG-export progress component already built. Toasts are for completion, not for "still working."

### Finding 4.2 — Hover states are inconsistent in depth `[LOW]`
Some elements lift (`translateY(-1px)` + shadow), some only change border color, some do nothing. The themes add 3D tilt to cards but plain buttons stay flat.

**Proposal:** define **3 interaction elevations** as tokens — *rest / hover / active* — with consistent shadow + transform deltas, and apply the same ladder to every interactive element. Motion timing standardized on one easing curve (`cubic-bezier(0.2,0.8,0.2,1)`, ~160–220ms) already used in places.

### Finding 4.3 — Icon-glyph buttons rely on emoji `[LOW]`
🔄 🗑️ 📂 ➕ ➖ 🚀 🧹 carry meaning but render differently per OS, don't inherit color, and aren't crisp. Fine as a stopgap; an inline SVG icon set would be sharper, themeable, and accessible (with `aria-label`, which some already have).

**Proposal:** a small inline SVG sprite for the ~12 recurring actions; keep emoji only in user-facing copy/toasts.

---

## 5. Visual hierarchy & color

### Finding 5.1 — Region naming is color-coded but color isn't semantic `[MEDIUM]`
"Red box / Green box / White box / Yellow box" are named by historical UI color, but the colors don't encode meaning the user can rely on (green ≠ "go", red ≠ "danger" here — red is just "source pool"). This is a hidden cognitive tax.

**Proposal:** rename regions by **function** in all labels and code comments — *Source*, *Page*, *Preview*, *Templates* — and let the theme accent (not arbitrary per-box hues) carry state. Reserve red strictly for destructive, green/accent for active/selected.

### Finding 5.2 — Typography is single-weight and low-contrast in places `[LOW]`
Most chrome is 10–12px in `--txt-secondary`. The match text, folder names, and toolbar labels all sit at similar size/weight, flattening hierarchy. Body uses Helvetica Neue while monospace appears ad hoc.

**Proposal:** a 3-level type ramp actually applied — section titles (`--fs-lg`, 600), control labels (`--fs-sm`, 500), meta (`--fs-xs`, `--txt-muted`). Adopt the system UI font stack (already used in the glass/proof gallery) app-wide for native feel.

---

## 6. Accessibility

### Finding 6.1 — Color-only state cues `[MEDIUM]`
"Used" photos are conveyed by opacity + glow (a ✓ badge was added — good), selection by color. Several states still rely on hue alone, failing for ~8% of users.

**Proposal:** every state gets a **non-color cue** (icon, border-style, or label) in addition to color. Audit each `.used`, `.selected`, `.active`, error/warning toast.

### Finding 6.2 — Keyboard reachability gaps `[MEDIUM]`
There's a good shortcut layer (J/K, Cmd+1-7, ?), and `:focus-visible` rings exist. But the folder-rail glyph actions are `<span role="button" tabindex="0">` without keydown handlers verified, drag-only reorder has no keyboard equivalent, and the storyboard isn't keyboard-navigable.

**Proposal:** ensure every pointer interaction has a keyboard path (arrow-key tile navigation in grids, Enter/Space to activate, a keyboard "move to page N" for reorder). Verify `role`/`aria` on custom controls.

### Finding 6.3 — Contrast on translucent themes `[LOW]`
The glass themes put `--txt-secondary` over translucent frost; on bright wallpaper regions this can dip below WCAG AA. Verify 4.5:1 for body text and 3:1 for large/UI on every theme.

---

## 7. The Design Language (the system to converge on)

**Layout:** Stage + collapsible Rails. One hero region per tab. 8px spacing grid (already tokenized). Max content widths on wide panels so cards don't sprawl.

**Type:** system UI stack. Three weights (400/500/600). The existing `--fs-*` ramp, applied with discipline.

**Color:** neutral surfaces from theme tokens; **one accent** per theme carries interactive + selected state; **red reserved for destructive**; **amber for caution**; semantic, never decorative.

**Elevation:** 3 levels (rest/hover/active) as shadow+transform tokens; one easing curve; 160–220ms.

**Components:** the existing `.btn` system, extended with: `.chip` (status/match), `.rail` (collapsible asset panel), `.stage` (hero region), `.skeleton` (loading), `.dropzone` (drag target), unified `.tile` selection states.

**Motion:** purposeful only — entrance/exit of toasts, progress, drag ghosts, hover elevation. Everything respects `prefers-reduced-motion` (already done for themes).

---

## 8. Risk & sequencing notes

- The **Stage + Rails** relayout (1.1) is the highest-impact and highest-risk item — it restructures Tab 1's DOM and the resizer logic. Stage it behind the existing resizer system; keep the 2×2 as a fallback view toggle during migration.
- Items 1.3 (inline-style removal), 4.x (micro-interactions), 5.x (hierarchy), 6.x (a11y) are **low-risk, incremental, token-driven** — they can land independently and improve the app immediately without structural change.
- Drag unification (2.1) touches three interaction subsystems; do it after the selection-token unification (2.2) so the visual language is settled first.
- Nothing here should regress the perf work (delegation, virtualization) or the theme system.

---

## 9. Verification strategy

- **Heuristic pass** against Nielsen's 10 heuristics per tab after each change.
- **Keyboard-only run-through** of the full album workflow (load → auto-fill → reorder → proof → export) with no mouse.
- **Contrast check** (4.5:1 body / 3:1 UI) on all 5 themes via a contrast tool.
- **Reduced-motion** verification (all animation suppressed).
- **No-regression gate:** `npm run typecheck && npm run lint` green; the perf-critical paths (Tab 1/6 grids) stay event-delegated and virtualized.
- Before/after screen recordings of the album workflow to confirm the "effortless" goal subjectively.
