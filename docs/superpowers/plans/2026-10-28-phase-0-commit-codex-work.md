# Phase 0: Commit Codex's Work, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review, prove and commit the publication-recovery work the Codex session left uncommitted. Then fix the one defect the review found, and pin the behaviour its tests don't cover.

**Architecture:** Codex's code is committed as its own commit after every one of its new tests has been shown to catch a deliberately broken copy of the code it guards. My message fix and the extra tests follow as separate commits, so authorship stays clear. Every commit passes the gate first; for Codex's commit the gate runs on a scratch worktree holding exactly the commit tree.

**Tech Stack:** Node 22 (`node:test`), the native backend (`native/backend`), git worktrees, the bundled PhotoCraft engine in `native/dist`.

**Spec:** `docs/superpowers/specs/2026-10-28-quality-above-nine-design.md` (phase 0).

## Global Constraints

- Repo: `/Volumes/Harry/works/albumStudio-photocraft`, branch `codex/album-quality-improvement`. Nothing is pushed.
- `SCRATCH=/private/tmp/claude-501/-Volumes-Harry-works-albumStudio-photocraft/2821a411-2a3f-4a06-90c0-a3e281d60cf7/scratchpad/phase0`
- The engine for backend tests: `ALBUM_STUDIO_PHOTOCRAFT_CLI` and `ALBUM_STUDIO_RENAME_CLI` point into `native/dist/Album Studio Latest.app/Contents/Resources/bin/` (`photocraft-cli`, `album-studio-rename-exclusive`).
- The only accepted failing test is `independent Poppler rendering matches perceptual ICC proof colours and page pixels`, because `pdftoppm` isn't installed on this Mac.
- Never run `git checkout`, `git restore` or `git stash` on a file with pending work. Restore from the copies in `$SCRATCH/backup`.
- Never commit `native/scripts/engine/architecture-publication-20261016.bundle`, `docs/quality/2026-10-16-iteration-10/`, `invoice-template/`, `docs/reviews/` or `.kiro/`. Phase 1 handles them.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Keep every new line at 160 characters or less; the readability check fails on new long lines.

## Review Focus

1. **A publication folder holding more than 10,000 entries.** The save or recovery stops before changing anything, and the message says so plainly. Today the message is garbled. Task 4.
2. **Saves into private folders.** A save into any folder named `.album-studio…`, in any letter case and at any depth, is refused with `PUBLICATION_PRIVATE_PATH`, except exactly `.album-studio/sheets`. Look-alike names such as `My.album-studio` still accept saves. Task 5.
3. **A crash in a delivery folder.** A native save killed while writing into a delivery JPEG folder is recovered by the next delivery operation. Task 5.
4. **Requests with unexpected fields.** A publication request carrying fields its mode doesn't define is refused with `PUBLICATION_PROTOCOL` before anything is written. Task 5.
5. **A brand-new album.** An album whose output folder doesn't exist yet passes the "settled" checks silently, so creating an album isn't blocked. Task 5.

## Review findings (from planning)

- **The CI step is consistent.** The native job's `CARGO_TARGET_DIR` is where `node native/scripts/engine.mjs build-rename` writes the helper, and `ALBUM_STUDIO_RENAME_CLI` points there.
- **The stricter request checks can't break a save today.** Nothing calls the `--native-publication` broker yet: neither the Rust shell checkout (`41a0f46`) nor the UI.
- **One defect.** The 10,000-entry limit message reads "The file publication directory exceeds the 10000-entry inspection limit changed during file publication." Task 4 fixes it.
- **Already consistent.** My history pruning in the working tree already uses Codex's `boundedNames`, which matches what Task 3 commits.

---

### Task 1: Snapshot the pending work and the gate

**Files:**
- Create: `$SCRATCH/backup/…` (copies of every pending file), `$SCRATCH/pending.sha256`, `$SCRATCH/gate.sh`

**Interfaces:**
- Produces: `$SCRATCH/gate.sh <checkout>`, which exits 0 only when every check passes. Tasks 2–6 use it. `$SCRATCH/backup` is what Task 2 restores from.

- [ ] **Step 1: Copy and checksum every pending file**

