// Read bounded native compatibility samples with their source ICC resource. A lossless
// TIFF retains source precision and lets libvips verify the source-to-sRGB conversion.
'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')
const { cacheRoot } = require('./cache')
const { createPrivateStage, finishPrivateStage } = require('./private_stage')

const MAX_PROFILE = 16 * 1024 * 1024
const verifiedProfiles = new Map()
const SRGB_POLICY = Object.freeze({ profile: 'srgb', intent: 'perceptual', bpc: false })
const MAX_PSD_SOURCE_BYTES = 512 * 1024 * 1024
const MAX_COMPOSITE_BYTES = 512 * 1024 * 1024
const LONG_LAYER_KEYS = new Set([
  'LMsk',
  'Lr16',
  'Lr32',
  'Layr',
  'Mt16',
  'Mt32',
  'Mtrn',
  'Alph',
  'FMsk',
  'lnk2',
  'FEid',
  'FXid',
  'PxSD',
])

function compositeError(detail) {
  return new Error(
    `The sheet composite cannot be delivered safely (${detail}). Save a real compatibility composite, or convert and save an 8-bit RGB sheet in the editor.`,
  )
}

/** Explicit source-file policy, separate from decoded plane limits. Hold a no-follow
 * descriptor, allocate only its verified bounded size, and refuse growth/replacement.
 * This does not promise support for arbitrary multi-gigabyte layered PSB documents.
 */
async function readPsdBuffer(file) {
  const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key])
  const changed = () =>
    Object.assign(compositeError('the source changed during reading; retry from a stable original'), {
      code: 'SOURCE_CHANGED',
    })
  const before = await fs.promises.lstat(file, { bigint: true })
  if (!before.isFile())
    throw compositeError('the source is not a regular file; resolve its symlink or restore the original')
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !same(before, opened)) throw changed()
    if (opened.size > BigInt(MAX_PSD_SOURCE_BYTES))
      throw compositeError(
        'source file exceeds the 512 MiB source-reading policy; save a smaller compatibility sheet or template in the editor',
      )
    const buf = Buffer.allocUnsafe(Number(opened.size))
    let at = 0
    while (at < buf.length) {
      const { bytesRead } = await handle.read(buf, at, Math.min(1024 * 1024, buf.length - at), at)
      if (!bytesRead) throw changed()
      at += bytesRead
    }
    const after = await handle.stat({ bigint: true }),
      named = await fs.promises.lstat(file, { bigint: true })
    if (!same(opened, after) || !same(after, named)) throw changed()
    return buf
  } finally {
    await handle.close()
  }
}

/** Read allocation bounds and merged transparency independently of ag-psd's RGBA preview.
 * Adobe's signed layer count identifies transparency; a saved selection is an auxiliary
 * channel even though ag-psd exposes it in the fourth RGBA component. High-depth files may
 * carry the same declaration in global Layr/Lr16/Lr32 blocks rather than the primary info.
 */
