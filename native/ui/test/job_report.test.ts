import test from 'node:test'
import assert from 'node:assert/strict'
import { jobIssues, mayOpenRenderedSheet } from '../src/job_report.ts'
const report = { done: 2, skipped: 0, failed: 0, cancelled: false, ms: 100 }
test('finishing errors remain visible alongside successful sheets and are deduplicated', () => {
  assert.deepEqual(jobIssues({ ...report, error: 'engine close failed lease release failed', finishingError: 'engine close failed lease release failed', warnings: ['engine close failed', 'lease release failed'] }), ['engine close failed lease release failed'])
  assert.deepEqual(jobIssues({ ...report, error: 'engine close failed', finishingError: 'engine close failed', warnings: ['engine close failed'] }), ['engine close failed'])
  assert.deepEqual(jobIssues({ ...report, error: 'job failed' }), ['job failed'])
  assert.deepEqual(jobIssues(report), [])
  assert.deepEqual(jobIssues(null), [])
})
test('only completed or preserved sheets can open after a render, never a cancelled or failed result', () => {
  for (const state of ['done', 'skipped']) assert.equal(mayOpenRenderedSheet([{ n: 1, state }], 1, false), true)
  for (const state of ['cancelled', 'failed', 'building']) assert.equal(mayOpenRenderedSheet([{ n: 1, state }], 1, false), false)
  assert.equal(mayOpenRenderedSheet([{ n: 1, state: 'done' }], 1, true), false)
  assert.equal(mayOpenRenderedSheet([], 1, false), false)
})
