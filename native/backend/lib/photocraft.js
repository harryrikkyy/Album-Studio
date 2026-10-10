// photocraft.js — a headless PhotoCraft session (`photocraft-cli serve`) spoken to over JSON lines.
//
// PhotoCraft's automation sandbox (0.6.0) takes paths RELATIVE to its roots: the read root is "/"
// so any file on any drive can be opened by its absolute path without the leading slash, and the
// write root is the one folder results may be written to.

'use strict'

const { spawn } = require('child_process')
const path = require('path')
const readline = require('readline')

/** The engine binary: ALBUM_STUDIO_PHOTOCRAFT_CLI, else the development build. */
function cliPath() {
  return process.env.ALBUM_STUDIO_PHOTOCRAFT_CLI
    || path.join(process.env.HOME || '', 'Library/Caches/AlbumStudioBuild/target/release/photocraft-cli')
}

class PhotoCraftSession {
  /** @param {{ writeRoot: string }} opts */
  constructor({ writeRoot }) {
    this.writeRoot = writeRoot
    this.next = 1
    /** @type {Map<number, {resolve: Function, reject: Function}>} */
    this.waiting = new Map()
    this.stderr = ''
    this.proc = spawn(cliPath(), ['serve', '--automation-read-root', '/', '--automation-write-root', writeRoot], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.exited = new Promise((resolve) => this.proc.on('exit', (code, signal) => resolve({ code, signal })))
    this.proc.on('error', (e) => this._failAll(new Error(`PhotoCraft couldn't start: ${e.message}`)))
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000) })
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let msg
      try { msg = JSON.parse(line) } catch (_) { return }
      const w = this.waiting.get(msg.id)
      if (!w) return
      this.waiting.delete(msg.id)
      if (msg.ok) w.resolve(msg.result)
      else w.reject(new Error(String(msg.error || 'PhotoCraft reported an error')))
    })
    this.exited.then(({ code, signal }) => this._failAll(new Error(`PhotoCraft stopped (${signal || code}). ${this.stderr.trim().split('\n').slice(-2).join(' ')}`)))
  }

  _failAll(err) {
    for (const w of this.waiting.values()) w.reject(err)
    this.waiting.clear()
  }

  /** @returns {Promise<any>} */
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.next++
      this.waiting.set(id, { resolve, reject })
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n', (e) => {
        if (e) { this.waiting.delete(id); reject(new Error(`PhotoCraft didn't accept a request: ${e.message}`)) }
      })
    })
  }

  /** Run one engine command. */
  run(command, params = {}) {
    return this.call('engine.execute', { command, params })
  }

  /** An absolute path as the read sandbox wants it. */
  static readPath(p) {
    return p.replace(/^\/+/, '')
  }

  /** An absolute path under the write root, relative to it. */
  writePath(p) {
    const rel = path.relative(this.writeRoot, p)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${p} is outside the output folder ${this.writeRoot}`)
    return rel.split(path.sep).join('/')
  }

  async close() {
    try { this.proc.stdin.end() } catch (_) { /* already gone */ }
    const timer = setTimeout(() => { try { this.proc.kill() } catch (_) {} }, 5000)
    await this.exited
    clearTimeout(timer)
  }
}

module.exports = { PhotoCraftSession, cliPath }