function compositeMetadata(buf) {
  const need = (at, size, end = buf.length) => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 0 || at > end - size)
      throw compositeError('truncated document data')
  }
  need(0, 30)
  if (buf.toString('ascii', 0, 4) !== '8BPS') throw compositeError('not a PSD/PSB document')
  const version = buf.readUInt16BE(4),
    channels = buf.readUInt16BE(12),
    height = buf.readUInt32BE(14),
    width = buf.readUInt32BE(18),
    depth = buf.readUInt16BE(22),
    mode = buf.readUInt16BE(24)
  if (![1, 2].includes(version) || ![1, 8, 16, 32].includes(depth) || !channels || channels > 56 || !width || !height)
    throw compositeError('invalid header')
  const limit = version === 2 ? 300000 : 30000
  if (width > limit || height > limit) throw compositeError('dimensions exceed the PSD/PSB format limit')
  // Bound both the source planes and the four-channel output before decoding a tiny
  // or malformed source. An oversized document must not be retried in the engine.
  const decodedBytes = width * height * Math.max(4, channels) * Math.max(1, depth / 8)
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_COMPOSITE_BYTES)
    throw compositeError('compatibility composite exceeds the 512 MiB decoding limit')
  let at = 30 + buf.readUInt32BE(26)
  need(at, 4)
  const resourceLength = buf.readUInt32BE(at)
  at += 4
  need(at, resourceLength)
  const resourceEnd = at + resourceLength
  let realMerged = null
  while (at < resourceEnd) {
    need(at, 7, resourceEnd)
    if (buf.toString('ascii', at, at + 4) !== '8BIM') throw compositeError('invalid image resource')
    const id = buf.readUInt16BE(at + 4),
      nameSize = 1 + buf[at + 6],
      sizeAt = at + 6 + nameSize + (nameSize % 2)
    need(sizeAt, 4, resourceEnd)
    const size = buf.readUInt32BE(sizeAt),
      dataAt = sizeAt + 4
    need(dataAt, size, resourceEnd)
    if (id === 1057) {
      if (size < 5 || buf.readUInt32BE(dataAt) !== 1 || realMerged !== null)
        throw compositeError('invalid merged-composite declaration')
      realMerged = !!buf[dataAt + 4]
    }
    at = dataAt + size + (size % 2)
    if (at > resourceEnd) throw compositeError('truncated image resource padding')
  }
  const lengthBytes = version === 2 ? 8 : 4
  const lengthAt = (where, bytes, end = buf.length) => {
    need(where, bytes, end)
    const value = bytes === 8 ? buf.readBigUInt64BE(where) : BigInt(buf.readUInt32BE(where))
    if (value > BigInt(end)) throw compositeError('invalid layer section length')
    return Number(value)
  }
  const layerLength = lengthAt(at, lengthBytes),
    layerAt = at + lengthBytes,
    layerEnd = layerAt + layerLength
  need(layerAt, layerLength)
  let alpha = null
  const declare = (where, size) => {
    if (size < 2) throw compositeError('truncated layer count')
    const value = buf.readInt16BE(where) < 0
    if (alpha !== null && value !== alpha) throw compositeError('conflicting merged transparency declarations')
    alpha = value
  }
  if (layerLength && [3, 4].includes(mode)) {
    const infoLength = lengthAt(layerAt, lengthBytes, layerEnd),
      infoAt = layerAt + lengthBytes
    need(infoAt, infoLength, layerEnd)
    if (infoLength) declare(infoAt, infoLength)
    at = infoAt + infoLength
    const maskLength = lengthAt(at, 4, layerEnd)
    at += 4
    need(at, maskLength, layerEnd)
    at += maskLength
    while (at < layerEnd) {
      // Global blocks are padded to two or four bytes by different writers.
      let padding = 0
      while (padding < 3 && at + padding < layerEnd && buf[at + padding] === 0) padding++
      if (at + padding === layerEnd) break
      at += padding
      need(at, 12, layerEnd)
      const signature = buf.toString('ascii', at, at + 4),
        key = buf.toString('ascii', at + 4, at + 8)
      if (!['8BIM', '8B64'].includes(signature)) throw compositeError('invalid global layer block')
      const bytes = signature === '8B64' || (version === 2 && LONG_LAYER_KEYS.has(key)) ? 8 : 4
      const size = lengthAt(at + 8, bytes, layerEnd),
        dataAt = at + 8 + bytes
      need(dataAt, size, layerEnd)
      if (key === 'Layr' || key === (depth === 16 ? 'Lr16' : depth === 32 ? 'Lr32' : 'Layr')) declare(dataAt, size)
      at = dataAt + size
    }
  }
  need(layerEnd, 2)
  if (mode === 3) {
    if (channels < 3 || channels > 4) throw compositeError('unsupported RGB extra channels')
    if (alpha === true && channels !== 4) throw compositeError('merged transparency channel is missing')
    if (channels === 4 && alpha === null) throw compositeError('fourth-channel transparency provenance is unknown')
    if (buf.readUInt16BE(layerEnd) === 0 && depth >= 8) need(layerEnd + 2, width * height * channels * (depth / 8))
  }
  return { width, height, channels, depth, mode, alpha, realMerged, compositeAt: layerEnd }
}

