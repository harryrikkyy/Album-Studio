# Phase 1: Docs and Repo Hygiene, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise "Docs & repo hygiene" from 5 to 9. Move raw evidence out of git, archive the long quality log and the Electron-era planning notes, and make every top-level doc match the code.

**Architecture:** Files leave git by moving to `/Volumes/Harry/works/albumStudio-quality-archive/`. Each keeps its repo-relative path there, and a checksum manifest is committed, so every archived file can be found and verified. Git history is not rewritten. Text documents are rewritten in place, or moved with `git mv` so their history follows them.

**Tech Stack:** git, POSIX shell (zsh session), Node 22 for the link checker.

**Spec:** `docs/superpowers/specs/2026-10-28-quality-above-nine-design.md` (decisions 1–5, phase 1).

## Global Constraints

- Repo: `/Volumes/Harry/works/albumStudio-photocraft`, branch `codex/album-quality-improvement`. Nothing is pushed.
- `SCRATCH=/private/tmp/claude-501/-Volumes-Harry-works-albumStudio-photocraft/2821a411-2a3f-4a06-90c0-a3e281d60cf7/scratchpad/phase1`
- `ARCHIVE=/Volumes/Harry/works/albumStudio-quality-archive`
- Nothing is permanently deleted. Archived files are moved, never removed, and each is checksum-verified after the move. Git history keeps the tracked ones as well.
- The gate runs before every commit: `/private/tmp/claude-501/-Volumes-Harry-works-albumStudio-photocraft/2821a411-2a3f-4a06-90c0-a3e281d60cf7/scratchpad/phase0/gate.sh /Volumes/Harry/works/albumStudio-photocraft`. It must print six `ok` lines; the only allowed failing test is the Poppler one.
- Never `git checkout`, `git restore` or `git stash` files with pending work.
- `invoice-template/` is never read, moved or committed.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Keep the spec's meaning, but apply these rulings:
  - **`CONTRIBUTING.md` stays short.** `docs/DEVELOPMENT.md` already is the contributor guide (setup, engine variables, gates), so `CONTRIBUTING.md` points to it instead of duplicating it.
  - **`tasks/` is archived.** It holds three Electron-era planning files (`plan.md`, `spec.md`, `todo.md`, 370 lines in the last). They move to the archive whole instead of having one item edited.

## Review Focus

1. **Links.** A link in a kept document (`README.md`, `docs/*.md`, `docs/quality/*.md`, the iteration READMEs) still resolves after the moves. The link checker in Task 6 covers this.
2. **Archive integrity.** Every archived file can be found and verified from the manifest, including the untracked ones that git history doesn't hold. Task 1 Step 4 covers this.
3. **Hidden readers.** No test, script or CI step reads a moved file. Task 1 Step 1 checks this before anything moves, and the gate checks it after.
4. **Local tools.** `.kiro/` stays on disk and only stops being tracked, so the Kiro IDE still finds it. Task 3 Step 2 covers this.
5. **No false claims.** A doc never claims a check, test count or workflow that the repo doesn't have. Task 4 replaces `PRODUCT.md`'s stale "e2e/a11y.spec.js" and "196 unit + 13 e2e" claims; Task 6 checks for leftover mentions.

---

### Task 1: Move raw evidence out of git, with a checksum manifest

**Files:**
- Move out: every tracked `docs/quality/**/*.log` (363 files, 12.1 MB). The 16 tracked evidence files under `docs/` over 100 KB (5.3 MB). Everything in the untracked `docs/quality/2026-10-16-iteration-10/` except its `README.md`. And `native/scripts/engine/architecture-publication-20261016.bundle` (15 MB).
- Create: `docs/quality/ARCHIVE.md`, `docs/quality/archive-manifest.sha256`, `README.md` in `docs/quality/2026-10-13/`, `docs/quality/2026-10-13-iteration-2/` and `docs/quality/engine-pin/`.
- Modify: `.gitignore`.

