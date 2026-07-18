#!/usr/bin/env node
// Unwrap CEP-panel ExtendScript bundles ($._ext_NAME = { run: function() { ... } })
// into standalone .jsx scripts runnable directly in Photoshop.
//
// Usage: node unwrap.js <srcDir> <outDir>

const fs = require('fs');
const path = require('path');

const [, , srcDir, outDir] = process.argv;
if (!srcDir || !outDir) {
  console.error('usage: node unwrap.js <srcDir> <outDir>');
  process.exit(1);
}

const MARKER = /^\s*\$\._ext_([A-Z0-9_]+)\s*=\s*\{\s*$/;

function extractModules(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  lines.forEach((l, i) => {
    const m = l.match(MARKER);
    if (m) starts.push({ line: i, key: m[1] });
  });
  const modules = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s].line;
    const to = s + 1 < starts.length ? starts[s + 1].line : lines.length;
    let body = lines.slice(from, to);

    // Drop the opening "$._ext_X={" and the "run : function() {" line.
    body = body.slice(1);
    const runIdx = body.findIndex((l) => /run\s*:\s*function\s*\(\)\s*\{/.test(l));
    if (runIdx === -1) continue; // malformed block, skip
    body = body.slice(runIdx + 1);

    // Drop the trailing "}," + "};" that close run() and the object literal.
    // They may be followed by banner comments belonging to the next module,
    // so cut at the last "}," line whose next non-blank line is "};".
    let cut = -1;
    for (let i = body.length - 1; i >= 0; i--) {
      if (/^\s*\},\s*$/.test(body[i])) {
        let j = i + 1;
        while (j < body.length && body[j].trim() === '') j++;
        if (j < body.length && /^\s*\};\s*$/.test(body[j])) { cut = i; break; }
      }
    }
    if (cut !== -1) {
      body = body.slice(0, cut);
    } else {
      // Fallback: walk back over blank lines and closers.
      while (body.length) {
        const last = body[body.length - 1].trim();
        if (last === '' || last === '};' || last === '},' || last === '}') {
          body.pop();
          if (last === '},') break;
        } else break;
      }
    }

    modules.push({ key: starts[s].key, body });
  }
  return modules;
}

// Strip CEP-only persistence code: the Persistent() function definition and calls.
function stripCep(lines) {
  const out = [];
  let skipDepth = 0;
  for (const l of lines) {
    if (skipDepth > 0) {
      skipDepth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
      if (skipDepth <= 0) skipDepth = 0;
      continue;
    }
    if (/function\s+Persistent\s*\(/.test(l)) {
      skipDepth = (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
      if (skipDepth <= 0) skipDepth = 1;
      continue;
    }
    if (/^\s*Persistent\s*\(\s*(true|false)\s*\)\s*;?\s*(\/\/.*)?$/.test(l)) continue;
    if (/csInterface|CSEvent/.test(l)) continue;
    out.push(l);
  }
  return out;
}

// Prefer the inner "// Name.jsx" header comment for the output filename.
function moduleName(mod) {
  for (const l of mod.body.slice(0, 12)) {
    const m = l.match(/^\/\/\s*([A-Za-z0-9 _-]+)\.jsx\s*$/);
    if (m) return m[1].replace(/\s+/g, '');
  }
  // Fallback: TitleCase the ALLCAPS key.
  return mod.key.charAt(0) + mod.key.slice(1).toLowerCase();
}

fs.mkdirSync(outDir, { recursive: true });
const manifest = [];
const seen = new Map(); // outputName -> content hash, for dedupe

for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.jsx')).sort()) {
  const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
  const mods = extractModules(text);
  if (!mods.length) {
    console.warn(`WARN: no modules found in ${file}`);
    continue;
  }
  const groupDir = path.basename(file, '.jsx');
  for (const mod of mods) {
    if (mod.key === 'PERSISTENT') continue; // CEP panel keep-alive, meaningless standalone
    const cleaned = stripCep(mod.body);
    const content = cleaned.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

    // Vestigial modules (CEP persistence only): no action call, no DOM access.
    // Ignore the cTID/sTID helper definitions when testing for real code.
    const meat = content
      .split('\n')
      .filter((l) => !/^\s*[cs]TID\s*=\s*function/.test(l))
      .join('\n');
    if (!/executeAction|app\./.test(meat)) {
      console.log(`skip: ${file} ${mod.key} has no executable code after CEP strip`);
      continue;
    }

    let name = moduleName(mod);
    const hash = require('crypto').createHash('sha1').update(content).digest('hex');
    if (seen.has(name)) {
      if (seen.get(name) === hash) {
        console.log(`dedupe: ${file} ${mod.key} identical to existing ${name}.jsx, skipped`);
        continue;
      }
      let n = 2;
      while (seen.has(`${name}-${n}`)) n++;
      name = `${name}-${n}`;
    }
    seen.set(name, hash);

    const dir = path.join(outDir, groupDir);
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.join(groupDir, `${name}.jsx`);
    fs.writeFileSync(path.join(outDir, rel), content);
    manifest.push({ source: file, module: `$._ext_${mod.key}`, script: rel });
  }
}

fs.writeFileSync(
  path.join(outDir, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);
console.log(`wrote ${manifest.length} scripts + manifest.json to ${outDir}`);
