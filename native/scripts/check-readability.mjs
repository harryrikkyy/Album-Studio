#!/usr/bin/env node
// Readability ratchet. Counts, per file, the lines over 160 characters and the functions above
// cyclomatic complexity 20, and fails when any file has more than readability-baseline.json
// records. The baseline is existing debt: it may only shrink. After a cleanup, record the new
// counts with `node native/scripts/check-readability.mjs --update`.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BASELINE = path.join(ROOT, 'native/scripts/readability-baseline.json')
const FILES = ['src/**/*.js', 'test/**/*.js', 'native/backend/**/*.js', 'native/contracts/**/*.js']
const RULES = { 'max-len': ['warn', { code: 160 }], complexity: ['warn', 20] }

const eslint = new ESLint({ cwd: ROOT, overrideConfig: { rules: RULES } })
const counts = {}
for (const result of await eslint.lintFiles(FILES)) {
  const file = path.relative(ROOT, result.filePath).split(path.sep).join('/')
  for (const { ruleId } of result.messages) {
    if (!(ruleId in RULES)) continue
    counts[file] ??= {}
    counts[file][ruleId] = (counts[file][ruleId] || 0) + 1
  }
}
const sorted = Object.fromEntries(Object.keys(counts).sort().map(file => [file, counts[file]]))
if (process.argv.includes('--update')) {
  fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n')
  console.log(`readability: recorded ${Object.keys(sorted).length} files with existing findings`)
} else {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
  const worse = [], better = []
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(sorted)])) {
    for (const rule of Object.keys(RULES)) {
      const now = sorted[file]?.[rule] || 0, was = baseline[file]?.[rule] || 0
      if (now > was) worse.push(`${file}: ${now} ${rule} findings, ${was} recorded`)
      else if (now < was) better.push(file)
    }
  }
  if (worse.length) {
    console.error(`readability: new long lines or complex functions. Split them; the recorded debt may only shrink.\n${worse.join('\n')}`)
    process.exitCode = 1
  } else {
    const note = better.length ? ` ${new Set(better).size} files improved: record them with --update.` : ''
    console.log(`readability: ok, no file exceeds its recorded findings.${note}`)
  }
}
