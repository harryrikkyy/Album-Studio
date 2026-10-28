# PRODUCT.md — Album Studio

## Register

product — app UI. Design serves the work; the tool should disappear into the task.

## Target users

Professional wedding/event photographers producing client albums. Power users in
long (2–6 h) deadline-driven sessions, often at night, usually on one large
display (sometimes a second for Photoshop). Fluent in Lightroom, Capture One,
Photoshop. Keyboard-heavy; repetitive placement work measured in pages/hour.

## Purpose

The album production pipeline on the Mac: choose a shoot and template collections → plan
spreads (auto-fill places the whole album in capture order) → review spreads as the client will
→ edit any sheet in the built-in PhotoCraft editor → deliver print JPEGs and a low-res PDF
rendered by the PhotoCraft engine. Photoshop isn't needed at any step. Primary loop: photo pool
→ spread → next spread, hundreds of times per album.

## Brand personality

Pro studio dark. Calm, deep, photo-first: near-black surfaces so photographs
carry the color; one distinctive accent doing real work (selection, primary
action, progress); crisp quiet type. "Addictive" comes from flow — instant
feedback, zero friction, satisfying completion states — not from decoration.
The reference family is Capture One / DaVinci Resolve / Linear: tools people
describe as feeling fast.

## Theme strategy

Two flagship themes, deeply crafted: a signature **studio dark** (default, the
identity) and one **studio light**. The previous 5-theme system (nebula,
obsidian, synthwave, glass, glass-dark) is consolidated; every visual decision
must be excellent twice, not passable five times.

## Iconography & voice

Coherent inline SVG icon set (SF-Symbols-style strokes, consistent weight/size)
replacing emoji glyphs. Sentence case everywhere ("Edit spread", not
🎨 EDIT SPREAD). Labels are quiet; the accent color and photos provide the eye.

## Anti-references

- Candy-colored button toolbars (red/yellow/blue fills competing with photos)
- Emoji-as-iconography; ALL-CAPS shouting labels
- SaaS-cream/gradient-hero aesthetics; decorative glassmorphism
- Neon-on-black gamer RGB (the old synthwave direction)

## Non-negotiables

- WCAG 2.1 AA in both shipped themes (studio dark and studio light)
- The shared, backend and interface test suites stay green through every visual change
- Every existing workflow keeps working; no functionality removed for looks
- Density is a feature: photographers want many thumbnails/controls per screen,
  macOS-comfortable but information-rich
