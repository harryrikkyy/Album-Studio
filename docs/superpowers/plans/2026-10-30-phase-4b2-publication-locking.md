# Phase 4b-2: Simplify verified reads, publication and locking, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the 16 functions above complexity 20 in the backend's verified reads, file publication, journals and locks down to 20 or less, with no behaviour change. This is the second of phase 4b's five batches.

**Architecture:** Each function is split into named helpers and predicates in its own module, as in phase 4b-1. These functions are the app's crash-safe save paths, so "no behaviour change" is checked more strictly than in 4b-1. A new scratch harness, the fault sweep, runs the old and new versions on the same folder and fails each file-system call in turn. It compares the result, the full sequence of file-system calls and the final folder tree, including after the recovery entry point runs. Pure validators are compared on random inputs, as before.

**Tech Stack:** Node 22, `node:test`, the repository's ESLint 10 complexity rule, the existing scratch tools (`complexity.mjs`, `fn-complexity.mjs`, `compare.mjs`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-28-quality-above-nine-design.md` (phase 4, item 4b).

## Global Constraints

- Repo `/Volumes/Harry/works/albumStudio-photocraft`, branch `codex/album-quality-improvement`. It tracks `origin`; push only when the user asks.
- `SCRATCH=/private/tmp/claude-501/-Volumes-Harry-works-albumStudio-photocraft/2821a411-2a3f-4a06-90c0-a3e281d60cf7/scratchpad/phase4b`. This shell is zsh: expand file lists with `${=F}`, and use `/usr/bin/grep` for complex patterns (`grep` is ugrep).
- Backend tests need the engine: `BIN="/Volumes/Harry/works/albumStudio-photocraft/native/dist/Album Studio Latest.app/Contents/Resources/bin"; export ALBUM_STUDIO_PHOTOCRAFT_CLI="$BIN/photocraft-cli" ALBUM_STUDIO_RENAME_CLI="$BIN/album-studio-rename-exclusive"`.
- Gate before every commit: `$SCRATCH/../phase0/gate.sh /Volumes/Harry/works/albumStudio-photocraft`, seven `ok` lines. The backend Poppler test is the only allowed failure. If an unrelated test times out under machine load, re-run it alone, then re-run the gate.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Prettier sets the layout. New lines stay within 120 characters.
- Never restore a file with uncommitted changes from git. A mutation check copies the file to `$SCRATCH` first and restores from that copy.
- Spec 4b, verbatim: "Refactor every runtime function above complexity 20 (48 today) to 20 or less by extracting named helpers and predicates. Each extracted pure predicate is compared with the original on random inputs; every refactored file runs the full backend suite."
- No behaviour change: identical return values, thrown errors (message, code, recovery fields), file-system calls in the same order with the same arguments, the same files left on disk, and the same recovery result after a failure at any step. The null-checked typecheck stays at zero errors.
- A bug found while splitting is fixed only in its own commit after the unchanged refactor, with a test that fails first (as in 4b-1).

### Rulings

Each ruling has its cost if wrong.

1. **The batch is these 16 functions** (measured 2026-10-30; 63 functions above 20 remain repo-wide). Uncovered lines are from the backend coverage run.

   | Module | Function | Complexity | Lines | Uncovered lines inside |
   |---|---|---:|---:|---|
   | `labnaming.js` | `validateJournal` | 24 | 41 | none |
   | `labnaming.js` | `renameSheetsUnlocked` | 24 | 98 | none |
   | `publication_broker.js` | `requestOf` | 27 | 46 | none |
   | `publication_broker.js` | `validateExpectation` | 22 | 30 | none |
   | `publication_broker.js` | `run` | 32 | 128 | 228, 272-274, 301-309, 320-332 |
   | `verified_file.js` | `readRecord` | 52 | 120 | none |
   | `cache.js` | `snapshotFile` | 55 | 165 | 224 |
   | `private_stage.js` | `cleanup` | 30 | 99 | 273-274, 280-281 |
   | `project_lock.js` | `acquireProjectLease` | 22 | 138 | 457-460, 479-481 |
   | `project_transaction.js` | `journalOf` | 29 | 66 | 155-156 |
   | `project_transaction.js` | `saveProject` | 30 | 100 | none |
   | `file_publication.js` | `journalOf` | 54 | 82 | 141-142 |
   | `file_publication.js` | `publishFiles` | 40 | 153 | none |
   | `render_transaction.js` | `journalOf` | 54 | 78 | none |
   | `render_transaction.js` | `publishRender` | 59 | 213 | none |
   | `delivery_transaction.js` | `publishDelivery`'s locked callback | 52 | 185 | 835-838, 876-877 |

   - Cost if wrong: none; the list is measured.
2. **One method for every function, as in 4b-1:**
   - (a) Pin uncovered branches with tests that pass on today's code, each mutation-checked.
   - (b) Split into named helpers and predicates in the same module, keeping the signature.
   - (c) Compare old and new: the fault sweep for anything that touches files, random inputs for pure validators.
   - (d) Check that it and every new helper are at 20 or less.
   - (e) Run the gate.

   Cost if wrong: none; each step is a check.
3. **The fault sweep is the comparison for file-system code.** Random inputs can't exercise a crash-safe transaction: what matters is what happens when step N fails.
   - The sweep records every `fs.promises` call, every file-handle call and every exclusive rename. It makes UUIDs, random bytes and temporary-folder names deterministic, so both versions see the same paths.
   - For each call N of a clean run, it runs both versions three ways:
     - **once:** call N fails with `EIO`;
     - **stop:** call N and every later call fail, then the module's recovery entry point runs normally;
     - **perturb:** the scenario's concurrent change (an edit, an extra file) happens just before call N.
   - The two versions must produce the same normalised result, the same call log and the same final tree (paths, types, modes, sizes and content hashes, with inode numbers and times normalised).
   - Cost if wrong: a scenario that never reaches a branch hides a difference there. Each task therefore lists its scenarios, and the pinning tests cover the branches the sweep can't reach.
