// Bounded UTF-8 JSON-line framing. Oversized lines are discarded through their
// next newline, so one malformed producer cannot retain an unbounded buffer.
'use strict'
const MAX_LINE_BYTES = 8 * 1024 * 1024
/** @param {(message: string) => void} [onInvalid] told why a line was dropped */
function jsonLines(onLine, onInvalid = () => {}, maximum = MAX_LINE_BYTES) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_LINE_BYTES)
    throw new Error('Choose a positive JSON-line limit within 8 MiB.')
  let pieces = [],
    bytes = 0,
    tailBytes = 0,
    discarding = false,
    ended = false
  const decoder = new TextDecoder('utf-8', { fatal: true })
  function append(part) {
    if (!part.length || discarding) return
    if (bytes + part.length > maximum) {
      pieces = []
      bytes = 0
      tailBytes = 0
      discarding = true
      onInvalid('Protocol line exceeds its byte limit.')
      return
    }
    // Coalesce fragments into fixed slabs. One-byte writes must not create millions
    // of retained Buffer wrappers and array entries beneath the byte limit.
    let position = 0
    while (position < part.length) {
      let tail = pieces[pieces.length - 1]
      if (!tail || tailBytes === tail.length) {
        tail = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - bytes))
        pieces.push(tail)
        tailBytes = 0
      }
      const count = Math.min(part.length - position, tail.length - tailBytes)
      part.copy(tail, tailBytes, position, position + count)
      tailBytes += count
      bytes += count
      position += count
    }
  }
  function finish() {
    if (!discarding && bytes) {
      let line
      try {
        line = decoder.decode(Buffer.concat(pieces, bytes))
      } catch (_) {
        onInvalid('Protocol line is not valid UTF-8.')
        line = ''
      }
      if (line.trim()) onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
    }
    pieces = []
    bytes = 0
    tailBytes = 0
    discarding = false
  }
  return {
    write(chunk) {
      if (ended) throw new Error('The protocol input has already ended.')
      if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk)
      let start = 0,
        newline
      while ((newline = chunk.indexOf(10, start)) !== -1) {
        append(chunk.subarray(start, newline))
        finish()
        start = newline + 1
      }
      append(chunk.subarray(start))
    },
    end() {
      if (!ended) {
        ended = true
        finish()
      }
    },
    get bufferedBytes() {
      return bytes
    },
    get bufferedChunks() {
      return pieces.length
    },
  }
}
module.exports = { jsonLines, MAX_LINE_BYTES }
