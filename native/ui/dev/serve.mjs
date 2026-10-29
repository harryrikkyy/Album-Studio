// dev/serve.mjs — the interface in an ordinary browser, for fast design and testing work.
//
// Serves native/ui on http://127.0.0.1:5179 and stands in for the native shell: interface calls
// go to the real background helper (native/backend/server.js, started here), its events stream
// back over Server-Sent Events, and local images are served from /file/<absolute path> (images
// only, as the shell's as://file does). Shell-only calls (window, editor, folder picker) answer
// with a short explanation instead.
//
//   node dev/serve.mjs            then open http://127.0.0.1:5179/?open=<album folder>
//
// Listens on the loopback interface only.

import { spawn } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BACKEND = resolve(UI, '../backend/server.js')
const PORT = Number(process.env.PORT) || 5179

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
}
const IMAGE = /\.(jpe?g|png|webp|gif|tiff?)$/i

// ── the helper ───────────────────────────────────────────────────────────────

const helper = spawn(process.execPath, [BACKEND], { stdio: ['pipe', 'pipe', 'inherit'] })
const waiting = new Map() // id → response
const streams = new Set() // open SSE responses
let seq = 1

createInterface({ input: helper.stdout }).on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.event) {
    const text = `data: ${JSON.stringify({ event: msg.event, data: msg.data })}\n\n`
    for (const s of streams) s.write(text)
    return
  }
  const w = waiting.get(msg.id)
  if (!w) return
  waiting.delete(msg.id)
  w.res.writeHead(200, { 'content-type': 'application/json' })
  w.res.end(JSON.stringify({ ...msg, id: w.pageId }))
})
helper.on('exit', (code) => {
  console.error(`helper exited (${code}); restart dev/serve.mjs`)
  process.exit(1)
})

const SHELL_ONLY = {
  'shell.ping': () => ({ pong: true, dev: true }),
  'shell.info': () => ({ dev: true }),
  'shell.log': (p) => {
    console.log('[ui]', p.level, p.kind ?? '', p.message ?? '')
    return null
  },
  'shell.dragWindow': () => null,
  'shell.zoomWindow': () => null,
}

function rpc(req, res) {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      res.writeHead(400).end()
      return
    }
    const reply = (r) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: msg.id, ...r }))
    }
    if (SHELL_ONLY[msg.method]) return reply({ ok: true, result: SHELL_ONLY[msg.method](msg.params || {}) })
    if (/^(shell|editor|dialog)\./.test(msg.method))
      return reply({ ok: false, error: `${msg.method} needs the Album Studio app (this is the browser preview).` })
    const id = seq++
    waiting.set(id, { res, pageId: msg.id })
    helper.stdin.write(JSON.stringify({ id, method: msg.method, params: msg.params || {} }) + '\n')
  })
}

// ── pages and files ──────────────────────────────────────────────────────────

const SHIM = `
window.__asFileBase = '/file'
window.ipc = {
  postMessage(text) {
    fetch('/rpc', { method: 'POST', body: text })
      .then((r) => r.json())
      .then((reply) => window.__asReply && window.__asReply(reply))
      .catch((e) => { const m = JSON.parse(text); window.__asReply && window.__asReply({ id: m.id, ok: false, error: String(e) }) })
  },
}
new EventSource('/events').onmessage = (e) => window.__asEvent && window.__asEvent(JSON.parse(e.data))
`

function page(res) {
  const html = readFileSync(join(UI, 'index.html'), 'utf8')
    .replace("connect-src 'none'", "connect-src 'self'")
    .replace("script-src 'self' as:", "script-src 'self' as: 'unsafe-inline'")
    .replace('<script src="dist/app.js"></script>', `<script>${SHIM}</script>\n<script src="dist/app.js"></script>`)
  res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' })
  res.end(html)
}

function send(res, file, cache) {
  const st = statSync(file, { throwIfNoEntry: false })
  if (!st || !st.isFile()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': cache,
  })
  createReadStream(file).pipe(res)
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const path = decodeURIComponent(url.pathname)
  if (req.method === 'POST' && path === '/rpc') return rpc(req, res)
  if (path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(': ok\n\n')
    streams.add(res)
    req.on('close', () => streams.delete(res))
    return
  }
  if (path === '/' || path === '/index.html') return page(res)
  if (path.startsWith('/file/')) {
    const file = normalize(path.slice('/file'.length))
    if (!IMAGE.test(file) || !existsSync(file)) {
      res.writeHead(404).end()
      return
    }
    return send(res, file, 'no-cache')
  }
  const file = normalize(join(UI, path))
  if (!file.startsWith(UI + '/')) {
    res.writeHead(403).end()
    return
  }
  return send(res, file, 'no-store')
}).listen(PORT, '127.0.0.1', () => console.log(`Album Studio interface: http://127.0.0.1:${PORT}/`))