4. **Pure validators are compared on random inputs with `compare.mjs`.** This covers `validateJournal`, `requestOf`, `validateExpectation`, and each `journalOf`, exposed by compiling a copy of its module. Each gets mutated journals and requests (seed per task). Cost if wrong: none.
5. **Helpers stay in their module.**
   - Four modules repeat one transaction skeleton: prepare, journal, capture, install, commit, recover. Merging them into one shared module is a design change, not a split, so it is recorded as an open item for a later phase.
   - Cost if wrong: the duplication stays until then.
6. **Tasks run from least to most risky.** The sweep is proven on lab renames and the broker before it guards the verified readers, then project, file, render and delivery publication. Cost if wrong: none.
7. **The readability baseline is re-recorded once per task,** after its complexity findings fall. Cost if wrong: none.
8. **The 4b-1 review's stacking-slot pin belongs to batch 4b-3.** It guards the proof renderer, which this batch doesn't touch. Cost if wrong: none.

## Measuring

- **Complexity.** `node $SCRATCH/complexity.mjs > $SCRATCH/complexity.tsv` lists every function above 20. For every function in one file, run `node $SCRATCH/fn-complexity.mjs <file>`.
- **Coverage.** With the engine variables exported, run `npm --prefix native/backend run test:coverage` and read the module's uncovered lines.
- **Old against new.** The old version comes from `$SCRATCH/base-4b2`, a `git archive` of this plan's base commit, with `node_modules` symlinked (Task 1). Pure functions use `$SCRATCH/compare.mjs` from 4b-1. File-system functions use `$SCRATCH/sweep.mjs` (Task 1).

## Review Focus

1. **A failure at any step leaves the same files and recovery fields.** Each publisher sets `recoveryStage`, `recoveryRequired`, `publicationRestored`, `renderRestored`, `projectCommitted` or `deliveryCommitted` at fixed steps. A helper that catches one step earlier or later changes what the user is told and what is left on disk. Every task's sweep runs "once" and "stop" at every call.
2. **The commit point doesn't move.** `committed = true` and the commit marker's move mark the moment a save has happened. A failure after it must report the save as done; a failure before it must restore the old files. The "stop" mode runs the recovery entry point after every possible failure and compares the recovered tree.
3. **Identity checks still run at the same boundaries.** Each publisher re-reads a file after capturing it and re-reads the journal before each move. A helper that reads once and reuses the record would accept a file swapped in mid-save. The "perturb" mode makes the scenario's concurrent change before every call.
4. **Close and release errors still merge the same way.** `readRecord`, `snapshotFile`, the broker and lease release each combine a primary failure with a close or release failure in a specific message and `closeErrors` shape. The sweep fails every `close` call, and the broker and lease pins cover release.
5. **Lease state survives errors.** `acquireProjectLease` retires its unused owner on failure, and its lease's `release()` shares one promise between concurrent callers and can be retried after a failure. Task 5 pins both before the split.

---

### Task 1: The base checkout and the fault sweep

**Files:**
- Create: `$SCRATCH/base-4b2/`, `$SCRATCH/sweep.mjs`, `$SCRATCH/sweep-toy/` (smoke test)
- No repository change.

**Interfaces:**
- Produces: `sweep(spec) → Promise<number>` (the number of differing runs), where `spec` is `{ name, root, versions: { old, new }, scenario(root) → ctx, run(version, ctx), recover(version, ctx), perturbs?, modes?, stride? }`, `root` must be inside `$SCRATCH`, and a scenario whose `ctx` has `perturb()` sets `perturbs: true`. Also `install(targets)`, which hooks extra modules such as each version's `exclusive_rename`.

- [ ] **Step 1: Base checkout**

```bash
cd /Volumes/Harry/works/albumStudio-photocraft && BASE=$(git rev-parse HEAD) && echo "$BASE" > $SCRATCH/base-4b2.sha
mkdir -p $SCRATCH/base-4b2 && git archive "$BASE" | tar -x -C $SCRATCH/base-4b2
ln -s /Volumes/Harry/works/albumStudio-photocraft/node_modules $SCRATCH/base-4b2/node_modules
ln -s /Volumes/Harry/works/albumStudio-photocraft/native/ui/node_modules $SCRATCH/base-4b2/native/ui/node_modules
```

Record `BASE` in the ledger. Then check that the modules use `fs.promises` through property lookups, so the sweep's hooks see every call:

```bash
/usr/bin/grep -nE "const \{[^}]*\} = require\('(node:)?fs(/promises)?'\)|require\('(node:)?fs/promises'\)" native/backend/lib/*.js
```

Expected: no line for the ten modules in Ruling 1. If one destructures, hook that module's binding too and record a ruling.

- [ ] **Step 2: Write `$SCRATCH/sweep.mjs`**

This is the final harness. Tasks 3 to 9 added value normalisation, `positions`, `labelDigests`, `note()` and the `both` mode to it, and the ledger gives the reason for each.

