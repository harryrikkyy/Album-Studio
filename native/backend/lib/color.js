// ag-psd exposes composite values without their ICC resource. Retain it in a lossless,
// uncompressed TIFF container so libvips performs the source-to-sRGB conversion normally.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

const MAX_PROFILE = 16 * 1024 * 1024

function validateProfile(profile) {
  if (!Buffer.isBuffer(profile) || profile.length < 132 || profile.length > MAX_PROFILE ||
      profile.readUInt32BE(0) !== profile.length || profile.toString('ascii', 36, 40) !== 'acsp') {
    throw new Error('The sheet has an invalid colour profile. Assign a valid profile in the editor before exporting.')
  }
  const count = profile.readUInt32BE(128)
  if (count > 4096 || 132 + count * 12 > profile.length) throw new Error('The sheet colour profile has an invalid tag table.')
  for (let i = 0; i < count; i++) {
    const offset = profile.readUInt32BE(136 + i * 12)
    const size = profile.readUInt32BE(140 + i * 12)
    if (offset < 128 || size > profile.length || offset > profile.length - size) throw new Error('The sheet colour profile contains a truncated tag.')
  }
  return profile
}

/** Resource 1039 (ICC), bounds checked independently of pixel decoding; supports PSD and PSB. */
function psdProfile(buf) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== '8BPS') return null
  const colorBytes = buf.readUInt32BE(26)
  const start = 30 + colorBytes
  if (start + 4 > buf.length) throw new Error('The sheet colour resources are truncated.')
  const length = buf.readUInt32BE(start)
  const end = start + 4 + length
  if (end > buf.length) throw new Error('The sheet colour resources are truncated.')
  let at = start + 4
  let found = null
  while (at < end) {
    if (at + 7 > end || buf.toString('ascii', at, at + 4) !== '8BIM') throw new Error('The sheet has an invalid image resource.')
    const id = buf.readUInt16BE(at + 4)
    const nameLength = 1 + buf[at + 6]
    const sizeAt = at + 6 + nameLength + nameLength % 2
    if (sizeAt + 4 > end) throw new Error('The sheet image resource name is truncated.')
    const size = buf.readUInt32BE(sizeAt)
    const dataAt = sizeAt + 4
    if (size > end - dataAt) throw new Error('The sheet image resource is truncated.')
    if (id === 1039) {
      if (found) throw new Error('The sheet contains conflicting colour profiles.')
      found = validateProfile(buf.subarray(dataAt, dataAt + size))
    }
    at = dataAt + size + size % 2
    if (at > end) throw new Error('The sheet image resource padding is truncated.')
  }
  return found
}

function rgbaTiffHeader(width, height, profile) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height * 4 > 0xffffffff) {
    throw new Error('The sheet dimensions exceed the colour conversion limit.')
  }
  validateProfile(profile)
  if (profile.toString('ascii', 16, 20) !== 'RGB ') throw new Error('The composite colour profile is not RGB. Convert the sheet in the editor before exporting.')
  const tags = 12
  const bitsAt = 8 + 2 + tags * 12 + 4
  const profileAt = bitsAt + 8
  const pixelsAt = profileAt + profile.length + profile.length % 2
  const header = Buffer.alloc(pixelsAt)
  header.write('II', 0); header.writeUInt16LE(42, 2); header.writeUInt32LE(8, 4)
  header.writeUInt16LE(tags, 8)
  let index = 0
  const tag = (id, type, count, value) => {
    const at = 10 + index++ * 12
    header.writeUInt16LE(id, at); header.writeUInt16LE(type, at + 2)
    header.writeUInt32LE(count, at + 4); header.writeUInt32LE(value, at + 8)
  }
  tag(256, 4, 1, width); tag(257, 4, 1, height)
  tag(258, 3, 4, bitsAt); tag(259, 3, 1, 1); tag(262, 3, 1, 2)
  tag(273, 4, 1, pixelsAt); tag(277, 3, 1, 4); tag(278, 4, 1, height)
  tag(279, 4, 1, width * height * 4); tag(284, 3, 1, 1)
  tag(338, 3, 1, 2); tag(34675, 7, profile.length, profileAt)
  for (let i = 0; i < 4; i++) header.writeUInt16LE(8, bitsAt + i * 2)
  profile.copy(header, profileAt)
  return header
}

/** Write header and borrowed pixel buffer separately; no extra full-size PNG encode/copy. */
async function profiledRgba(input, width, height, profile) {
  const header = rgbaTiffHeader(width, height, profile)
  if (input.length !== width * height * 4) throw new Error('The sheet composite has an invalid pixel length.')
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'as-colour-'))
  const file = path.join(dir, 'composite.tif')
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true })
  let handle
  try {
    handle = await fs.promises.open(file, 'wx', 0o600)
    await handle.writeFile(header)
    await handle.writeFile(input)
    await handle.close(); handle = null
    return { input: file, width, height, cleanup }
  } catch (e) {
    if (handle) await handle.close().catch(() => {})
    await cleanup()
    throw e
  }
}

module.exports = { profiledRgba, psdProfile, rgbaTiffHeader, validateProfile }
