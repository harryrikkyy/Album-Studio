# Phase 4b-1: Simplify the contract runtime and shared modules, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the 10 functions above complexity 20 in the contract runtime and the shared `src/` modules down to 20 or less, with no behaviour change. This is the first of phase 4b's five batches.

**Architecture:** Each function is split into named helpers and predicates in the same module. Before a function changes, its branches must be covered by tests, and `proof_renderer.js` gets tests that pin today's behaviour first. After each refactor, a scratch harness runs the old and new versions side by side on thousands of seeded random inputs and requires identical results, as the spec asks. Then the full gate runs.

**Tech Stack:** Node 22, the repository's ESLint 10 complexity rule, `node:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-28-quality-above-nine-design.md` (phase 4, item 4b).

## Global Constraints

- Repo `/Volumes/Harry/works/albumStudio-photocraft`, branch `codex/album-quality-improvement`. It tracks `origin`; push only when the user asks.
- `SCRATCH=/private/tmp/claude-501/-Volumes-Harry-works-albumStudio-photocraft/2821a411-2a3f-4a06-90c0-a3e281d60cf7/scratchpad/phase4b`. This shell is zsh: expand file lists with `${=F}`.
- Gate before every commit: `$SCRATCH/../phase0/gate.sh /Volumes/Harry/works/albumStudio-photocraft`, seven `ok` lines. The backend Poppler test is the only allowed failure. If an unrelated test times out under machine load, re-run it alone, then re-run the gate.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Prettier sets the layout. New lines stay within 120 characters.
- Never restore a file with uncommitted changes from git. A mutation check copies the file to `$SCRATCH` first and restores from that copy.
- Spec 4b, verbatim: "Refactor every runtime function above complexity 20 (48 today) to 20 or less by extracting named helpers and predicates. Each extracted pure predicate is compared with the original on random inputs; every refactored file runs the full backend suite."
- No behaviour change: identical return values, thrown errors (message, code, fields), issue order, side effects and call order. The null-checked typecheck (phase 4a) stays at zero errors.

### Rulings

Each ruling has its cost if wrong.

1. **Phase 4b runs in five batches, each with its own plan and review.**
   - Measured 2026-10-29 with the repository's ESLint config (`$SCRATCH/complexity.mjs`): 73 functions exceed complexity 20, 8,594 lines in all.
   - 49 are runtime code: the spec's 48, recounted under ESLint 10's counting, including the contract runtime. 14 are interface components, 9 are tool scripts and 1 is a test fixture.

   | Batch | Area | Functions |
   |---|---|---:|
   | 4b-1 (this plan) | Contract runtime, shared `src/` modules | 10 |
   | 4b-2 | Verified reads, publication and locking | 16 |
   | 4b-3 | Rendering, colour, PDF and proofs | 16 |
   | 4b-4 | Albums, projects, account and server | 7 |
   | 4b-5 | Tool scripts and the test fixture | 10 |

   - The 14 interface components wait for phase 5's component tests. 11 of them sit in components no test exercises, and refactoring them blind is the riskiest change in the programme. Until then, phase 4c records them in `eslint-suppressions.json`, so making `complexity` an error doesn't wait on them.
   - Cost if wrong: the interface keeps 14 complex functions until phase 5.
2. **One method for every function.**
   - (a) Confirm that the tests exercise its branches, adding tests that pin current behaviour where they don't.
   - (b) Split it into named helpers and predicates in the same module, keeping the signature.
   - (c) Compare the old and new versions on random and fixture inputs.
   - (d) Check that it and every new helper are at complexity 20 or less.
   - (e) Run the gate.

   Cost if wrong: none; each step is a check.
3. **The comparison harness lives in `$SCRATCH`, not the repository.**
   - It loads the base revision from `git archive` beside the working tree and compares outputs on seeded random inputs.
   - Each commit message records the function, the input count and the seed.
   - The spec asks for the comparison, not a permanent copy of old code. A permanent test against an old copy would freeze the old implementation into the repository.
   - Cost if wrong: re-running the comparison later needs the scratch harness.
