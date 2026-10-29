# Phase 4a: Null-checked types for every backend runtime file, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every backend runtime file type-checks with null checks, and `npm run typecheck` (and so CI) enforces it. Today 2 of the 55 files are checked.

**Architecture:** A new `native/backend/tsconfig.checked.json` checks every runtime file at the spec's 4a level: strict null checks, with implicit `any` and untyped catch variables still allowed. The 237 errors it reports are fixed in seven file groups, one commit each, using JSDoc types and explicit null checks. The existing strict opt-in config (`// @ts-check` files) stays as it is; phase 4d grows it. The new config joins `npm run typecheck` in the last fix task, once it reports zero.

**Tech Stack:** TypeScript 6.0.3 over JavaScript (`checkJs`, JSDoc), Node 22.

**Spec:** `docs/superpowers/specs/2026-10-28-quality-above-nine-design.md` (phase 4, item 4a).

## Global Constraints

- Repo `/Volumes/Harry/works/albumStudio-photocraft`, branch `codex/album-quality-improvement`. It tracks `origin`; push only when the user asks.
- `SCRATCH=/private/tmp/claude-501/-Volumes-Harry-works-albumStudio-photocraft/2821a411-2a3f-4a06-90c0-a3e281d60cf7/scratchpad/phase4a`.
- Gate before every commit: `$SCRATCH/../phase0/gate.sh /Volumes/Harry/works/albumStudio-photocraft`, seven `ok` lines. The backend Poppler test is the only allowed failure.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Prettier sets the layout; run `npx prettier --write` on edited files. New lines stay within 120 characters, comments included (phase 4c's limit).
- Never restore a file with uncommitted changes from git. A mutation check copies the file to `$SCRATCH` first and restores from that copy.
- Spec 4a, verbatim: "Type-check every backend runtime file with implicit-`any` relaxed and fix the 237 errors with JSDoc types and null checks. A genuine bug is fixed with a regression test."
- Runtime behaviour does not change, except to fix a genuine bug, and each such fix gets a test that fails first.
- No new dependencies.

### Rulings

Each ruling has its cost if wrong.

1. **The checked level is `checkJs`, `noImplicitAny: false` and `useUnknownInCatchVariables: false`, on top of the root config's `strict`.**
   - That combination gives exactly the spec's 237 errors on today's code (measured 2026-10-29 at `804e706`).
   - Keeping catch variables as `unknown` instead gives 479: the extra 242 are almost all catch variables, which phase 4d's strict checking handles.
   - Cost if wrong: none; 4d tightens both flags.
2. **Two configs.** `native/backend/tsconfig.json` stays the strict opt-in check (files marked `// @ts-check`; today `publication_io.js` and `verified_file.js`). The new `tsconfig.checked.json` extends it and checks every runtime file at the 4a level. Phase 4d turns files strict one by one by marking them, and retires the checked config when all are marked. Cost if wrong: one extra config file.
3. **The root `lib` moves from ES2022 to ES2024.** Node 22 provides ES2024. Three call sites use `String.prototype.isWellFormed`, which ES2022's declarations lack. Cost if wrong: none at runtime; declarations only.
4. **One shared type for errors that carry recovery details.**
   - `serializeError` (`native/contracts/runtime.js`) copies a fixed set of fields from an error and its causes into the reply: the code, seven booleans, seven paths, `retainedPaths`, `sourceCode`, `closeErrors`, `cleanupError` and `releaseError`. The generated `ErrorData` type lists exactly those fields.
   - `RecoverableError` is declared beside `serializeError` in `native/contracts/runtime.d.ts` and derived from `ErrorData`. An error's extra fields then check against what a reply can carry, and a misspelt field becomes an error.
   - `runtime.d.ts` isn't one of the five files shared with the engine (those are the schema, manifest, examples and two Rust files).
   - Cost if wrong: one type to adjust.
5. **The three shared modules the backend imports are checked too.** `src/curation.js`, `src/firebase_auth.js` and `src/proof_renderer.js` (8 errors) enter the program through backend imports, so Task 8 fixes them. Cost if wrong: none.
6. **Guards before casts.**
   - Most possibly-null errors sit behind a predicate TypeScript can't see through, such as `matches`, `owned` or `sameNode`, which already returns false for null. Each becomes an explicit `!x ||` in the same condition, throwing the same error as today.
   - A cast (`/** @type {T} */ (expr)`) is used only where the code guarantees the type (for example `server.address()` after `listen` resolved), and carries a one-line reason.
   - Cost if wrong: a cast could hide a real null path, which Review Focus 1 checks.
7. **`JSON.parse(buffer)` becomes `JSON.parse(String(buffer))`.** `JSON.parse` converts its argument with `String()`, so behaviour is identical, including an absent buffer. Cost if wrong: none.
8. **The three ag-psd canvas shims return `colorSpace: 'srgb'`.** `createImageData` in `parity.js`, `preflight.js` and `psd_template.js` returns `{ width, height, data }`; `ImageData` also has `colorSpace`, and ag-psd reads only the other three. Cost if wrong: none; ag-psd ignores the field.
9. **One commit per file group, and the checked config joins `npm run typecheck` only in Task 8.** Every earlier commit's gate stays green, and each task ends with zero errors in its own files. Cost if wrong: a regression in a finished group could slip in until Task 8, which then catches it.
10. **No genuine bug was found in the sites read while planning.** Execution still reads every remaining possibly-null site and every property error on `never`. A path that really dereferences null is a genuine bug: a test reproducing it comes first. The sites read:
    - `account.js:389-418, 456, 512`.
    - `project_transaction.js:111, 333-384`.
    - `namespace_lock.js:64`, `pdf.js:98, 217-220`, `file_publication.js:506`.

    Cost if wrong: one more test and fix during execution.

## Fix patterns

Every task uses these. The examples are real sites; P1, P2, P4 and P6 were tried on a copy of HEAD.

- **P1, errors carrying recovery details.**
  - Type the error with `RecoverableError`. Add once, after the requires: `/** @typedef {import('../../contracts/runtime').RecoverableError} RecoverableError */`.
  - Give the variable its own typed declaration. For `cache.js:223`, `let source, destination, created, retainedPath, failure` becomes:

    ```js
    let source, destination, created, retainedPath
    /** @type {RecoverableError | undefined} */
    let failure
    ```

    This alone clears `cache.js`'s eight field errors.
  - Where an error is built and thrown at once, use `/** @type {RecoverableError} */ (new Error(message))`, or `Object.assign(new Error(message), { code })` when every field is known at creation.
- **P2, options objects.** In a destructured parameter defaulting to `{}`, TypeScript's JavaScript inference drops every option without a default value, so callers' `digest`, `inputs`, `buffer`, `lease` and so on look unknown. Document the options at the definition, which fixes every caller:

  ```js
  /** @param {string} file @param {{ digest?: string, readOnly?: boolean }} [options] */
  async register(file, { digest, readOnly = false } = {}) {
  ```

  The same applies to parameters defaulting to `null` (for example `unchangedSource`'s `identity`) and to literal defaults (`project_domain.js`'s `string(…, max = LIMITS.TEXT)`).
- **P3, values declared before they're known.** These include `let x = null` later assigned, object literals with `null` or `[]` fields (`{ done: null }` in `account.js`, `finishingErrors: []` in `render.js`, `{ album: null, file: null }` in `jobs.js`), and the `never` types they produce. Type the declaration: `/** @type {Promise<Result> | null} */`, `/** @type {string[]} */ ([])`, or a `@typedef` for a recurring record such as `proofs.js`'s render targets.
- **P4, guards TypeScript can't see through.** Name the null in the same condition; the thrown error stays the same:

  ```js
  if (!copied || !matches(copied, expected) || !matches(await record(source), expected)) throw changed()
  ```

  In `project_transaction.js` this also types `copyNew`'s result, clearing five errors at its callers.
- **P5, values the code guarantees.** Narrow with the check the code already implies, and keep the error it throws today:
  - `pdf.js:217` gets `typeof ppi !== 'number' ||` in front of `!Number.isFinite(ppi)`, because `Number.isFinite` doesn't narrow.
  - Otherwise cast with a reason, for example `/** @type {AddressInfo} */ (server.address()) // listening: an IP socket address`.
- **P6, a `new Promise` resolved without a value.** Give the function a return type, `@returns {Promise<void>}`. Where the Promise isn't the function's return value, write `/** @type {Promise<void>} */ (new Promise(…))`.
- **P7, `JSON.parse` of a Buffer.** `JSON.parse(raw.bytes)` becomes `JSON.parse(String(raw.bytes))` (ruling 7).
- **P8, stale or malformed JSDoc** (TS1131, TS8024). Fix the comment to match the code.

### Measuring

Task 1 creates `$SCRATCH/types.mjs`. It runs the checked config from the repository root and prints errors per file, optionally for the given files only:

```js
// Null-checked type errors per file: node types.mjs [--lines] [file ...]. Run from the repository root.
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2),
  showLines = args[0] === '--lines',
  files = args.filter((arg) => arg !== '--lines')
const run = spawnSync('npx', ['tsc', '--noEmit', '-p', 'native/backend/tsconfig.checked.json'], { encoding: 'utf8' })
const fileOf = (line) => line.slice(0, line.indexOf('('))
const errors = run.stdout
  .split('\n')
  .filter((line) => / error TS\d+:/.test(line) && (!files.length || files.includes(fileOf(line))))
if (showLines) console.log(errors.join('\n'))
const counts = {}
for (const line of errors) counts[fileOf(line)] = (counts[fileOf(line)] || 0) + 1
for (const [file, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`${n}\t${file}`)
console.log(`${errors.length} errors`)
```

## Review Focus

1. **Casts that claim more than the code guarantees.** Each `/** @type {T} */ (expr)` either follows a check or carries a reason that holds on every path; otherwise it hides a null path at runtime.
2. **Explicit guards keep the error they replace.** A new `!x ||` throws exactly what the predicate path threw (same message, code and recovery fields), so callers and `serializeError` see no change.
3. **JSDoc types match how callers really call.** Each options type lists every option the function reads, with the right optional marks; a wrong type would mislead phase 4d. Each task's tests and the gate run the real calls.
4. **`RecoverableError` matches `serializeError`.** Every field the backend sets on an error is one `serializeError` copies, or is deliberately local. A field outside the type must fail to type-check.
5. **The checked config really covers every runtime file.** All 55 files under `native/backend/*.js` and `native/backend/lib/**/*.js` are in it, plus the `src/` modules they import. Task 8's mutation plants an error in a file no task touched, and `npm run typecheck` must fail.

---

### Task 1: The checked config, ES2024 declarations and `RecoverableError`

**Files:**
- Create: `native/backend/tsconfig.checked.json`, `$SCRATCH/types.mjs`
- Modify: `tsconfig.json` (`lib`), `native/contracts/runtime.d.ts` (before `export function serializeError`)

**Interfaces:**
- Produces:
  - `native/backend/tsconfig.checked.json`.
  - The type `RecoverableError`, imported in JavaScript as `/** @typedef {import('../../contracts/runtime').RecoverableError} RecoverableError */`.
  - `node $SCRATCH/types.mjs [--lines] [file ...]`.

- [ ] **Step 1: Write the measuring script and the config, and see the starting count (RED)**

Write `$SCRATCH/types.mjs` exactly as in "Measuring" above. Create `native/backend/tsconfig.checked.json`:

```json
{
  "// note": "Every backend runtime file with null checks (phase 4a). Implicit any and untyped catch variables stay allowed until strict checking (phase 4d); files marked // @ts-check also pass tsconfig.json's strict check.",
  "extends": "./tsconfig.json",
  "compilerOptions": { "checkJs": true, "noImplicitAny": false, "useUnknownInCatchVariables": false }
}
```

Run `node $SCRATCH/types.mjs | tail -1`. Expected: `237 errors`.

- [ ] **Step 2: ES2024 declarations**

In `tsconfig.json`, `"lib": ["ES2022", "DOM", "DOM.Iterable"]` becomes `"lib": ["ES2024", "DOM", "DOM.Iterable"]`. Run `node $SCRATCH/types.mjs | tail -1`. Expected: `234 errors`, since the three `isWellFormed` errors are gone.

- [ ] **Step 3: Declare `RecoverableError`**

In `native/contracts/runtime.d.ts`, insert before `export function serializeError(error: unknown): ErrorData`:

```ts
/** An error carrying the recovery details serializeError copies into its reply (see ErrorData). */
export type RecoverableError = Error &
  Partial<Omit<ErrorData, 'error' | 'code' | 'details' | 'cleanupError' | 'releaseError' | 'closeErrors'>> & {
    code?: string
    cleanupError?: unknown
    releaseError?: unknown
    closeErrors?: unknown[]
  }
```

Run `npm run typecheck`. Expected: exit 0; the checked config isn't part of it yet.

- [ ] **Step 4: Gate and commit**

Run the gate (seven `ok` lines), then:

```bash
git add native/backend/tsconfig.checked.json tsconfig.json native/contracts/runtime.d.ts
git commit -q -F - <<'EOF'
build(typecheck): add a null-checked config for every backend runtime file

native/backend/tsconfig.checked.json checks all 55 runtime files at the
spec's phase 4a level: strict null checks, with implicit any and untyped
catch variables still allowed until phase 4d. It reports 234 errors,
which the next commits fix; it joins npm run typecheck once it reports
none. Declarations move to ES2024, which Node 22 provides, for
String.prototype.isWellFormed. RecoverableError types errors that carry
the recovery details serializeError copies into replies, derived from
the reply schema's ErrorData.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Publication primitives

**Files:** in `native/backend/lib/`: `private_stage.js`, `exclusive_rename.js`, `json_lines.js`, `namespace_lock.js`, `project_lock.js`, `output_lock.js`, `output_paths.js`, `publication_paths.js`, `publication_broker.js`, `protocol_writer.js`, `jobs.js`, `publication_io.js`, `verified_file.js`.

**Interfaces:**
- Consumes: `RecoverableError`, `$SCRATCH/types.mjs`.
- Produces: JSDoc types for options and parameters that later tasks' callers rely on, notably `register(file, { digest, readOnly })` in `private_stage.js`.

- [ ] **Step 1: Measure (RED)**

```bash
F="native/backend/lib/private_stage.js native/backend/lib/exclusive_rename.js native/backend/lib/json_lines.js native/backend/lib/namespace_lock.js native/backend/lib/project_lock.js native/backend/lib/output_lock.js native/backend/lib/output_paths.js native/backend/lib/publication_paths.js native/backend/lib/publication_broker.js native/backend/lib/protocol_writer.js native/backend/lib/jobs.js native/backend/lib/publication_io.js native/backend/lib/verified_file.js"
node $SCRATCH/types.mjs --lines $F > $SCRATCH/t2-red.txt; tail -1 $SCRATCH/t2-red.txt
```

Expected: `40 errors` (42 at HEAD, less Task 1's two `isWellFormed` sites).

- [ ] **Step 2: Fix every listed error with the patterns**

The sites known from planning:
- `private_stage.js:164`, `register`: P2, exactly as in the pattern. This also clears four callers in `color.js` and `render.js`.
- `private_stage.js:242`, `failure.retainedPaths`: P1.
- `exclusive_rename.js`: P6 on `renameExclusive` (`@param {string} source @param {string} target @returns {Promise<void>}`), and P1 for `failure.code`.
- `publication_broker.js:73`: P6.
- `json_lines.js:21, 47`: `onInvalid` is called with a message, so P2 types it as `(message: string) => void`.
- `namespace_lock.js:64`: P4, `!named ||` in the condition, so the same `uncertain(file)` error is thrown.
- `namespace_lock.js:20`: P1.
- `jobs.js:26-27`: P3, the lease record's `album` and `file` are `string | null`.

Read each remaining line in `t2-red.txt` and apply the pattern that fits. Treat every possibly-null site and every property on `never` as Ruling 10 says.

- [ ] **Step 3: Measure (GREEN)**

Run `node $SCRATCH/types.mjs $F | tail -1`. Expected: `0 errors`. Run `node $SCRATCH/types.mjs | tail -1` and record the total for the ledger. Expected: no more than `190 errors`.

- [ ] **Step 4: Gate and commit**

Run the gate. Then `git add` the changed files and commit as `types(backend): null-check the publication primitives`. The body says how many errors were fixed, the patterns used, and any genuine bug with its test.

---

### Task 3: Publication transactions

**Files:** in `native/backend/lib/`: `project_transaction.js`, `delivery_transaction.js`, `render_transaction.js`, `file_publication.js`, `publication_recovery.js`.

**Interfaces:**
- Consumes: `RecoverableError`, and Task 2's primitive types.
- Produces: `copyNew` in `project_transaction.js` returns a non-null record.

- [ ] **Step 1: Measure (RED)**

```bash
F="native/backend/lib/project_transaction.js native/backend/lib/delivery_transaction.js native/backend/lib/render_transaction.js native/backend/lib/file_publication.js native/backend/lib/publication_recovery.js"
node $SCRATCH/types.mjs --lines $F > $SCRATCH/t3-red.txt; tail -1 $SCRATCH/t3-red.txt
```

Expected: about `49 errors` (50 at HEAD, less one `isWellFormed`).

- [ ] **Step 2: Fix every listed error with the patterns**

The sites known from planning:
- `project_transaction.js:107`: P4, `!copied ||`, exactly as in the pattern. Also `next` (line 333) gets `if (!next) throw changed()` right after its `record()`, which is the error `copyNew` would throw for it.
- `delivery_transaction.js`: P1 for `recoveryLock` (235, 263, 293), `deliveryCommitted` (322, 631, 896, 906), and `recoveryJournal`, `recoveryStage` and `code` (416-418).
- `file_publication.js:86`: P1, `recoveryRequired`.
- P7 for `JSON.parse` of a buffer in:
  - `project_transaction.js:151, 202, 443`;
  - `file_publication.js:131, 198`;
  - `render_transaction.js:170, 232`.
- `file_publication.js:506` and `render_transaction.js:513`: `remember(…)` gets a record that the preceding `owned(…)` or `readRecord(…)` check makes non-null. Use P4 where a check exists. Where it doesn't (`render_transaction.js:512-513` reads a file this transaction just wrote), add `if (!nextCacheRecord) throw changed('prepared render cache')`.

Read each remaining line in `t3-red.txt` and apply the pattern that fits, per Ruling 10.

- [ ] **Step 3: Measure (GREEN)**

`node $SCRATCH/types.mjs $F | tail -1`. Expected: `0 errors`. Record the total.

- [ ] **Step 4: Gate and commit**

Run the gate, then commit as `types(backend): null-check the publication transactions`, with the same body contents as Task 2.

---

### Task 4: Cache and proofs

**Files:** `native/backend/lib/cache.js`, `native/backend/lib/proofs.js`. Also `native/backend/lib/color.js`, but only the JSDoc above `psdPixels`.

**Interfaces:**
- Consumes: `RecoverableError`, and Task 2's `register` type.
- Produces: a `@typedef` for `proofs.js`'s render targets, and JSDoc for `fileEvidence(file, { prefixBytes, expectedDigest })` and `psdPixels(psdPath, { buffer, inMemory })`.

- [ ] **Step 1: Measure (RED)**

```bash
F="native/backend/lib/cache.js native/backend/lib/proofs.js"
node $SCRATCH/types.mjs --lines $F > $SCRATCH/t4-red.txt; tail -1 $SCRATCH/t4-red.txt
```

Expected: about `53 errors`.

- [ ] **Step 2: Fix every listed error with the patterns**

The sites known from planning:
- `cache.js:223`: P1, exactly as in the pattern; this clears the field errors at 335-338 and 360-363.
- `cache.js:37`: P2, `fileEvidence`'s options. This also clears `print_settings.js:35`.
- `proofs.js`:
  - Most of its 42 errors are properties of one record shape (`s`, `fromSheet`, `sheetDigest`, `hash`, `inputs`, `previous` and more): P3, one `@typedef`, used where those records are built.
  - `drawProof`'s options (line 302): P2.
  - `color.js:698`, `psdPixels`'s options: P2 at the definition. This clears `proofs.js:164` and `psd_template.js:326`.
- `proofs.js:649`, `new Map(await Promise.all(…))`: the mapped pairs need a tuple type, `/** @type {[number, Inputs]} */`.

Read each remaining line in `t4-red.txt` and apply the pattern that fits, per Ruling 10.

- [ ] **Step 3: Measure (GREEN)**

`node $SCRATCH/types.mjs $F | tail -1`. Expected: `0 errors`. Record the total.

- [ ] **Step 4: Gate and commit**

Run the gate, then commit as `types(backend): null-check the cache and proof renderer`.

---

### Task 5: Rendering and images

**Files:** in `native/backend/lib/`: `render.js`, `thumbs.js`, `raw.js`, `pdf.js`, `psd_template.js`, `color.js`, `sheets.js`, `sheet.js`, `parity.js`, `preflight.js`.

**Interfaces:**
- Consumes: Tasks 2 and 4's types.
- Produces: JSDoc for `unchangedSource(file, key, identity)` at its definition, which `labnaming.js` (Task 7) also calls.

- [ ] **Step 1: Measure (RED)**

```bash
F="native/backend/lib/render.js native/backend/lib/thumbs.js native/backend/lib/raw.js native/backend/lib/pdf.js native/backend/lib/psd_template.js native/backend/lib/color.js native/backend/lib/sheets.js native/backend/lib/sheet.js native/backend/lib/parity.js native/backend/lib/preflight.js"
node $SCRATCH/types.mjs --lines $F > $SCRATCH/t5-red.txt; tail -1 $SCRATCH/t5-red.txt
```

Expected: about `37 errors` (42 at HEAD, less the four `register` callers Task 2 clears and the `psdPixels` caller Task 4 clears).

- [ ] **Step 2: Fix every listed error with the patterns**

The sites known from planning:
- `unchangedSource`'s `identity` parameter defaults to `null`: P2 at its definition (`git grep -n "function unchangedSource" native/backend`). This clears `raw.js:59, 139, 151, 170, 331`, and in Task 7's files `labnaming.js:80, 89, 103`.
- `render.js:137`, `finishingErrors: []`: P3.
- `render.js:67`: P6.
- `render.js:235`: P2, the parameter that defaults to `null`.
- `psd_template.js:338`, `art.backdrop`: P3.
- `pdf.js:98`: P4, `!frameIds ||` beside `!frame`, so the same "Malformed JPEG SOS scan header." error is thrown.
- `pdf.js:217-220`: P5 as in the pattern.
- `parity.js:24`, `preflight.js:22`, `psd_template.js:36`: Ruling 8, add `colorSpace: 'srgb'`.
- TS1131 and TS8024: P8.

Read each remaining line in `t5-red.txt` and apply the pattern that fits, per Ruling 10.

- [ ] **Step 3: Measure (GREEN)**

`node $SCRATCH/types.mjs $F | tail -1`. Expected: `0 errors`. Record the total.

- [ ] **Step 4: Gate and commit**

Run the gate, then commit as `types(backend): null-check rendering and image handling`.

---

### Task 6: Account and sign-in

**Files:** `native/backend/lib/account.js`

- [ ] **Step 1: Measure (RED)**

`node $SCRATCH/types.mjs --lines native/backend/lib/account.js > $SCRATCH/t6-red.txt; tail -1 $SCRATCH/t6-red.txt`. Expected: `15 errors`.

- [ ] **Step 2: Fix every listed error with the patterns**

The sites known from planning:
- `fetch: (...a) => fetch(...a)` (65): becomes `(input, init) => fetch(input, init)`, a two-parameter wrapper with the same behaviour.
- `open` (75): P6.
- `me` (386): a `@typedef` for the sign-in flow (`url`, `cancel`, `done`, `generation`), with `done: Promise<Account> | null`. This clears 389 and 392.
- `server.listen(deps.port, '127.0.0.1', resolve)` (412): becomes `() => resolve()`.
- `server.address()` (418): P5, a cast with a reason.
- `client_id` (421): `configured()` already verified the Google settings, so `String(process.env.GOOGLE_CLIENT_ID)`, with a comment saying so.
- `new URL(req.url, …)` (456): `req.url || '/'`; a server request always has a URL.
- `finishFlow` (512): P3. Type it `(error: Error | null, result?: Account) => void`; it's assigned when the Promise is built, before `deps.open` can reject.
- `e.code` (405): `e` is an `Error` from the `'error'` event; type it `NodeJS.ErrnoException`.

Read each remaining line in `t6-red.txt` and apply the pattern that fits, per Ruling 10.

- [ ] **Step 3: Measure (GREEN)**

`node $SCRATCH/types.mjs native/backend/lib/account.js | tail -1`. Expected: `0 errors`.

- [ ] **Step 4: Gate and commit**

Run the gate, then commit as `types(backend): null-check account sign-in`.

---

### Task 7: Albums and projects

**Files:** in `native/backend/lib/`: `project_domain.js`, `project.js`, `album.js`, `labnaming.js`, `deliver.js`, `picks.js`, `templates.js`, `template_check.js`, `storage.js`, `print_settings.js`, `newalbum.js`, `identity.js`. Also `delivery_transaction.js`, but only the JSDoc above `publishDelivery`.

- [ ] **Step 1: Measure (RED)**

```bash
F="native/backend/lib/project_domain.js native/backend/lib/project.js native/backend/lib/album.js native/backend/lib/labnaming.js native/backend/lib/deliver.js native/backend/lib/picks.js native/backend/lib/templates.js native/backend/lib/template_check.js native/backend/lib/storage.js native/backend/lib/print_settings.js native/backend/lib/newalbum.js native/backend/lib/identity.js"
node $SCRATCH/types.mjs --lines $F > $SCRATCH/t7-red.txt; tail -1 $SCRATCH/t7-red.txt
```

Expected: about `23 errors` (27 at HEAD, less the `labnaming.js` and `print_settings.js` sites earlier tasks clear).

- [ ] **Step 2: Fix every listed error with the patterns**

The sites known from planning:
- `project_domain.js:89, 154, 166`: P2. The `max` parameter is a `number`, not the literal its default implies.
- `templates.js:130`, `listTemplates`'s options (`onConflict`, `dimensions`): P2. This clears `album.js:183`.
- `album.js:232`, `identityConflicts`: P3, typed as conflicts that may carry the spread number `n`.
- `delivery_transaction.js:704`, `publishDelivery`'s options (`paths`, `makeCache`, `isCancelled`, `validateSnapshot`, `albumFile`): P2. This clears `deliver.js:436`.
- `project.js:494`, `withProjectLease`'s options (`lease`, `kind`): P2. This clears `project.js:640`.
- `deliver.js:230`, `preflightAlbum`'s parameter that defaults to `null`: P2 at its definition.
- `newalbum.js:230`: the operation record's type is inferred too narrowly; P3, typed from the operation it builds.
- `labnaming.js:248, 417`: P1.

Read each remaining line in `t7-red.txt` and apply the pattern that fits, per Ruling 10.

- [ ] **Step 3: Measure (GREEN)**

`node $SCRATCH/types.mjs $F | tail -1`. Expected: `0 errors`. Record the total.

- [ ] **Step 4: Gate and commit**

Run the gate, then commit as `types(backend): null-check albums and projects`.

---

### Task 8: The shared modules; the checked config joins the gate

**Files:**
- Modify:
  - `src/curation.js`, `src/firebase_auth.js`, `src/proof_renderer.js`
  - `package.json` (`typecheck`)
  - `docs/DEVELOPMENT.md` (the `npm run typecheck` row)

- [ ] **Step 1: Measure (RED)**

Run `node $SCRATCH/types.mjs --lines > $SCRATCH/t8-red.txt; tail -1 $SCRATCH/t8-red.txt`. Expected: `8 errors`, all in the three `src/` modules. If any other file still reports errors, finish it here first, applying the patterns per Ruling 10.

- [ ] **Step 2: Fix the eight with the patterns**

- `src/proof_renderer.js:507` returns `skipped`, which the function's documented result type lacks. Correct the `@returns` type (P8).
- Apply the patterns to the remaining seven, in `curation.js` (4) and `firebase_auth.js` (3).
- These modules are also checked by the root config when they are marked `// @ts-check`. Run `npx tsc --noEmit` too.

Then: `node $SCRATCH/types.mjs | tail -1`. Expected: `0 errors`.

- [ ] **Step 3: The checked config joins `npm run typecheck`**

In `package.json`, `typecheck` becomes:

```
"typecheck": "tsc --noEmit && tsc --noEmit -p native/backend && tsc --noEmit -p native/backend/tsconfig.checked.json && npm --prefix native/ui run typecheck"
```

In `docs/DEVELOPMENT.md`, the `npm run typecheck` row becomes:

```
| `npm run typecheck` | `tsc` over the shared modules and backend files that opt in with `// @ts-check` (strict), every backend runtime file with null checks (`native/backend/tsconfig.checked.json`), and the interface |
```

Run `npm run typecheck`. Expected: exit 0.

- [ ] **Step 4: Mutation check (must fail; restore from the copy)**

Copy `native/backend/lib/inputs.js` to `$SCRATCH/inputs.bak`. No task touches that file, and only the checked config covers it. Append:

```js
const probe = /** @type {{ n: number } | null} */ (null)
module.exports.probe = probe.n
```

Run `npm run typecheck`. Expected: exit 1, with `TS18047: 'probe' is possibly 'null'.` in `inputs.js`. Restore from the copy, then `cmp` it against `$SCRATCH/inputs.bak`.

- [ ] **Step 5: Gate and commit**

Run the gate (seven `ok` lines; typecheck now includes the checked config), then:

```bash
git add src/curation.js src/firebase_auth.js src/proof_renderer.js package.json docs/DEVELOPMENT.md
git commit -q -F - <<'EOF'
build(typecheck): check every backend runtime file with null checks

npm run typecheck, and so CI, now runs native/backend/tsconfig.checked.json:
all 55 backend runtime files and the shared modules they import, with
strict null checks. The last eight errors were in src/curation.js,
src/firebase_auth.js and src/proof_renderer.js. Implicit any and untyped
catch variables stay allowed until phase 4d's strict checking.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 9: Re-score and commit this plan

- [ ] **Step 1: Measure**

```bash
node $SCRATCH/types.mjs | tail -1
for f in native/backend/*.js native/backend/lib/*.js; do head -5 "$f" | grep -q '@ts-check' && echo "$f"; done | wc -l
```

Expected: `0 errors`, and `2`. Strict opt-in is unchanged until phase 4d.

- [ ] **Step 2: Re-score and update the status page**

In `QUALITY_IMPROVEMENT_LOG.md`:
- **Readability: 6.5 → 7.**
  - Every backend runtime file is type-checked with null checks in CI, up from 2 of 55. Their shapes are documented as JSDoc types.
  - The 50 over-complex functions (4b), the 340 long lines (4c) and strict checking (4d) remain.
  - The measurements decide; if they land lower, the page says why.
- Add a phase 4a paragraph after phase 3's: what is checked, how many errors were fixed, and any genuine bugs with their tests.
- Set the phase table to `| 4a. Null-checked types | Done <date> |`, followed by `| 4b–4d, 5–7 | Not started |`.
- Remove the phase 3 deferred item about `generate-contract-types.mjs` only if this phase fixed it; it didn't, so it stays.

Run the gate, then commit as `docs: record the phase 4a re-score`, ending with the `Co-Authored-By` line.

- [ ] **Step 3: Commit this plan**

```bash
git add docs/superpowers/plans/2026-10-29-phase-4a-types.md
git commit -q -m "docs: add the phase 4a plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Then one fresh reviewer checks the whole phase 4a range, and Critical and Important findings get one fix pass.
