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
  /** Long print commands can take minutes; tests and callers may choose shorter bounds. */
  constructor({ writeRoot, requestTimeoutMs = 300000, shutdownTimeoutMs = 5000, forceKillTimeoutMs = 1000 }) {
    for (const [name, value] of Object.entries({ requestTimeoutMs, shutdownTimeoutMs, forceKillTimeoutMs })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error(`${name} must be a positive timeout in milliseconds`)
    }
    this.writeRoot = writeRoot
    this.requestTimeoutMs = requestTimeoutMs
    this.shutdownTimeoutMs = shutdownTimeoutMs
    this.forceKillTimeoutMs = forceKillTimeoutMs
    this.next = 1
    /** @type {Map<number, {resolve: Function, reject: Function, timer: object}>} */
    this.waiting = new Map()
    this.stderr = ''
    this.terminalError = null
    this.finished = false
    this.closing = null
    this.proc = spawn(cliPath(), ['serve', '--automation-read-root', '/', '--automation-write-root', writeRoot], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.exited = new Promise((resolve) => { this.resolveExited = resolve })
    const stopped = (code, signal) => this._finish({ code, signal }, new Error(`PhotoCraft stopped (${signal || code}). ${this.stderr.trim().split('\n').slice(-2).join(' ')}`))
    this.proc.on('exit', stopped)
    this.proc.on('close', stopped)
    this.proc.on('error', (e) => {
      const err = new Error(`PhotoCraft couldn't start or continue: ${e.message}`)
      this._failAll(err)
      // A failed spawn has no PID and emits `close`, but never `exit`.
      if (!this.proc.pid) this._finish({ code: null, signal: null }, err)
    })
    this.proc.stdin.on('error', (e) => this._failAll(new Error(`PhotoCraft didn't accept a request: ${e.message}`)))
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000) })
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let msg
      try { msg = JSON.parse(line) } catch (_) { return }
      if (!msg || typeof msg !== 'object' || !Number.isSafeInteger(msg.id)) return
      const w = this.waiting.get(msg.id)
      if (!w) return
      this.waiting.delete(msg.id)
      clearTimeout(w.timer)
      if (msg.ok) w.resolve(msg.result)
      else w.reject(new Error(String(msg.error || 'PhotoCraft reported an error')))
    })
  }

  _failAll(err) {
    if (!this.terminalError) this.terminalError = err
    for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(this.terminalError) }
    this.waiting.clear()
  }

  _finish(result, err) {
    if (this.finished) return
    this.finished = true
    this._failAll(err)
    this.resolveExited(result)
  }

  /** @returns {Promise<any>} */
  call(method, params = {}) {
    if (this.terminalError) return Promise.reject(this.terminalError)
    let request
    const id = this.next++
    try { request = JSON.stringify({ id, method, params }) + '\n' } catch (e) { return Promise.reject(e) }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._failAll(new Error(`PhotoCraft request “${method}” timed out after ${this.requestTimeoutMs} ms. Retry the job with a new engine session.`))
        // Continuing after a timed-out stateful command could apply later commands to the wrong document.
        this.close().catch(() => {})
      }, this.requestTimeoutMs)
      this.waiting.set(id, { resolve, reject, timer })
      const failedWrite = (e) => { if (e) this._failAll(new Error(`PhotoCraft didn't accept a request: ${e.message}`)) }
      try { this.proc.stdin.write(request, failedWrite) } catch (e) { failedWrite(e) }
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
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`${p} is outside the output folder ${this.writeRoot}`)
    return rel.split(path.sep).join('/')
  }

  close() {
    if (!this.closing) this.closing = this._close()
    return this.closing
  }

  async _waitForExit(ms) {
    if (this.finished) return true
    let timer
    try {
      return await Promise.race([this.exited.then(() => true), new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), ms)
      })])
    } finally { clearTimeout(timer) }
  }

  async _close() {
    this._failAll(new Error('PhotoCraft session is closing.'))
    if (this.finished) return
    try { this.proc.stdin.end() } catch (_) { /* already gone */ }
    if (await this._waitForExit(this.shutdownTimeoutMs)) return
    try { this.proc.kill('SIGTERM') } catch (_) { /* KILL below still gets a chance */ }
    if (await this._waitForExit(this.shutdownTimeoutMs)) return
    try { this.proc.kill('SIGKILL') } catch (_) { /* bounded final wait */ }
    if (!await this._waitForExit(this.forceKillTimeoutMs)) {
      throw new Error(`PhotoCraft process ${this.proc.pid || '(unknown)'} did not stop after SIGKILL. Close it before retrying the job.`)
    }
  }
}

module.exports = { PhotoCraftSession, cliPath }
