# Phase 2: Architecture, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise "Architecture & structure" from 8 to 9. Delete the runtime modules no application entry point reaches. Make the architecture gate reject any new one. Document the module map.

**Architecture:** Reachability follows `require`/`import` transitively from the four application entry points. The gate already builds that import graph, so it gains an opt-in `reachability` policy and an `UNREACHABLE_MODULE` violation. Live tests in the dead modules' test files move to the live modules' own test files first; then the dead code goes. Git history keeps it.

**Tech Stack:** Node 22 (`node:test`), `native/scripts/check-architecture.mjs` (TypeScript-AST import graph).

**Spec:** `docs/superpowers/specs/2026-10-28-quality-above-nine-design.md` (phase 2).

## Global Constraints

- Repo `/Volumes/Harry/works/albumStudio-photocraft`, branch `codex/album-quality-improvement`. Nothing is pushed.
- Gate before every commit: `/private/tmp/claude-501/-Volumes-Harry-works-albumStudio-photocraft/2821a411-2a3f-4a06-90c0-a3e281d60cf7/scratchpad/phase0/gate.sh /Volumes/Harry/works/albumStudio-photocraft`. It must print six `ok` lines; the Poppler test is the only allowed failure.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Keep new lines at 160 characters or less.
- **Ruling: three dead modules, not four.** Transitive reachability (measured 2026-10-28) finds three unreachable modules: `src/renderer_pure.js`, `src/shortcut_target.js` and `src/ui_icons.js`. `src/editor_geometry.js` is live through `src/proof_renderer.js:40`.
- **Ruling: the four app entry points are enough.** They are `native/backend/server.js`, `native/ui/src/main.tsx`, `server/index.js` and `server/keygen.js`. Adding the tool scripts in `native/scripts/`, `scripts/` and `bench/` reaches no additional module (measured), so they are not entries. A module used only by a tool would need its tool added to the entries.

## Review Focus

1. **Type declarations.** `.d.ts` files (`src/shared/domain.d.ts`, `native/contracts/runtime.d.ts`) are not runtime modules and must never be reported. Task 2 covers this.
2. **Entries outside the roots.** The licence server (`server/`) is outside the gate's roots; a shared module that only it imports (`src/license_signing.js`) must count as reachable. Task 2 covers this.
3. **Live tests survive.** Every test of a live module that sat in a dead module's test file still runs after the move; test counts must not fall by more than the dead modules' own tests. Task 1 covers this.
4. **Existing gate tests stay meaningful.** The fixture-based architecture tests don't start failing on unrelated unreachable fixture files. Task 2 covers this.
5. **Nothing live is deleted.** The real repo shows zero `UNREACHABLE_MODULE` after the deletions, and the full suite passes. Task 2 covers this.

---

### Task 1: Move live tests out, then delete the three dead modules

**Files:**
- Create: `test/exif_date.test.js`, `test/autofill_counts.test.js`
- Delete (`git rm`): `src/renderer_pure.js`, `src/shortcut_target.js`, `src/ui_icons.js`, `test/renderer_pure.test.js`, `test/shortcut_target.test.js`

- [ ] **Step 1: Count the shared tests now**

Run: `node --test test/*.test.js 2>&1 | grep -E '^# (tests|pass|fail)'` and note the count as `BEFORE`.

- [ ] **Step 2: Extract the live tests verbatim**

Create `$SCRATCH/extract.js` (`SCRATCH=/private/tmp/claude-501/-Volumes-Harry-works-albumStudio-photocraft/2821a411-2a3f-4a06-90c0-a3e281d60cf7/scratchpad/phase2`):