```bash
cd /Volumes/Harry/works/albumStudio-photocraft
SCRATCH=/private/tmp/claude-501/-Volumes-Harry-works-albumStudio-photocraft/2821a411-2a3f-4a06-90c0-a3e281d60cf7/scratchpad/phase0
mkdir -p "$SCRATCH/backup"
FILES=".github/workflows/ci.yml QUALITY_IMPROVEMENT_LOG.md native/backend/lib/file_publication.js native/backend/lib/namespace_lock.js native/backend/lib/output_lock.js native/backend/lib/publication_broker.js native/backend/lib/publication_io.js native/backend/lib/render_transaction.js native/backend/lib/sheets.js native/backend/lib/publication_paths.js native/backend/lib/publication_recovery.js native/backend/test/namespace_lock.test.js native/backend/test/publication_broker.test.js native/backend/test/native_publication_recovery.test.js native/scripts/readability-baseline.json"
for f in $FILES; do mkdir -p "$SCRATCH/backup/$(dirname "$f")"; cp -p "$f" "$SCRATCH/backup/$f"; done
shasum -a 256 $FILES > "$SCRATCH/pending.sha256"
git status --short | tee "$SCRATCH/status-before.txt"
```

Expected: 15 lines in `pending.sha256`. `status-before.txt` lists 12 modified files and these untracked paths: `docs/quality/2026-10-16-iteration-10/`, `docs/reviews/`, `docs/superpowers/`, `invoice-template/`, the three new backend files and the engine bundle.

- [ ] **Step 2: Write the gate script**

```bash
cat > "$SCRATCH/gate.sh" <<'EOF'
#!/bin/bash
# Runs every gate check in the given checkout. Exits 0 only when all pass, allowing the one
# Poppler test that needs pdftoppm (not installed on this Mac).
set -u
DIR=${1:?usage: gate.sh <checkout>}
BIN="/Volumes/Harry/works/albumStudio-photocraft/native/dist/Album Studio Latest.app/Contents/Resources/bin"
export ALBUM_STUDIO_PHOTOCRAFT_CLI="$BIN/photocraft-cli" ALBUM_STUDIO_RENAME_CLI="$BIN/album-studio-rename-exclusive"
LOG=$(mktemp -d); cd "$DIR" || exit 2; status=0
check() { local name=$1; shift; if "$@" > "$LOG/$name.log" 2>&1; then echo "ok    $name"; else echo "FAIL  $name ($LOG/$name.log)"; status=1; fi; }
check shared node --test test/*.test.js
npm --prefix native/backend test > "$LOG/backend.log" 2>&1
unexpected=$(grep -E '^not ok ' "$LOG/backend.log" | grep -vc 'independent Poppler rendering')
if [ "$unexpected" = 0 ] && grep -qE '^# pass [1-9]' "$LOG/backend.log"; then
  echo "ok    backend ($(grep -hE '^# (pass|fail) ' "$LOG/backend.log" | tr '\n' ' '))"
else echo "FAIL  backend ($unexpected unexpected failures, $LOG/backend.log)"; status=1; fi
check ui npm --prefix native/ui test
check lint npm run lint
check typecheck npm run typecheck
check architecture npm run check:architecture
exit $status
EOF
chmod +x "$SCRATCH/gate.sh"
```

- [ ] **Step 3: Run the gate on the working tree as it stands**

Run: `"$SCRATCH/gate.sh" /Volumes/Harry/works/albumStudio-photocraft`

Expected: six `ok` lines, and the backend line shows `# fail 1` (the Poppler test). Any `FAIL` stops the plan: report it before going on.

### Task 2: Prove each of Codex's new tests catches a break

**Files:**
- Modify temporarily, then restore: `native/backend/lib/namespace_lock.js`, `publication_recovery.js`, `render_transaction.js`, `sheets.js`, `publication_paths.js`, `publication_broker.js`

**Interfaces:**
- Consumes: `$SCRATCH/backup`, `$SCRATCH/pending.sha256` (Task 1).

For each row: apply the change, run the command, confirm the named test **fails**, restore the file from the backup, and confirm its checksum. Run every command from `native/backend` with the two engine variables exported, as below.