**Interfaces:**
- Produces: `$ARCHIVE/<repo-relative path>` for every moved file, and `docs/quality/archive-manifest.sha256` (`shasum -a 256` format, paths relative to `$ARCHIVE`). Tasks 2 and 6 rely on both.

- [ ] **Step 1: List what moves, and prove nothing reads it**

```bash
cd /Volumes/Harry/works/albumStudio-photocraft
SCRATCH=/private/tmp/claude-501/-Volumes-Harry-works-albumStudio-photocraft/2821a411-2a3f-4a06-90c0-a3e281d60cf7/scratchpad/phase1; mkdir -p "$SCRATCH"
git ls-files 'docs/quality/**/*.log' > "$SCRATCH/move-tracked.txt"
git ls-files -s docs | awk '{print $2" "$4}' | git cat-file --batch-check='%(objectsize) %(rest)' \
  | awk '$2 ~ /\.(json|pdf|jpg|png)$/ && $1 > 102400 {print $2}' >> "$SCRATCH/move-tracked.txt"
find docs/quality/2026-10-16-iteration-10 -type f ! -name README.md > "$SCRATCH/move-untracked.txt"
echo native/scripts/engine/architecture-publication-20261016.bundle >> "$SCRATCH/move-untracked.txt"
wc -l < "$SCRATCH/move-tracked.txt"; wc -l < "$SCRATCH/move-untracked.txt"
git grep -nE "docs/quality|architecture-publication-20261016" -- '*.js' '*.mjs' '*.cjs' '*.ts' '*.tsx' '*.yml' '*.sh' 'package.json' | head
```

Expected: `379`, then a small number for the untracked list, and **no** `git grep` output, meaning no code, test, script or CI step points into `docs/quality` or at the bundle. If anything is printed, stop and report it; whatever it reads stays.

- [ ] **Step 2: Write the manifest from the files as they are now**

```bash
shasum -a 256 $(cat "$SCRATCH/move-tracked.txt" "$SCRATCH/move-untracked.txt") > docs/quality/archive-manifest.sha256
wc -l < docs/quality/archive-manifest.sha256
```

Expected: the sum of Step 1's two counts.

- [ ] **Step 3: Move each file into the archive at the same relative path**

```bash
ARCHIVE=/Volumes/Harry/works/albumStudio-quality-archive
while read -r f; do mkdir -p "$ARCHIVE/$(dirname "$f")" && mv "$f" "$ARCHIVE/$f"; done < <(cat "$SCRATCH/move-tracked.txt" "$SCRATCH/move-untracked.txt")
cp -p docs/quality/archive-manifest.sha256 "$ARCHIVE/archive-manifest.sha256"
```

- [ ] **Step 4: Verify every archived file against the manifest**

Run: `(cd "$ARCHIVE" && shasum -a 256 -c archive-manifest.sha256 | grep -vc ': OK$')`
Expected: `0` (every line OK).

- [ ] **Step 5: Summaries for the three folders that have none, and the archive note**

Create `docs/quality/2026-10-13/README.md`, `docs/quality/2026-10-13-iteration-2/README.md` and `docs/quality/engine-pin/README.md`, each with exactly this text, with `<folder>` replaced by the folder's name:

```markdown
# <folder>

Evidence from this quality iteration. Raw logs and large result files were moved out of git on
2026-10-28 to `/Volumes/Harry/works/albumStudio-quality-archive/docs/quality/<folder>/`; see
[the archive note](../ARCHIVE.md) for how to find and verify them. Smaller files remain here.
```

Create `docs/quality/ARCHIVE.md`:

```markdown
# Archived quality evidence

On 2026-10-28, raw evidence moved out of git to keep the repository small:

- every `.log` file under `docs/quality/`
- evidence files under `docs/` larger than 100 KB
- the untracked evidence of `2026-10-16-iteration-10/` (its `README.md` stays here)
- `native/scripts/engine/architecture-publication-20261016.bundle`

They live in `/Volumes/Harry/works/albumStudio-quality-archive/`, each at its original
repository-relative path. Tracked files also remain in git history. To verify the archive:

    cd /Volumes/Harry/works/albumStudio-quality-archive
    shasum -a 256 -c archive-manifest.sha256

[`archive-manifest.sha256`](archive-manifest.sha256) lists every moved file with its checksum.
New raw logs are ignored by git; keep them in the archive.
```

- [ ] **Step 6: Ignore future raw evidence**

Append to `.gitignore`:

```gitignore

# Raw quality evidence lives outside git (docs/quality/ARCHIVE.md)
docs/quality/**/*.log
native/scripts/engine/*.bundle
```

- [ ] **Step 7: Check, gate and commit**

```bash
git add -A docs/quality .gitignore
git add docs/quality/2026-10-16-iteration-10/README.md
echo "tracked logs: $(git ls-files '*.log' | wc -l | tr -d ' ')"
git ls-files -s docs | awk '{print $4}' | git cat-file --batch-check='%(objectsize)' | awk '{s+=$1} END {printf "tracked docs: %.1f MB\n", s/1048576}'
```

Expected: `tracked logs: 0`. The docs figure still includes the quality log, which moves in Task 2, so it may be above 3 MB here.

Run the gate (six `ok` lines), then:

```bash
git commit -q -F - <<'EOF'
chore(docs): move raw quality evidence out of git

363 raw .log files, 16 evidence files over 100 KB under docs/, Codex's
untracked iteration-10 evidence and the 15 MB engine bundle moved to
/Volumes/Harry/works/albumStudio-quality-archive at their original paths.
docs/quality/archive-manifest.sha256 lists each with its checksum and
docs/quality/ARCHIVE.md explains how to verify them. Tracked files stay in
git history; future raw logs are ignored.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 2: Archive the quality log, scorecard and Electron-era notes; one-page status

**Files:**
- Move (`git mv`): `QUALITY_IMPROVEMENT_LOG.md` → `docs/quality/archive/QUALITY_IMPROVEMENT_LOG-2026-10.md`; `QUALITY_SCORECARD.json` → `docs/quality/archive/QUALITY_SCORECARD-2026-10.json`; `tasks/plan.md`, `tasks/spec.md`, `tasks/todo.md` → `docs/quality/archive/electron-era/`
- Create: `QUALITY_IMPROVEMENT_LOG.md` (one page)

- [ ] **Step 1: Move with history**

```bash
mkdir -p docs/quality/archive/electron-era
git mv QUALITY_IMPROVEMENT_LOG.md docs/quality/archive/QUALITY_IMPROVEMENT_LOG-2026-10.md
git mv QUALITY_SCORECARD.json docs/quality/archive/QUALITY_SCORECARD-2026-10.json
git mv tasks/plan.md tasks/spec.md tasks/todo.md docs/quality/archive/electron-era/
git grep -nE "tasks/(plan|spec|todo)\.md|QUALITY_SCORECARD\.json" -- ':!docs/quality/archive' ':!docs/superpowers'
```

Expected: no output, so nothing outside the archive links to the moved notes or scorecard. If a link prints, point it at the new path in Step 2's commit.

- [ ] **Step 2: Write the one-page status**

Create `QUALITY_IMPROVEMENT_LOG.md`:

```markdown
# Quality status

The quality programme raises the review score from 7.2 to above 9. The design is
[docs/superpowers/specs/2026-10-28-quality-above-nine-design.md](docs/superpowers/specs/2026-10-28-quality-above-nine-design.md);
each phase has a plan in [docs/superpowers/plans/](docs/superpowers/plans/).

## Scorecard

Re-scored after every phase from measurements; an area that misses its target says so.