/** Strict PackBits/ZIP planes shared by RGB and CMYK; no preview or colour conversion. */
function compositePlanes(buf, { width, height, channels, depth }, compressionAt, error = compositeError) {
  const need = (at, size) => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 0 || at > buf.length - size)
      throw error('truncated document data')
  }
  const sample = depth / 8,
    rowBytes = width * sample,
    rows = channels * height,
    expected = rowBytes * rows
  if (![8, 16].includes(depth) || !Number.isSafeInteger(expected) || expected > MAX_COMPOSITE_BYTES)
    throw error('unsupported or oversized compatibility composite')
  need(compressionAt, 2)
  const compression = buf.readUInt16BE(compressionAt)
  let at = compressionAt + 2,
    planar
  if (compression === 0) {
    need(at, expected)
    return buf.subarray(at, at + expected)
  }
  if (compression === 1) {
    const countBytes = buf.readUInt16BE(4) === 2 ? 4 : 2,
      tableSize = rows * countBytes
    need(at, tableSize)
    const tableAt = at
    at += tableSize
    let encodedTotal = 0
    for (let row = 0; row < rows; row++)
      encodedTotal +=
        countBytes === 4 ? buf.readUInt32BE(tableAt + row * countBytes) : buf.readUInt16BE(tableAt + row * countBytes)
    need(at, encodedTotal)
    planar = Buffer.allocUnsafe(expected)
    for (let row = 0; row < rows; row++) {
      const length =
        countBytes === 4 ? buf.readUInt32BE(tableAt + row * countBytes) : buf.readUInt16BE(tableAt + row * countBytes)
      const end = at + length,
        destination = row * rowBytes
      let decoded = 0
      while (at < end) {
        const control = buf[at++]
        if (control === 128) continue
        const count = control < 128 ? control + 1 : 257 - control
        if (decoded + count > rowBytes) throw error('an RLE row exceeds its width')
        if (control < 128) {
          if (at + count > end) throw error('truncated RLE literal')
          buf.copy(planar, destination + decoded, at, at + count)
          at += count
        } else {
          if (at >= end) throw error('truncated RLE repeat')
          planar.fill(buf[at++], destination + decoded, destination + decoded + count)
        }
        decoded += count
      }
      if (decoded !== rowBytes) throw error('truncated RLE row')
    }
  } else if (compression === 2 || compression === 3) {
    try {
      planar = zlib.inflateSync(buf.subarray(at), { maxOutputLength: expected })
    } catch (_) {
      throw error('invalid or oversized ZIP composite')
    }
    if (planar.length !== expected) throw error('ZIP composite length does not match its planes')
    if (compression === 3)
      for (let row = 0; row < rows; row++) {
        const start = row * rowBytes
        for (let x = 1; x < width; x++) {
          const pos = start + x * sample
          if (depth === 8) planar[pos] = (planar[pos] + planar[pos - 1]) & 255
          else planar.writeUInt16BE((planar.readUInt16BE(pos) + planar.readUInt16BE(pos - 2)) & 65535, pos)
        }
      }
  } else throw error('unsupported composite compression')
  return planar
}

/** RGB compatibility samples, including white-matted merged alpha at original precision. */
function decodeRgbComposite(buf, source = compositeMetadata(buf)) {
  if (source.mode !== 3 || ![8, 16].includes(source.depth)) throw compositeError('unsupported RGB source depth')
  if (source.realMerged === false) throw compositeError('the document declares no real merged composite')
  const { width, height, depth } = source,
    sample = depth / 8,
    pixels = width * height,
    maximum = depth === 8 ? 255 : 65535
  const planar = compositePlanes(buf, source, source.compositeAt),
    alpha = source.alpha === true
  const data = Buffer.allocUnsafe(pixels * 4 * sample)
  const read = (position) => (depth === 8 ? planar[position] : planar.readUInt16BE(position))
  const write = (position, value) => {
    if (depth === 8) data[position] = value
    else data.writeUInt16LE(value, position)
  }
  for (let i = 0; i < pixels; i++) {
    const a = alpha ? read((3 * pixels + i) * sample) : maximum
    for (let c = 0; c < 3; c++) {
      const value = read((c * pixels + i) * sample)
      const straight = alpha
        ? a
          ? Math.max(0, Math.min(maximum, Math.round(((value - maximum + a) * maximum) / a)))
          : 0
        : value
      write((i * 4 + c) * sample, straight)
    }
    write((i * 4 + 3) * sample, a)
  }
  return { data, width, height, depth, channels: 4, alpha }
}

function profileError(detail) {
  return new Error(
    `The sheet colour profile is invalid or unsupported (${detail}). Assign a valid source profile before exporting.`,
  )
}

