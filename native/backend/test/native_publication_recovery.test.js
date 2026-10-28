'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { tmpdir } = require('./fixtures')
const { withProjectLease } = require('../lib/project')
const { acquireOutputLease, withProjectOutputs } = require('../lib/output_lock')
const { readRenderCache } = require('../lib/sheets')
const modulePath = require.resolve('../lib/file_publication'), namespaces = require.resolve('../lib/namespace_lock'), exclusive = require.resolve('../lib/exclusive_rename')
function fixture(t, canonical) {
  const root = tmpdir(), album = path.join(root, 'Album'), output = path.join(root, 'Sheets')
  fs.mkdirSync(album); fs.mkdirSync(output)
  fs.writeFileSync(path.join(album, 'project.json'), JSON.stringify({ version: 1, workspace: { outputToken: output, imageTokens: [], templateTokens: [] }, albumPages: {}, totalActivePages: 0 }))
  const folder = canonical ? path.join(output, '.album-studio/sheets') : output
  fs.mkdirSync(folder, { recursive: true })
  const target = path.join(folder, canonical ? 'spread_fixture.psd' : 'Page_001.psd'), source = path.join(root, 'encoded.psd')
  const before = Buffer.from('existing manually edited sheet'), after = Buffer.from('new native encoded revision')
  fs.writeFileSync(target, before); fs.writeFileSync(source, after)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, album, output, folder, target, source, before, after }
}
async function interrupt(f, point) {
  const output = await acquireOutputLease(f.output); await output.release()
  const args = { target: f.target, source: f.source, point, digest: crypto.createHash('sha256').update(f.after).digest('hex') }
  const code = `
    const path=require('path'), ex=require(${JSON.stringify(exclusive)}), rename=ex.renameExclusive, p=JSON.parse(process.argv[1]);
    ex.renameExclusive=async(from,to)=>{const r=await rename(from,to);if(path.basename(to)===(p.point==='capture'?'captured-0':'commit.json'))process.kill(process.pid,'SIGKILL');return r};
    (async()=>{const files=require(${JSON.stringify(modulePath)}),lease=await require(${JSON.stringify(namespaces)}).acquirePublicationDirectories([p.target]);
      await files.publishFiles({folder:path.dirname(p.target),entries:[{name:path.basename(p.target),source:p.source,sourceDigest:p.digest,before:await files.fingerprintFile(p.target)}]},lease);
    })().then(()=>process.exit(2),e=>{console.error(e);process.exit(3)});
  `
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, JSON.stringify(args)], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native interruption fixture timed out.')) }, 15000)
    child.once('error', e => { clearTimeout(deadline); reject(e) })
    child.once('exit', (code, signal) => { clearTimeout(deadline); try { assert.equal(signal, 'SIGKILL', stderr); resolve() } catch (e) { reject(e) } })
  })
}
for (const canonical of [false, true]) for (const point of ['capture', 'commit']) test(`output admission recovers a ${canonical ? 'canonical' : 'numbered'} native save killed at ${point}`, async t => {
  const f = fixture(t, canonical)
  await interrupt(f, point)
  await assert.rejects(readRenderCache(f.output), { code: 'PUBLICATION_RECOVERY_REQUIRED' })
  const bytes = await withProjectLease(f.album, ({ lease }) => withProjectOutputs(lease, async () => {
    await readRenderCache(f.output)
    return fs.readFileSync(f.target)
  }))
  assert.deepEqual(bytes, point === 'commit' ? f.after : f.before)
  const metadata = path.join(f.folder, '.album-studio-publications'), names = fs.readdirSync(metadata)
  assert.equal(names.some(n => /^files-/.test(n)), false)
  const history = path.join(metadata, 'history'), stage = path.join(history, fs.readdirSync(history)[0])
  assert.deepEqual(fs.readFileSync(path.join(stage, 'old-0')), f.before)
  assert.deepEqual(fs.readFileSync(path.join(stage, 'next-0')), f.after)
})
test('native save admission refuses an interrupted render before trusting its sheet', async t => {
  const f = fixture(t, true), render = require.resolve('../lib/render_transaction'), locks = require.resolve('../lib/project_lock'), outputs = require.resolve('../lib/output_lock')
  const albumFile = path.join(f.album, 'project.json'), spreadId = 'spread_fixture'
  const p = { albumFile, outputFolder: f.output, spreadId, source: f.source, sourceDigest: crypto.createHash('sha256').update(f.after).digest('hex'), cacheBefore: null, expectedProjectRevision: crypto.createHash('sha256').update(fs.readFileSync(albumFile)).digest('hex'), cacheNext: { version: 2, albumFile, spreads: { [spreadId]: { path: f.target, outputFolder: f.output, hash: 'fixture' } } } }
  const code = `const path=require('path'),ex=require(${JSON.stringify(exclusive)}),rename=ex.renameExclusive,p=JSON.parse(process.argv[1]);
    ex.renameExclusive=async(a,b)=>{const r=await rename(a,b);if(path.basename(b).startsWith('render-'))process.kill(process.pid,'SIGKILL');return r};
    (async()=>{const project=await require(${JSON.stringify(locks)}).acquireProjectLease(p.albumFile),output=await require(${JSON.stringify(outputs)}).acquireOutputLease(p.outputFolder),renderer=require(${JSON.stringify(render)});
      p.sheetBefore=await renderer.fingerprintRenderFile(${JSON.stringify(f.target)});
      await renderer.publishRender(p,{assertOwned:async()=>{await project.assertOwned();await output.assertOwned()},assertOutput:x=>output.assertFor(x)});
    })().then(()=>process.exit(2),e=>{console.error(e);process.exit(3)});`
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, JSON.stringify(p)], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''; child.stderr.on('data', b => { stderr += b })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Interrupted render fixture timed out.')) }, 15000)
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('exit', (_code, signal) => { clearTimeout(timer); try { assert.equal(signal, 'SIGKILL', stderr); resolve() } catch (e) { reject(e) } })
  })
  const header = Buffer.from(JSON.stringify({ version: 1, target: f.target, expected: { mode: 'overwrite' } })), prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length)
  const first = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../server.js'), '--native-publication'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b }); child.stderr.on('data', b => { stderr += b }); child.stdin.on('error', () => {})
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native admission fixture timed out.')) }, 15000)
    child.once('error', e => { clearTimeout(timer); reject(e) })
    child.once('exit', () => { clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n').filter(Boolean)[0] || stderr)) } catch (e) { reject(e) } })
    child.stdin.end(Buffer.concat([prefix, header]))
  })
  assert.equal(first.state, 'failed'); assert.equal(first.error.code, 'RENDER_RECOVERY_REQUIRED')
  assert.deepEqual(fs.readFileSync(f.target), f.before)
  assert.equal(fs.readdirSync(path.join(f.output, '.album-studio')).filter(n => /^render-/.test(n)).length, 1)
})
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
test('a brand-new album with no output folder yet passes the settled checks', async t => {
  const { assertFilesSettled } = require('../lib/file_publication'), { assertRendersSettled } = require('../lib/render_transaction')
  const root = tmpdir(); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const missing = path.join(root, 'Not yet created')
  await assertFilesSettled(missing)
  await assertRendersSettled(missing)
  assert.equal(fs.existsSync(missing), false)
})
test("Finder's .DS_Store and AppleDouble files in publication records block neither reads nor album operations", async t => {
  const f = fixture(t, false), metadata = path.join(f.output, '.album-studio-publications')
  fs.mkdirSync(metadata); fs.writeFileSync(path.join(metadata, '.DS_Store'), 'finder'); fs.writeFileSync(path.join(metadata, '._history'), 'appledouble')
  await readRenderCache(f.output)
  await withProjectLease(f.album, ({ lease }) => withProjectOutputs(lease, async () => readRenderCache(f.output)))
})
test('an entry Album Studio did not create in its publication records is named plainly', async t => {
  const f = fixture(t, false), metadata = path.join(f.output, '.album-studio-publications')
  fs.mkdirSync(metadata); fs.writeFileSync(path.join(metadata, 'notes.txt'), 'mine')
  const plain = error => error.code === 'PUBLICATION_CONFLICT' && error.message.includes('.album-studio-publications')
    && error.message.includes('"notes.txt"') && !/changed during/.test(error.message)
  await assert.rejects(readRenderCache(f.output), plain)
  await assert.rejects(withProjectLease(f.album, ({ lease }) => withProjectOutputs(lease, async () => readRenderCache(f.output))), plain)
})
