# Phase 3: Tooling, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise "Tooling & CI" from 7.5 toward 9.5. Prettier formats the code and CI checks it. ESLint 10's flat config lints all JavaScript and the interface's TypeScript, with accessibility rules. CI's strict test gate enforces coverage limits.

**Architecture:** One `eslint.config.mjs` replaces `.eslintrc.json`. ESLint's own suppressions file (`eslint-suppressions.json`) records the findings left for later phases. A new finding fails lint, and so does an entry that no longer occurs, so the file can only shrink. Prettier lands as a setup commit, then one pure formatting commit that `.git-blame-ignore-revs` lists. The generated `types.ts` is formatted by its own generator. Coverage limits live in the `test:coverage` scripts, and the strict gate (`engine.mjs test-node`, which CI runs) runs them through a new `test:strict` script.

**Tech Stack:** ESLint 10.13 with `@eslint/js` 10, `globals` 17, `typescript-eslint` 8.72 and `eslint-plugin-jsx-a11y` 6.10.2; Prettier 3.9.10; Node 22 test-runner coverage thresholds.

**Spec:** `docs/superpowers/specs/2026-10-28-quality-above-nine-design.md` (phase 3; decisions 6 and 9).

## Global Constraints

- Repo `/Volumes/Harry/works/albumStudio-photocraft`, branch `codex/album-quality-improvement`. Nothing is pushed.
- `SCRATCH=/private/tmp/claude-501/-Volumes-Harry-works-albumStudio-photocraft/2821a411-2a3f-4a06-90c0-a3e281d60cf7/scratchpad/phase3`.
- Gate before every commit: `$SCRATCH/../phase0/gate.sh /Volumes/Harry/works/albumStudio-photocraft`. It prints six `ok` lines until Task 3 adds the format check (seven). The Poppler test is the only allowed failure. Also run `npm --prefix native/ui run build` when UI code changes (Tasks 2 and 3).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. New lines stay at 160 characters or less; from Task 3, Prettier sets the layout.
- Never restore a file with uncommitted changes from git. Mutation checks copy the file to `$SCRATCH` first and restore from that copy.
- Decision 6, verbatim: "Prettier matching today's style: no semicolons, single quotes, two-space indent, 120-character lines. One formatting commit, listed in `.git-blame-ignore-revs`."
- Decision 9: new dev-only dependencies, none of which ship in the app, include "`prettier`, … `typescript-eslint`, `eslint-plugin-jsx-a11y` … plus an ESLint upgrade if the flat config needs one".
- Spec phase 3: "Move ESLint to the flat config, lint `native/ui/src` with `typescript-eslint` and `eslint-plugin-jsx-a11y`, and keep the existing rules for JavaScript." Coverage limits are "set just below today's figures … and raised in phase 5".
- Every figure below was measured on 2026-10-28 by rehearsing this whole plan on a copy of `5ef349b` (`$SCRATCH/rehearse.sh`). That run passed every check: format check, lint, readability, typecheck, architecture, contract types, UI build, all three suites and the native-contract byte check.
- The spec asks before formatting if the Google-rename fix hasn't merged. It has: it is on this branch as `97b4c96`. No local branch holds commits this branch lacks (checked 2026-10-28), so the formatting commit conflicts with no pending work.

### Rulings

Each ruling has its cost if wrong.

1. **ESLint 10, not 8 or 9.**
   - ESLint 8 has had no fixes since October 2024. npm marks 9.39.5 as "no longer supported". 10.13.0 is current.
   - `eslint-plugin-jsx-a11y` 6.10.2, its latest release (October 2024), declares ESLint peers only up to 9. It calls only `context.report`, `context.options` and `context.settings`, all of which ESLint 10 keeps. The rehearsal ran it on ESLint 10 and got the expected findings.
   - An npm `overrides` entry lets it use ESLint 10.
   - Cost if wrong: an accessibility rule misbehaves. Task 2's mutation check would catch that, and ESLint 9.39.5 is the fallback.
2. **Two companion packages beyond decision 9's list:** `@eslint/js` (the recommended rule set the flat config imports) and `globals` (the Node and browser global names that `env` used to supply). Both are standard parts of ESLint's own flat-config setup and are dev-only. Cost if wrong: two small extra dev packages.
3. **"Keep the existing rules" means the custom settings carry over and ESLint 10's recommended set applies.** Where ESLint changed a default, the old intent is kept explicitly:
   - **Caught errors:** ESLint 9 started checking them, so `caughtErrorsIgnorePattern: '^_'` extends the `_` convention the config already applies to arguments and variables. The three bindings that were never used become `catch {}`.
   - **Globals:** Node code gets Node's globals only. The old config gave every file browser globals too, and with ESLint 9's `builtinGlobals` check that flags 50 `const crypto = require('crypto')` lines. `src/` keeps browser globals for its wrappers' `window`. All of it is linted as CommonJS, which it is.
   - **Rules that drop out:** `no-redeclare` and `no-undef` stay errors through the recommended set. `no-extra-semi` is gone, because Prettier owns semicolons.

   Cost if wrong: none at runtime; lint only.