function validateCurve(data) {
  const type = data.toString('ascii', 0, 4)
  if (data.length < 12) throw profileError('truncated tone curve')
  if (type === 'curv') {
    const count = data.readUInt32BE(8)
    if (count > (data.length - 12) / 2 || (count === 1 && !data.readUInt16BE(12)))
      throw profileError('invalid tone curve')
  } else if (type === 'para') {
    const fn = data.readUInt16BE(8),
      parameters = [1, 3, 4, 5, 7][fn]
    if (!parameters || data.length < 12 + parameters * 4 || data.readInt32BE(12) <= 0)
      throw profileError('invalid parametric tone curve')
    if ((fn === 1 || fn === 2) && data.readInt32BE(16) === 0) throw profileError('tone curve divides by zero')
  } else throw profileError('unknown tone curve type')
}

function validateProfile(profile) {
  if (
    !Buffer.isBuffer(profile) ||
    profile.length < 132 ||
    profile.length > MAX_PROFILE ||
    profile.readUInt32BE(0) !== profile.length ||
    profile.toString('ascii', 36, 40) !== 'acsp'
  ) {
    throw new Error('The sheet has an invalid colour profile. Assign a valid profile in the editor before exporting.')
  }
  const version = profile[8],
    profileClass = profile.toString('ascii', 12, 16),
    space = profile.toString('ascii', 16, 20),
    pcs = profile.toString('ascii', 20, 24)
  if (![2, 4].includes(version)) throw profileError('unsupported ICC version')
  // Source scanner, monitor, printer and colour-space profiles remain supported. Device-link,
  // abstract and named-colour profiles cannot describe these document samples independently.
  if (!['scnr', 'mntr', 'prtr', 'spac'].includes(profileClass)) throw profileError('not a source image profile')
  if (
    !['RGB ', 'GRAY', 'CMYK', 'Lab '].includes(space) ||
    !['XYZ ', 'Lab '].includes(pcs) ||
    profile.readUInt32BE(64) > 3
  )
    throw profileError('invalid colour space, PCS or intent')
  const count = profile.readUInt32BE(128)
  if (!count || count > 4096 || 132 + count * 12 > profile.length)
    throw new Error('The sheet colour profile has an invalid tag table.')
  const seen = new Set()
  for (let i = 0; i < count; i++) {
    const signature = profile.toString('ascii', 132 + i * 12, 136 + i * 12)
    const offset = profile.readUInt32BE(136 + i * 12)
    const size = profile.readUInt32BE(140 + i * 12)
    if (
      seen.has(signature) ||
      offset % 4 ||
      offset < 132 + count * 12 ||
      size < 8 ||
      size > profile.length ||
      offset > profile.length - size
    )
      throw new Error('The sheet colour profile contains an invalid or truncated tag.')
    seen.add(signature)
    const data = profile.subarray(offset, offset + size)
    if (['rTRC', 'gTRC', 'bTRC', 'kTRC'].includes(signature)) validateCurve(data)
    if (['rXYZ', 'gXYZ', 'bXYZ', 'wtpt'].includes(signature) && (size < 20 || data.toString('ascii', 0, 4) !== 'XYZ '))
      throw profileError('invalid matrix or white point tag')
  }
  return profile
}

/** Probe the real LittleCMS parser/transform rather than guessing which vendor LUTs are valid.
 * Sharp catches ICC transform exceptions and warns; failOn:warning makes that fallback fatal.
 * One pixel plus at most 16 MiB of profile data, cached by contents with bounded entries.
 */
