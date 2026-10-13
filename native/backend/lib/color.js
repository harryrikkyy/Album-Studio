// ag-psd exposes composite values without their ICC resource. Retain it in a lossless,
// uncompressed TIFF container so libvips performs the source-to-sRGB conversion normally.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const zlib = require('zlib')

const MAX_PROFILE = 16 * 1024 * 1024
const verifiedProfiles = new Map()
const SRGB_POLICY = Object.freeze({ profile: 'srgb', intent: 'perceptual', bpc: false })
const MAX_COMPOSITE_BYTES = 512 * 1024 * 1024

function profileError(detail) {
  return new Error(`The sheet colour profile is invalid or unsupported (${detail}). Assign a valid source profile before exporting.`)
}

function validateCurve(data) {
  const type = data.toString('ascii', 0, 4)
  if (data.length < 12) throw profileError('truncated tone curve')
  if (type === 'curv') {
    const count = data.readUInt32BE(8)
    if (count > (data.length - 12) / 2 || count === 1 && !data.readUInt16BE(12)) throw profileError('invalid tone curve')
  } else if (type === 'para') {
    const fn = data.readUInt16BE(8), parameters = [1, 3, 4, 5, 7][fn]
    if (!parameters || data.length < 12 + parameters * 4 || data.readInt32BE(12) <= 0) throw profileError('invalid parametric tone curve')
    if ((fn === 1 || fn === 2) && data.readInt32BE(16) === 0) throw profileError('tone curve divides by zero')
  } else throw profileError('unknown tone curve type')
}

function validateProfile(profile) {
  if (!Buffer.isBuffer(profile) || profile.length < 132 || profile.length > MAX_PROFILE ||
      profile.readUInt32BE(0) !== profile.length || profile.toString('ascii', 36, 40) !== 'acsp') {
    throw new Error('The sheet has an invalid colour profile. Assign a valid profile in the editor before exporting.')
  }
  const version = profile[8], profileClass = profile.toString('ascii', 12, 16), space = profile.toString('ascii', 16, 20), pcs = profile.toString('ascii', 20, 24)
  if (![2, 4].includes(version)) throw profileError('unsupported ICC version')
  // Source scanner, monitor, printer and colour-space profiles remain supported. Device-link,
  // abstract and named-colour profiles cannot describe these document samples independently.
  if (!['scnr', 'mntr', 'prtr', 'spac'].includes(profileClass)) throw profileError('not a source image profile')
  if (!['RGB ', 'GRAY', 'CMYK', 'Lab '].includes(space) || !['XYZ ', 'Lab '].includes(pcs) || profile.readUInt32BE(64) > 3) throw profileError('invalid colour space, PCS or intent')
  const count = profile.readUInt32BE(128)
  if (!count || count > 4096 || 132 + count * 12 > profile.length) throw new Error('The sheet colour profile has an invalid tag table.')
  const seen = new Set()
  for (let i = 0; i < count; i++) {
    const signature = profile.toString('ascii', 132 + i * 12, 136 + i * 12)
    const offset = profile.readUInt32BE(136 + i * 12)
    const size = profile.readUInt32BE(140 + i * 12)
    if (seen.has(signature) || offset % 4 || offset < 132 + count * 12 || size < 8 || size > profile.length || offset > profile.length - size) throw new Error('The sheet colour profile contains an invalid or truncated tag.')
    seen.add(signature)
    const data = profile.subarray(offset, offset + size)
    if (['rTRC', 'gTRC', 'bTRC', 'kTRC'].includes(signature)) validateCurve(data)
    if (['rXYZ', 'gXYZ', 'bXYZ', 'wtpt'].includes(signature) && (size < 20 || data.toString('ascii', 0, 4) !== 'XYZ ')) throw profileError('invalid matrix or white point tag')
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
    const space = profile.toString('ascii', 16, 20), channels = { 'RGB ': 3, 'GRAY': 1, 'CMYK': 4, 'Lab ': 3 }[space]
    const tags = 11, bitsAt = 8 + 2 + tags * 12 + 4, profileAt = bitsAt + channels * 2, alignedProfileAt = profileAt + profileAt % 2
    const pixelAt = alignedProfileAt + profile.length + profile.length % 2, header = Buffer.alloc(pixelAt)
    header.write('II'); header.writeUInt16LE(42, 2); header.writeUInt32LE(8, 4); header.writeUInt16LE(tags, 8)
    let index = 0
    const tag = (id, type, count, value) => { const at = 10 + index++ * 12; header.writeUInt16LE(id, at); header.writeUInt16LE(type, at + 2); header.writeUInt32LE(count, at + 4); header.writeUInt32LE(value, at + 8) }
    tag(256, 4, 1, 1); tag(257, 4, 1, 1); tag(258, 3, channels, channels === 1 ? 8 : bitsAt); tag(259, 3, 1, 1)
    tag(262, 3, 1, { 'RGB ': 2, 'GRAY': 1, 'CMYK': 5, 'Lab ': 8 }[space]); tag(273, 4, 1, pixelAt)
    tag(277, 3, 1, channels); tag(278, 4, 1, 1); tag(279, 4, 1, channels); tag(284, 3, 1, 1); tag(34675, 7, profile.length, alignedProfileAt)
    for (let i = 0; i < channels; i++) header.writeUInt16LE(8, bitsAt + i * 2)
    profile.copy(header, alignedProfileAt)
    const input = Buffer.concat([header, Buffer.from([64, 128, 192, 32].slice(0, channels))])
    try {
      await require('../../../src/sharp_config').getSharp()(input, { failOn: 'warning' }).withIccProfile(SRGB_POLICY.profile).raw().toBuffer()
    } catch (_) { throw profileError('source transform could not be verified by LittleCMS') }
  })()
  if (verifiedProfiles.size >= 32) verifiedProfiles.delete(verifiedProfiles.keys().next().value)
  verifiedProfiles.set(key, probe)
  try { await probe } catch (error) { verifiedProfiles.delete(key); throw error }
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

