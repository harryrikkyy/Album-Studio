'use strict'
// Preparation/namespace diagnostic only. Does not render, export or replace public artifacts.
const fs = require('fs')
const path = require('path')
const assert = require('assert/strict')
const { spawn } = require('child_process')
const repo = process.cwd()
const { deliverPaths } = require(path.join(repo, 'native/backend/lib/deliver'))
const root = fs.mkdtempSync(path.join(repo, 'bench/fixture/shared-output-diagnostic-'))
const held = []
async function childLease(album, kind) {
  const source = `const jobs=require(${JSON.stringify(path.join(repo, 'native/backend/lib/jobs'))});let lease;const timer=setTimeout(()=>process.exit(91),15000);process.on('message',async m=>{if(m==='release'){try{await jobs.releaseJob(lease);clearTimeout(timer);process.disconnect()}catch(e){console.error(e.stack);process.exit(92)}}});jobs.reserveJob(${JSON.stringify(kind)},${JSON.stringify(album)}).then(l=>{lease=l;process.send({pid:process.pid,file:l.file,lockPath:l.project.lockPath})},e=>{console.error(e.stack);process.exit(93)});`
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  child.stderr.on('data', b => { stderr += b })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  held.push({ child, exited })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Diagnostic owner did not become ready')), 6000)
    child.once('message', value => { clearTimeout(timer); resolve(value) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', () => { clearTimeout(timer); reject(Error(stderr || 'Owner exited before ready')) })
  })
}
;(async () => {
  const output = path.join(root, 'shared', 'sheets')
  fs.mkdirSync(output, { recursive: true })
  const projects = ['A', 'B'].map(name => {
    const folder = path.join(root, name)
    fs.mkdirSync(folder)
    fs.writeFileSync(path.join(folder, 'project.json'), JSON.stringify({ version: 1, workspace: { outputToken: output }, albumPages: {}, totalActivePages: 1 }))
    return folder
  })
  const a = await childLease(projects[0], 'render'), b = await childLease(projects[1], 'export')
  assert.notEqual(a.pid, b.pid)
  const paths = projects.map(folder => deliverPaths({ name: path.basename(folder) }, output))
  assert.equal(paths[0].cache, paths[1].cache)
  assert.equal(paths[0].high, paths[1].high)
  const siblingPaths = ['A', 'B'].map(name => deliverPaths({ name }, path.join(root, 'siblings', name)))
  assert.equal(siblingPaths[0].high, siblingPaths[1].high)
  const result = { root, concurrentIndependentJobReservations: [a, b], sharedOutput: output, paths, siblingOutputPaths: siblingPaths, conclusion: 'Project locks do not reserve shared output/cache or numbered JPEG namespaces. This confirms concurrent preparation and colliding destinations, not successful overwriting: no artifact publication was attempted.' }
  fs.writeFileSync(path.join(repo, 'docs/quality/2026-10-14-iteration-4/shared-output-diagnostic.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
})().catch(error => { console.error(error.stack); process.exitCode = 1 }).finally(async () => {
  for (const { child } of held) if (child.connected) child.send('release')
  for (const { child, exited } of held) {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    const result = await exited
    clearTimeout(timer)
    if (result.code !== 0) { console.error('Diagnostic release failed', result); process.exitCode = 1 }
  }
})