async function assertProfileUsable(profile) {
  validateProfile(profile)
  const key = crypto.createHash('sha256').update(profile).digest('hex')
  if (verifiedProfiles.has(key)) return verifiedProfiles.get(key)
  const probe = (async () => {
    const space = profile.toString('ascii', 16, 20),
      channels = { 'RGB ': 3, GRAY: 1, CMYK: 4, 'Lab ': 3 }[space]
    const tags = 11,
      bitsAt = 8 + 2 + tags * 12 + 4,
      profileAt = bitsAt + channels * 2,
      alignedProfileAt = profileAt + (profileAt % 2)
    const pixelAt = alignedProfileAt + profile.length + (profile.length % 2),
      header = Buffer.alloc(pixelAt)
    header.write('II')
    header.writeUInt16LE(42, 2)
    header.writeUInt32LE(8, 4)
    header.writeUInt16LE(tags, 8)
    let index = 0
    const tag = (id, type, count, value) => {
      const at = 10 + index++ * 12
      header.writeUInt16LE(id, at)
      header.writeUInt16LE(type, at + 2)
      header.writeUInt32LE(count, at + 4)
      header.writeUInt32LE(value, at + 8)
    }
    tag(256, 4, 1, 1)
    tag(257, 4, 1, 1)
    tag(258, 3, channels, channels === 1 ? 8 : bitsAt)
    tag(259, 3, 1, 1)
    tag(262, 3, 1, { 'RGB ': 2, GRAY: 1, CMYK: 5, 'Lab ': 8 }[space])
    tag(273, 4, 1, pixelAt)
    tag(277, 3, 1, channels)
    tag(278, 4, 1, 1)
    tag(279, 4, 1, channels)
    tag(284, 3, 1, 1)
    tag(34675, 7, profile.length, alignedProfileAt)
    for (let i = 0; i < channels; i++) header.writeUInt16LE(8, bitsAt + i * 2)
    profile.copy(header, alignedProfileAt)
    const input = Buffer.concat([header, Buffer.from([64, 128, 192, 32].slice(0, channels))])
    try {
      await require('../../../src/sharp_config')
        .getSharp()(input, { failOn: 'warning' })
        .withIccProfile(SRGB_POLICY.profile)
        .raw()
        .toBuffer()
    } catch (_) {
      throw profileError('source transform could not be verified by LittleCMS')
    }
  })()
  if (verifiedProfiles.size >= 32) verifiedProfiles.delete(verifiedProfiles.keys().next().value)
  verifiedProfiles.set(key, probe)
  try {
    await probe
  } catch (error) {
    verifiedProfiles.delete(key)
    throw error
  }
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
    if (at + 7 > end || buf.toString('ascii', at, at + 4) !== '8BIM')
      throw new Error('The sheet has an invalid image resource.')
    const id = buf.readUInt16BE(at + 4)
    const nameLength = 1 + buf[at + 6]
    const sizeAt = at + 6 + nameLength + (nameLength % 2)
    if (sizeAt + 4 > end) throw new Error('The sheet image resource name is truncated.')
    const size = buf.readUInt32BE(sizeAt)
    const dataAt = sizeAt + 4
    if (size > end - dataAt) throw new Error('The sheet image resource is truncated.')
    if (id === 1039) {
      if (found) throw new Error('The sheet contains conflicting colour profiles.')
      found = validateProfile(buf.subarray(dataAt, dataAt + size))
    }
    at = dataAt + size + (size % 2)
    if (at > end) throw new Error('The sheet image resource padding is truncated.')
  }
  return found
}

function rgbaTiffHeader(width, height, profile, depth = 8) {
  if (
    ![8, 16].includes(depth) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height * 4 * (depth / 8) > 0xffffffff
  ) {
    throw new Error('The sheet dimensions exceed the colour conversion limit.')
  }
  validateProfile(profile)
  if (profile.toString('ascii', 16, 20) !== 'RGB ')
    throw new Error('The composite colour profile is not RGB. Convert the sheet in the editor before exporting.')
  const tags = 12
  const bitsAt = 8 + 2 + tags * 12 + 4
  const profileAt = bitsAt + 8
  const pixelsAt = profileAt + profile.length + (profile.length % 2)
  const header = Buffer.alloc(pixelsAt)
  header.write('II', 0)
  header.writeUInt16LE(42, 2)
  header.writeUInt32LE(8, 4)
  header.writeUInt16LE(tags, 8)
  let index = 0
  const tag = (id, type, count, value) => {
    const at = 10 + index++ * 12
    header.writeUInt16LE(id, at)
    header.writeUInt16LE(type, at + 2)
    header.writeUInt32LE(count, at + 4)
    header.writeUInt32LE(value, at + 8)
  }
  tag(256, 4, 1, width)
  tag(257, 4, 1, height)
  tag(258, 3, 4, bitsAt)
  tag(259, 3, 1, 1)
  tag(262, 3, 1, 2)
  tag(273, 4, 1, pixelsAt)
  tag(277, 3, 1, 4)
  tag(278, 4, 1, height)
  tag(279, 4, 1, width * height * 4 * (depth / 8))
  tag(284, 3, 1, 1)
  tag(338, 3, 1, 2)
  tag(34675, 7, profile.length, profileAt)
  for (let i = 0; i < 4; i++) header.writeUInt16LE(depth, bitsAt + i * 2)
  profile.copy(header, profileAt)
  return header
}