4. **`proof_renderer.js` gets tests that pin today's behaviour before it changes.**
   - Its coverage is 35% of lines (shared suite) and 45% (backend). Its three complex functions would otherwise change untested.
   - The new tests pass before and after the refactor. They are mutation-checked against the original, and they stay, lifting the module's coverage toward phase 5's goal.
   - Cost if wrong: one more test file to maintain.
5. **Helpers stay in their module and keep its style.** No new files, no new exports unless a test needs one. Comments stay at the module's density. Cost if wrong: none.
6. **The readability baseline is re-recorded once per task,** after its complexity findings fall. Cost if wrong: none.

## Measuring

- **Complexity.** `node $SCRATCH/complexity.mjs > $SCRATCH/complexity.tsv` lists every function above 20 as `complexity`, `file:line` and `name`, sorted. Grep the module under work. The script exists. It imports ESLint from the repository's `node_modules` and lints the same directories as `npm run lint:eslint`, with only the complexity rule.
- **Coverage of a function.** Run the gate's suites with coverage and read the module's uncovered lines:
  - `npm run test:coverage` for the shared suite;
  - with the engine variables exported, `npm --prefix native/backend run test:coverage` for the backend.

  A target is ready when none of its lines appear in the uncovered list.
- **Old against new.** Task 1 creates `$SCRATCH/compare.mjs`:

  ```js
  // Old-versus-new comparison on seeded random inputs: compare(name, oldFn, newFn, inputs) → number of differences.
  import { isDeepStrictEqual } from 'node:util'
  export function rng(seed) {
    let s = seed >>> 0
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  }
  const run = (fn, args) => {
    try {
      return { value: fn(...structuredClone(args)) }
    } catch (error) {
      return { error: { name: error.name, message: error.message, code: error.code, issues: error.issues } }
    }
  }
  export function compare(name, oldFn, newFn, inputs) {
    let differences = 0
    for (const args of inputs) {
      const a = run(oldFn, args),
        b = run(newFn, args)
      if (!isDeepStrictEqual(a, b) && differences++ < 3) console.log(name, JSON.stringify(args).slice(0, 300), a, b)
    }
    console.log(`${name}: ${inputs.length} inputs, ${differences} differences`)
    return differences
  }
  export function randomJson(random, depth = 0) {
    const pick = Math.floor(random() * (depth > 3 ? 6 : 8))
    if (pick === 0) return null
    if (pick === 1) return random() < 0.5
    if (pick === 2) return Math.floor(random() * 2000) - 1000
    if (pick === 3) return random() * 1e6
    if (pick === 4) return [Number.NaN, Infinity, -0, 2 ** 53][Math.floor(random() * 4)]
    if (pick === 5) return ['', 'a', 'spread_x', 'é'.repeat(Math.floor(random() * 5)), String(random())][Math.floor(random() * 5)]
    if (pick === 6) return Array.from({ length: Math.floor(random() * 5) }, () => randomJson(random, depth + 1))
    const out = {}
    for (let i = Math.floor(random() * 5); i > 0; i--) out[['id', 'n', 'kind', 'path', String(i)][i % 5]] = randomJson(random, depth + 1)
    return out
  }
  ```

  The old version comes from `$SCRATCH/base`, a `git archive` of this plan's base commit. It is created in Task 1, with symlinks to the main checkout's `node_modules` and `native/ui/node_modules`.

## Review Focus

1. **Validators report the same issues, in the same order.** `matches` returns at the first failing keyword inside a group, and recursion collects issues in traversal order. A helper that reorders checks changes which message and keyword a reply carries. Task 2's comparison deep-compares the full issue lists.
2. **Work limits trigger at the same inputs.** `matches` counts `budget.steps` and depth, and `walk` counts nodes and characters. An extracted helper that skips or double-counts a step moves the limit. Task 2 includes inputs at and just over each limit.
3. **`serializeError` walks causes the same way.** It stops at depth 4, keeps a seen-set, and the first value found wins for each field. Task 3 compares random error chains, including cycles and repeated fields.
4. **`applyAdjust` calls the Sharp pipeline in the same order.** The order is greyscale, then tone and colour, then local contrast, then detail. Task 5 records the pipeline calls with a fake object and compares the sequences.
5. **Rendered proofs are byte-identical.** Task 5's pinning tests hash `renderPageProof`'s output for fixed fixtures before and after.

