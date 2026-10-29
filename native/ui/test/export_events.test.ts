import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { ExportFinished, ExportStarted } from '../../contracts/types'

async function workflow() {
  const bundle = await build({
    stdin: {
      contents:
        "export { exportJob } from './src/exporting'; export { toasts } from './src/state'; export { jobIssues } from './src/job_report'",
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  const source = bundle.outputFiles[0]?.text
  assert.ok(source)
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    console,
    TextEncoder,
    window: { setTimeout: () => 0, clearTimeout: () => {} },
    setTimeout: () => 0,
    clearTimeout: () => {},
  })
  vm.runInContext(source, context)
  return {
    send(event: string, data: unknown) {
      vm.runInContext(`window.__asEvent(${JSON.stringify({ event, data })})`, context)
    },
    state() {
      const encoded = vm.runInContext(
        'JSON.stringify({job:module.exports.exportJob.value,toasts:module.exports.toasts.value,issues:module.exports.jobIssues(module.exports.exportJob.value?.finished ?? null)})',
        context,
      )
      assert.equal(typeof encoded, 'string')
      return JSON.parse(encoded)
    },
  }
}
const paths = {
  cache: '/album/exports/.album-studio/export-cache.json',
  sheets: '/album/exports',
  high: '/album/JPEG-High-Res',
  low: '/album/JPEG-Low-Res',
  pdf: '/album/Album - Low Res.pdf',
}
const started: ExportStarted = { jobId: 'job-1', total: 1, missingSheets: [], paths }
const finished: ExportFinished = {
  ...started,
  done: 1,
  skipped: 0,
  failed: 0,
  cancelled: false,
  ms: 100,
  results: [{ n: 1, state: 'done' }],
  pdf: null,
  error: 'lease release failed',
  finishingError: 'lease release failed',
  warnings: ['lease release failed'],
}
test('validated export finishing warnings stay stored beside delivered results and surface as issues', async () => {
  const app = await workflow()
  app.send('export.started', started)
  app.send('export.finished', finished)
  const state = app.state()
  assert.equal(state.job.finished.done, 1)
  assert.equal(state.job.finished.failed, 0)
  assert.equal(state.job.finished.error, 'lease release failed')
  assert.equal(state.job.finished.finishingError, 'lease release failed')
  assert.deepEqual(state.job.finished.warnings, ['lease release failed'])
  assert.deepEqual(state.issues, ['lease release failed'])
  assert.equal(state.toasts.at(-1).kind, 'error')
})
test('job-level delivery errors remain visible without inventing a spread number', async () => {
  const app = await workflow()
  app.send('export.started', started)
  app.send('export.progress', {
    jobId: started.jobId,
    total: 1,
    n: null,
    state: 'failed',
    error: 'publication refused',
  })
  const state = app.state()
  assert.deepEqual(state.job.results, [])
  assert.deepEqual(state.job.issues, ['publication refused'])
})