/** Write header and borrowed pixel buffer separately; no extra full-size PNG encode/copy. */
async function profiledRgba(input, width, height, profile, depth = 8, options) {
  const header = rgbaTiffHeader(width, height, profile, depth)
  await assertProfileUsable(profile)
  if (input.length !== width * height * 4 * (depth / 8))
    throw new Error('The sheet composite has an invalid pixel length.')
  return writeProfiledTiff(header, input, width, height, options)
}

function colourCleanup(stage) {
  let completion
  return () => completion || (completion = finishPrivateStage(stage))
}
async function writeProfiledTiff(header, pixels, width, height, { inMemory = false } = {}) {
  if (inMemory) {
    if (header.length + pixels.length > MAX_COMPOSITE_BYTES)
      throw new Error('The preview composite exceeds its 512 MiB memory budget.')
    return { input: Buffer.concat([header, pixels]), width, height }
  }
  const stage = await createPrivateStage(cacheRoot(), 'as-colour-'),
    file = path.join(stage.path, 'composite.tif')
  let handle, failure
  try {
    await stage.reserveBytes(header.length + pixels.length)
    handle = await fs.promises.open(file, 'wx', 0o400)
    await handle.writeFile(header)
    await handle.writeFile(pixels)
  } catch (error) {
    failure = error
  }
  try {
    if (handle) await handle.close()
  } catch (close) {
    if (failure) {
      failure.closeError = close
      failure.message += ` Colour file close also failed: ${close.message}`
    } else failure = close
  }
  if (failure) return finishPrivateStage(stage, failure)
  try {
    await stage.register(file, { readOnly: true })
  } catch (error) {
    return finishPrivateStage(stage, error)
  }
  return { input: file, width, height, cleanup: colourCleanup(stage) }
}

function cmykError(detail) {
  return new Error(
    `The CMYK sheet cannot be delivered safely (${detail}). Save a real compatibility composite with its CMYK profile, or convert and save an 8-bit RGB sheet in the editor.`,
  )
}

/** Native CMYK compatibility samples, without ag-psd's naive CMYK→RGB preview conversion. */
function decodeCmykComposite(buf) {
  const need = (at, size) => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 0 || at > buf.length - size)
      throw cmykError('truncated document data')
  }
  need(0, 30)
  if (buf.toString('ascii', 0, 4) !== '8BPS' || buf.readUInt16BE(24) !== 4) throw cmykError('not a CMYK PSD/PSB')
  const version = buf.readUInt16BE(4),
    channels = buf.readUInt16BE(12),
    height = buf.readUInt32BE(14),
    width = buf.readUInt32BE(18),
    depth = buf.readUInt16BE(22)
  if (![1, 2].includes(version) || ![8, 16].includes(depth) || !width || !height || ![4, 5].includes(channels))
    throw cmykError('unsupported depth or extra spot channels')
  const dimensionLimit = version === 1 ? 30000 : 300000
  if (width > dimensionLimit || height > dimensionLimit) throw cmykError('dimensions exceed the PSD/PSB format limit')
  const sample = depth / 8,
    rowBytes = width * sample,
    rows = channels * height,
    expected = rowBytes * rows
  if (!Number.isSafeInteger(expected) || expected > MAX_COMPOSITE_BYTES)
    throw cmykError('compatibility composite exceeds the 512 MiB decoding limit')
  let at = 30 + buf.readUInt32BE(26)
  need(at, 4)
  const resourcesLength = buf.readUInt32BE(at),
    resourceStart = at + 4,
    resourceEnd = resourceStart + resourcesLength
  need(resourceStart, resourcesLength)
  let realMerged = null
  for (let r = resourceStart; r < resourceEnd;) {
    need(r, 7)
    if (buf.toString('ascii', r, r + 4) !== '8BIM') throw cmykError('invalid resource signature')
    const id = buf.readUInt16BE(r + 4),
      nameSize = 1 + buf[r + 6],
      sizeAt = r + 6 + nameSize + (nameSize % 2)
    if (sizeAt + 4 > resourceEnd) throw cmykError('truncated resource name')
    const size = buf.readUInt32BE(sizeAt),
      dataAt = sizeAt + 4
    if (dataAt + size > resourceEnd) throw cmykError('truncated resource')
    if (id === 1057) {
      if (size < 5 || buf.readUInt32BE(dataAt) !== 1 || realMerged !== null)
        throw cmykError('invalid merged-composite declaration')
      realMerged = !!buf[dataAt + 4]
    }
    r = dataAt + size + (size % 2)
    if (r > resourceEnd) throw cmykError('truncated resource padding')
  }
  if (realMerged === false) throw cmykError('the document declares no real merged composite')
  at = resourceEnd
  const lengthBytes = version === 2 ? 8 : 4
  const sectionLength = (where) => {
    need(where, lengthBytes)
    const value = version === 2 ? buf.readBigUInt64BE(where) : BigInt(buf.readUInt32BE(where))
    if (value > BigInt(buf.length)) throw cmykError('invalid layer section length')
    return Number(value)
  }
  const layerLength = sectionLength(at),
    layerAt = at + lengthBytes
  need(layerAt, layerLength)
  const hasAlpha = compositeMetadata(buf).alpha === true
  if (hasAlpha && channels < 5) throw cmykError('transparency plane is missing')
  const alpha = channels === 5 && hasAlpha
  if (channels === 5 && !alpha) throw cmykError('an extra channel is not identified as transparency')
  at = layerAt + layerLength
  const planar = compositePlanes(buf, { width, height, channels, depth }, at, cmykError)
  const data = Buffer.allocUnsafe(expected),
    pixels = width * height,
    maximum = depth === 8 ? 255 : 65535
  const read = (position) => (depth === 8 ? planar[position] : planar.readUInt16BE(position))
  const write = (position, value) => {
    if (depth === 8) data[position] = value
    else data.writeUInt16LE(value, position)
  }
  for (let i = 0; i < pixels; i++) {
    const a = alpha ? read((4 * pixels + i) * sample) : maximum
    for (let c = 0; c < 4; c++) {
      // CMYK compatibility planes are inverted and matted against white (zero ink).
      const ink = maximum - read((c * pixels + i) * sample)
      write((i * channels + c) * sample, alpha ? (a ? Math.min(maximum, Math.round((ink * maximum) / a)) : 0) : ink)
    }
    if (alpha) write((i * channels + 4) * sample, a)
  }
  return { data, width, height, channels, depth, alpha }
}