```bash
cd /Volumes/Harry/works/albumStudio-photocraft/native/backend
BIN="/Volumes/Harry/works/albumStudio-photocraft/native/dist/Album Studio Latest.app/Contents/Resources/bin"
export ALBUM_STUDIO_PHOTOCRAFT_CLI="$BIN/photocraft-cli" ALBUM_STUDIO_RENAME_CLI="$BIN/album-studio-rename-exclusive"
restore() { cp -p "$SCRATCH/backup/native/backend/lib/$1" "lib/$1" && (cd ../.. && shasum -a 256 -c "$SCRATCH/pending.sha256" --quiet) && echo restored; }
```

- [ ] **Step 1: `coversNamespace` (lock nesting)**

In `lib/namespace_lock.js` replace `      if (!context) return false` with `      return false`.
Run: `node --test --test-name-pattern='can cover its enclosing scope' test/namespace_lock.test.js`
Expected: FAIL (`PROJECT_BUSY`). Then `restore namespace_lock.js`.

- [ ] **Step 2: recovery on output admission**

In `lib/publication_recovery.js` replace `  const recovered = []` with `  const recovered = []; if (recovered) return recovered`.
Run: `node --test --test-name-pattern='output admission recovers' test/native_publication_recovery.test.js`
Expected: all four parametrised tests FAIL. Then `restore publication_recovery.js`.

- [ ] **Step 3: reading the render cache refuses until recovery**

In `lib/sheets.js` delete the two lines starting `  await assertFilesSettled(`.
Run: `node --test --test-name-pattern='output admission recovers' test/native_publication_recovery.test.js`
Expected: FAIL at `assert.rejects(readRenderCache(...), { code: 'PUBLICATION_RECOVERY_REQUIRED' })`. Then `restore sheets.js`.

- [ ] **Step 4: native save admission refuses an interrupted render**