```js
// Copy named top-level test() blocks and helper functions verbatim from one test file into a new one.
'use strict'
const fs = require('fs')
const [from, to, header, ...args] = process.argv.slice(2)
// "@file" reads more names from a file, one per line, so names with spaces survive the shell.
const names = args.flatMap(a => a.startsWith('@') ? fs.readFileSync(a.slice(1), 'utf8').split('\n').filter(Boolean) : [a])
const lines = fs.readFileSync(from, 'utf8').split('\n'), out = [fs.readFileSync(header, 'utf8').trimEnd(), '']
for (const name of names) {
  const start = lines.findIndex(l => l.startsWith(`test('${name}'`) || l.startsWith(`function ${name}(`))
  if (start < 0) throw new Error(`not found: ${name}`)
  let first = start
  while (first > 0 && lines[first - 1].startsWith('//')) first--
  let end = start
  while (!/^}\)?\s*$/.test(lines[end])) end++
  out.push(...lines.slice(first, end + 1), '')
}
fs.writeFileSync(to, out.join('\n').trimEnd() + '\n')
console.log(`${names.length} blocks → ${to}`)
```

Write `$SCRATCH/exif-header.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseExifDateFromBuffer } = require('../src/exif_date')
```

Write `$SCRATCH/autofill-header.js` the same way, with `const { planAutoFillCounts } = require('../src/autofill_counts')` as its last line.

Run:

```bash
node "$SCRATCH/extract.js" test/renderer_pure.test.js test/exif_date.test.js "$SCRATCH/exif-header.js" \
  buildJpegWithExifDate 'parseExifDateFromBuffer reads DateTimeOriginal from a real APP1 block' \
  'parseExifDateFromBuffer returns null for a non-JPEG buffer' 'parseExifDateFromBuffer returns null for a JPEG with no EXIF date'
grep -oE "^test\('[^']*planAutoFillCounts[^']*'|^test\('the desired-mode remainder is spread, not front-loaded'" test/renderer_pure.test.js \
  | sed -E "s/^test\('//; s/'$//" > "$SCRATCH/autofill-names.txt"; wc -l < "$SCRATCH/autofill-names.txt"
node "$SCRATCH/extract.js" test/renderer_pure.test.js test/autofill_counts.test.js "$SCRATCH/autofill-header.js" "@$SCRATCH/autofill-names.txt"
```

Expected: `4 blocks`, then `11`, then `11 blocks`.

- [ ] **Step 3: Run the new files on their own**

Run: `node --test test/exif_date.test.js test/autofill_counts.test.js`
Expected: 14 pass.

- [ ] **Step 4: Delete the dead modules and their tests**

```bash
git rm -q src/renderer_pure.js src/shortcut_target.js src/ui_icons.js test/renderer_pure.test.js test/shortcut_target.test.js
git grep -nE "renderer_pure|shortcut_target|ui_icons" -- src native test scripts server bench ':!docs' | head
```

Expected: no output. Any hit is a live reference; stop and investigate it.

- [ ] **Step 5: Count again, gate, commit**

Run: `node --test test/*.test.js 2>&1 | grep -E '^# (tests|pass|fail)'`. Expected: `BEFORE` minus the deleted modules' own tests (those of `renderer_pure.test.js` other than the 14 moved, plus all of `shortcut_target.test.js`), and `# fail 0`.

Run the gate (six `ok` lines). If the readability check reports improved files, run `node native/scripts/check-readability.mjs --update` and include the baseline. Then:

```bash
git add test/exif_date.test.js test/autofill_counts.test.js native/scripts/readability-baseline.json
git commit -q -F - <<'EOF'
refactor: delete three Electron-era modules nothing reaches

src/renderer_pure.js, src/shortcut_target.js and src/ui_icons.js (628 lines)
are imported by no application entry point, directly or indirectly; they
built the Electron renderer's HTML. Their tests go with them. The Exif-date
and Auto-Fill tests that lived in renderer_pure's test file move, verbatim,
to test/exif_date.test.js and test/autofill_counts.test.js.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 2: The gate rejects modules no entry point reaches

**Files:**
- Modify: `native/scripts/check-architecture.mjs` (`defaultPolicy`, `checkArchitecture`)
- Test: `test/architecture_boundaries.test.js`

**Interfaces:**
- Produces: `defaultPolicy.reachability = { entries: string[] }`; violation `{ code: 'UNREACHABLE_MODULE', message, file }`.

- [ ] **Step 1: Keep existing fixture tests independent of the new rule**

In `test/architecture_boundaries.test.js`, inside `fixture()`, directly after `const policy = JSON.parse(JSON.stringify(defaultPolicy))`, add:

```js
  delete policy.reachability // the miniature fixture has deliberately unimported files; one test opts in
```

- [ ] **Step 2: Write the failing test**

Append to `test/architecture_boundaries.test.js`:

```js
test('a module no application entry point reaches is reported; type declarations and issuer-only imports are not', async t => {
  const f = await fixture(t)
  f.policy.reachability = { entries: ['native/backend/server.js', 'native/ui/src/main.ts', 'server/index.js'] }
  f.write('src/orphan.js', 'module.exports = {}\n')
  f.write('src/types.d.ts', 'export type Unused = string\n')
  f.write('src/signing.js', 'module.exports = {}\n')
  f.write('server/index.js', "require('../src/signing')\n")
  const unreachable = f.check().violations.filter(v => v.code === 'UNREACHABLE_MODULE').map(v => v.file)
  assert.ok(unreachable.includes('src/orphan.js'), JSON.stringify(unreachable))
  for (const live of ['src/types.d.ts', 'src/signing.js', 'native/ui/src/bridge.ts', 'native/backend/methods.js']) {
    assert.equal(unreachable.includes(live), false, live)
  }
})
```

Run: `node --test --test-name-pattern='no application entry point reaches' test/architecture_boundaries.test.js`
Expected: FAIL (no `UNREACHABLE_MODULE` is ever produced).

- [ ] **Step 3: Implement**

In `native/scripts/check-architecture.mjs`, add to `defaultPolicy`, after the `runtime:` line:

```js
  reachability: { entries: ['native/backend/server.js', 'native/ui/src/main.tsx', 'server/index.js', 'server/keygen.js'] },
```

In `checkArchitecture`, directly before the line that starts `const runtimeFiles = new Set(`, add:

```js
  if (policy.reachability) {
    // Every module under the roots must be reachable from an application entry point. Entries
    // outside the roots (the licence server) contribute their imports only; .d.ts files are types.
    const reached = new Set(), queue = [...policy.reachability.entries]
    const outgoing = file => sources.has(file) ? edges.filter(edge => edge.from === file)
      : refsIn(sourceOf(file, fs.readFileSync(path.join(root, file), 'utf8'))).edges
        .map(ref => ({ ...ref, target: ref.spec.startsWith('.') ? resolveLocal(root, file, ref.spec) : null }))
    while (queue.length) {
      const file = queue.pop()
      if (reached.has(file) || !fs.existsSync(path.join(root, file))) continue
      reached.add(file)
      for (const edge of outgoing(file)) if (edge.target) queue.push(edge.target)
    }
    for (const file of nodes) {
      if (!reached.has(file) && !file.endsWith('.d.ts')) add('UNREACHABLE_MODULE', 'No application entry point reaches this module; import it or delete it.', { file })
    }
  }
```

- [ ] **Step 4: Run the test, the whole architecture test file and the real gate**

Run:
- `node --test test/architecture_boundaries.test.js`. Expected: all pass, including the new test.
- `npm run check:architecture | tail -3`. Expected: ok, with 0 violations on the real repo, since Task 1 removed the dead modules.

- [ ] **Step 5: Prove the gate catches a new orphan**

Run: `printf 'module.exports = {}\n' > src/zz_orphan_probe.js && npm run check:architecture 2>&1 | grep -c UNREACHABLE_MODULE; rm src/zz_orphan_probe.js`
Expected: `1`. The probe is a scratch file this step creates and removes.

- [ ] **Step 6: Gate and commit**

Run the gate (six `ok` lines). Then commit `native/scripts/check-architecture.mjs` and `test/architecture_boundaries.test.js`:

```bash
git commit -q -F - <<'EOF'
feat(architecture): reject runtime modules no application entry point reaches

The gate follows imports from the backend server, the interface entry and
the licence server (whose own imports count, though it sits outside the
scanned roots) and reports every module under src/, native/backend,
native/ui/src or native/contracts it never reaches. Type declarations are
exempt. The miniature fixture opts out so existing tests stay focused.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 3: Document the module map

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Add a "Module reachability" section**

Insert directly after the `## Components and dependency direction` section of `docs/ARCHITECTURE.md` (before `## State and ownership`):

```markdown
## Module reachability

Every runtime module under `src/`, `native/backend/`, `native/ui/src/` and `native/contracts/`
must be reachable, through `require`/`import`, from an application entry point:
`native/backend/server.js` (the helper), `native/ui/src/main.tsx` (the interface),
`server/index.js` or `server/keygen.js` (the licence issuer). `npm run check:architecture`
reports any other module as `UNREACHABLE_MODULE`. Type declarations (`*.d.ts`) are exempt, and
tests are not entry points, so a module only tests use counts as dead. Shared modules in `src/`
are used by the helper (proofs, PSD layers, curation, licensing, Auto-Fill counts, Exif dates)
and by the licence issuer (`license_signing.js`).
```

- [ ] **Step 2: Gate and commit**

Run the gate, then commit with the subject `docs(architecture): describe module reachability and the gate rule`, ending with the `Co-Authored-By` line.

### Task 4: Re-score architecture and commit this plan

- [ ] **Step 1: Re-score**

Re-score "Architecture & structure" against the review's drags: Electron-era leftovers and odd coupling (the coupling was fixed in phase 0's history; the leftovers are now removed and gate-enforced). Update the "Now" column and the phase table in `QUALITY_IMPROVEMENT_LOG.md`. Gate, and commit as `docs: record the phase 2 re-score`, ending with the `Co-Authored-By` line. If the area lands below 9, say what falls short.

- [ ] **Step 2: Commit this plan**

```bash
git add docs/superpowers/plans/2026-10-28-phase-2-architecture.md
git commit -q -m "docs: add the phase 2 plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