| Area | Baseline (2026-10-27) | Target |
|---|---:|---:|
| Architecture & structure | 8 | 9 |
| Testing | 8 | 9.5 |
| UI code | 7.5 | 9 |
| Tooling & CI | 7.5 | 9.5 |
| Data integrity & reliability | 8 | 9 |
| Readability | 5.5 | 9 |
| Security & licensing | 7.5 | 9 |
| Performance | 7.5 | 9 |
| Docs & repo hygiene | 5 | 9 |
| **Average** | **7.2** | **9.1** |

## Phases

| Phase | Status |
|---|---|
| 0. Commit Codex's work | Done 2026-10-28 |
| 1. Docs and repo hygiene | In progress |
| 2–7 | Not started |

## History

- The full log of earlier iterations (to 2026-10-19) and Codex's scorecard:
  [docs/quality/archive/](docs/quality/archive/).
- Raw evidence moved out of git: [docs/quality/ARCHIVE.md](docs/quality/ARCHIVE.md).
- Recovery and verification guidance: [docs/quality/RECOVERY_AND_VERIFICATION.md](docs/quality/RECOVERY_AND_VERIFICATION.md).
```

- [ ] **Step 3: Gate and commit**

Run the gate (six `ok` lines), then:

```bash
git add QUALITY_IMPROVEMENT_LOG.md
git commit -q -F - <<'EOF'
docs: archive the long quality log and Electron-era notes; add a status page

The 1,368-line quality log, Codex's scorecard and the Electron-era plan,
spec and to-do list move to docs/quality/archive/ with their history. A
one-page QUALITY_IMPROVEMENT_LOG.md now shows the scorecard, targets and
phase status, and links to the design, plans and archive.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 3: Untrack `.kiro/`, ignore `invoice-template/`, commit the 13 Oct review

**Files:**
- Modify: `.gitignore`
- Untrack: `.kiro/` (28 files; the local copy stays)
- Add: `docs/reviews/2026-10-13-project-review.md`

- [ ] **Step 1: Untrack and ignore**

```bash
git rm -r --cached -q .kiro
printf '\n# Local tool and business files, never part of the app\n.kiro/\ninvoice-template/\n' >> .gitignore
git add .gitignore docs/reviews/2026-10-13-project-review.md
```

- [ ] **Step 2: Confirm the local copies survive and nothing else changes**

Run: `ls .kiro/steering/ui-ux-pro-max/SKILL.md && git status --short`
Expected: the `SKILL.md` path prints. Status shows the staged `.kiro` deletions, `.gitignore` and the review as staged. `invoice-template/` no longer appears as untracked.

- [ ] **Step 3: Gate and commit**

Run the gate (six `ok` lines), then:

```bash
git commit -q -F - <<'EOF'
chore: stop tracking the Kiro IDE skill; ignore local invoices; add the 13 Oct review

.kiro/ (a bundled IDE skill, 0.5 MB) stays on disk but leaves git.
invoice-template/ holds business files and is now ignored. The 13 Oct
project review joins docs/reviews/ beside later reviews.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 4: Make the top-level docs match the code

**Files:**
- Modify: `PRODUCT.md`, `server/README.md`, `docs/DEVELOPMENT.md`
- Create: `CONTRIBUTING.md`

- [ ] **Step 1: `PRODUCT.md`**

Replace the title line `# PRODUCT.md — Creative Hubb Album Toolkit Pro` with `# PRODUCT.md — Album Studio`.

Replace the whole `## Purpose` section (heading and its paragraph) with:

```markdown
## Purpose

The album production pipeline on the Mac: choose a shoot and template collections → plan
spreads (auto-fill places the whole album in capture order) → review spreads as the client will
→ edit any sheet in the built-in PhotoCraft editor → deliver print JPEGs and a low-res PDF
rendered by the PhotoCraft engine. Photoshop isn't needed at any step. Primary loop: photo pool
→ spread → next spread, hundreds of times per album.
```

Replace the first two bullets of `## Non-negotiables` (the "WCAG 2.1 AA enforced by CI…" bullet with its continuation line, and the "196 unit + 13 e2e tests…" bullet) with:

