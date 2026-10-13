'use strict'

const fs = require('fs')
const zlib = require('zlib')
const ag = require('ag-psd')
const sharp = require('../../../src/sharp_config').getSharp()
const W = 48, H = 24

function rgbPixels(color = null) {
  const data = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(color || (x < W / 2 ? [210, 110, 75, 255] : [50, 140, 200, 255]), (y * W + x) * 4)
  return data
}

async function icc(name) {
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#888' } }).withIccProfile(name).jpeg().toBuffer()
  return (await sharp(image).metadata()).icc
}

function resource(id, data) {
  const header = Buffer.alloc(12)
  header.write('8BIM'); header.writeUInt16BE(id, 4); header.writeUInt32BE(data.length, 8)
  return Buffer.concat([header, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

function taggedPsd8(file, profile, pixels = rgbPixels(), { realMerged = true, withComposite = true, compositePixels = pixels } = {}) {
  const imageData = { width: W, height: H, data: new Uint8ClampedArray(pixels) }
  const bytes = ag.writePsdBuffer({ width: W, height: H,
    ...(withComposite ? { imageData: { width: W, height: H, data: new Uint8ClampedArray(compositePixels) } } : {}),
    children: [{ name: 'Synthetic patches', left: 0, top: 0, right: W, bottom: H, imageData }],
    imageResources: { versionInfo: { hasRealMergedData: realMerged, writerName: 'Album Studio synthetic test', readerName: 'Synthetic', fileVersion: 1 } },
  })
  if (!profile) { fs.writeFileSync(file, bytes); return }
  const at = 30 + bytes.readUInt32BE(26), length = bytes.readUInt32BE(at), block = resource(1039, profile), nextLength = Buffer.alloc(4)
  nextLength.writeUInt32BE(length + block.length)
  fs.writeFileSync(file, Buffer.concat([bytes.subarray(0, at), nextLength, bytes.subarray(at + 4, at + 4 + length), block, bytes.subarray(at + 4 + length)]))
}

/** Independently authored matrix/TRC fixture compatible with the public Adobe RGB encoding.
 * D50 PCS matrix and gamma 563/256: AdobeRGB1998.pdf section 4.3.7, not a copied vendor profile.
 */
function adobeCompatibleProfile(version = 2, profileClass = 'mntr') {
  const xyz = (values) => { const b = Buffer.alloc(20); b.write('XYZ '); values.forEach((v, i) => b.writeInt32BE(Math.round(v * 65536), 8 + i * 4)); return b }
  const curve = Buffer.alloc(14); curve.write('curv'); curve.writeUInt32BE(1, 8); curve.writeUInt16BE(563, 12)
  const description = Buffer.from('RGB fixture compatible with Adobe RGB (1998)\0'), desc = Buffer.alloc(12 + description.length + 78)
  desc.write('desc'); desc.writeUInt32BE(description.length, 8); description.copy(desc, 12)
  const copyright = Buffer.concat([Buffer.from('text\0\0\0\0'), Buffer.from('Public specification fixture\0')])
  const tags = [['desc', desc], ['cprt', copyright], ['wtpt', xyz([0.9642, 1, 0.8249])],
    ['rXYZ', xyz([0.60974, 0.31111, 0.01947])], ['gXYZ', xyz([0.20528, 0.62567, 0.06087])], ['bXYZ', xyz([0.14919, 0.06322, 0.74457])],
    ['rTRC', curve], ['gTRC', curve], ['bTRC', curve]]
  const header = Buffer.alloc(132 + tags.length * 12), bodies = []
  header[8] = version; header[9] = version === 2 ? 0x10 : 0x20
  header.write(profileClass, 12); header.write('RGB ', 16); header.write('XYZ ', 20); header.write('acsp', 36); header.write('TEST', 80)
  header.writeUInt16BE(2026, 24); header.writeUInt16BE(1, 26); header.writeUInt16BE(1, 28)
  ;[0.9642, 1, 0.8249].forEach((v, i) => header.writeInt32BE(Math.round(v * 65536), 68 + i * 4))
  header.writeUInt32BE(tags.length, 128)
  let offset = header.length
  for (const [i, [name, data]] of tags.entries()) {
    const at = 132 + i * 12
    header.write(name, at); header.writeUInt32BE(offset, at + 4); header.writeUInt32BE(data.length, at + 8)
    const padding = (4 - data.length % 4) % 4
    bodies.push(data, Buffer.alloc(padding)); offset += data.length + padding
  }
  header.writeUInt32BE(offset)
  return Buffer.concat([header, ...bodies])
}

/** Original portable ICC v2 gray gamma 2.2 fixture from the ICC curve/XYZ tag definitions. */
function grayGammaProfile() {
  const xyz = Buffer.alloc(20); xyz.write('XYZ ')
  ;[0.9642, 1, 0.8249].forEach((v, i) => xyz.writeInt32BE(Math.round(v * 65536), 8 + i * 4))
  const curve = Buffer.alloc(14); curve.write('curv'); curve.writeUInt32BE(1, 8); curve.writeUInt16BE(Math.round(2.2 * 256), 12)
  const text = Buffer.concat([Buffer.from('text\0\0\0\0'), Buffer.from('Original public ICC gray gamma fixture\0')])
  const tags = [['wtpt', xyz], ['kTRC', curve], ['cprt', text]]
  const header = Buffer.alloc(132 + tags.length * 12), bodies = []
  header[8] = 2; header[9] = 0x10; header.write('mntr', 12); header.write('GRAY', 16); header.write('XYZ ', 20); header.write('acsp', 36)
  header.writeUInt16BE(2026, 24); header.writeUInt16BE(1, 26); header.writeUInt16BE(1, 28)
  ;[0.9642, 1, 0.8249].forEach((v, i) => header.writeInt32BE(Math.round(v * 65536), 68 + i * 4))
  header.writeUInt32BE(tags.length, 128)
  let offset = header.length
  for (const [i, [name, data]] of tags.entries()) {
    const at = 132 + i * 12, padding = (4 - data.length % 4) % 4
    header.write(name, at); header.writeUInt32BE(offset, at + 4); header.writeUInt32BE(data.length, at + 8)
    bodies.push(data, Buffer.alloc(padding)); offset += data.length + padding
  }
  header.writeUInt32BE(offset)
  return Buffer.concat([header, ...bodies])
}

/** Original RGB LUT source profile using the public lut8Type structure (v2 and v4). */
function rgbLutProfile(version = 4) {
  const base = adobeCompatibleProfile(version, 'prtr'), tags = []
  for (let i = 0; i < base.readUInt32BE(128); i++) {
    const at = 132 + i * 12, name = base.toString('ascii', at, at + 4)
    if (['desc', 'cprt', 'wtpt'].includes(name)) tags.push([name, base.subarray(base.readUInt32BE(at + 4), base.readUInt32BE(at + 4) + base.readUInt32BE(at + 8))])
  }
  const lut = Buffer.alloc(48 + 3 * 256 + 8 * 3 + 3 * 256)
  lut.write('mft1'); lut[8] = 3; lut[9] = 3; lut[10] = 2
  for (let i = 0; i < 3; i++) lut.writeInt32BE(65536, 12 + (i * 3 + i) * 4)
  for (let c = 0; c < 3; c++) for (let i = 0; i < 256; i++) { lut[48 + c * 256 + i] = i; lut[48 + 3 * 256 + 8 * 3 + c * 256 + i] = i }
  let at = 48 + 3 * 256
  for (let r = 0; r <= 1; r++) for (let g = 0; g <= 1; g++) for (let b = 0; b <= 1; b++) {
    for (const value of [0.60974 * r + 0.20528 * g + 0.14919 * b, 0.31111 * r + 0.62567 * g + 0.06322 * b, 0.01947 * r + 0.06087 * g + 0.74457 * b]) lut[at++] = Math.round(value * 128)
  }
  tags.push(['A2B0', lut])
  const header = Buffer.alloc(132 + tags.length * 12), bodies = []
  base.copy(header, 0, 0, 128); header.writeUInt32BE(tags.length, 128)
  let offset = header.length
  for (const [i, [name, data]] of tags.entries()) {
    const entry = 132 + i * 12, padding = (4 - data.length % 4) % 4
    header.write(name, entry); header.writeUInt32BE(offset, entry + 4); header.writeUInt32BE(data.length, entry + 8)
    bodies.push(data, Buffer.alloc(padding)); offset += data.length + padding
  }
  header.writeUInt32BE(offset)
  return Buffer.concat([header, ...bodies])
}

/** Layerless PSD by the published format; channels are planar and 16-bit values big-endian. */
function rawPsd(file, { depth = 16, mode = 3, values, profile, version = 1, compression = 0, channels = mode === 4 ? 4 : 3, realMerged = null, width = W, height = H, alphaDeclared = channels === 5 }) {
  const sampleBytes = depth / 8, pixels = width * height, maximum = depth === 8 ? 255 : 65535
  const header = Buffer.alloc(26)
  header.write('8BPS'); header.writeUInt16BE(version, 4); header.writeUInt16BE(channels, 12)
  header.writeUInt32BE(height, 14); header.writeUInt32BE(width, 18); header.writeUInt16BE(depth, 22); header.writeUInt16BE(mode, 24)
  const mergedInfo = Buffer.alloc(17); mergedInfo.writeUInt32BE(1); mergedInfo[4] = realMerged ? 1 : 0; mergedInfo.writeUInt32BE(1, 13)
  const resources = Buffer.concat([...(profile ? [resource(1039, profile)] : []), ...(realMerged !== null ? [resource(1057, mergedInfo)] : [])]), resourceLength = Buffer.alloc(4)
  resourceLength.writeUInt32BE(resources.length)
  const planar = Buffer.alloc(pixels * channels * sampleBytes)
  for (let c = 0; c < channels; c++) for (let i = 0; i < pixels; i++) {
    let value = values[i * channels + c]
    if (mode === 4 && c < 4) value = maximum - (channels === 5 ? Math.round(value * values[i * channels + 4] / maximum) : value)
    const at = (c * pixels + i) * sampleBytes
    if (depth === 16) planar.writeUInt16BE(value, at)
    else planar[at] = value
  }
  let encoded = planar
  if (compression === 1) {
    const rows = [], countBytes = version === 2 ? 4 : 2, counts = Buffer.alloc(channels * height * countBytes), rowBytes = width * sampleBytes
    for (let row = 0; row < channels * height; row++) {
      const input = planar.subarray(row * rowBytes, (row + 1) * rowBytes), pieces = []
      for (let at = 0; at < input.length;) {
        let run = 1
        while (run < 128 && at + run < input.length && input[at + run] === input[at]) run++
        if (run >= 3) { pieces.push(Buffer.from([257 - run, input[at]])); at += run }
        else { const size = Math.min(128, input.length - at); pieces.push(Buffer.from([size - 1]), input.subarray(at, at + size)); at += size }
      }
      const packed = Buffer.concat(pieces)
      if (countBytes === 4) counts.writeUInt32BE(packed.length, row * countBytes)
      else counts.writeUInt16BE(packed.length, row * countBytes)
      rows.push(packed)
    }
    encoded = Buffer.concat([counts, ...rows])
  } else if (compression === 2 || compression === 3) {
    const predicted = Buffer.from(planar), rowBytes = width * sampleBytes
    if (compression === 3) for (let row = 0; row < channels * height; row++) for (let x = width - 1; x > 0; x--) {
      const at = row * rowBytes + x * sampleBytes
      if (depth === 8) predicted[at] = (predicted[at] - predicted[at - 1]) & 255
      else predicted.writeUInt16BE((predicted.readUInt16BE(at) - predicted.readUInt16BE(at - 2)) & 65535, at)
    }
    encoded = zlib.deflateSync(predicted)
  }
  const compressionField = Buffer.alloc(2); compressionField.writeUInt16BE(compression)
  const lengthBytes = version === 2 ? 8 : 4
  let layerSection = Buffer.alloc(lengthBytes)
  if (alphaDeclared) {
    // A negative layer count, rather than simply the fifth channel, identifies merged
    // transparency. Include one valid empty layer record (no channel data), with an empty
    // mask/blend-range/name block and the global-mask length.
    const info = Buffer.alloc(48)
    info.writeInt16BE(-1); info.write('8BIM', 20); info.write('norm', 24); info[28] = 255; info.writeUInt32BE(12, 32)
    const body = Buffer.concat([Buffer.alloc(lengthBytes), info, Buffer.alloc(4)])
    if (version === 2) body.writeBigUInt64BE(BigInt(info.length)); else body.writeUInt32BE(info.length)
    const size = Buffer.alloc(lengthBytes)
    if (version === 2) size.writeBigUInt64BE(BigInt(body.length)); else size.writeUInt32BE(body.length)
    layerSection = Buffer.concat([size, body])
  }
  fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(4), resourceLength, resources, layerSection, compressionField, encoded]))
}

function pngChunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4)
  length.writeUInt32BE(data.length); crc.writeUInt32BE(zlib.crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}

/** Independent PNG container construction, including source sample precision and ICC bytes. */
function taggedPng(values, channels, depth, profile) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W); ihdr.writeUInt32BE(H, 4); ihdr[8] = depth; ihdr[9] = channels === 4 ? 6 : 2
  const bytes = depth / 8, stride = W * channels * bytes + 1, rows = Buffer.alloc(H * stride)
  for (let y = 0; y < H; y++) for (let x = 0; x < W * channels; x++) {
    const at = y * stride + 1 + x * bytes, value = values[y * W * channels + x]
    if (depth === 16) rows.writeUInt16BE(value, at)
    else rows[at] = value
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    ...(profile ? [pngChunk('iCCP', Buffer.concat([Buffer.from('Synthetic source\0\0'), zlib.deflateSync(profile)]))] : []),
    pngChunk('IDAT', zlib.deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))])
}

/** Independent CMYK TIFF oracle with direct ink samples, no alpha or PSD conversion. */
function taggedCmykTiff(values, profile, { depth = 8, channels = 4, width = W, height = H } = {}) {
  const alpha = channels === 5, tags = alpha ? 13 : 12, bitsAt = 8 + 2 + tags * 12 + 4, profileAt = bitsAt + channels * 2, pixelAt = profileAt + profile.length + profile.length % 2
  const data = depth === 8 ? Buffer.from(values) : Buffer.alloc(values.length * 2)
  if (depth === 16) for (let i = 0; i < values.length; i++) data.writeUInt16LE(values[i], i * 2)
  const header = Buffer.alloc(pixelAt)
  header.write('II'); header.writeUInt16LE(42, 2); header.writeUInt32LE(8, 4); header.writeUInt16LE(tags, 8)
  let index = 0
  const tag = (id, type, count, value) => { const at = 10 + index++ * 12; header.writeUInt16LE(id, at); header.writeUInt16LE(type, at + 2); header.writeUInt32LE(count, at + 4); header.writeUInt32LE(value, at + 8) }
  tag(256, 4, 1, width); tag(257, 4, 1, height); tag(258, 3, channels, bitsAt); tag(259, 3, 1, 1); tag(262, 3, 1, 5)
  tag(273, 4, 1, pixelAt); tag(277, 3, 1, channels); tag(278, 4, 1, height); tag(279, 4, 1, data.length); tag(284, 3, 1, 1); tag(332, 3, 1, 1)
  if (alpha) tag(338, 3, 1, 2)
  tag(34675, 7, profile.length, profileAt)
  for (let i = 0; i < channels; i++) header.writeUInt16LE(depth, bitsAt + i * 2)
  profile.copy(header, profileAt)
  return Buffer.concat([header, data])
}

module.exports = { W, H, rgbPixels, icc, resource, taggedPsd8, rawPsd, taggedPng, taggedCmykTiff, adobeCompatibleProfile, grayGammaProfile, rgbLutProfile }
