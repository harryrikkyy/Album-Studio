// Disposable native integration fixture. Inputs are exclusively test-created paths.
'use strict'
const readline = require('node:readline')
const { acquireProjectLease } = require('../../lib/project_lock')
const { acquireOutputLease } = require('../../lib/output_lock')
async function main() {
  const [file, output] = process.argv.slice(2)
  const project = await acquireProjectLease(file, { kind: 'native-save-regression' })
  let outputs
  try {
    outputs = await acquireOutputLease(output, { kind: 'native-save-regression' })
    await project.assertOwned(); await outputs.assertOwned()
    process.stdout.write(JSON.stringify({ ready: true }) + '\n')
    const input = readline.createInterface({ input: process.stdin })
    await new Promise(resolve => { input.once('line', resolve); input.once('close', resolve) })
    input.close()
    await project.assertOwned(); await outputs.assertOwned()
  } finally {
    if (outputs) await outputs.release()
    await project.release()
  }
}
main().catch(error => { process.stdout.write(JSON.stringify({ ready: false, code: error.code, error: error.message }) + '\n'); process.exitCode = 1 })