```markdown
- WCAG 2.1 AA in both shipped themes (studio dark and studio light)
- The shared, backend and interface test suites stay green through every visual change
```

- [ ] **Step 2: `server/README.md`**

Replace the section from `## Still to do (needs the owner's Firebase project)` to the end of the file with:

```markdown
## How it fits together

The owner's admin panel (outside this repository) calls `/sign` when it activates or extends a
licence, and stores the response's `sig`, `licExpiresOn` and `licActivatedOn` in the customer's
Firestore user record. The app signs in to Firebase with Google, reads its own record, and keeps
offline access only for a licence whose `sig` verifies against the bundled public key; an unsigned
record opens the app online only. Firestore rules let only the owner write those fields.

Known limit: the signature covers the customer's `name`, which the app refreshes from Google at
every sign-in, so a Google profile-name change breaks offline verification until the licence is
signed again (Extend in the admin panel does that).
```

- [ ] **Step 3: `docs/DEVELOPMENT.md` gate table**

Replace the table row whose first cell is `npm run lint` (it currently ends "ESLint over src/, test/ and native/backend/") with:

```markdown
| `npm run lint` | ESLint over `src/`, `test/`, `native/backend/` and `native/contracts/`, then the readability ratchet (`native/scripts/check-readability.mjs`: no file may gain lines over 160 characters or functions above complexity 20) |
```

Replace the table row whose first cell is `npm run typecheck` (it currently ends "the shared modules (opt-in // @ts-check) and the interface") with these two rows:

```markdown
| `npm run typecheck` | `tsc` over the shared modules and backend files that opt in with `// @ts-check`, and the interface |
| `npm run check:architecture` | Dependency boundaries, canonical contracts and the packaged closure |
```

- [ ] **Step 4: `CONTRIBUTING.md`**

Create `CONTRIBUTING.md`:

```markdown
# Contributing

Setup, the engine binaries, every test suite and the quality gates are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Before every commit, run the gates listed there;
the only test allowed to fail locally is the Poppler one when `pdftoppm` isn't installed.

Commits:

- One logical change per commit, with its tests.
- Subject in the imperative with a type prefix, e.g. `fix(backend): …`, `test: …`, `docs: …`.
- The body says why, with measurements where they matter.

Larger work starts from a design in `docs/superpowers/specs/` and a plan in
`docs/superpowers/plans/`.
```

- [ ] **Step 5: Gate and commit**

Run the gate (six `ok` lines), then:

```bash
git add PRODUCT.md server/README.md docs/DEVELOPMENT.md CONTRIBUTING.md
git commit -q -F - <<'EOF'
docs: bring PRODUCT, the licence server README and the dev guide up to date

PRODUCT.md described the Photoshop-based toolkit and Electron-era test
counts; it now describes the native pipeline. The licence server README
listed finished to-dos; it now explains how signing, the app and the rules
fit together, and the Google-rename limit. The dev guide's gate table gains
the readability ratchet, backend type checking and the architecture gate.
CONTRIBUTING.md points to the dev guide.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 5: Fix stale comments

**Files:**
- Modify: whichever runtime or test files Step 1 lists (comments only)
- Create: `$SCRATCH/stale-comments.txt`

The rule: a comment is stale when it states something untrue of today's code. That covers a step, file, function or tool that no longer exists, or Photoshop described as a required step. A comment that explains compatibility with files the Electron app wrote is still true, so it stays (for example "the saved licence is the Electron app's own file").

- [ ] **Step 1: List the candidates**

```bash
git grep -nE "(//|/\*|^\s*\*).*(Electron|ipcRenderer|ipcMain|Playwright|BrowserWindow|preload|Photoshop|renderer_pure|editor_geometry|shortcut_target|ui_icons)" \
  -- src native/backend native/ui/src native/contracts native/scripts scripts test server > "$SCRATCH/stale-comments.txt"
wc -l < "$SCRATCH/stale-comments.txt"
```