function rgbaTiffHeader(width, height, profile, depth = 8) {
  if (![8, 16].includes(depth) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height * 4 * (depth / 8) > 0xffffffff) {
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
  tag(279, 4, 1, width * height * 4 * (depth / 8)); tag(284, 3, 1, 1)
  tag(338, 3, 1, 2); tag(34675, 7, profile.length, profileAt)
  for (let i = 0; i < 4; i++) header.writeUInt16LE(depth, bitsAt + i * 2)
  profile.copy(header, profileAt)
  return header
}

/** Write header and borrowed pixel buffer separately; no extra full-size PNG encode/copy. */
async function profiledRgba(input, width, height, profile, depth = 8) {
  const header = rgbaTiffHeader(width, height, profile, depth)
  await assertProfileUsable(profile)
  if (input.length !== width * height * 4 * (depth / 8)) throw new Error('The sheet composite has an invalid pixel length.')
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

function cmykError(detail) {
  return new Error(`The CMYK sheet cannot be delivered safely (${detail}). Save a real compatibility composite with its CMYK profile, or convert and save an 8-bit RGB sheet in the editor.`)
}

/** Native CMYK compatibility samples, without ag-psd's naive CMYK→RGB preview conversion. */
function decodeCmykComposite(buf) {
  const need = (at, size) => { if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || at < 0 || size < 0 || at > buf.length - size) throw cmykError('truncated document data') }
  need(0, 30)
  if (buf.toString('ascii', 0, 4) !== '8BPS' || buf.readUInt16BE(24) !== 4) throw cmykError('not a CMYK PSD/PSB')
  const version = buf.readUInt16BE(4), channels = buf.readUInt16BE(12), height = buf.readUInt32BE(14), width = buf.readUInt32BE(18), depth = buf.readUInt16BE(22)
  if (![1, 2].includes(version) || ![8, 16].includes(depth) || !width || !height || ![4, 5].includes(channels)) throw cmykError('unsupported depth or extra spot channels')
  const dimensionLimit = version === 1 ? 30000 : 300000
  if (width > dimensionLimit || height > dimensionLimit) throw cmykError('dimensions exceed the PSD/PSB format limit')
  const sample = depth / 8, rowBytes = width * sample, rows = channels * height, expected = rowBytes * rows
  if (!Number.isSafeInteger(expected) || expected > MAX_COMPOSITE_BYTES) throw cmykError('compatibility composite exceeds the 512 MiB decoding limit')
  let at = 30 + buf.readUInt32BE(26)
  need(at, 4)
  const resourcesLength = buf.readUInt32BE(at), resourceStart = at + 4, resourceEnd = resourceStart + resourcesLength
  need(resourceStart, resourcesLength)
  let realMerged = null
  for (let r = resourceStart; r < resourceEnd;) {
    need(r, 7)
    if (buf.toString('ascii', r, r + 4) !== '8BIM') throw cmykError('invalid resource signature')
    const id = buf.readUInt16BE(r + 4), nameSize = 1 + buf[r + 6], sizeAt = r + 6 + nameSize + nameSize % 2
    if (sizeAt + 4 > resourceEnd) throw cmykError('truncated resource name')
    const size = buf.readUInt32BE(sizeAt), dataAt = sizeAt + 4
    if (dataAt + size > resourceEnd) throw cmykError('truncated resource')
    if (id === 1057) {
      if (size < 5 || buf.readUInt32BE(dataAt) !== 1 || realMerged !== null) throw cmykError('invalid merged-composite declaration')
      realMerged = !!buf[dataAt + 4]
    }
    r = dataAt + size + size % 2
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
  const layerLength = sectionLength(at), layerAt = at + lengthBytes
  need(layerAt, layerLength)
  let alpha = false
  if (layerLength) {
    if (layerLength < lengthBytes) throw cmykError('truncated layer section')
    const infoLength = sectionLength(layerAt)
    if (infoLength > layerLength - lengthBytes) throw cmykError('invalid layer information length')
    if (infoLength) {
      if (infoLength < 2) throw cmykError('truncated layer count')
      const hasAlpha = buf.readInt16BE(layerAt + lengthBytes) < 0
      if (hasAlpha && channels < 5) throw cmykError('transparency plane is missing')
      alpha = channels === 5 && hasAlpha
    }
  }
  if (channels === 5 && !alpha) throw cmykError('an extra channel is not identified as transparency')
  at = layerAt + layerLength
  need(at, 2)
  const compression = buf.readUInt16BE(at); at += 2
  let planar
  if (compression === 0) {
    need(at, expected); planar = buf.subarray(at, at + expected)
  } else if (compression === 1) {
    const countBytes = version === 2 ? 4 : 2, tableSize = rows * countBytes
    need(at, tableSize)
    const tableAt = at; at += tableSize
    let encodedTotal = 0
    for (let row = 0; row < rows; row++) encodedTotal += countBytes === 4 ? buf.readUInt32BE(tableAt + row * countBytes) : buf.readUInt16BE(tableAt + row * countBytes)
    need(at, encodedTotal)
    planar = Buffer.allocUnsafe(expected)
    for (let row = 0; row < rows; row++) {
      const length = countBytes === 4 ? buf.readUInt32BE(tableAt + row * countBytes) : buf.readUInt16BE(tableAt + row * countBytes)
      const end = at + length, destination = row * rowBytes
      let decoded = 0
      while (at < end) {
        const control = buf[at++]
        if (control === 128) continue
        const count = control < 128 ? control + 1 : 257 - control
        if (decoded + count > rowBytes) throw cmykError('an RLE row exceeds its width')
        if (control < 128) {
          if (at + count > end) throw cmykError('truncated RLE literal')
          buf.copy(planar, destination + decoded, at, at + count); at += count
        } else {
          if (at >= end) throw cmykError('truncated RLE repeat')
          planar.fill(buf[at++], destination + decoded, destination + decoded + count)
        }
        decoded += count
      }
      if (decoded !== rowBytes) throw cmykError('truncated RLE row')
    }
  } else if (compression === 2 || compression === 3) {
    try { planar = zlib.inflateSync(buf.subarray(at), { maxOutputLength: expected }) } catch (_) { throw cmykError('invalid or oversized ZIP composite') }
    if (planar.length !== expected) throw cmykError('ZIP composite length does not match its planes')
    if (compression === 3) for (let row = 0; row < rows; row++) {
      const start = row * rowBytes
      for (let x = 1; x < width; x++) {
        const pos = start + x * sample
        if (depth === 8) planar[pos] = (planar[pos] + planar[pos - 1]) & 255
        else planar.writeUInt16BE((planar.readUInt16BE(pos) + planar.readUInt16BE(pos - 2)) & 65535, pos)
      }
    }
  } else throw cmykError('unsupported composite compression')
  const data = Buffer.allocUnsafe(expected), pixels = width * height, maximum = depth === 8 ? 255 : 65535
  const read = (position) => depth === 8 ? planar[position] : planar.readUInt16BE(position)
  const write = (position, value) => { if (depth === 8) data[position] = value; else data.writeUInt16LE(value, position) }
  for (let i = 0; i < pixels; i++) {
    const a = alpha ? read((4 * pixels + i) * sample) : maximum
    for (let c = 0; c < 4; c++) {
      // CMYK compatibility planes are inverted and matted against white (zero ink).
      const ink = maximum - read((c * pixels + i) * sample)
      write((i * channels + c) * sample, alpha ? (a ? Math.min(maximum, Math.round(ink * maximum / a)) : 0) : ink)
    }
    if (alpha) write((i * channels + 4) * sample, a)
  }
  return { data, width, height, channels, depth, alpha }
}

async function profiledCmyk(composite, profile) {
  await assertProfileUsable(profile)
  if (profile.toString('ascii', 16, 20) !== 'CMYK') throw cmykError('source profile is not CMYK')
  const { data, width, height, channels, depth, alpha } = composite
  const tags = alpha ? 13 : 12, bitsAt = 8 + 2 + tags * 12 + 4, profileAt = bitsAt + channels * 2
  const pixelsAt = profileAt + profile.length + profile.length % 2, header = Buffer.alloc(pixelsAt)
  header.write('II'); header.writeUInt16LE(42, 2); header.writeUInt32LE(8, 4); header.writeUInt16LE(tags, 8)
  let index = 0
  const tag = (id, type, count, value) => { const at = 10 + index++ * 12; header.writeUInt16LE(id, at); header.writeUInt16LE(type, at + 2); header.writeUInt32LE(count, at + 4); header.writeUInt32LE(value, at + 8) }
  tag(256, 4, 1, width); tag(257, 4, 1, height); tag(258, 3, channels, bitsAt); tag(259, 3, 1, 1); tag(262, 3, 1, 5)
  tag(273, 4, 1, pixelsAt); tag(277, 3, 1, channels); tag(278, 4, 1, height); tag(279, 4, 1, data.length); tag(284, 3, 1, 1); tag(332, 3, 1, 1)
  if (alpha) tag(338, 3, 1, 2)
  tag(34675, 7, profile.length, profileAt)
  for (let i = 0; i < channels; i++) header.writeUInt16LE(depth, bitsAt + i * 2)
  profile.copy(header, profileAt)
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'as-colour-')), file = path.join(dir, 'composite.tif')
  const cleanup = () => fs.promises.rm(dir, { recursive: true, force: true })
  let handle
  try {
    handle = await fs.promises.open(file, 'wx', 0o600); await handle.writeFile(header); await handle.writeFile(data); await handle.close(); handle = null
    return { input: file, width, height, cleanup }
  } catch (error) { if (handle) await handle.close().catch(() => {}); await cleanup(); throw error }
}