4. **Lint covers all code:** 237 files, up from 156. That is 175 JavaScript files (adding `server/`, `scripts/`, `bench/`, `native/scripts/` and the interface's build tools) and 62 TypeScript files (the interface and the generated contract types). The lint script names the code directories, because ESLint doesn't read `.gitignore` and this checkout holds ignored local folders full of code: `impeccable/` (about 3,000 files), `.claude/` and `invoice-template/`. Cost if wrong: a new top-level code directory needs adding to `lint:eslint`.
5. **The 18 `preserve-caught-error` findings are recorded, not fixed.** `serializeError` (`native/contracts/runtime.js:195-212`) copies recovery metadata from an error's `cause` chain into the reply: committed/recovery flags, `retryable` and recovery paths. Attaching a cause therefore changes what some replies report. Phase 4 decides each site, with a test. Cost if wrong: the 18 sites keep losing their original error until phase 4.
6. **Accessibility: 11 findings.**
   - **Exempt, with the reason inline (4):** the two window drag regions, which are mouse-only like any title bar; the template browser, which closes on Escape bubbling from its controls; and the menu, whose items carry focus.
   - **Fixed (2):** a click-swallowing `<span>` around the frame tools becomes `role="presentation"`, which clears both of its findings.
   - **Recorded for phase 5 (5, in 3 controls that need keyboard operation):** the Inspector's photo rows, the spread's frame hit areas and the frame-adjust overlay. Phase 5 adds them with component tests that prove they work.

   No interface behaviour changes in this phase. Cost if wrong: those three controls stay mouse-only until phase 5, as they are today.
7. **The suppressions file is the ratchet.** A new violation fails lint (exit 1), and a stale entry fails it too (exit 2: "There are suppressions left that do not occur anymore"). Both were measured. Prettier skips the file because ESLint writes it in its own layout. Cost if wrong: none.
8. **The readability baseline is re-recorded twice.**
   - Under ESLint 10, because ESLint 9 began counting optional chaining and default values toward complexity: `psd_template.js` goes from 2 to 3 and `project_lock.js` from 0 to 1, with no code changed.
   - After formatting: lines over 160 in the ratchet's scope fall from 863 to 57, and files with findings from 111 to 54.

   Cost if wrong: none, since the counts only fell or rose from the measuring change.
9. **What Prettier formats:** JavaScript, TypeScript, JSON and YAML.
   - **Skipped (`.gitignore`'d paths too):**
     - Markdown and `docs/` (prose and frozen evidence).
     - CSS: short rules stay on one line, with aligned comments. Prettier would add about 2,700 lines to `app.css`.
     - The two HTML pages: phase 6 reviews `index.html`'s CSP, and `spike.html` is a leftover shell page, logged for phase 4.
     - Bytes other tools own: npm's lockfiles, the suppressions file, the contract JSON the engine shares byte for byte (`types.ts` records its SHA-256), and `pin.json`, which CI cache keys hash.
   - **Options beyond decision 6 stay at Prettier's defaults** (arrow parentheses always, trailing commas everywhere). The measured churn differs by under 1% between choices.

   Cost if wrong: CSS stays unformatted; a later decision can add it.
10. **Generated files are formatted** (spec phase 4: they "are still formatted"). The `types.ts` generator formats its own output with this repository's Prettier settings, never those of the `--root` it targets. Cost if wrong: none.
11. **Coverage limits: shared 88/88 instead of the spec's 89/89; backend 94/88 as specified.**
    - Measured on the formatted tree: shared 88.64% of lines and 88.61% of branches; backend 94.95% and 88.77%.
    - Phase 2's removal of three well-covered dead modules lowered the shared figure; no live file changed.
    - The user left the choice to me (2026-10-29). 88/88 keeps the spec's rule, "just below today's figures"; 89/89 would first need the tests phase 5 adds anyway.

    Cost if wrong: a 0.6-point regression slips through until phase 5 raises the limits to 92/90.
12. **The strict gate enforces the limits, `npm test` doesn't.** Without an engine, `npm test` skips the engine tests and would miss the limits locally. The strict gate already requires the engine, and CI runs each suite once. Cost if wrong: none.
13. **CI fails if a `.log` file is tracked,** which keeps phase 1's result. `.gitignore` already blocks new logs; this catches `git add -f`. Cost if wrong: one CI line.

## Review Focus

1. **Bytes owned elsewhere stay identical through formatting.** That covers the contract JSON shared with the engine, `pin.json`, the lockfiles and the suppressions file. Task 3 Step 8 checks the formatting commit's file list and re-runs the native-contract byte check.
2. **Formatting changes no behaviour.** All three suites, the UI build, typecheck, the architecture gate and lint (including `no-unexpected-multiline`) run on the formatted tree. Task 3 Step 9.
3. **The generator gives identical, formatted output from any `--root`.** `test/contract_types.test.js` runs it on a temp-folder root. Task 3 Step 5's mutation reads the Prettier settings from the wrong place and must fail that test.
4. **Lint really covers the new scope.** Task 1 Step 10 plants violations in a newly linted directory. Task 2 Step 7 plants them in an interface component. Each must fail lint.
5. **The coverage limits can't silently drop out of the strict gate.** Task 4's test fails if the gate script loses a suite or a limit (Step 6 mutation), and a limit set above the measured figure fails the run.

---

### Task 1: ESLint 10's flat config over all JavaScript

**Files:**
- Create: `eslint.config.mjs`, `eslint-suppressions.json`, `$SCRATCH/tally.cjs`
- Delete: `.eslintrc.json` (`git rm`; history keeps it)
- Modify:
  - `package.json` and `package-lock.json`
  - `native/backend/lib/labnaming.js:61-62`
  - `native/backend/test/project.test.js:120,314,317`
  - `native/backend/test/proofs.test.js:168,178`
  - `src/license.js:73,85`
  - `scripts/colormatch.js:32,120-122`
  - `native/scripts/readability-baseline.json`

**Interfaces:**
- Produces:
  - `eslint.config.mjs`, a `defineConfig([...])` array with a `const underscoreMeansUnused` that Task 2 reuses.
  - `npm run lint:eslint`, which is `eslint --max-warnings 0 eslint.config.mjs src test server scripts bench native`.
  - `npm run lint`, which is `npm run lint:eslint && npm run check:readability`.
  - `eslint-suppressions.json` at the root.

- [ ] **Step 1: Install ESLint 10 and write the tally helper**

```bash
npm install --save-dev eslint@10.13.0 @eslint/js@10.0.1 globals@17.13.0
```

Expected: `package.json` lists `"eslint": "^10.13.0"`, `"@eslint/js": "^10.0.1"` and `"globals": "^17.13.0"`. Write `$SCRATCH/tally.cjs`:

```js
// Tallies an ESLint JSON report by rule: node tally.cjs <report.json>
const report = require(require('node:path').resolve(process.argv[2])), counts = {}
for (const file of report) for (const m of file.messages) counts[m.ruleId] = (counts[m.ruleId] || 0) + 1
console.log(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([rule, n]) => `${n}\t${rule}`).join('\n') || 'clean')
```

- [ ] **Step 2: Write the flat config and drop the old one**

Create `eslint.config.mjs`:

```js
// ESLint flat config. Prettier owns formatting; ESLint checks correctness in all JavaScript.
// Findings still to fix are recorded in eslint-suppressions.json, which may only shrink.
import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'

const underscoreMeansUnused = { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }

export default defineConfig([
  globalIgnores(['**/dist/', 'bench/fixture/', 'native/photocraft/']),
  {
    files: ['**/*.{js,cjs,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: globals.node },
    rules: {
      'no-unused-vars': ['warn', underscoreMeansUnused],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
      'no-inner-declarations': 'off',
      'prefer-const': 'warn',
    },
  },
  // The shared modules' wrappers still look for a browser `window`.
  { files: ['src/**/*.js'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  { files: ['**/*.mjs'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
])
```

Run `git rm -q .eslintrc.json`. In `package.json`, set `"lint": "npm run lint:eslint && npm run check:readability"` and add `"lint:eslint": "eslint --max-warnings 0 eslint.config.mjs src test server scripts bench native"`.

- [ ] **Step 3: Run lint and see it fail (RED)**

```bash
npx eslint eslint.config.mjs src test server scripts bench native -f json -o "$SCRATCH/t1-red.json"; node "$SCRATCH/tally.cjs" "$SCRATCH/t1-red.json"
```

Expected:

```
18	preserve-caught-error
6	no-useless-assignment
3	no-unused-vars
3	prefer-const
```

- [ ] **Step 4: Fix the dead stores and unused bindings**

Exact edits:
- `native/backend/lib/labnaming.js:61-62`: `  let width = 0` becomes `  let width`, and `  let height = 0` becomes `  let height`. Both branches below assign them before the dimension check.
- `native/backend/test/project.test.js:120`: `  r = await redo({ album: proj })` becomes `  await redo({ album: proj })`. The assertion after it reads the file.
- `native/backend/test/project.test.js:317`: `  r = await edit(proj, { op: 'adjustPhoto', id: B, adjust: { exposure: 0 } })` becomes `  await edit(proj, { op: 'adjustPhoto', id: B, adjust: { exposure: 0 } })`.
- `native/backend/test/project.test.js:314`: the `let r = await edit(proj, { op: 'adjustPhoto', id: B, adjust: { exposure: 30.4, …` declaration becomes `const r = …`, since nothing reassigns it now.
- `native/backend/test/proofs.test.js:168` and `:178`: `  ev = await refresh(proj)` becomes `  await refresh(proj)`. The assertions after each one read the files.
- `src/license.js:73`: `  } catch(e) { return null }` becomes `  } catch { return null }`.
- `src/license.js:85`: `  try { fs.unlinkSync(LICENSE_FILE) } catch(e) {}` becomes `  try { fs.unlinkSync(LICENSE_FILE) } catch {}`.
- `scripts/colormatch.js:32`: `  try { sharp = require('sharp') } catch (e) {` becomes `  try { sharp = require('sharp') } catch {`.
- `scripts/colormatch.js:120-122`: `let sumAbs`, `let sumSigned` and `let sumSq` become `const`. The arrays are filled in place and never reassigned.

- [ ] **Step 5: Record the 18 `preserve-caught-error` findings**

```bash
npx eslint eslint.config.mjs src test server scripts bench native --suppress-rule preserve-caught-error
```

Expected: `eslint-suppressions.json` lists 18 findings in 10 files:

| File | Findings |
|---|---:|
| `native/backend/lib/account.js` | 1 |
| `native/backend/lib/album.js` | 1 |
| `native/backend/lib/cache.js` | 1 |
| `native/backend/lib/delivery_transaction.js` | 5 |
| `native/backend/lib/labnaming.js` | 2 |
| `native/backend/lib/project_lock.js` | 1 |
| `native/backend/lib/project_transaction.js` | 2 |
| `native/backend/lib/render_transaction.js` | 3 |
| `native/backend/lib/sheets.js` | 1 |
| `native/scripts/publish-new-directory.mjs` | 1 |

- [ ] **Step 6: Re-record the readability baseline under ESLint 10**

Run `npm run check:readability`. Expected: it fails on exactly two entries:
- `native/backend/lib/project_lock.js: 1 complexity findings, 0 recorded`
- `native/backend/lib/psd_template.js: 3 complexity findings, 2 recorded`

Then run `node native/scripts/check-readability.mjs --update`. Confirm that `git diff native/scripts/readability-baseline.json` changes only those two entries.

- [ ] **Step 7: Run lint and see it pass (GREEN)**

Run: `npm run lint`. Expected: exit 0, and `readability: ok, no file exceeds its recorded findings.`

- [ ] **Step 8: Check the old config's intent survived**

Run `npx eslint --print-config src/curation.js | grep -E '"(no-redeclare|no-undef|no-unused-vars|prefer-const)"' -A1`. Expected: `no-redeclare` and `no-undef` are errors (2); `no-unused-vars` and `prefer-const` are warnings (1).

- [ ] **Step 9: Count the scope**

Run: `npx eslint eslint.config.mjs src test server scripts bench native -f json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))'`. Expected: `175`.

- [ ] **Step 10: Mutation checks (each must fail lint; restore from the copy)**

1. Copy `server/index.js` to `$SCRATCH/index.js.bak` and append `const unusedProbe = 1`. Run `npm run lint:eslint`. Expected: exit 1 on a `no-unused-vars` warning, because warnings fail. Restore from the copy.
2. Copy `native/scripts/publish-new-directory.mjs` to `$SCRATCH/publish.bak` and append `try { JSON.parse('') } catch (error) { throw new Error('probe') }`. Run `npm run lint:eslint`. Expected: exit 1 with a `preserve-caught-error` error, more than its one recorded finding. Restore from the copy.
3. Make a stale entry:

   ```bash
   node -e 'const s = require("./eslint-suppressions.json"); s["native/backend/lib/sheets.js"]["preserve-caught-error"].count = 2; require("fs").writeFileSync(process.argv[1], JSON.stringify(s, null, 2))' "$SCRATCH/stale.json"
   npx eslint eslint.config.mjs src test server scripts bench native --suppressions-location "$SCRATCH/stale.json"
   ```

   Expected: exit 2 and "There are suppressions left that do not occur anymore".

- [ ] **Step 11: Gate and commit**

Run the gate (six `ok` lines), then:

```bash
git add eslint.config.mjs eslint-suppressions.json package.json package-lock.json native/scripts/readability-baseline.json \
  native/backend/lib/labnaming.js native/backend/test/project.test.js native/backend/test/proofs.test.js src/license.js scripts/colormatch.js
git commit -q -F - <<'EOF'
build(lint): move to ESLint 10's flat config and lint all JavaScript

ESLint 8 has had no fixes since October 2024 and 9's support has ended;
10.13 is current. The flat config keeps the existing rule settings and
adds ESLint 10's recommended rules. Lint now covers every JavaScript
file: server/, scripts/, bench/, native/scripts/ and the interface's build
tools join the 156 files linted before (175 now). Warnings fail.

Two defaults changed since ESLint 8. Caught errors are checked, so the
`_` convention the config already applied to arguments and variables
covers them too; three bindings that were never used are dropped. Node
code gets Node's globals only: giving it a browser's as well made every
`const crypto = require('crypto')` clash with the browser global.

Fixed: six dead stores (the tests' assertions read the files, so the
discarded results were never checked) and three let-to-const.

Recorded, not fixed: 18 errors thrown from catch blocks without a cause
(preserve-caught-error, new in ESLint 10). serializeError copies recovery
metadata from an error's cause chain into the reply, so attaching causes
changes what replies report; phase 4 decides each site, with tests.
eslint-suppressions.json holds them and may only shrink: a new finding
fails lint, and so does an entry that no longer occurs.

The readability baseline is re-recorded because ESLint 9 began counting
optional chaining and default values toward complexity: psd_template.js
2 -> 3 and project_lock.js 0 -> 1. No code changed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Lint the interface with TypeScript and accessibility rules

**Files:**
- Modify: `package.json` (add `overrides`), `package-lock.json`, `eslint.config.mjs`, `eslint-suppressions.json`
- Modify:
  - `native/ui/src/app/AlbumSettings.tsx:9` and `native/ui/src/places/Library.tsx:9`
  - `native/ui/src/bridge.ts:74-76`
  - `native/ui/src/app/Frame.tsx:47-48`
  - `native/ui/src/app/SignIn.tsx:82-83`
  - `native/ui/src/places/plan/TemplateBrowser.tsx:55-56`
  - `native/ui/src/ui/Menu.tsx:71-72`
  - `native/ui/src/places/plan/SpreadView.tsx:146`

**Interfaces:**
- Consumes: Task 1's `eslint.config.mjs` and `underscoreMeansUnused`.
- Produces: TypeScript blocks for `native/ui/**/*.{ts,tsx}` and `native/contracts/**/*.ts`, and an accessibility block for `native/ui/src/**/*.tsx`.

- [ ] **Step 1: Install, with the override in place first**

Add `"overrides": { "eslint-plugin-jsx-a11y": { "eslint": "$eslint" } }` at the top level of `package.json`, then:

```bash
npm install --save-dev typescript-eslint@8.72.1 eslint-plugin-jsx-a11y@6.10.2
npm ls eslint | grep jsx-a11y
```

Expected: no `ERESOLVE`, and `eslint-plugin-jsx-a11y@6.10.2 overridden`. Root `typescript` stays at 6.0.3, inside `typescript-eslint`'s `>=4.8.4 <6.1.0`.

- [ ] **Step 2: Extend the config**

In `eslint.config.mjs`:
- Make the first two comment lines read: `// ESLint flat config. Prettier owns formatting; ESLint checks correctness in all JavaScript and, for` / `// the interface, TypeScript and accessibility rules. Findings still to fix are recorded in` / `// eslint-suppressions.json, which may only shrink.`
- Add `import jsxA11y from 'eslint-plugin-jsx-a11y'` and `import tseslint from 'typescript-eslint'`, keeping the imports alphabetical.
- Append after the `.mjs` block:

```js
  {
    files: ['native/ui/**/*.{ts,tsx}', 'native/contracts/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: { globals: globals.browser },
    rules: { '@typescript-eslint/no-unused-vars': ['error', underscoreMeansUnused] },
  },
  { files: ['native/ui/src/**/*.tsx'], extends: [jsxA11y.flatConfigs.recommended] },
```

- [ ] **Step 3: Run lint and see it fail (RED)**

```bash
npx eslint eslint.config.mjs src test server scripts bench native -f json -o "$SCRATCH/t2-red.json"; node "$SCRATCH/tally.cjs" "$SCRATCH/t2-red.json"
```

Expected:

```
4	jsx-a11y/no-static-element-interactions
3	jsx-a11y/no-noninteractive-element-interactions
3	jsx-a11y/click-events-have-key-events
2	@typescript-eslint/no-unused-vars
1	@typescript-eslint/no-empty-object-type
1	jsx-a11y/interactive-supports-focus
```

- [ ] **Step 4: Fix two, exempt five with their reasons**

Exact edits:
- **`AlbumSettings.tsx:9` and `Library.tsx:9`:** `import { applyUpdate, forgetTemplateCatalogue, type UpdateResult } from '../edit'` becomes `import { applyUpdate, forgetTemplateCatalogue } from '../edit'`.
- **`SpreadView.tsx:146`:** `<span class="frame-tools" onClick={(e) => e.stopPropagation()}` becomes `<span class="frame-tools" role="presentation" onClick={(e) => e.stopPropagation()}`. The span only stops clicks reaching the frame; its buttons stay operable.
- **`bridge.ts`:** a block comment, because Task 3's formatting rewraps this signature over several lines. Insert above the `/** Call a shell or helper method. … */` line (74):

  ```ts
  /* eslint-disable @typescript-eslint/no-empty-object-type -- `{} extends P` asks whether P has no required keys */
  ```

  Insert between the overload (75) and the implementation (`export function call(method: MethodName, params: object = {}, …`):

  ```ts
  /* eslint-enable @typescript-eslint/no-empty-object-type */
  ```
- **`Frame.tsx`:** between `  return (` (47) and `    <header class="topbar" onMouseDown={onMouseDown} …`, insert `    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the window's drag region, mouse-only like any title bar`.
- **`SignIn.tsx`:** between `    <div class="signin">` (82) and `      <div class="signin__drag" …`, insert `      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- the window's drag region, mouse-only like any title bar */}`.
- **`TemplateBrowser.tsx`:** between `  return (` (55) and `    <section`, insert `    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape from any control inside closes the browser`.
- **`Menu.tsx`:** between `      {open ? (` (71) and `        <div class="menu__list" role="menu" …`, insert `        // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- the items carry focus; their keys bubble here`.

- [ ] **Step 5: Record the five findings left for phase 5**

```bash
npx eslint eslint.config.mjs src test server scripts bench native --suppress-rule jsx-a11y/no-noninteractive-element-interactions \
  --suppress-rule jsx-a11y/click-events-have-key-events --suppress-rule jsx-a11y/no-static-element-interactions
```

Expected new entries:
- `native/ui/src/places/plan/FrameAdjust.tsx`: `no-noninteractive-element-interactions` 1.
- `native/ui/src/places/plan/Inspector.tsx`: `click-events-have-key-events` 1 and `no-noninteractive-element-interactions` 1.
- `native/ui/src/places/plan/SpreadView.tsx`: `click-events-have-key-events` 1 and `no-static-element-interactions` 1.

The file now holds 23 findings.

- [ ] **Step 6: Run lint and see it pass (GREEN)**

Run: `npm run lint && npm --prefix native/ui run typecheck && npm --prefix native/ui test && npm --prefix native/ui run build`. Expected: all exit 0, and the UI suite reports `# pass 62`. Re-run Task 1 Step 9's count; expected `237`.

- [ ] **Step 7: Mutation check (must fail lint; then delete the probe)**

Create `native/ui/src/zz_probe.tsx`:

```tsx
import { signal } from '@preact/signals'
export const Probe = () => <div onClick={() => {}} />
```

Run `npm run lint:eslint`. Expected: exit 1, naming `@typescript-eslint/no-unused-vars`, `jsx-a11y/click-events-have-key-events` and `jsx-a11y/no-static-element-interactions` in `zz_probe.tsx`. Then `rm native/ui/src/zz_probe.tsx`.

- [ ] **Step 8: Gate and commit**

Run the gate (six `ok` lines) and the UI build, then:

```bash
git add package.json package-lock.json eslint.config.mjs eslint-suppressions.json native/ui/src
git commit -q -F - <<'EOF'
build(lint): lint the interface with TypeScript and accessibility rules

typescript-eslint's recommended rules now check native/ui and the
generated contract types, and eslint-plugin-jsx-a11y checks every view.
jsx-a11y 6.10.2, its latest release, declares ESLint peers only up to 9;
it uses only context.report, options and settings, which ESLint 10
keeps, so an npm override lets it run on ESLint 10.

Fixed: two unused type imports, and the click-swallowing wrapper around
the frame tools is marked presentational. Exempt, each with its reason
inline: the two window drag regions (mouse-only, like any title bar), the
template browser and the menu (they handle keys bubbling from the
controls inside), and bridge.ts's `{} extends P` test. Five findings in
three controls are recorded for phase 5, which adds keyboard operation
with component tests: the Inspector's photo rows, the spread's frame hit
areas and the frame-adjust overlay. No behaviour changes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Prettier, in three commits (setup, formatting, blame and CI)

**Files:**
- Create: `.prettierrc.json`, `.prettierignore`, `.git-blame-ignore-revs`
- Modify:
  - `package.json` and `package-lock.json`
  - `native/scripts/generate-contract-types.mjs:6,9,61`
  - `native/contracts/types.ts` (regenerated)
  - `native/backend/test/labnaming.test.js:20`
  - `.github/workflows/ci.yml`
  - then every file `npm run format` changes, plus `native/scripts/readability-baseline.json`

**Interfaces:**
- Consumes: Tasks 1-2's lint, which must still pass on the formatted tree.
- Produces: `npm run format` (`prettier --write .`) and `npm run format:check` (`prettier --check .`).

- [ ] **Step 1: Install and configure**

```bash
npm install --save-dev --save-exact prettier@3.9.10
```

Add the scripts `"format": "prettier --write ."` and `"format:check": "prettier --check ."`. Create `.prettierrc.json`:

```json
{
  "semi": false,
  "singleQuote": true,
  "printWidth": 120
}
```

Create `.prettierignore`:

```
# Prettier formats the JavaScript, TypeScript, JSON and YAML, and skips .gitignore'd paths too.
# Prose and frozen evidence:
docs/
*.md
# The stylesheets keep short rules on one line; the two shell pages are plain HTML:
*.css
*.html
# Bytes other tools own: npm's lockfiles, ESLint's suppressions file, the contract files shared
# byte for byte with the engine (types.ts records their SHA-256), and the engine pin (CI cache
# keys hash it):
package-lock.json
eslint-suppressions.json
native/contracts/*.json
native/scripts/engine/pin.json
# A local workspace that ignores itself with its own .gitignore:
.superpowers/
```

- [ ] **Step 2: Rewrite the one expression Prettier would make ambiguous**

`native/backend/test/labnaming.test.js:20`. Prettier breaks this chain before the computed member, a shape `no-unexpected-multiline` rejects. Before:

```js
    await sharp({ create: { width: w, height: 300, channels: 3, background: '#888' } })[name.endsWith('png') ? 'png' : 'jpeg']().toFile(path.join(dir, name))
```

After:

```js
    const image = sharp({ create: { width: w, height: 300, channels: 3, background: '#888' } })
    await (name.endsWith('png') ? image.png() : image.jpeg()).toFile(path.join(dir, name))
```

Run it with the engine variables exported (as in the gate): `node --test native/backend/test/labnaming.test.js`. Expected: all pass.

- [ ] **Step 3: Format the generated types, and see the generator test fail (RED)**

```bash
npx prettier --write native/contracts/types.ts && cp native/contracts/types.ts "$SCRATCH/types.prettier.ts"
node --test test/contract_types.test.js
```

Expected: "committed declarations are deterministic …" fails, because the generator still writes unformatted declarations.

- [ ] **Step 4: The generator formats its own output (GREEN)**

In `native/scripts/generate-contract-types.mjs`:
- After `import { fileURLToPath } from 'node:url'` (line 6), add `import * as prettier from 'prettier'`.
- After `const quote = value => JSON.stringify(value)` (line 9), add:

  ```js
  // Formatted with this repository's Prettier settings, never the target root's, so --check and
  // `npm run format:check` agree on the committed file.
  const formatted = async text => {
    const options = await prettier.resolveConfig(path.join(DEFAULT_ROOT, 'native/contracts/types.ts'))
    return prettier.format(text, { ...options, parser: 'typescript' })
  }
  ```
- On line 61, `expected = generateContractTypes(root)` becomes `expected = await formatted(generateContractTypes(root))`.

Then:

```bash
node native/scripts/generate-contract-types.mjs > /dev/null && cmp native/contracts/types.ts "$SCRATCH/types.prettier.ts" && echo "generator output equals Prettier's"
node native/scripts/generate-contract-types.mjs --check && node --test test/contract_types.test.js && npm run check:architecture > /dev/null
```

Expected:
- `generator output equals Prettier's`.
- `--check` passes, the 3 contract tests pass, and the architecture check exits 0.

- [ ] **Step 5: Mutation check on the generator**

Copy the generator to `$SCRATCH/generator.bak`. Replace `path.join(DEFAULT_ROOT, 'native/contracts/types.ts')` with `'/'`, which makes Prettier find no settings and use its defaults. Run `node --test test/contract_types.test.js`. Expected: the determinism test fails. Restore from the copy.

- [ ] **Step 6: Commit the setup (commit A)**

Run the gate. The rest of the tree is formatted only in the next commit, so this one gate runs without the format check. Then:

```bash
git add .prettierrc.json .prettierignore package.json package-lock.json native/scripts/generate-contract-types.mjs native/contracts/types.ts \
  native/backend/test/labnaming.test.js
git commit -q -F - <<'EOF'
build(format): add Prettier; the contract generator emits formatted types

Prettier 3.9.10, pinned exactly because formatting can change between
releases, with the house style: no semicolons, single quotes, two-space
indent, 120-character lines. It formats JavaScript, TypeScript, JSON and
YAML. It skips Markdown and docs/, the stylesheets (short rules stay on
one line), the two shell pages, and bytes other tools own: npm's
lockfiles, ESLint's suppressions file, the contract files the engine
shares byte for byte, and the engine pin, which CI cache keys hash.

types.ts is generated, so its generator now formats its own output with
this repository's settings, never the target root's, and --check and the
format check agree. One test helper is rewritten because Prettier would
break `sharp(...)[format]()` before the computed member, a shape
no-unexpected-multiline rejects.

The next commit formats everything else.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 7: Format everything and re-record the readability baseline**

```bash
npm run format > /dev/null && node native/scripts/check-readability.mjs --update && git diff --shortstat
```

Expected:
- About 232 files change, +25,500/−8,600 lines.
- `readability: recorded 54 files with existing findings`.
- Lines over 160 in the ratchet's scope fall from 863 to 57; complexity findings stay at 50.

- [ ] **Step 8: Prove the owned bytes are untouched**

```bash
git diff --name-only | grep -E '\.(md|css|html)$|package-lock\.json$|^eslint-suppressions\.json$|^native/contracts/.*\.json$|^native/scripts/engine/pin\.json$|^docs/' \
  && echo "PROTECTED FILE CHANGED" || echo "protected files untouched"
node native/scripts/generate-native-contracts.mjs --engine native/photocraft --check
```

Expected: `protected files untouched` and `Native contracts match: 5 files.`

- [ ] **Step 9: Gate with the format check**

Add `check format npm run format:check` to `$SCRATCH/../phase0/gate.sh`, after the `ui` line. Run the gate (seven `ok` lines) and `npm --prefix native/ui run build`. Expected:
- Shared, backend and UI suites pass as before: 233, 895 plus the one Poppler failure, and 62.
- Lint passes on the formatted tree, including `no-unexpected-multiline`.

- [ ] **Step 10: Commit the formatting (commit B)**

```bash
git add -u
git status --short | grep -v '^M  ' && echo "UNEXPECTED STATUS" || true
git commit -q -F - <<'EOF'
style: format the code with Prettier

Generated by `npm run format`; no other change.

The readability baseline is re-recorded: lines over 160 characters in its
scope fell from 863 to 57, and files with findings from 111 to 54.
Complexity is unchanged. The next commit lists this one in
.git-blame-ignore-revs.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 11: Skip it in blame; check formatting in CI (commit C)**

```bash
printf '# Prettier formatting, phase 3. Locally: git config blame.ignoreRevsFile .git-blame-ignore-revs\n%s\n' "$(git rev-parse HEAD)" > .git-blame-ignore-revs
```

In `.github/workflows/ci.yml`, between the "Install dependencies" step and the "Lint" step, add:

```yaml
      - name: Formatting
        run: npm run format:check
```

Mutation check: copy `src/curation.js` to `$SCRATCH/curation.bak`, add a `;` to the end of its first code line, and run `npm run format:check`. Expected: exit 1 naming `src/curation.js`. Restore from the copy. Run `npx prettier --check .github/workflows/ci.yml` (this parses the YAML), then the gate, then:

```bash
git add .git-blame-ignore-revs .github/workflows/ci.yml
git commit -q -F - <<'EOF'
build(format): check formatting in CI; skip the formatting commit in blame

.git-blame-ignore-revs lists the formatting commit. GitHub applies it;
locally, git config blame.ignoreRevsFile .git-blame-ignore-revs.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
B=$(git rev-parse HEAD~1) F=native/scripts/check-architecture.mjs
echo "without: $(git blame --line-porcelain $F | grep -c "^$B ")  with: $(git blame --line-porcelain --ignore-revs-file .git-blame-ignore-revs $F | grep -c "^$B ")"
```

Expected: about `without: 457  with: 20`, as measured on the rehearsal. The 20 are lines Prettier added that have no earlier counterpart, such as closing brackets on their own lines.

---

### Task 4: Coverage limits in the strict test gate

**Files:**
- Modify:
  - `package.json` (`test:coverage` and a new `test:strict`)
  - `native/backend/package.json` (new `test:coverage`)
  - `native/scripts/engine.mjs:11,145`
  - `test/engine_pin.test.js` (new test at the end)
  - `.github/workflows/ci.yml` (test step name)

**Interfaces:**
- Produces:
  - `export const NODE_GATE_SCRIPT = 'test:strict'` from `native/scripts/engine.mjs`.
  - Root `test:strict` = `npm run check:architecture && npm run test:coverage && npm --prefix native/backend run test:coverage && npm --prefix native/ui test`.

- [ ] **Step 1: Write the failing test**

Append to `test/engine_pin.test.js`:

```js
test('the strict gate runs all three suites, with coverage limits on the shared and backend suites', async () => {
  const { NODE_GATE_SCRIPT } = await scripts()
  const root = require('../package.json').scripts, backend = require('../native/backend/package.json').scripts
  const gate = root[NODE_GATE_SCRIPT] || ''
  for (const step of ['npm run check:architecture', 'npm run test:coverage', 'npm --prefix native/backend run test:coverage', 'npm --prefix native/ui test']) {
    assert.ok(gate.includes(step), `${NODE_GATE_SCRIPT} runs ${step}`)
  }
  for (const script of [root['test:coverage'], backend['test:coverage']]) {
    assert.match(script, /--test-coverage-lines=\d+/)
    assert.match(script, /--test-coverage-branches=\d+/)
  }
})
```

- [ ] **Step 2: Run it and see it fail (RED)**

Run: `node --test test/engine_pin.test.js`. Expected: the new test fails on `test:strict runs npm run check:architecture`, because `NODE_GATE_SCRIPT` doesn't exist yet. The other tests pass.

- [ ] **Step 3: Implement**

- **`native/scripts/engine.mjs`:**
  - After `export const DEFAULT_ENGINE = …` (line 12), add `export const NODE_GATE_SCRIPT = 'test:strict' // all three suites, with coverage limits`.
  - On line 145, `spawnSync('npm', ['test'], …` becomes `spawnSync('npm', ['run', NODE_GATE_SCRIPT], …`.
- **Root `package.json` scripts:**
  - `"test:coverage": "node --test --experimental-test-coverage --test-coverage-lines=88 --test-coverage-branches=88 test/*.test.js"`.
  - `"test:strict": "npm run check:architecture && npm run test:coverage && npm --prefix native/backend run test:coverage && npm --prefix native/ui test"`.
- **`native/backend/package.json`:** add `"test:coverage": "node --test --test-concurrency=2 --experimental-test-coverage --test-coverage-lines=94 --test-coverage-branches=88 test/*.test.js"`.

- [ ] **Step 4: Run it and see it pass (GREEN)**

Run: `node --test test/engine_pin.test.js`. Expected: all pass.

- [ ] **Step 5: Measure against the limits**

Run `npm run test:coverage`. Expected: exit 0, about 88.6% of lines and 88.6% of branches. Then, with the engine variables exported, run `npm --prefix native/backend run test:coverage`. Expected: the only `not ok` is the Poppler test, with no "does not meet threshold" line, at about 95.0% and 88.8%. Record both figures for Task 5's docs.

- [ ] **Step 6: Mutation checks (restore from copies)**

1. Copy `package.json` to `$SCRATCH/package.bak` and set the shared line limit to 89. Run `npm run test:coverage`. Expected: exit 1 and `# Error: 88.6…% line coverage does not meet threshold of 89%.` Restore.
2. Copy `native/scripts/engine.mjs` to `$SCRATCH/engine.bak` and set `NODE_GATE_SCRIPT` to `'test'`. Run `node --test test/engine_pin.test.js`. Expected: the new test fails. Restore.

- [ ] **Step 7: CI and the local gate**

In `.github/workflows/ci.yml`, rename `- name: Test all Node suites; reject any skipped real-engine tests` to `- name: Test all Node suites with coverage limits; reject any skipped real-engine tests`. The command is unchanged: `engine.mjs test-node` now runs `test:strict`.

In `$SCRATCH/../phase0/gate.sh`:
- Replace the shared line with `check shared npm run test:coverage`.
- Replace the backend lines with:

```bash
npm --prefix native/backend run test:coverage > "$LOG/backend.log" 2>&1
unexpected=$(grep -E '^not ok ' "$LOG/backend.log" | grep -vc 'independent Poppler rendering')
limits=$(grep -c 'does not meet threshold' "$LOG/backend.log")
if [ "$unexpected" = 0 ] && [ "$limits" = 0 ] && grep -qE '^# pass [1-9]' "$LOG/backend.log"; then
  echo "ok    backend ($(grep -hE '^# (pass|fail) |all files' "$LOG/backend.log" | tr -s ' ' | tr '\n' ' '))"
else echo "FAIL  backend ($unexpected unexpected failures, $limits coverage limits missed, $LOG/backend.log)"; status=1; fi
```

Locally, `npm run test:strict` stops at the backend's Poppler failure before the UI suite. CI installs Poppler, and the gate script runs the UI suite separately.

- [ ] **Step 8: Gate and commit**

Run the gate (seven `ok` lines), then:

```bash
git add package.json native/backend/package.json native/scripts/engine.mjs test/engine_pin.test.js .github/workflows/ci.yml
git commit -q -F - <<'EOF'
build(test): enforce coverage limits in the strict test gate

The strict gate (node native/scripts/engine.mjs test-node, which CI runs)
now runs `npm run test:strict`: the architecture check, the shared and
backend suites under Node's coverage thresholds, then the interface
suite. The limits sit just below today's figures and only rise:

  shared   88% of lines and branches       (measured 88.64 / 88.61)
  backend  94% of lines, 88% of branches   (measured 94.95 / 88.77)

The spec named 89/89 for the shared suite before phase 2 removed three
well-covered dead modules; 88/88 was chosen with the phase 3 plan.
`npm test` stays quick and limit-free: without an engine, its engine
tests skip. A new test fails if the gate script loses a suite or a limit.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: The log guard and the docs

**Files:**
- Modify: `.github/workflows/ci.yml`, `docs/DEVELOPMENT.md:86-112`, `CONTRIBUTING.md`

- [ ] **Step 1: Fail CI when a log file is tracked**

In `.github/workflows/ci.yml`, in the `checks` job, right after the checkout step, add:

```yaml
      - name: No raw logs tracked
        run: test -z "$(git ls-files '*.log')"
```

Run `test -z "$(git ls-files '*.log')" && echo none`. Expected: `none`. Mutation check:

```bash
touch probe.log && git add -f probe.log && test -z "$(git ls-files '*.log')"; echo "exit $?"
git rm -q --cached probe.log && rm probe.log
```

Expected: `exit 1`. Check formatting (`npx prettier --check .github/workflows/ci.yml`), then:

```bash
git add .github/workflows/ci.yml
git commit -q -F - <<'EOF'
ci: fail when a log file is tracked

Phase 1 moved 363 raw logs out of git. .gitignore keeps new ones out,
but `git add -f` would not; CI now fails if any .log file is tracked.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 2: Update the dev guide**

In `docs/DEVELOPMENT.md`'s gate table:
- **Insert after the header separator:** `` | `npm run format:check` | Prettier formatting of the JavaScript, TypeScript, JSON and YAML; `npm run format` fixes it | ``.
- **Replace the `npm run lint` row with:** `` | `npm run lint` | ESLint 10 over all JavaScript and the interface's TypeScript (typescript-eslint, jsx-a11y); any warning fails. `eslint-suppressions.json` records findings left for later phases and may only shrink (after a fix, `npm run lint:eslint -- --prune-suppressions`). Then the readability ratchet (`native/scripts/check-readability.mjs`: no file may gain lines over 160 characters or functions above complexity 20) | ``.
- **Replace the `engine.mjs test-node` row with:** `` | `node native/scripts/engine.mjs test-node` | All three application suites against the pinned CLI/helper (`npm run test:strict`), with coverage limits on the shared and backend suites; rejects skips | ``.

Replace the coverage paragraph and its command (from "Run coverage and the strict gate sequentially." through the closing fence) with:

````
Run coverage and the strict gate sequentially.

Coverage limits sit just below the measured figures and only rise: shared 88% of lines and
branches, backend 94% of lines and 88% of branches (measured 2026-10-28: 88.6/88.6 and
95.0/88.8). Check them with:

```sh
npm run test:coverage
ALBUM_STUDIO_PHOTOCRAFT_CLI=/absolute/target/release/photocraft-cli \
ALBUM_STUDIO_RENAME_CLI=/absolute/target/release/album-studio-rename-exclusive \
npm --prefix native/backend run test:coverage
```
````

- [ ] **Step 3: Update the contributing guide**

In `CONTRIBUTING.md`, insert before "Commits:":

```
Formatting and lint:

- `npm run format` formats the code with Prettier; CI checks it. One commit formatted the whole
  repository; to see past it in `git blame`, run `git config blame.ignoreRevsFile .git-blame-ignore-revs`.
- `npm run lint` fails on any warning. `eslint-suppressions.json` records findings left for later
  phases and may only shrink: after fixing one, run `npm run lint:eslint -- --prune-suppressions`.
```

- [ ] **Step 4: Check and commit**

Run `node "$SCRATCH/../phase1/check-links.mjs" . | tail -1`. Expected: `all relative links resolve`. Run the gate, then:

```bash
git add docs/DEVELOPMENT.md CONTRIBUTING.md
git commit -q -m "docs: describe formatting, lint scope and coverage limits" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Re-score and commit this plan

- [ ] **Step 1: Measure**

```bash
git ls-files '*.js' '*.mjs' '*.cjs' '*.ts' '*.tsx' | grep -v '^docs/' | xargs awk 'length > 120 { a++ } length > 200 { b++ } END { print a " lines over 120, " b " over 200" }'
node -e 'const b = require("./native/scripts/readability-baseline.json"); let c = 0; for (const f of Object.values(b)) c += f.complexity || 0; console.log(c + " functions above complexity 20")'
```

The pre-phase figures are 3,117 code lines over 120 and 50 complex functions under ESLint 10's counting. Expected now: about 340 over 120, and 50.

- [ ] **Step 2: Re-score and update the status page**

Re-score from the measurements in `QUALITY_IMPROVEMENT_LOG.md`'s scorecard. The scores below are expected; the measurements decide them, and an area that lands lower says why.
- **Tooling & CI: 9.** Formatting, UI lint and coverage limits are all in CI, ESLint is on a supported major, and lint covers every code file and fails on warnings. 9.5 needs the strict backend typecheck in CI, which is phase 4.
- **UI code: 8.** TypeScript and accessibility linting is in. Component tests and axe come in phase 5.
- **Readability: 6.5.** One consistent format, and code lines over 120 fall from 3,117 to about 340. The 50 complex functions and the strict typecheck remain for phase 4.

Then:
- Add a phase 3 paragraph after phase 2's.
- Set the phase table to `| 3. Tooling | Done 2026-10-28 |` and `| 4–7 | Not started |`.
- Delete the two phase 3 open items.
- Add these open items:
  - Phase 4: 18 errors thrown from catch blocks carry no cause (`eslint-suppressions.json`). `serializeError` copies recovery metadata from the cause chain, so each site needs its own decision and test. ESLint 10 counts two more complex functions than ESLint 8 did (`psd_template.js`, `project_lock.js`) with no code changed. `native/ui/spike.html` is a leftover shell feasibility page.
  - Phase 5: five accessibility findings in three controls lack keyboard operation: the Inspector's photo rows, the spread's frame hit areas and the frame-adjust overlay (`eslint-suppressions.json`). Coverage limits rise from 88/88 (shared) and 94/88 (backend).

Run the gate, then commit as `docs: record the phase 3 re-score`, ending with the `Co-Authored-By` line.

- [ ] **Step 3: Commit this plan**

```bash
git add docs/superpowers/plans/2026-10-28-phase-3-tooling.md
git commit -q -m "docs: add the phase 3 plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Then one fresh reviewer checks the whole phase 3 range, and Critical and Important findings get one fix pass.