```js
// Old-versus-new fault sweep for file-system transactions. Each version runs a scenario on a fresh
// folder at the same path: cleanly (to count its calls), then once per call N with call N failing
// ("once"), with call N and every later call failing and the recovery entry point run afterwards
// ("stop"), and with the scenario's concurrent change made just before call N ("perturb").
import crypto from "node:crypto";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";

const SCRATCH =
  "/private/tmp/claude-501/-Volumes-Harry-works-albumStudio-photocraft/2821a411-2a3f-4a06-90c0-a3e281d60cf7/scratchpad";
const PROMISES = [
  "access",
  "chmod",
  "copyFile",
  "link",
  "lstat",
  "mkdir",
  "mkdtemp",
  "open",
  "opendir",
  "readFile",
].concat([
  "readdir",
  "readlink",
  "realpath",
  "rename",
  "rm",
  "rmdir",
  "stat",
  "statfs",
  "unlink",
  "utimes",
  "writeFile",
]);
const HANDLE = [
  "chmod",
  "close",
  "datasync",
  "read",
  "readFile",
  "stat",
  "sync",
  "truncate",
  "utimes",
  "write",
].concat(["writeFile"]);
let current = null; // { root, calls, log, fault, perturb, quiet, nodes, uuid, temp }
let labelDigests = false;

const sha = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
const text = (value) =>
  value
    .split(current.root)
    .join("<root>")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z\b/g, "<iso>")
    .replace(/\b1\d{12}\b/g, "<ms>");
// JSON written through a call (journals, markers, owner files) holds inode numbers and times too.
function jsonArgument(raw) {
  if (raw.length > 1024 * 1024 || !/^\s*[[{]/.test(raw)) return undefined;
  try {
    return `json:${JSON.stringify(normalize(JSON.parse(raw)))}`;
  } catch {
    return undefined;
  }
}
function clean(value, depth = 0) {
  if (typeof value === "string") return jsonArgument(value) ?? text(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function") return "function";
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value))
    return (
      (value.byteLength <= 1024 * 1024 &&
        jsonArgument(
          Buffer.from(
            value.buffer,
            value.byteOffset,
            value.byteLength,
          ).toString("utf8"),
        )) ||
      `bytes:${value.byteLength}:${sha(value)}`
    );
  if (!value || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, clean(v, depth + 1)]),
  );
}
// The next label of one kind within the current run.
function nextLabel(kind) {
  const counts = (current.labelCounts ??= new Map());
  const next = counts.get(kind) || 0;
  counts.set(kind, next + 1);
  return next;
}
// Inode numbers and times differ between runs, so each becomes a stable label within one run.
function normalize(value, key = "", depth = 0) {
  // A process start (ps lstart, one-second resolution) can match another process started in the
  // same second, which first-appearance labels would turn into a false difference.
  if (key === "start" && typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) return "<start>";
  if (
    // Lock owners also name their process (pid, start) and a random token.
    ["dev", "ino", "pid", "token"].includes(key) &&
    value !== undefined &&
    value !== null
  ) {
    const id = `${key}:${value}`;
    if (!current.nodes.has(id))
      current.nodes.set(id, `${key}#${nextLabel(key)}`);
    return current.nodes.get(id);
  }
  if (/^(?:[acm]time|birthtime)(?:Ms|Ns)?$/.test(key)) return "<time>";
  // A commit marker names its journal by the SHA-256 of bytes that hold inode numbers and times.
  if (
    key === "journal" &&
    typeof value === "string" &&
    /^[a-f0-9]{64}$/.test(value)
  ) {
    const id = `journal:${value}`;
    if (!current.nodes.has(id))
      current.nodes.set(id, `journal#${nextLabel("journal")}`);
    return current.nodes.get(id);
  }
  // A render cache records its sheet's stamp, so the cache's own SHA-256 varies with the time too.
  if (
    labelDigests &&
    ["digest", "cacheRevision"].includes(key) &&
    typeof value === "string" &&
    /^[a-f0-9]{64}$/.test(value)
  ) {
    const id = `digest:${value}`;
    if (!current.nodes.has(id))
      current.nodes.set(id, `digest#${nextLabel("digest")}`);
    return current.nodes.get(id);
  }
  if (key === "stamp" && typeof value === "string")
    return value.replace(/:\d+$/, ":<time>");
  if (value instanceof Error) return describe(value, depth);
  if (
    !value ||
    typeof value !== "object" ||
    Buffer.isBuffer(value) ||
    depth > 6
  )
    return clean(value);
  if (Array.isArray(value))
    return value.map((item) => normalize(item, "", depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, normalize(v, k, depth + 1)]),
  );
}
function describe(error, depth = 0) {
  if (!(error instanceof Error))
    return { thrown: normalize(error, "", depth + 1) };
  const { stack: _stack, ...fields } = Object.fromEntries(
    Object.entries(error),
  );
  return {
    name: error.name,
    message: text(error.message),
    fields: normalize(fields, "", depth + 1),
    cause:
      depth < 3 && error.cause !== undefined
        ? describe(error.cause, depth + 1)
        : undefined,
  };
}

// A file handle's close is an own property of each handle, not a prototype method, so every
// handle that open returns gets its own hook.
const AFTER = {
  "fs.open": (handle) => (hook(handle, "close", "handle.close"), handle),
};
// Equal numbers keep equal labels within a run, so a read of a different length still differs.
function numberLabel(value) {
  const id = `number:${value}`;
  if (!current.nodes.has(id)) current.nodes.set(id, `n#${nextLabel("n")}`);
  return current.nodes.get(id);
}
function hook(target, method, label) {
  const original = target[method],
    after = AFTER[label];
  if (typeof original !== "function" || original.swept) return;
  const wrapped = async function (...args) {
    if (!current || current.quiet)
      return after
        ? after(await original.apply(this, args))
        : original.apply(this, args);
    const n = ++current.calls;
    // A read's buffer is only where the bytes go, so its leftover contents aren't part of the call.
    current.log.push([
      label,
      ...args.map((arg, i) =>
        label === "handle.read" && i === 0 && ArrayBuffer.isView(arg)
          ? `buffer:${arg.byteLength}`
          : (label === "handle.read" || label === "handle.write") && typeof arg === "number"
            ? "<n>" // offsets and lengths follow file sizes, which vary between runs
            : label.endsWith("utimes") && typeof arg !== "string"
            ? "<time>" // access and modification times, in seconds
            : clean(arg),
      ),
    ]);
    if (
      (current.fault.mode === "perturb" || current.fault.mode === "both") &&
      current.fault.at === n
    ) {
      current.quiet = true;
      try {
        await current.perturb();
      } finally {
        current.quiet = false;
      }
    }
    if (
      ((current.fault.mode === "once" || current.fault.mode === "both") &&
        current.fault.at === n) ||
      (current.fault.mode === "stop" && n >= current.fault.at)
    )
      throw Object.assign(new Error(`injected EIO at ${label}`), {
        code: "EIO",
      });
    return after
      ? after(await original.apply(this, args))
      : original.apply(this, args);
  };
  wrapped.swept = true;
  target[method] = wrapped;
}
// A check that makes no file-system call of its own, recorded so its position shows in the log.
// It may perturb, but not fail; it has no result to fail with. perturb must finish synchronously:
// a hooked call the caller doesn't wait for would run on while recording is off.
export function note(label) {
  if (!current || current.quiet) return;
  const n = ++current.calls;
  current.log.push([label]);
  if (current.fault.mode === "perturb" && current.fault.at === n) current.perturb();
}
export function install(targets) {
  for (const [object, methods, prefix] of targets)
    for (const method of methods) hook(object, method, prefix + method);
}