async function profiledCmyk(composite, profile, options) {
  await assertProfileUsable(profile)
  if (profile.toString('ascii', 16, 20) !== 'CMYK') throw cmykError('source profile is not CMYK')
  const { data, width, height, channels, depth, alpha } = composite
  const tags = alpha ? 13 : 12,
    bitsAt = 8 + 2 + tags * 12 + 4,
    profileAt = bitsAt + channels * 2
  const pixelsAt = profileAt + profile.length + (profile.length % 2),
    header = Buffer.alloc(pixelsAt)
  header.write('II')
  header.writeUInt16LE(42, 2)
  header.writeUInt32LE(8, 4)
  header.writeUInt16LE(tags, 8)
  let index = 0
  const tag = (id, type, count, value) => {
    const at = 10 + index++ * 12
    header.writeUInt16LE(id, at)
    header.writeUInt16LE(type, at + 2)
    header.writeUInt32LE(count, at + 4)
    header.writeUInt32LE(value, at + 8)
  }
  tag(256, 4, 1, width)
  tag(257, 4, 1, height)
  tag(258, 3, channels, bitsAt)
  tag(259, 3, 1, 1)
  tag(262, 3, 1, 5)
  tag(273, 4, 1, pixelsAt)
  tag(277, 3, 1, channels)
  tag(278, 4, 1, height)
  tag(279, 4, 1, data.length)
  tag(284, 3, 1, 1)
  tag(332, 3, 1, 1)
  if (alpha) tag(338, 3, 1, 2)
  tag(34675, 7, profile.length, profileAt)
  for (let i = 0; i < channels; i++) header.writeUInt16LE(depth, bitsAt + i * 2)
  profile.copy(header, profileAt)
  return writeProfiledTiff(header, data, width, height, options)
}

let defaultRgbProfile = null
async function untaggedRgbProfile() {
  if (!defaultRgbProfile)
    defaultRgbProfile = (async () => {
      const sharp = require('../../../src/sharp_config').getSharp()
      const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
        .withIccProfile('srgb')
        .jpeg()
        .toBuffer()
      return (await sharp(image).metadata()).icc
    })()
  return defaultRgbProfile
}

/**
 * Shared verified PSD pixels for production sheets and original template backdrops.
 * @param {string} psdPath
 * @param {{ buffer?: Buffer, inMemory?: boolean }} [options]
 */
