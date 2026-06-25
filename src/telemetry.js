// telemetry.js
//
// Thin wrapper around electron-log. Two responsibilities:
//   1. Crash logs — uncaught exceptions and unhandled rejections persisted
//      to a rotating file under app.getPath('userData')/logs.
//   2. Local metrics — append-only JSONL stream of small structured events
//      (`{ ts, event, durationMs, ...fields }`) so we can answer questions
//      like "how long does auto-fill take on real albums" without shipping
//      data anywhere.
//
// Intentionally local-only by default. A future "send anonymous metrics"
// toggle would post the JSONL stream to a server, but right now everything
// stays on disk and the user can grep through it.

const path = require('path')
const fs = require('fs')
const { app } = require('electron')

let log = null
let metricsStream = null

function ensure() {
  if (log) return log
  try {
    log = require('electron-log/main')
  } catch {
    // electron-log occasionally bundles weirdly. Fall back to console.
    log = {
      info: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
      transports: { file: { level: 'info' } },
      catchErrors: () => {},
      initialize: () => {},
    }
    return log
  }

  // Wire up renderer-side logs to flow through the same file transport.
  if (typeof log.initialize === 'function') {
    try { log.initialize({ preload: false, spyRendererConsole: false }) } catch (_) {}
  }
  log.transports.file.level = 'info'
  log.transports.file.maxSize = 5 * 1024 * 1024 // rotate at 5 MB
  log.transports.file.fileName = 'app.log'
  if (log.transports.console) log.transports.console.level = app.isPackaged ? false : 'info'

  // Catch uncaught exceptions so they show up in the log file instead of
  // disappearing into a renderer DevTools console nobody is watching.
  if (typeof log.catchErrors === 'function') {
    log.catchErrors({
      showDialog: false,
      onError(err) { log.error('uncaught', err) },
    })
  }
  return log
}

function metricsPath() {
  const dir = path.join(app.getPath('userData'), 'metrics')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'events.jsonl')
}

function getMetricsStream() {
  if (metricsStream) return metricsStream
  metricsStream = fs.createWriteStream(metricsPath(), { flags: 'a' })
  metricsStream.on('error', () => { metricsStream = null })
  return metricsStream
}

function event(name, fields = {}) {
  ensure()
  const rec = { ts: new Date().toISOString(), event: name, ...fields }
  try { getMetricsStream().write(JSON.stringify(rec) + '\n') } catch { /* fail silent */ }
  // Also tee into the rotating log at info level so a single file gives a
  // chronological story when debugging support tickets.
  try { log.info('metric', rec) } catch { /* fail silent */ }
}

module.exports = {
  init() { ensure() },
  event,
  info: (...a) => { ensure().info(...a) },
  warn: (...a) => { ensure().warn(...a) },
  error: (...a) => { ensure().error(...a) },
  logFilePath() {
    try { return require('electron-log/main').transports.file.getFile().path }
    catch { return null }
  },
  metricsFilePath: metricsPath,
}