let agpsd = null, defaultRgbProfile = null
function compositeReader() {
  if (!agpsd) {
    agpsd = require('ag-psd')
    agpsd.initializeCanvas((w, h) => ({ width: w, height: h, getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }) }) }))
  }
  return agpsd
}
async function untaggedRgbProfile() {
  if (!defaultRgbProfile) defaultRgbProfile = (async () => {
    const sharp = require('../../../src/sharp_config').getSharp()
    const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).withIccProfile('srgb').jpeg().toBuffer()
    return (await sharp(image).metadata()).icc
  })()
  return defaultRgbProfile
}

/** Shared verified PSD pixels for production sheets and original template backdrops. */
async function psdPixels(psdPath, { buffer } = {}) {
  const buf = buffer || await fs.promises.readFile(psdPath), profile = psdProfile(buf)
  if (profile) await assertProfileUsable(profile)
  if (buf.length >= 26 && buf.toString('ascii', 0, 4) === '8BPS' && buf.readUInt16BE(24) === 4) {
    if (!profile) throw cmykError('the actual source profile is absent')
    return profiledCmyk(decodeCmykComposite(buf), profile)
  }
  let psd = null
  try { psd = compositeReader().readPsd(buf, { skipLayerImageData: true, skipCompositeImageData: false, skipThumbnail: true, useImageData: true }) } catch (_) { /* the engine tries unsupported RGB encodings */ }
  const img = psd && psd.imageData
  const realMerged = psd && psd.imageResources && psd.imageResources.versionInfo && psd.imageResources.versionInfo.hasRealMergedData
  if (img && realMerged !== false && [8, 16].includes(psd.bitsPerChannel) && psd.colorMode === 3 && img.data.length === img.width * img.height * 4) {
    let nonBlack = false
    for (let i = 0; i < img.data.length && !nonBlack; i += 4) nonBlack = !!(img.data[i] || img.data[i + 1] || img.data[i + 2])
    if (realMerged === true || nonBlack) {
      const input = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength)
      if (profile || psd.bitsPerChannel === 16) return profiledRgba(input, img.width, img.height, profile || await untaggedRgbProfile(), psd.bitsPerChannel)
      return { input, raw: { width: img.width, height: img.height, channels: 4 }, width: img.width, height: img.height }
    }
  }
  const { PhotoCraftSession } = require('./photocraft')
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'as-export-')), out = path.join(dir, 'sheet.png')
  const pc = new PhotoCraftSession({ writeRoot: dir }), cleanup = () => fs.promises.rm(dir, { recursive: true, force: true })
  try {
    await pc.call('doc.open', { path: PhotoCraftSession.readPath(psdPath) })
    await pc.run('edit.convertToProfile', SRGB_POLICY)
    await pc.call('doc.save', { path: pc.writePath(out) })
  } catch (error) { await cleanup(); throw error } finally { await pc.close() }
  try {
    const meta = await require('../../../src/sharp_config').getSharp()(out, { failOn: 'warning' }).metadata()
    if (profile && !meta.icc) throw new Error('The editor render did not retain a verifiable colour profile. Save an 8-bit RGB sheet with its compatibility composite before delivery.')
    if (meta.icc) await assertProfileUsable(meta.icc)
    return { input: out, width: meta.width, height: meta.height, cleanup }
  } catch (error) { await cleanup(); throw error }
}

module.exports = { psdPixels, profiledRgba, profiledCmyk, decodeCmykComposite, psdProfile, rgbaTiffHeader, validateProfile, assertProfileUsable, SRGB_POLICY, MAX_COMPOSITE_BYTES }