Expected: about 110 lines.

- [ ] **Step 2: Classify each line, and fix only the stale ones**

For each line, read the surrounding function and apply the rule. Edit stale comments so they say what the code does today, in the file's own comment style. Change comments only; no code. Record each change in `$SCRATCH/stale-comments-fixed.txt` as `file:line: old → new`.

- [ ] **Step 3: Prove only comments changed**

Run: `git diff -U0 | grep -E '^[-+][^-+]' | grep -vE '^[-+]\s*(//|/?\*|\*)' | head`
Expected: no output, so every changed line is a comment line.

- [ ] **Step 4: Gate and commit**

Run the gate (six `ok` lines), then commit with the subject `docs(comments): say what the code does today, not what the Electron app did`. The body lists how many comments changed and gives two examples from `stale-comments-fixed.txt`, and the message ends with the `Co-Authored-By` line.

### Task 6: Prove phase 1 is done, then re-score docs

**Files:**
- Create: `$SCRATCH/check-links.mjs`

- [ ] **Step 1: Every relative link in kept docs resolves**

Create `$SCRATCH/check-links.mjs`:

```js
// Every relative markdown link in the kept, living docs must point at a file or folder that
// exists. Archived and historical docs, and the design/plan templates, are skipped.
// Prints each broken link; exits 1 if any.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
const repo = process.argv[2]
const SKIP = ['docs/quality/archive/', 'docs/reviews/', 'docs/superpowers/', 'impeccable/']
const docs = execFileSync('git', ['ls-files', '*.md'], { cwd: repo, encoding: 'utf8' }).split('\n')
  .filter(f => f && !SKIP.some(prefix => f.startsWith(prefix)))
let broken = 0
for (const doc of docs) {
  const text = fs.readFileSync(path.join(repo, doc), 'utf8')
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const file = decodeURIComponent(target.split('#')[0])
    if (!file) continue
    if (!fs.existsSync(path.resolve(repo, path.dirname(doc), file))) { broken++; console.log(`${doc}: ${target}`) }
  }
}
console.log(broken ? `${broken} broken link(s)` : 'all relative links resolve')
process.exitCode = broken ? 1 : 0
```

Run: `node "$SCRATCH/check-links.mjs" /Volumes/Harry/works/albumStudio-photocraft`
Expected: `all relative links resolve`. Fix any broken link in the doc that holds it (gate, then commit as `docs: fix links after the archive move`).

- [ ] **Step 2: Measure the done criteria**

```bash
echo "tracked logs: $(git ls-files '*.log' | wc -l | tr -d ' ')"
git ls-files -s docs | awk '{print $4}' | git cat-file --batch-check='%(objectsize)' | awk '{s+=$1} END {printf "tracked docs: %.1f MB\n", s/1048576}'
git grep -nE "e2e/a11y\.spec|196 unit|Creative Hubb Album Toolkit Pro" -- '*.md' ':!docs/quality/archive' ':!docs/reviews' ':!docs/superpowers' | head
```

Expected: `tracked logs: 0`, `tracked docs: ≤ 3.0 MB`, and no stale-claim matches.

- [ ] **Step 3: Re-score "Docs & repo hygiene" and update the status page**

Re-score from Step 2's measurements against the spec's target of 9, using the original review's criteria: tracked docs size, log length, accuracy of top-level docs, stale comments. Update the scorecard row and phase table in `QUALITY_IMPROVEMENT_LOG.md` (add a "Now" column). Then gate, and commit as `docs: record the phase 1 re-score`, ending with the `Co-Authored-By` line. If the area lands below 9, say which criterion fell short.

- [ ] **Step 4: Commit this plan**

```bash
git add docs/superpowers/plans/2026-10-28-phase-1-docs-hygiene.md
git commit -q -m "docs: add the phase 1 plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