async function psdPixels(psdPath, { buffer, inMemory = false } = {}) {
  const buf = buffer || (await readPsdBuffer(psdPath))
  if (buf.length > MAX_PSD_SOURCE_BYTES)
    throw compositeError(
      'source file exceeds the 512 MiB source-reading policy; save a smaller compatibility sheet or template in the editor',
    )
  const source = compositeMetadata(buf),
    profile = psdProfile(buf)
  if (profile) await assertProfileUsable(profile)
  if (buf.length >= 26 && buf.toString('ascii', 0, 4) === '8BPS' && buf.readUInt16BE(24) === 4) {
    if (!profile) throw cmykError('the actual source profile is absent')
    return profiledCmyk(decodeCmykComposite(buf), profile, { inMemory })
  }
  if (source.mode === 3 && profile && profile.toString('ascii', 16, 20) !== 'RGB ')
    throw compositeError('the RGB source profile does not match its channels')
  if (source.mode === 3 && source.realMerged !== false && [8, 16].includes(source.depth)) {
    const img = decodeRgbComposite(buf, source),
      sample = source.depth / 8
    let nonBlack = false
    for (let i = 0; i < img.data.length && !nonBlack; i += 4 * sample) {
      for (let c = 0; c < 3 && !nonBlack; c++)
        nonBlack = source.depth === 8 ? !!img.data[i + c] : !!img.data.readUInt16LE(i + c * 2)
    }
    if (source.realMerged === true || nonBlack) {
      if (profile || source.depth === 16)
        return profiledRgba(img.data, img.width, img.height, profile || (await untaggedRgbProfile()), source.depth, {
          inMemory,
        })
      return {
        input: img.data,
        raw: { width: img.width, height: img.height, channels: 4 },
        width: img.width,
        height: img.height,
      }
    }
  }
  const { PhotoCraftSession } = require('./photocraft')
  const stage = await createPrivateStage(cacheRoot(), 'as-export-'),
    dir = stage.path,
    out = path.join(dir, 'sheet.png')
  const frozen = path.join(dir, `source.${buf.readUInt16BE(4) === 2 ? 'psb' : 'psd'}`)
  let pc = null,
    failure
  try {
    // The source can change after readPsdBuffer's verification, including A→B→A
    // changes hidden from later source hashes. The engine must consume these exact
    // verified bytes, with the same PSD/PSB encoding, rather than reopening its path.
    await stage.reserveBytes(buf.length + source.width * source.height * 4)
    await fs.promises.writeFile(frozen, buf, { flag: 'wx', mode: 0o400 })
    await stage.register(frozen, { digest: crypto.createHash('sha256').update(buf).digest('hex'), readOnly: true })
    pc = new PhotoCraftSession({ writeRoot: dir })
    await pc.call('doc.open', { path: PhotoCraftSession.readPath(frozen) })
    await pc.run('edit.convertToProfile', SRGB_POLICY)
    await pc.call('doc.save', { path: pc.writePath(out) })
  } catch (error) {
    failure = error
  }
  try {
    if (pc) await pc.close()
  } catch (close) {
    if (failure) {
      failure.closeError = close
      failure.message += ` PhotoCraft close also failed: ${close.message}`
    } else failure = close
  }
  if (failure) return finishPrivateStage(stage, failure)
  try {
    await stage.assertFiles()
    await stage.register(out)
    const meta = await require('../../../src/sharp_config').getSharp()(out, { failOn: 'warning' }).metadata()
    if (profile && !meta.icc)
      throw new Error(
        'The editor render did not retain a verifiable colour profile. Save an 8-bit RGB sheet with its compatibility composite before delivery.',
      )
    if (meta.icc) await assertProfileUsable(meta.icc)
    return { input: out, width: meta.width, height: meta.height, cleanup: colourCleanup(stage) }
  } catch (error) {
    return finishPrivateStage(stage, error)
  }
}

module.exports = {
  readPsdBuffer,
  psdPixels,
  profiledRgba,
  profiledCmyk,
  decodeRgbComposite,
  decodeCmykComposite,
  psdProfile,
  rgbaTiffHeader,
  validateProfile,
  assertProfileUsable,
  SRGB_POLICY,
  MAX_PSD_SOURCE_BYTES,
  MAX_COMPOSITE_BYTES,
}
