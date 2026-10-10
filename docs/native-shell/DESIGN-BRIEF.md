# Design brief: the new Album Studio interface

Status: decided by the designer under the owner's free hand (2026-10-10). Shown to the owner as
a working prototype before the build continues; any redirect from the owner wins.

Anchors: `PRODUCT.md` (users, purpose, brand, anti-references, non-negotiables). This brief
adds the decisions the native shell and the new UI need.

## 1. Summary

A single native Mac app for producing wedding albums end to end: import a shoot, plan and
auto-fill spreads, refine them, edit any spread in the built-in PhotoCraft editor, proof to the
client and deliver print files. No Photoshop. One window, one visual language.

## 2. Primary user action

Move through the album spread by spread: see the spread large, swap or re-place photos from
the pool, accept, next. Everything else (templates, editing, delivery) hangs off that loop.

## 3. Design direction

- **Scene:** a photographer at a 27-inch display late at night, the room lit only by the screen,
  judging skin tones and saree reds for hours. The surround must be neutral and dark so photos
  read true and the eyes don't tire. This forces dark, neutral grey.
- **Colour strategy: Restrained.** Surfaces are true neutral greys (chroma 0): a tinted surround
  biases colour judgement, which matters more here than brand flavour. One accent, **cool ice
  blue** (OKLCH ≈ 0.76 0.11 235), for selection, focus, primary action and progress only.
  Wedding photos are dominated by reds, magentas and golds; a cool accent never competes with
  or is mistaken for photo content. (The previous coral accent did both.)
- **Studio light** remains a second theme, crafted to the same rules (neutral greys, the accent
  darkened for contrast).
- **Anchors:** Capture One (neutral grey surround, dense panels, the photo as the hero),
  Linear (speed, keyboard-first, quiet chrome), Apple Photos (calm, generous image presentation).
- **Type:** one family, the system font (SF Pro): native on macOS, excellent at small sizes,
  tabular figures for counts. Fixed scale, ratio ≈1.125: 11 / 12 / 13 (base) / 15 / 17 / 20.
- **Motion:** 150–200 ms, ease-out-quart, state changes only; full `prefers-reduced-motion`
  fallbacks. No load choreography.

## 4. Scope

Production quality, whole application, interactive and shipped. Built in steps; the first step
is the album workspace with real data, shown to the owner.

## 5. Information architecture and layout

One window. A slim **left rail** switches between places; the active album stays loaded.

| Place | What it is | Replaces today |
|---|---|---|
| **Albums** | Recent albums with cover spreads; New album (photo folders, sheet count, template collections, output folder) | Load / Save / New project |
| **Plan** | The working surface: photo pool, the current spread large, spread strip, inspector | Tab 1 Album creation, Automation bar |
| **Review** | All spreads in a large grid; drag photos between spreads; pick spreads to deliver | Tab 7 Export Studio storyboard |
| **Edit** | The PhotoCraft editor on the chosen spread (native, full Photoshop-class editing) | Spread Editor window, Photoshop |
| **Deliver** | Render queue, print PSDs, JPEG high/low, PDF proofs, client gallery, with progress | Render buttons, JPEG export, resize, PDF |
| **Library** | Templates, wallpapers, PNG frames, masks: collections, previews, add/remove | Tabs 2–4, library view |
| **Tools** | Renamer, curation (best picks), thumbnails, retouch actions | Tab 5, Tab 8, Tools Bar |

**Plan layout** (the screen used 90% of the time):

- **Left: photo pool.** Dense thumbnail grid with filters (unused / used / all; landscape /
  portrait), capture-time order, size slider, multi-select, drag to a slot.
- **Centre: the spread.** The live proof at the largest size the window allows, slots
  outlined on hover, drop targets while dragging. Above it: spread number, photo count,
  orientation signature (e.g. "6 H · 1 V"), template name. Below it: the spread strip.
- **Right: inspector** (collapsible). Template picker filtered to matching layouts, page
  background, per-photo crop and adjustments, layer overrides.
- **Bottom: spread strip.** Every spread as a thumbnail with status (empty, planned, edited,
  rendered, stale); drag to reorder; keyboard ←/→ moves between spreads.

Global: ⌘K command palette; a jobs tray for long work (renders, exports, thumbnails) that
stays visible from any place; toasts for completion; full keyboard map.

## 6. Key states

Each surface ships: empty (teaches the next step: "Add a photo folder" with the drop zone),
loading (skeletons shaped like the content, never a centred spinner), partial (some thumbnails
still generating, shown progressively), error (what failed, why, the fix, retry), success
(quiet confirmation; completion moments for "Album rendered"), offline / drive missing (a
moved or unplugged drive is named with a "Locate…" action), and very large albums (200+
spreads, 5,000 photos: virtualised lists, no layout jank).

## 7. Interaction model

Keyboard first: ←/→ spreads, ⌘1–⌘7 places, Space quick look, Enter edit spread, ⌘Z/⇧⌘Z
everywhere, ⌘K palette, ⌘R render selection. Drag and drop is the primary placement gesture,
with keyboard alternatives. Every action that takes over 300 ms shows progress; anything over
2 s moves to the jobs tray so the user keeps working.

## 8. Content and voice

Sentence case, short labels, numbers in tabular figures ("23 spreads · 176 photos"). Errors say
what happened and what to do ("The drive 'Harry' isn't connected. Connect it or locate the
folder."). Photos and spreads are the only imagery; no illustrations.

## 9. Technical constraints

- Runs in the shell's web view (WebKit, macOS 11+), talking to the shell and the Node helper
  over an async bridge; no synchronous file access.
- Built with TypeScript + Preact + signals, bundled by esbuild; no runtime network.
- Accessibility: WCAG 2.1 AA in both themes (axe in CI), full keyboard operation, visible
  focus, reduced motion respected.
- Performance budget: 60 fps scrolling with 5,000 thumbnails (virtualised), spread switch
  under 100 ms when the proof is cached, first paint under 500 ms.

## 10. Anti-goals

Not a web-app look (no SaaS cards, no gradients, no glass). Not a Photoshop clone: Album
Studio is about albums; deep pixel editing lives in Edit. Not colourful chrome: the photos
are the colour.