---

### Task 1: The comparison harness and the base checkout

**Files:**
- Create: `$SCRATCH/compare.mjs` (as in "Measuring"), `$SCRATCH/base/`
- No repository change.

- [ ] **Step 1: Base checkout**

```bash
cd /Volumes/Harry/works/albumStudio-photocraft && BASE=$(git rev-parse HEAD) && echo "$BASE" > $SCRATCH/base.sha
rm -rf $SCRATCH/base && mkdir -p $SCRATCH/base && git archive "$BASE" | tar -x -C $SCRATCH/base
ln -s /Volumes/Harry/works/albumStudio-photocraft/node_modules $SCRATCH/base/node_modules
ln -s /Volumes/Harry/works/albumStudio-photocraft/native/ui/node_modules $SCRATCH/base/native/ui/node_modules
```

Record `BASE` in the ledger. Every task compares against it.

- [ ] **Step 2: Harness smoke test**

Write `$SCRATCH/compare.mjs`. Write `$SCRATCH/smoke.mjs`, which imports `compare`, `rng` and `randomJson` and compares `serializeError` from `$SCRATCH/base/native/contracts/runtime.js` with itself on 1,000 random values. Expected: `serializeError: 1000 inputs, 0 differences`.

Then compare it with a deliberately broken copy, `(e) => ({ ...serializeError(e), code: 'X' })`. Expected: a non-zero count, which proves the harness can see a difference.

---

### Task 2: `matches` and `walk` in the contract runtime

**Files:** `native/contracts/runtime.js` (`walk` inside the bounded-value check at line 48, complexity 38; `matches` at line 160, complexity 67)

- [ ] **Step 1: Confirm coverage (RED for the refactor)**

`complexity.tsv` lists both functions above 20. Backend coverage of `runtime.js` is 95.5% of lines; its uncovered lines are 82-84, 131-134, 140-143, 163-164, 414-417 and 422-425. Lines 82-84 sit in `walk`, and 163-164 in `matches` (the step limit). Add tests to the contracts tests (`git grep -l "contracts/runtime" test native/backend/test` lists them) that reach those lines:
- a value with more nodes than `MAX_NODES`;
- a schema traversal over `MAX_STEPS`.

Each test asserts today's exact issue (message and keyword), or today's thrown `ContractError` and its issue. Watch each pass on the current code, then mutation-check it: change the limit's comparison in a copy and see it fail.

- [ ] **Step 2: Split `matches` by keyword group**

`matches(schema, value, path, issues, depth, budget)` keeps its signature, its budget and depth checks, and the `true`, `false`, invalid-schema and `$ref` handling. The groups move to helpers in the same order, each returning either an issue result (`false`, after `issue()`) or `undefined` to continue:
- `matchesCombinator(schema, value, path, issues, depth, budget)`, for `anyOf`/`oneOf`. It returns its result whenever the schema has a combinator.
- `scalarIssue(schema, value, path, issues)`, for `type`, `const` and `enum`.
- `numberIssue(schema, value, path, issues)`, for finiteness, `minimum` and `maximum`.
- `stringIssue(schema, value, path, issues)`, for `minLength`, `maxLength` and `pattern`, including the pattern cache.
- `matchesArray(schema, value, path, issues, depth, budget)`, for items, bounds and `uniqueItems`.
- `matchesObject(schema, value, path, issues, depth, budget)`, for `maxProperties`, `required`, properties, `propertyNames` and `additionalProperties`, with the `MAX_ISSUES` break.

`matches` then reads as the sequence of groups and ends with `return issues.length === 0`.