// Deterministic names: UUIDs, random bytes and temporary folders are counters within a run.
const realMkdir = fs.promises.mkdir,
  realUUID = crypto.randomUUID,
  realBytes = crypto.randomBytes;
let outsideTemp = 0; // scenario builders run outside a sweep run
fs.promises.mkdtemp = async (prefix) => {
  const folder = `${prefix}${current ? String(++current.temp).padStart(6, "0") : `x${++outsideTemp}`}`;
  await realMkdir.call(fs.promises, folder, 0o700);
  return folder;
};
crypto.randomUUID = () =>
  current
    ? `00000000-0000-4000-8000-${String(++current.uuid).padStart(12, "0")}`
    : realUUID();
crypto.randomBytes = (size, callback) =>
  current && !callback
    ? Buffer.alloc(size, ++current.uuid & 255)
    : realBytes(size, callback);
const probeFile = `${SCRATCH}/sweep-probe`;
fs.writeFileSync(probeFile, "");
const probe = await fs.promises.open(probeFile, "r");
const handleProto = Object.getPrototypeOf(probe);
await probe.close();
install([
  [fs.promises, PROMISES, "fs."],
  [handleProto, HANDLE, "handle."],
]);

function tree(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = `${dir}/${name}`,
        st = fs.lstatSync(file),
        entry = [
          `${rel}${name}`,
          st.isDirectory() ? "dir" : st.isSymbolicLink() ? "link" : "file",
          st.mode & 0o777,
        ];
      if (st.isFile()) {
        const bytes = fs.readFileSync(file);
        let json;
        try {
          json = JSON.parse(String(bytes));
        } catch {}
        entry.push(
          st.nlink,
          json === undefined ? st.size : "json",
          json === undefined
            ? sha(bytes)
            : (process.env.SWEEP_DEBUG_JSON ? JSON.stringify(normalize(json)) : sha(JSON.stringify(normalize(json)))),
        );
      }
      out.push(entry);
      if (st.isDirectory()) walk(file, `${rel}${name}/`);
    }
  };
  walk(root, "");
  return out;
}
async function settle(work) {
  let timer;
  const limit = new Promise(
    (resolve) => (timer = setTimeout(() => resolve({ timeout: true }), 20000)),
  );
  try {
    return await Promise.race([
      work().then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      limit,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function attempt(spec, side, fault) {
  if (!spec.root.startsWith(`${SCRATCH}/`))
    throw new Error("Sweep roots must be inside the scratch folder.");
  fs.rmSync(spec.root, { recursive: true, force: true });
  fs.mkdirSync(spec.root, { recursive: true });
  // A scenario is built unrecorded but with its own deterministic names, and with the app's data
  // and cache folders inside its root, so both versions start from the same files.
  process.env.ALBUM_STUDIO_DATA_DIR = `${spec.root}/.sweep-data`;
  process.env.ALBUM_STUDIO_CACHE_DIR = `${spec.root}/.sweep-cache`;
  current = { root: spec.root, quiet: true, nodes: new Map(), uuid: 900000, temp: 900000, fault: { mode: "none" } };
  let ctx;
  try {
    ctx = await spec.scenario(spec.root);
  } finally {
    current = null;
  }
  current = {
    root: spec.root,
    calls: 0,
    log: [],
    fault,
    perturb: ctx.perturb,
    quiet: false,
    nodes: new Map(),
    uuid: 0,
    temp: 0,
  };
  const outcome = await settle(() => spec.run(spec.versions[side], ctx));
  if (outcome.timeout)
    throw new Error(
      `${spec.name}: ${side} timed out at ${fault.mode}@${fault.at}`,
    );
  let recovered;
  if (fault.mode === "stop") {
    current.fault = { mode: "none" };
    recovered = await settle(() => spec.recover(spec.versions[side], ctx));
  }
  const result = {
    calls: current.calls,
    log: current.log,
    outcome: outcome.error
      ? { error: describe(outcome.error) }
      : { value: normalize(outcome.value) },
    recovered:
      recovered &&
      (recovered.error
        ? { error: describe(recovered.error) }
        : { value: normalize(recovered.value) }),
    tree: tree(spec.root),
  };
  current = null;
  return result;
}
// Where two values' JSON first differs, with context on both sides.
function firstDifference(x, y) {
  const a = JSON.stringify(x) || "",
    b = JSON.stringify(y) || "";
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}:\n    old ...${a.slice(Math.max(0, i - 160), i + 240)}\n    new ...${b.slice(Math.max(0, i - 160), i + 240)}`;
}
export async function sweep(spec) {
  labelDigests = !!spec.labelDigests;
  const clean = {
    old: await attempt(spec, "old", { mode: "none" }),
    new: await attempt(spec, "new", { mode: "none" }),
  };
  let runs = 1,
    differences = 0;
  const tally = new Map();
  const check = (label, a, b) => {
    const key = b.outcome.error
      ? `error ${b.outcome.error.fields?.code || b.outcome.error.name}`
      : b.outcome.value && b.outcome.value.ok === false
        ? "returned not ok"
        : "ok";
    tally.set(key, (tally.get(key) || 0) + 1);
    if (isDeepStrictEqual(a, b)) return;
    if (differences++ < 3)
      for (const part of ["calls", "log", "outcome", "recovered", "tree"])
        if (!isDeepStrictEqual(a[part], b[part]))
          console.log(
            spec.name,
            label,
            part,
            firstDifference(a[part], b[part]),
          );
  };
  check("clean", clean.old, clean.new);
  // A spec may choose which calls to fail (all of them by default), from the clean run's log.
  const positions = spec.positions
    ? spec.positions(clean.new.calls, clean.new.log)
    : Array.from(
        { length: Math.ceil(clean.new.calls / (spec.stride || 1)) },
        (_, i) => 1 + i * (spec.stride || 1),
      );
  for (const at of positions)
    for (const mode of spec.modes || ["once", "stop", "perturb"]) {
      if ((mode === "perturb" || mode === "both") && !spec.perturbs) continue;
      runs++;
      check(
        `${mode}@${at}`,
        await attempt(spec, "old", { mode, at }),
        await attempt(spec, "new", { mode, at }),
      );
    }
  console.log(
    `${spec.name}: ${clean.new.calls} calls, ${runs} runs compared, ${differences} differences`,
  );
  console.log(
    `  outcomes: ${[...tally].map(([k, n]) => `${k} ${n}`).join(", ")}`,
  );
  return differences;
}
```

A scenario that defines `ctx.perturb` sets `spec.perturbs = true`. Before any comparison, check that `renameExclusive` and every hooked method return promises; a synchronous original would change behaviour once wrapped. Record a ruling if one doesn't.

- [ ] **Step 3: Smoke test**

Write `$SCRATCH/sweep-toy/publish.js`. It writes `.tmp-<uuid>` with a `wx` handle (`writeFile`, `sync`, `close`), checks the temp file's size with `lstat`, then renames it to `target`. Its `recover(dir)` unlinks any `.tmp-*`. Copy it to `$SCRATCH/sweep-toy/same.js` and `$SCRATCH/sweep-toy/swapped.js`; the swapped copy runs the `lstat` after the rename. Write `$SCRATCH/sweep-toy/smoke.mjs`, which sweeps old `publish.js` against `same.js` and then against `swapped.js`, with a `perturb` that writes into `target`.

Expected:
- against `same.js`: `0 differences`, at least 8 calls, and every mode ran;
- against `swapped.js`: a non-zero count, which proves the harness can see a reordered call.

- [ ] **Step 4: Ledger**

Record the base commit, the toy's call count and both difference counts. No commit.

---

### Task 2: Lab renames (`labnaming.js`)

**Files:** `native/backend/lib/labnaming.js` (`validateJournal` line 254, `renameSheetsUnlocked` line 446); tests in `native/backend/test/labnaming.test.js` and `labnaming_recovery.test.js`.

**Interfaces:**
- Consumes: `compare`, `rng` and `randomJson` from `$SCRATCH/compare.mjs`; `sweep` and `install` from Task 1.

- [ ] **Step 1: Confirm coverage.** Neither function has uncovered lines. Run both test files on today's code and confirm they pass.
- [ ] **Step 2: Split `validateJournal`.**
  - The header check becomes `validRenameJournal(folder, journal, match)`; the per-entry shape becomes `validRenameEntry(entry, i, match)`. The `name` predicate moves to module level as `plainName`.
  - `validateJournal` keeps the two throws, the duplicate check and the `sources`/`targets` sets, in the same order.
- [ ] **Step 3: Split `renameSheetsUnlocked`.**
  - `planRenames(folder, canonical, ops)` returns `plan`. It keeps every per-op check and its message, the `lstat`, and the hash for inode-0 files, in today's order.
  - `refuseOverwrites(plan)` holds the `access` loop.
  - `renameJournal(canonical, plan)` returns `{ journal, journalFile }`.
  - `applyRenames(canonical, journal, journalFile)` saves the journal, makes both move passes, unlinks the journal and syncs, and recovers on failure with today's messages.
  - `renameSheetsUnlocked` keeps the early `{ renamed: 0, undo: [] }` return and builds the same result.
- [ ] **Step 4: Compare old and new.**
  - Write `$SCRATCH/t2b-compare.mjs`.
  - `validateJournal`, seed 5201: 5,000 journals. Each starts from a valid two-entry journal, then gets 1–3 random changes:
    - a field's type;
    - a name with `/`, `..`, a leading `.` or `.as-`;
    - a wrong `tmp`;
    - an identity field that isn't a decimal string;
    - an ino of `'0'` without a digest;
    - a case-insensitive duplicate;
    - a random value from `randomJson`.
  - Compare the thrown message, or no throw.
  - `renameSheetsUnlocked`, through the exported `renameSheets` (which takes the folder lock), seed 5202. Sweep three scenarios:
    - two renames;
    - a swap (`a→b`, `b→a`);
    - a rename onto an unrelated existing sheet, which is refused.

    `recover` calls `listSheets({ folder })`, which recovers journals first; `perturb` rewrites the first source sheet's bytes.
  - Hook both versions' `exclusive_rename` modules with `install`.
  - Expected: `0 differences` for every comparison.
- [ ] **Step 5: Measure.** `fn-complexity.mjs native/backend/lib/labnaming.js` shows nothing above 20, and `complexity.mjs` drops to 61. Run `node native/scripts/check-readability.mjs --update`; only `labnaming.js` changes.
- [ ] **Step 6: Gate and commit** `refactor(backend): split lab rename journals and planning`. The body gives before and after complexity, the helpers, the comparison counts and seeds, and the sweep's call and run counts.

---

### Task 3: The publication broker (`publication_broker.js`)

**Files:** `native/backend/lib/publication_broker.js` (`requestOf` line 121, `validateExpectation` line 181, `run` line 212); new tests in `native/backend/test/publication_broker_inprocess.test.js`.

**Interfaces:**
- Consumes: `compare`/`rng` from `compare.mjs`; `sweep`/`install` from Task 1.
- Produces: in-process broker tests that drive the exported `run({ input, output })` with `PassThrough` streams. Input frames are a 4-byte big-endian length followed by JSON, as `frame()` writes them in `publication_broker.test.js`. Replies are JSON lines.

- [ ] **Step 1: Pin `run`'s uncovered paths.** Each test runs today's `run` in-process with a temporary album output folder (as `fixture()` in `publication_broker.test.js` builds one), asserts the exact reply sequence (`state` and `error` fields), and checks what is left on disk:
  - **line 228:** the target is a symlink to itself. `realpath` fails with `ELOOP`, and the reply is `failed` with that error before any bytes are read.
  - **lines 272-274:** a `t.mock.method(fs.promises, 'open')` wrapper makes the staged `source` handle's `close` reject once. The reply is `failed`, the error is the close error with today's `recoveryStage`, and the stage is kept. In a second case the declared length exceeds the bytes sent, so the read also fails; the message carries both failures as today.
  - **lines 301-309:** after commit, `t.mock.method(io, 'move')` fails the move into `inputs/`. The reply carries today's error fields, and the published file holds the new bytes.
  - **lines 320-332:** the lease's release fails. Find the first file-system call `release()` makes from the sweep's log, fail it once with a counting mock, and assert today's reply with and without a primary failure.

  Mutation-check one assertion per path in a copy of the module.
- [ ] **Step 2: Split `requestOf`.**
  - `validRequestShape(request)` covers the version, target and expected checks. `EXPECTATION_FIELDS` is a module-level table.
  - `validExpectationFields(e)` covers the mode fields with the `source`/`exact` checks.
  - For document mode, `validDocumentEvidence(e)` and `validEarlierReceipt(publication)` each keep their own message.
  - `requestOf` keeps the four throws in today's order.
- [ ] **Step 3: Split `validateExpectation`.**
  - `fixedModeConflict(e, before)` handles `new`, `source` and `exact`.
  - `documentAliases(target, e)` returns `{ current, previous, source }`. It makes the `canonicalName` calls in today's order: the target, then current, previous and source, each only when present.
  - `validateExpectation` keeps the branch order and the three outcomes.
- [ ] **Step 4: Split `run`.**
  - `admit(reader)` reads the request, checks the reserved name and the existing on-disk name, and returns `{ request, folder, name }`.
  - `stageInput(reader, payload, metadata)` creates the stage, streams, hashes and closes the handle, merges the read and close errors as today, checks the digest, and returns `{ stage, source }`. It reports the stage to `run` before any byte is written, so `recoveryStage` stays exact.
  - `keepInputHistory(lease, metadata, stage, result)` covers the move into `inputs/` and its committed-failure fields.
  - `releaseLease(lease, failure, result)` returns the failure to report.
  - `run` keeps both deadlines, every `write` to `output` in order, `input.destroy()`, and the return value.
- [ ] **Step 5: Compare old and new.**
  - Write `$SCRATCH/t3b-compare.mjs`.
  - `requestOf`, seed 5301: 5,000 requests. Each starts from a valid request of each mode, then gets random changes: extra or missing keys, wrong types, relative or `\0` paths, malformed Unicode, digest and size edge cases, and random `randomJson` values.
  - `validateExpectation`, seed 5302: 2,000 cases in a temporary folder with a symlinked alias and a missing parent. Each takes random modes, records and path choices; compare the result or the thrown message.
  - `run`: sweep three scenarios with `PassThrough` streams:
    - overwrite with a `source` expectation;
    - a `new` file;
    - a document Save As.

    `recover` runs `recoverFiles(folder, lease)` under a fresh lease; `perturb` edits the target.
  - Expected: `0 differences`.
- [ ] **Step 6: Measure, gate and commit** `refactor(backend): split native publication admission, staging and release`. Commit the pins first, as `test(backend): pin the native publication broker's failure replies`.

---

### Task 4: Verified reads (`verified_file.js`, `cache.js`)

**Files:** `native/backend/lib/verified_file.js` (`readRecord` line 42), `native/backend/lib/cache.js` (`snapshotFile` line 215); tests in `verified_file.test.js` and `cache_snapshot_safety.test.js`.

- [ ] **Step 1: Pin `cache.js:224`.** During retention after a failed snapshot, an `lstat` of the retained name fails with `EACCES` (a counting `t.mock.method(fs.promises, 'lstat')`). Assert today's thrown message, which appends "Snapshot retention also needs review", plus its `code`, `snapshotPath` and `sourceCode`. Mutation-check it.
- [ ] **Step 2: Split `readRecord`** (inside `createVerifiedFileReader`, keeping its closure over `label`, `subject` and `changed`):
  - `assertReadable(file, before, maximum, retain)` covers both policy throws.
  - `hashPass(handle, buffer, length, { retain, sink })` returns `{ digest, chunks }`.
  - `verifyPass(handle, buffer, length)` returns the second digest.
  - `settledRead(handle, buffer, length, opened, file, what, digestMatches = true)` reads the extra byte and the handle's `stat`, then throws `changed(what)` unless no extra byte was read, the digest matches, the handle's identity is unchanged, and the path's `lstat` agrees. It keeps today's short-circuit: the path's `lstat` runs only when the earlier checks pass. It returns `after`.
  - `recordOf(after, digest, retain, chunks, length)` builds the result in today's key order.
  - The close-error merge becomes `withCloseError(failure, failed, closeError)` at module level. It is pure, so `compare.mjs` also checks it: 2,000 random failure values (seed 5401): strings, plain and frozen errors, errors with read-only or getter `closeErrors`, existing arrays over 63 entries, and `code` values of every type.
- [ ] **Step 3: Split `snapshotFile`.**
  - The local `sameNode`, `sameRead` and `statOrMissing` move to module level as `sameSnapshotNode`, `sameSnapshotRead` and `statOrMissing`, unchanged.
  - `copyIntoSnapshot(source, destination, opened, file, digest)` covers the copy loop, the hash and the unchanged checks.
  - `protectSnapshot(destination, created, target, digest)` covers `chmod`, `sync` and the protection checks.
  - `retainFailedSnapshot(target, created, error)` returns `retainedPath` and appends to `error.message` exactly as today.
  - `snapshotFailure(message, cause, target, retainedPath)` builds the typed error.
  - `closeSnapshotHandles(source, destination)` returns `closeErrors`.
  - `snapshotFile` keeps the order: digest check, `mkdir`, target, try/catch/finally.
- [ ] **Step 4: Compare old and new.** Write `$SCRATCH/t4b-compare.mjs`.
  - `readRecord`: sweep files of 0 bytes, 1 byte and 1 MiB + 1 byte (two chunks), each with `retain` on and off, with a `sink`, and with a matching `expectedDigest` (which skips the second pass). `perturb` either rewrites the file with the same size (A/B/A) or appends a byte, alternating by call number.
  - `snapshotFile`: sweep a small file and a two-chunk file, hooking both versions' `exclusive_rename`. `perturb` rewrites the source.
  - Neither has a recovery entry point, so `recover` lists the folder.
  - Expected: `0 differences`.
- [ ] **Step 5: Measure, gate and commit** `refactor(backend): split verified file reads and source snapshots`.

---

### Task 5: Private stages and project leases (`private_stage.js`, `project_lock.js`)

**Files:** `native/backend/lib/private_stage.js` (`cleanup` line 194), `native/backend/lib/project_lock.js` (`acquireProjectLease` line 355); tests in `private_stage_cleanup.test.js` and `project_lock.test.js`.

- [ ] **Step 1: Pin the uncovered paths and Review Focus 5.**
  - `private_stage.js:273-274`: a mocked `renameExclusive` makes the move, then makes one registered file in the retained folder unreadable (`chmod 000`). Assert today's `reason`, with the error's `retirement`.
  - `private_stage.js:280-281`: `usage(retained)` fails through a counting `lstat` mock. Assert `reason` is "Private work size could not be verified." and `bytes` is `null`.
  - `project_lock.js:457-460`: after acquiring, create the reclamation guard folder (as another process would). `assertOwned()` rejects with `PROJECT_LOCK_LOST` and the guard path.
  - `project_lock.js:479-481`: `release()` where the guard's retirement fails once. Assert today's message both alone and appended to a primary failure.
  - Review Focus 5:
    - two concurrent `release()` calls resolve from one release, and the lock is gone;
    - a `release()` that failed once succeeds when called again;
    - a failed acquisition leaves no unused owner folder and sets `lockPath`.

  Mutation-check one assertion per path.
- [ ] **Step 2: Split `cleanup`** (inside the stage factory, keeping its closure state).
  - `auditFiles(dir, names, messages)` returns a reason or `null`. It is used before and after capture, each time with today's messages.
  - `removeEmptyStage()` returns a result or the reason it couldn't.
  - `retainStage(history)` returns `retained` and keeps today's failure fields.
  - `assertRetained(retained, historyNode)` covers both identity throws.
  - `finished` is set at the same points as today.
- [ ] **Step 3: Split `acquireProjectLease`.**
  - `assertLeaseKind(kind)` covers the kind check.
  - `reclaimStaleOwner(context, local, prepared, lockPath, takeGuard, releaseGuard)` covers the `EEXIST` branch and returns `held`. It reads the owner, takes the guard, re-reads the owner, retires the stale one, publishes, and releases the guard, merging a guard failure into the primary one as today.
  - `retireUnusedOwner(error, prepared, context, held, lockPath)` covers the catch block.
  - The lease object and its closures (`released`, `held`, `releasePromise`) are unchanged.
- [ ] **Step 4: Compare old and new.** Write `$SCRATCH/t5b-compare.mjs`.
  - `cleanup`: sweep three stages (empty, two registered files, plus an unknown file). `perturb` adds a file to the stage.
  - `acquireProjectLease`: sweep four starting states (free, stale owner with a dead process id, live owner, existing guard). Each run acquires, calls `assertOwned()`, then `release()`; `recover` is a fresh acquisition and release.
  - Expected: `0 differences`.
- [ ] **Step 5: Measure, gate and commit** `refactor(backend): split private stage retirement and project lease acquisition`, after the pins commit, `test(backend): pin private stage retirement and project lease release failures`.

---

### Task 6: Project saves (`project_transaction.js`)

**Files:** `native/backend/lib/project_transaction.js` (`journalOf` line 147, `saveProject` line 314); test in `project_transaction.test.js`.

- [ ] **Step 1: Pin `project_transaction.js:155-156`.** A stage whose `journal.json` holds invalid JSON is preserved, and the save reports "The project recovery journal is invalid JSON." Build the stage by interrupting a save with a `rename` mock, then rewrite its journal. Mutation-check it.
- [ ] **Step 2: Split `journalOf`.**
  - `validProjectJournal(journal, context, stage)` is the identity predicate.
  - `checkProjectStage(stage)` checks allowed names and regular files.
  - `checkProjectSnapshots(stage, journal)` checks the retained snapshots.
  - `projectCommit(stage, raw)` checks the marker.
  - `PROJECT_STAGE_NAMES` is a module-level set.
- [ ] **Step 3: Split `saveProject`.**
  - `prepareProjectSave(context, prepared, name, previous, backup, text)` returns `{ next, journal }`.
  - `installProjectSave(context, stage, previous, backup, next, journal, assertOwned)` returns the commit state, with every move, re-read and `assertOwned()` in today's order.
  - `failedProjectSave(error, context, prepared, stage, published, committed, committedRevision, assertOwned)` covers the catch block.
- [ ] **Step 4: Compare old and new.**
  - `journalOf`, exposed by compiling a copy that exports it, seed 5602: 2,000 stages. Each takes a real save's journal and changes one field, name, file or marker, then compares the result or message.
  - `saveProject`: sweep two scenarios, with and without a `.bak`, with `recover` = `recoverProject(file, { assertOwned })`. `perturb` edits the project file.
  - Expected: `0 differences`.
- [ ] **Step 5: Measure, gate and commit** `refactor(backend): split project save journals and installation`.

---

### Task 7: File publication (`file_publication.js`)

**Files:** `native/backend/lib/file_publication.js` (`journalOf` line 133, `publishFiles` line 416); test in `file_publication.test.js`.

- [ ] **Step 1: Pin `file_publication.js:141-142`.** Interrupt a publication after its stage is exposed, then replace the stage's `journal.json` with invalid JSON (mode 0400). `recoverFiles` reports the "publication journal JSON" conflict, and the stage is kept. Mutation-check it.
- [ ] **Step 2: Split `journalOf`.**
  - `validPublicationJournal(journal, c, stage, stageNode)` is the identity predicate.
  - `checkPublicationEntry(c, known, stage, entry, i, contents, names, allowed)` covers the entry check and its retained files.
  - `checkStageFiles(stage, present, allowed)` checks the names present.
  - `publicationCommit(stage, journal, raw)` checks the marker.
- [ ] **Step 3: Split `publishFiles`.**
  - `validPublicationEntries(entries)` is the predicate.
  - `readPublicationRevisions(c, entries)` returns `{ before, sources }`.
  - `preparePublication(c, entries, before, sources, prepared, name, known)` returns `{ records, journal, revision, commitNode }`.
  - `installPublication(c, stage, records, known, exactJournal)` covers the per-entry capture and install.
  - `commitPublication(c, stage, journal, revision, commitNode, known, exactJournal)` covers the marker, retirement and pruning.
  - `failedPublication(c, error, prepared, stage, exposed, committed, result)` covers the catch block.
- [ ] **Step 4: Compare old and new.**
  - `journalOf`, exposed by compiling a copy, seed 5702: 2,000 changed stages, as in Task 6.
  - `publishFiles`: sweep two scenarios (one new file; two entries, one replacing an owned file), with `recover` = `recoverFiles(folder, capabilities)`. `perturb` edits a published target.
  - Expected: `0 differences`.
- [ ] **Step 5: Measure, gate and commit** `refactor(backend): split file publication journals and installation`.

---

### Task 8: Render publication (`render_transaction.js`)

**Files:** `native/backend/lib/render_transaction.js` (`journalOf` line 167, `publishRender` line 426); test in `render_transaction.test.js`.

- [ ] **Step 1: Confirm coverage.** Neither function has uncovered lines. Run the test file on today's code.
- [ ] **Step 2: Split `journalOf`.**
  - `renderEntryNames(i)` returns `{ kind, limit, old, next, install }`.
  - `validRenderEntry(entry, i, targets, names)` is the predicate.
  - `checkRenderRetained(known, stage, entry, names, limit)` checks the retained files.
  - `checkRenderStage(stage, present, allowed)` checks the names present.
  - `renderCommit(stage, journal, raw)` checks the marker.
- [ ] **Step 3: Split `publishRender`.**
  - `validRenderCapabilities(capabilities)` is the predicate.
  - `readRenderRevisions(c, p)` returns `{ sheet, cacheFile, beforeSheet, beforeCache, oldCache, source }` with today's checks.
  - `checkNextCache(p, c, oldCache, logicalSheet, proposed)` checks the next cache.
  - `prepareRender(c, p, prepared, name, known, sources)` returns `{ entries, journal, journalRevision, commitNode, installSheet, installCache, nextCache }`, where `sources` is the object `readRenderRevisions` returned.
  - `installRender(c, p, stage, entries, known, exactJournal)` covers each entry's identity check, capture, re-read and install.
  - `commitRender(c, p, stage, journal, journalRevision, commitNode, known, exactJournal)` covers the ownership inspection, the marker's preparation and move, retirement and pruning, and returns `historyPath`.
  - `failedRender(c, error, prepared, stage, exposed, committed, result)` covers the catch block: it decides whether the stage was exposed, recovers it, sets `recoveryStage`, `renderRestored` or `recoveryRequired`, and returns `failureAt(...)`'s error.
- [ ] **Step 4: Compare old and new.**
  - `journalOf`, seed 5802: 2,000 changed stages.
  - `publishRender`: sweep two scenarios (a first render; a re-render replacing an owned sheet and cache), with `recover` = `recoverRenders(p, capabilities)` (the same publication and capabilities). `perturb` edits the public sheet.
  - Expected: `0 differences`.
- [ ] **Step 5: Measure, gate and commit** `refactor(backend): split render publication journals and installation`.

---

### Task 9: Delivery publication (`delivery_transaction.js`)

**Files:** `native/backend/lib/delivery_transaction.js` (`publishDelivery`'s locked callback, line 744); tests in `delivery_transaction.test.js`.

- [ ] **Step 1: Pin lines 835-838 and 876-877.**
  - An unexpected file in the delivery stage before publishing gives today's recovery error, and no target changes.
  - A failed journal save (an `open` mock on `journal.json.new`) gives today's recovery error with its stage.

  Mutation-check both.
- [ ] **Step 2: Split the callback.**
  - `collectDeliveryEntries(context, stage, files, owned)` returns `entries` with every per-file check and message.
  - `checkCurrentCache(context, cache, entries)` returns `beforeCache`.
  - `buildNextCache(cache, makeCache, records, albumFile, context)` returns `next`.
  - `writeNextCache(stage, next, files)` covers the stage-contents check and the `wx` write.
  - `recheckTargets(entries)` re-reads the old targets.
  - `installDelivery(context, stage, entries, journal, isCancelled, validateSnapshot)` covers the moves and the commit.
  - The callback keeps the recovery and cleanup error handling, and its return.
- [ ] **Step 3: Compare old and new.** Sweep three scenarios with `recover` = `recoverDeliveries(paths, { albumFile })`, using the scenario's paths:
  - a first export;
  - a re-export replacing owned files;
  - an asynchronous `makeCache`.

  `perturb` edits a delivered file. Expected: `0 differences`.
- [ ] **Step 4: Measure, gate and commit** `refactor(backend): split delivery publication`, after the pins commit, `test(backend): pin delivery publication's stage and journal failures`.

---

### Task 10: Re-score and commit this plan

- [ ] **Step 1: Measure.** `node $SCRATCH/complexity.mjs | /usr/bin/grep -cE 'labnaming|publication_broker|verified_file|lib/cache|private_stage|project_lock|project_transaction|file_publication|render_transaction|delivery_transaction'`. Expected: `0`. Record the new total; expected `47`.
- [ ] **Step 2: Status page.** In `QUALITY_IMPROVEMENT_LOG.md`:
  - Add a phase 4b-2 paragraph: the functions simplified, the sweep's call and run counts, the comparisons, the pins and the coverage changes.
  - Add the phase table row `| 4b-2. Verified reads, publication and locking | Done <date> |`, and update the "Not started" row.
  - Add the open item for the shared transaction skeleton (Ruling 5).
  - Keep Readability at 7 unless the measurements justify more.

  Run the gate, then commit as `docs: record phase 4b-2`.
- [ ] **Step 3: Commit this plan.**

```bash
git add docs/superpowers/plans/2026-10-30-phase-4b2-publication-locking.md
git commit -q -m "docs: add the phase 4b-2 plan" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Then one fresh reviewer checks the whole 4b-2 range, and Critical and Important findings get one fix pass.
