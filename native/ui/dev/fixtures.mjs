// Isolated UI acceptance preview. Synthetic data only: no helper, credentials, shell, or disk RPCs.
// Run from any directory: node native/ui/dev/fixtures.mjs
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDefinition, validateReply } from '../../contracts/runtime.js'

const ui = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const examples = JSON.parse(readFileSync(resolve(ui, '../contracts/examples.json'), 'utf8')).methods
const buildOptions = {
  entryPoints: [resolve(ui, 'src/main.tsx')],
  bundle: true,
  write: false,
  outdir: 'dist',
  format: 'iife',
  target: 'safari15',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: { 'process.env.NODE_ENV': '"development"' },
}
const assets = new Map()
async function rebuild() {
  const bundle = await build(buildOptions)
  for (const file of bundle.outputFiles) assets.set(file.path.split('/').pop(), file.text)
}
await rebuild()

function fixture(count) {
  const album = structuredClone(examples['album.open'][1])
  album.name = 'Maya & Arjun — Wedding'
  album.photoFolders = [{ path: '/shoot', name: 'Wedding day', exists: true, hasThumbs: true, count }]
  album.photos = Object.fromEntries(
    Array.from({ length: count }, (_, i) => {
      const id = `photo-${i + 1}`
      return [
        id,
        {
          id,
          base: `Wedding_${String(i + 1).padStart(4, '0')}.jpg`,
          folder: '/shoot',
          thumb: `/sample/${i % 6}.svg`,
          original: `/shoot/${id}.jpg`,
          width: 1800,
          height: 1200,
          orient: 'h',
          usedOn: i < 3 ? [i + 1] : [],
          rotation: 0,
        },
      ]
    }),
  )
  album.pool = Object.keys(album.photos)
  album.spreads = Array.from({ length: 3 }, (_, i) => ({
    id: `spread_fixture_${i}`,
    n: i + 1,
    photoIds: [`photo-${i + 1}`],
    missingPhotos: 0,
    template: { id: 'tpl-one', name: '1h0v.psd', h: 1, v: 0, file: '/templates/1h0v.psd', preview: '/sample/0.svg' },
    proof: '/sample/0.svg',
    sheet: null,
    edited: false,
  }))
  album.stats = { spreads: 3, photos: count, used: 3, planned: 3 }
  return validateDefinition('Album', album)
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (type, body) => {
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(body)
  }
  if (url.pathname === '/') {
    await rebuild()
    const count = url.searchParams.get('large') === '1' ? 6000 : 36
    const scenario = url.searchParams.get('scenario') || 'normal'
    const album = fixture(count)
    const storage = structuredClone(examples['storage.usage'][1])
    if (scenario === 'retention-limit') storage.retention.stages = storage.retention.limits.maxHistoryStages
    if (scenario === 'retention-bytes') storage.retention.bytes = storage.retention.limits.maxHistoryBytes
    if (scenario === 'retention-empty') {
      storage.retention.stages = 0
      storage.retention.bytes = 0
    }
    if (scenario === 'retention-zero-budget') {
      storage.retention.stages = 0
      storage.retention.bytes = 0
      storage.retention.limits.maxHistoryStages = 0
      storage.retention.limits.maxHistoryBytes = 0
    }
    if (scenario === 'retention-unavailable') delete storage.retention
    validateDefinition('StorageUsage', storage)
    if (scenario === 'missing-thumbs')
      for (const photo of Object.values(album.photos)) photo.thumb = '/sample/missing.svg'
    if (scenario === 'empty-plan') {
      album.spreads = []
      album.stats.spreads = 0
      album.stats.planned = 0
      album.stats.used = 0
      for (const p of Object.values(album.photos)) p.usedOn = []
    }
    const data = { album, examples, scenario, storage }
    const shim = `
      const fixture = ${JSON.stringify(data).replaceAll('<', '\\u003c')};
      let storageRequests = 0;
      window.__asFileBase = '/fixture';
      window.ipc = { postMessage(text) {
        const {id,method,params} = JSON.parse(text);
        let result, error;
        if (method === 'account.status') result = {state:'allowed',configured:true,bypass:true,daysLeft:999};
        else if (method === 'album.open') result = fixture.album;
        else if (method === 'album.recent') {
          if (fixture.scenario === 'offline') error = 'The album drive is disconnected. Reconnect it and try Refresh.';
          else result = fixture.scenario === 'empty' ? [] : [{...fixture.examples[method][1][0],name:fixture.album.name,photos:fixture.album.stats.photos,spreads:3}];
        }
        else if (method === 'storage.usage' && fixture.scenario === 'storage-error' && storageRequests++ === 0) error = 'Storage could not be measured. Reconnect the drive and try again.';
        else if (method === 'storage.usage') {
          result = structuredClone(fixture.storage);
          if (fixture.scenario === 'retention-refresh' && storageRequests++ > 0) result.retention.stages = result.retention.limits.maxHistoryStages;
        }
        else if (method === 'render.plan') result = {...fixture.examples[method][1],spreads:fixture.album.spreads.map(s=>({n:s.n,id:s.id,state:'missing'}))};
        else if (method === 'spread.layout') result = {...fixture.examples[method][1], n:params.n, frames:[]};
        else if (['library.collections','library.templates','folders.inspect','templates.inspect','templates.list','storage.usage','export.plan'].includes(method)) result = fixture.examples[method]?.[1];
        else if (method === 'shell.log') { console.info('[fixture]',params.kind,params.message); result = null; }
        else error = 'This synthetic UI preview cannot run '+method+'. No files were changed.';
        setTimeout(()=>window.__asReply?.({id,ok:!error,...(error?{error,code:'FIXTURE_ONLY'}:{result})}),80);
      }};
    `
    const html = readFileSync(resolve(ui, 'index.html'), 'utf8')
      .replace("script-src 'self' as:", "script-src 'self' as: 'unsafe-inline'")
      .replace(
        '<div id="app">',
        '<aside style="height:24px;background:#18364a;color:#fff;text-align:center;font:12px/24px system-ui">UI test fixture · Synthetic album · No files are written</aside><div id="app" style="height:calc(100% - 24px)">',
      )
      .replace('<script src="dist/app.js">', `<script>${shim}</script><script src="dist/main.js">`)
      .replace('dist/app.css', 'dist/main.css')
    return send('text/html; charset=utf-8', html)
  }
  if (/^\/dist\/main\.(js|css)$/.test(url.pathname)) {
    const name = url.pathname.split('/').pop()
    return send(name.endsWith('.js') ? 'text/javascript' : 'text/css', assets.get(name))
  }
  if (/^\/fixture\/sample\/[0-5]\.svg$/.test(url.pathname)) {
    return send(
      'image/svg+xml',
      '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400"><rect width="600" height="400" fill="#92715d"/><circle cx="180" cy="160" r="90" fill="#d8bc95"/><circle cx="400" cy="190" r="130" fill="#6c7d68"/><path d="M0 400L300 210 600 400" fill="#4b5751"/></svg>',
    )
  }
  res.writeHead(404).end()
}).listen(5191, '127.0.0.1', () =>
  console.log(
    'Synthetic UI preview: http://127.0.0.1:5191/?open=/album (large=1; scenario=empty|offline|storage-error)',
  ),
)

// Check the ordinary fixture through the same wire validator used in production.
validateReply('album.open', { id: 1, ok: true, result: fixture(36) })