- [ ] **Step 3: Split `walk` the same way**

Keep its node, depth and character accounting in the same order. Extract one helper per value kind (string, number, array, object), each keeping its own checks and messages.

- [ ] **Step 4: Compare old and new (the spec's random comparison)**

Write `$SCRATCH/t2-compare.mjs`. It imports `validateDefinition` and `schema` from the base copy and from the working tree (`native/contracts/runtime.js`) and builds inputs from three sources:
- every definition name in `schema.definitions` (or `$defs`) crossed with 200 `randomJson` values each (seed 4201);
- every value in `native/contracts/examples.json` against its definition;
- each example with one random field replaced by a random value (seed 4202).

Compare `validateDefinition(name, value)`: the thrown `ContractError`'s issues, or the returned value. For `walk`, compare the bounded-value check on random values plus values at and just past `MAX_NODES`, `MAX_DEPTH` and the character limit. Expected: every comparison reports `0 differences`. Record the counts and seeds.

- [ ] **Step 5: Measure (GREEN)**

Re-run `complexity.mjs`. Expected: no `runtime.js` line for `matches` or `walk`, and no new helper above 20. Run `node native/scripts/check-readability.mjs --update` and check that only `runtime.js`'s complexity count fell.

- [ ] **Step 6: Gate and commit**

Commit as `refactor(contracts): split schema matching and value walking by keyword`. The body gives the before and after complexity, the helpers, the comparison counts and seeds, and the new limit tests.

---

### Task 3: `serializeError` and `auditSchema`

**Files:** `native/contracts/runtime.js` (`serializeError` at line 313, complexity 26; `auditSchema` at line 375, complexity 26)

- [ ] **Step 1: Confirm coverage**

The uncovered lines 414-417 and 422-425 sit in `auditSchema`'s rejection branches. Add tests that pass a schema with each rejected keyword and assert today's error. Watch them pass and mutation-check them.

- [ ] **Step 2: Split**

- `serializeError` keeps its result's construction. Its per-source loop body becomes `copyRecoveryFields(result, source)`: booleans, paths, `retainedPaths`, `sourceCode`, `closeErrors`, `cleanupError` and `releaseError`, in that order, first value wins. The `issues` and `field` handling become `copyDetails(result, error)`.
- `auditSchema` gets one helper per rejected keyword family, applied in the current order.

- [ ] **Step 3: Compare old and new**

Generate random error chains with seed 4301, 5,000 inputs:
- plain `Error` objects with random subsets of every field `serializeError` reads, with random types (string, boolean, number, object, very long strings, paths with and without a leading `/`);
- `cause` chains 0 to 6 deep, including a cycle;
- strings and non-objects as errors.

Compare `serializeError` outputs. Compare `auditSchema` on the canonical schema and on 2,000 random mutations of it (seed 4302): delete a key, add an unknown keyword, or change a type. Expected: `0 differences` everywhere.

- [ ] **Step 4: Measure, gate and commit**

As in Task 2, Steps 5 and 6. Commit as `refactor(contracts): split error serialization and schema auditing`.

---

### Task 4: `psdTextOverlay`, `toPhotoshopLayerOps` and `convertNodes`

**Files:**
- `src/overlay_render.js` (`psdTextOverlay` at line 440, complexity 26; 99% of lines covered)
- `src/psd_layers.js` (`toPhotoshopLayerOps` at line 411, complexity 33; `convertNodes` at line 130, complexity 31; 90% covered)

- [ ] **Step 1: Confirm coverage**

`psd_layers.js`'s uncovered lines include 163-190 and 200-204 inside `convertNodes`. Add tests to its test file (`git grep -l psd_layers test`) that reach them, building layer trees as the existing tests do. Assert today's converted output, watch the tests pass, and mutation-check them.

- [ ] **Step 2: Split**

- `psdTextOverlay`: extract the text-style resolution and the box computation into helpers.
- `toPhotoshopLayerOps`: its recursive `walk` keeps the traversal; each edit kind's operation building becomes a helper.
- `convertNodes`: the per-node conversion becomes `convertNode(...)`, keeping the index-path naming and the awaits in the same order.

- [ ] **Step 3: Compare old and new**

- `psdTextOverlay` and `toPhotoshopLayerOps` are pure. Compare them on 5,000 random nodes and edits (seed 4401), built from the shapes the existing tests use with random field values.
- `convertNodes` is async. Compare its results on the existing tests' fixtures, plus 200 random layer trees (seed 4402), awaiting both versions.

Expected: `0 differences`.

- [ ] **Step 4: Measure, gate and commit**

Commit as `refactor(shared): split text overlays and layer conversion`.

---

### Task 5: The proof renderer, pinned first

**Files:**
- `src/proof_renderer.js` (`applyAdjust` at line 123, complexity 38; `buildPhotoLayer` at line 208, complexity 24; `renderPageProof` at line 338, complexity 38)
- Test: `test/proof_renderer_pinning.test.js` (new)

- [ ] **Step 1: Pin today's behaviour**

Write `test/proof_renderer_pinning.test.js`:
- **`applyAdjust`:** a recording fake pipeline whose every method returns the fake, with each method name and its arguments appended to a list. For a table of adjustments (each field alone, all fields together, extremes, `bw`), assert the exact call list today's code produces, with `dims` set.
- **`buildPhotoLayer`:** real sharp on small generated images, landscape and portrait, with rotation and smart crop. Assert `top`, `left` and the SHA-256 of `input`.
- **`renderPageProof`:** two small jobs (one with a missing photo, which is skipped), each building its template and photos with sharp in a temp folder. Assert `ok`, `skipped` and the output's SHA-256.

Run the file on the current code: all pass. Mutation-check one assertion per function in a copy of `proof_renderer.js`. Record the module's new coverage.

- [ ] **Step 2: Split**

- `applyAdjust`: one helper per stage (`greyscaleStage`, `toneStage`, `contrastStage`, `detailStage`), applied in today's order.
- `buildPhotoLayer`: separate the orientation, cover-scaling and crop computations into pure helpers, so the I/O stays in the function.
- `renderPageProof`: separate job validation, layer collection and the composite-and-write step.

- [ ] **Step 3: Compare old and new**

- `applyAdjust`: compare the recorded call lists from the base and new versions on 5,000 random adjustment objects (seed 4501).
- The pure helpers extracted from `buildPhotoLayer`: compare against the same computations in the base function, using the pinning fixtures plus 2,000 random frame, image-size and rotation combinations (seed 4502). Use the base `buildPhotoLayer` with stubbed sharp metadata, if needed, to get the old values.
- `renderPageProof`: the pinning test's hashes must stay identical.

Expected: `0 differences`.

- [ ] **Step 4: Measure, gate and commit**

Commit the pinning tests first, as `test(shared): pin the proof renderer's adjustments, photo layers and page output`. Then commit the refactor as `refactor(shared): split the proof renderer's stages`.

---

### Task 6: Re-score and commit this plan

- [ ] **Step 1: Measure**

`node $SCRATCH/complexity.mjs | grep -cE 'native/contracts/|^[0-9]+\tsrc/'`. Expected: `0`. Record the new total; expected `63`.

- [ ] **Step 2: Status page**

In `QUALITY_IMPROVEMENT_LOG.md`:
- Add a phase 4b-1 paragraph: functions simplified, the comparison counts, and the pinning tests with `proof_renderer.js`'s new coverage.
- Add the phase table row `| 4b-1. Contract runtime and shared modules | Done <date> |`.
- Keep Readability at 7 unless the measurements justify more; the complex functions are 63 of 73.

Run the gate, then commit as `docs: record phase 4b-1`.

- [ ] **Step 3: Commit this plan**

```bash
git add docs/superpowers/plans/2026-10-29-phase-4b1-contracts-shared.md
git commit -q -m "docs: add the phase 4b-1 plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Then one fresh reviewer checks the whole 4b-1 range, and Critical and Important findings get one fix pass.