In `lib/render_transaction.js` replace `async function assertRendersSettled(output) {` with `async function assertRendersSettled(output) { if (output) return`.
Run: `node --test --test-name-pattern='refuses an interrupted render' test/native_publication_recovery.test.js`
Expected: FAIL (the error code isn't `RENDER_RECOVERY_REQUIRED`). Then `restore render_transaction.js`.

- [ ] **Step 5: private folders refuse ordinary saves**

In `lib/publication_paths.js` replace `function assertPublicationParent(folder) {` with `function assertPublicationParent(folder) { if (folder) return`.
Run: `node --test --test-name-pattern='cannot change private recovery history' test/publication_broker.test.js`
Expected: FAIL (no `PUBLICATION_PRIVATE_PATH`). Then `restore publication_paths.js`.

- [ ] **Step 6: the managed sheets folder stays writable**

In `lib/publication_paths.js` delete the line starting `    if (name === '.album-studio' && index === parts.length - 2`.
Run: `node --test --test-name-pattern='managed sheets directory remains' test/publication_broker.test.js`
Expected: FAIL. Then `restore publication_paths.js`.

- [ ] **Step 7: a later save checks the last receipt**

In `lib/publication_broker.js` replace `  if (previous) { if (!matchesFileRevision(before, e.publication.revision)) throw conflict() }` with `  if (previous) { /* mutation */ }`.
Run: `node --test --test-name-pattern='subsequent receipts guard' test/publication_broker.test.js`
Expected: FAIL (the save after the external edit succeeds). Then `restore publication_broker.js`.

- [ ] **Step 8: aliases resolve to the same file**

In `lib/publication_broker.js` replace `  const file = path.resolve(name)` with `  const file = path.resolve(name); if (file) return file`.
Run: `node --test --test-name-pattern='resolve aliases' test/publication_broker.test.js`
Expected: FAIL (`replacesSource` is false). Then `restore publication_broker.js`.

- [ ] **Step 9: an unproven current file is never adopted**

In `lib/publication_broker.js` delete the line starting `  else if (current) throw changed('This document has no verified revision`.
Run: `node --test --test-name-pattern='cannot be silently adopted' test/publication_broker.test.js`
Expected: FAIL. Then `restore publication_broker.js`.

- [ ] **Step 10: Save Copy to a former source doesn't replace it**

In `lib/publication_broker.js` replace the line `  return current` (the last line of `validateExpectation`; it occurs once) with `  return current || source`.
Run: `node --test --test-name-pattern='former source after Save As' test/publication_broker.test.js`
Expected: FAIL (`copy.replacesSource` is true). Then `restore publication_broker.js`.

- [ ] **Step 11: wire types aren't coerced**

In `lib/publication_broker.js`, in `sourceRevision`, delete `typeof e.size === 'string' && `.
Run: `node --test --test-name-pattern='preserve string wire types' test/publication_broker.test.js`
Expected: FAIL. Then `restore publication_broker.js`.

- [ ] **Step 12: Confirm every file is back**

Run: `cd /Volumes/Harry/works/albumStudio-photocraft && shasum -a 256 -c "$SCRATCH/pending.sha256"`
Expected: 15 lines ending `OK`. If any test **passed** under its mutation, stop: that test doesn't protect what it claims, and the finding goes in the phase report before Codex's work is committed.

### Task 3: Commit Codex's work, gated on exactly its tree

**Files:**
- Commit: the 11 modified files in Task 1 (minus the baseline), the three new backend files, and `native/scripts/readability-baseline.json` regenerated.

**Interfaces:**
- Consumes: `$SCRATCH/gate.sh` (Task 1).
- Produces: a commit `feat(backend): recover interrupted native saves before outputs are read` that Tasks 4–6 build on.

- [ ] **Step 1: Regenerate the readability baseline for this content**

Run: `node native/scripts/check-readability.mjs --update && node native/scripts/check-readability.mjs`
Expected: `readability: recorded …` and then `readability: ok, …`.

- [ ] **Step 2: Stage exactly Codex's work**

```bash
git add .github/workflows/ci.yml QUALITY_IMPROVEMENT_LOG.md native/backend/lib/file_publication.js \
  native/backend/lib/namespace_lock.js native/backend/lib/output_lock.js native/backend/lib/publication_broker.js \
  native/backend/lib/publication_io.js native/backend/lib/render_transaction.js native/backend/lib/sheets.js \
  native/backend/lib/publication_paths.js native/backend/lib/publication_recovery.js \
  native/backend/test/namespace_lock.test.js native/backend/test/publication_broker.test.js \
  native/backend/test/native_publication_recovery.test.js native/scripts/readability-baseline.json
git diff --cached --name-only | wc -l; git status --short | grep -vE '^[AM] '
```

Expected: `15`, then only untracked (`??`) lines for the bundle, `docs/quality/2026-10-16-iteration-10/`, `docs/reviews/`, `docs/superpowers/` and `invoice-template/`.

- [ ] **Step 3: Gate the exact tree in a scratch worktree**

```bash
TREE=$(git write-tree); PROBE=$(git commit-tree "$TREE" -p HEAD -m "phase 0 gate probe")
W="$SCRATCH/wt"; git worktree add --detach "$W" "$PROBE"
ln -s "$PWD/node_modules" "$W/node_modules"; ln -s "$PWD/native/ui/node_modules" "$W/native/ui/node_modules"; ln -s "$PWD/native/photocraft" "$W/native/photocraft"
"$SCRATCH/gate.sh" "$W"; echo "gate exit $?"
for l in "$W/node_modules" "$W/native/ui/node_modules" "$W/native/photocraft"; do rm "$l"; done; git worktree remove "$W"
```

Expected: six `ok` lines and `gate exit 0`. On failure, unstage with `git reset -q` (the working tree is untouched) and report.

- [ ] **Step 4: Commit**

```bash
git commit -q -F - <<'EOF'
feat(backend): recover interrupted native saves before outputs are read

Work from the Codex session, which has ended. Reviewed, each new test shown
to fail against a deliberately broken copy of the code it guards, and the
full suite run on exactly this tree before committing.

- Output admission recovers interrupted native file saves in the output,
  managed sheets and delivery folders before anything reads them; reading
  the render cache refuses while such a save awaits recovery.
- Native document saves check the current file, its source and the last
  save receipt, resolving aliases, so Save, Save As and Save Copy never
  overwrite a document that changed elsewhere.
- Ordinary saves cannot write into the app's private .album-studio folders;
  the managed sheets folder stays writable.
- Publication folder listings stop at 10,000 entries.
- An output lock can cover a file reservation inside it without locking the
  same folder twice.
- CI builds the atomic rename helper for the native integration tests.
- Codex's quality-log entries for its last iterations.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git log --oneline -1; git status --short
```

Expected: the new commit, and `git status` shows only the untracked paths from Step 2.

### Task 4: Say plainly when a folder holds too many entries

**Files:**
- Modify: `native/backend/lib/publication_io.js` (`boundedNames`)
- Test: `native/backend/test/file_publication.test.js`, `native/backend/test/render_transaction.test.js`

**Interfaces:**
- Consumes: `assertFilesSettled(folder: string): Promise<void>` (`lib/file_publication.js`), `assertRendersSettled(output: string): Promise<void>` (`lib/render_transaction.js`).
- Produces: `boundedNames(folder: string): Promise<string[]>`, unchanged, now throwing a clear "holds more than 10000 entries" error that keeps the caller's error type and code.

- [ ] **Step 1: Write the failing tests**

Append to `native/backend/test/file_publication.test.js`:

```js
test('a publication folder with more than 10000 entries stops with a plain message and changes nothing', async t => {
  const { tmpdir } = require('./fixtures'), { assertFilesSettled } = require('../lib/file_publication')
  const root = tmpdir(); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const metadata = path.join(root, '.album-studio-publications'); fs.mkdirSync(metadata)
  for (let i = 0; i <= 10000; i++) fs.writeFileSync(path.join(metadata, `.prepare-${i}`), '')
  const plain = error => error.code === 'PUBLICATION_CONFLICT' && /holds more than 10000 entries/.test(error.message) && !/changed during/.test(error.message)
  await assert.rejects(assertFilesSettled(root), plain)
  assert.equal(fs.readdirSync(metadata).length, 10001)
})
```

Append to `native/backend/test/render_transaction.test.js`:

```js
test('a render folder with more than 10000 entries stops with a plain message and changes nothing', async t => {
  const { tmpdir } = require('./fixtures'), { assertRendersSettled } = require('../lib/render_transaction')
  const output = tmpdir(); t.after(() => fs.rmSync(output, { recursive: true, force: true }))
  const metadata = path.join(output, '.album-studio'); fs.mkdirSync(metadata)
  for (let i = 0; i <= 10000; i++) fs.writeFileSync(path.join(metadata, `entry-${i}`), '')
  await assert.rejects(assertRendersSettled(output), error => /holds more than 10000 entries/.test(error.message) && !/changed during/.test(error.message))
  assert.equal(fs.readdirSync(metadata).length, 10001)
})
```

Both files already import `test`, `assert`, `fs` and `path` at the top.

- [ ] **Step 2: Run them to confirm they fail**

Run (from `native/backend`, engine variables exported): `node --test --test-name-pattern='more than 10000 entries' test/file_publication.test.js test/render_transaction.test.js`
Expected: 2 FAIL, because the message still contains `changed during`.

- [ ] **Step 3: Implement**

In `native/backend/lib/publication_io.js`, add below the `require` lines at the top:

```js
const MAX_LISTED = 10000
```

Replace the whole `boundedNames` function (with its JSDoc line) with:

```js
  /** @param {string} folder @returns {Promise<string[]>} */
  async function boundedNames(folder) {
    const names = [], entries = await fs.promises.opendir(folder)
    for await (const entry of entries) {
      if (names.length >= MAX_LISTED) throw tooManyEntries(folder)
      names.push(entry.name)
    }
    return names.sort()
  }
  /**
   * The caller's own conflict error (type and code), with a message that names the actual problem.
   * @param {string} folder
   */
  function tooManyEntries(folder) {
    const error = changed('folder listing')
    error.message = `${folder} holds more than ${MAX_LISTED} entries, so the ${subject} stopped before changing anything. `
      + 'Existing files and recovery evidence were preserved.'
    return error
  }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `node --test --test-name-pattern='more than 10000 entries' test/file_publication.test.js test/render_transaction.test.js`
Expected: 2 pass.

- [ ] **Step 5: Prove the tests guard the limit**

Back up `lib/publication_io.js` to `$SCRATCH/task4-io.js`, change `const MAX_LISTED = 10000` to `const MAX_LISTED = 20000`, and rerun Step 4's command. Expected: 2 FAIL (no error is thrown). Then `cp -p "$SCRATCH/task4-io.js" lib/publication_io.js` and rerun: 2 pass.

- [ ] **Step 6: Gate and commit**

Run: `"$SCRATCH/gate.sh" /Volumes/Harry/works/albumStudio-photocraft`. Expected: six `ok` lines.

```bash
git add native/backend/lib/publication_io.js native/backend/test/file_publication.test.js native/backend/test/render_transaction.test.js
git commit -q -F - <<'EOF'
fix(backend): say plainly when a publication folder holds too many entries

The 10,000-entry listing limit reused the generic "changed during"
template, so users read "The file publication directory exceeds the
10000-entry inspection limit changed during file publication." The error
now names the folder, says it holds more than 10000 entries and that
nothing was changed, and keeps each caller's error type and code.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

### Task 5: Pin the behaviour Codex's tests leave uncovered

**Files:**
- Create: `native/backend/test/publication_paths.test.js`
- Modify (tests only): `native/backend/test/native_publication_recovery.test.js`, `native/backend/test/publication_broker.test.js`

**Interfaces:**
- Consumes:
  - `assertPublicationParent(folder: string): void` (`lib/publication_paths.js`)
  - `assertFilesSettled(folder)` and `assertRendersSettled(output)` (Task 4's interfaces)
  - `withProjectOutputs(project, work, { delivery })` (`lib/output_lock.js`)
  - `requestOf(request)`, which throws `PUBLICATION_PROTOCOL` (`lib/publication_broker.js`)
  - in `native_publication_recovery.test.js`: `fixture(t, canonical)` and `interrupt(f, point)`
  - in `publication_broker.test.js`: `fixture(t)` and `request(f, expected)`

These tests pin existing behaviour, so they should pass the first time. A failure is a real bug in Codex's code. In that case, stop and find the root cause with superpowers:systematic-debugging, then fix it with the failing test as the regression test.

- [ ] **Step 1: Private-folder rules**

Create `native/backend/test/publication_paths.test.js`:

```js
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { assertPublicationParent } = require('../lib/publication_paths')

const refused = { code: 'PUBLICATION_PRIVATE_PATH' }

test('ordinary folders accept saves, including names that merely contain album-studio', () => {
  for (const folder of ['/Users/ana/Albums/Client', '/Volumes/Work/My.album-studio', '/Volumes/Work/album-studio']) {
    assert.doesNotThrow(() => assertPublicationParent(folder))
  }
})

test('the managed sheets folder accepts saves in any letter case', () => {
  for (const folder of ['/Users/ana/Out/.album-studio/sheets', '/Users/ana/Out/.Album-Studio/Sheets']) {
    assert.doesNotThrow(() => assertPublicationParent(folder))
  }
})

test('private metadata refuses saves at any depth and in any letter case', () => {
  for (const folder of [
    '/Users/ana/Out/.album-studio',
    '/Users/ana/Out/.album-studio/sheets/old',
    '/Users/ana/Out/.album-studio/render-history',
    '/Users/ana/Out/.album-studio-publications/history',
    '/Users/ana/Out/.ALBUM-STUDIO-PUBLICATIONS/history',
    '/Volumes/Work/.album-studio-old/Client',
  ]) assert.throws(() => assertPublicationParent(folder), refused, folder)
})
```

Run: `node --test test/publication_paths.test.js`. Expected: 3 pass.

Prove them, restoring from a copy each time:
- Remove `.toLowerCase()` from `const name = part.toLowerCase()`. Expected: the "private metadata" test FAILs on the upper-case folder.
- Replace `index === parts.length - 2` with `index >= 0`. Expected: it FAILs on `/sheets/old`.

- [ ] **Step 2: A crash in a delivery JPEG folder is recovered**

Append to `native/backend/test/native_publication_recovery.test.js`:

```js
for (const point of ['capture', 'commit']) test(`delivery admission recovers a native save killed at ${point} in a delivery folder`, async t => {
  const f = fixture(t, false), jpegs = path.join(f.root, 'JPEG-High-Res')
  fs.mkdirSync(jpegs)
  const delivery = { ...f, folder: jpegs, target: path.join(jpegs, 'Page_001.jpg') }
  fs.writeFileSync(delivery.target, f.before)
  await interrupt(delivery, point)
  const read = () => fs.readFileSync(delivery.target)
  const bytes = await withProjectLease(f.album, ({ lease }) => withProjectOutputs(lease, async () => read(), { delivery: true }))
  assert.deepEqual(bytes, point === 'commit' ? f.after : f.before)
  assert.equal(fs.readdirSync(path.join(jpegs, '.album-studio-publications')).some(n => /^files-/.test(n)), false)
})
```

Run: `node --test --test-name-pattern='delivery admission recovers' test/native_publication_recovery.test.js`. Expected: 2 pass.

Prove it: in `lib/publication_recovery.js`, delete the line starting `  if (delivery) { const root = path.dirname(output)`. Expected: 2 FAIL. Restore from the copy.

- [ ] **Step 3: Requests with fields their mode doesn't define**

Append to `native/backend/test/publication_broker.test.js`:

```js
test('a publication request with fields its mode does not define is refused before anything is written', async t => {
  const f = fixture(t), record = await fingerprintFile(f.target), { requestOf } = require('../lib/publication_broker')
  for (const expected of [
    { mode: 'overwrite', extra: true },
    { mode: 'source', digest: record.digest, size: record.size, record },
    { mode: 'exact', record, digest: record.digest },
  ]) assert.throws(() => requestOf(request(f, expected)), { code: 'PUBLICATION_PROTOCOL' })
  assert.deepEqual(fs.readFileSync(f.target), f.old)
})
```

Run: `node --test --test-name-pattern='mode does not define' test/publication_broker.test.js`. Expected: pass.

Prove it: in `lib/publication_broker.js` replace `if (!Array.isArray(fields) || !exactKeys(e, fields) ||` with `if (!Array.isArray(fields) ||`. Expected: FAIL. Restore from the copy.

- [ ] **Step 4: A brand-new album passes the settled checks**

Append to `native/backend/test/native_publication_recovery.test.js`:

```js
test('a brand-new album with no output folder yet passes the settled checks', async t => {
  const { assertFilesSettled } = require('../lib/file_publication'), { assertRendersSettled } = require('../lib/render_transaction')
  const root = tmpdir(); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const missing = path.join(root, 'Not yet created')
  await assertFilesSettled(missing)
  await assertRendersSettled(missing)
  assert.equal(fs.existsSync(missing), false)
})
```

Run: `node --test --test-name-pattern='brand-new album' test/native_publication_recovery.test.js`. Expected: pass.

Prove it: in `lib/file_publication.js`, in `assertFilesSettled`, replace `if (error.code === 'ENOENT') return; throw error` with `throw error`. Expected: FAIL (`ENOENT`). Restore from the copy.

- [ ] **Step 5: Gate and commit**

Run: `"$SCRATCH/gate.sh" /Volumes/Harry/works/albumStudio-photocraft`. Expected: six `ok` lines. Then:

```bash
git add native/backend/test/publication_paths.test.js native/backend/test/native_publication_recovery.test.js native/backend/test/publication_broker.test.js
git diff --cached --stat
git commit -q -F - <<'EOF'
test(backend): pin private-folder, delivery-recovery and request-shape rules

- Private .album-studio folders refuse saves at any depth and in any letter
  case; the managed sheets folder and look-alike names still accept them.
- A native save killed in a delivery JPEG folder is recovered by the next
  delivery operation.
- Publication requests with fields their mode doesn't define are refused
  before anything is written.
- A brand-new album with no output folder passes the settled checks.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

Expected: `git diff --cached --stat` lists only the three test files.

### Task 6: Commit the design and this plan, then report

**Files:**
- Commit: `docs/superpowers/specs/2026-10-28-quality-above-nine-design.md`, `docs/superpowers/plans/2026-10-28-phase-0-commit-codex-work.md`

- [ ] **Step 1: Commit the documents**

```bash
git add docs/superpowers/specs/2026-10-28-quality-above-nine-design.md docs/superpowers/plans/2026-10-28-phase-0-commit-codex-work.md
git commit -q -F - <<'EOF'
docs: add the quality-above-nine design and the phase 0 plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
git log --oneline -5; git status --short
```

Expected: four new commits since `3f2fac8`, and only the untracked paths phase 1 handles.

- [ ] **Step 2: Phase report**

Report:
- the four commits
- the gate results, with test counts
- each mutation and whether its test caught it
- any bug found

Phase 0 targets no scored area, so the score stays 7.2. Say so, along with how many new tests there are.
