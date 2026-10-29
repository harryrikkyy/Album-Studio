// A single print canvas contract shared by planning, rendering and delivery.
'use strict'
const { fileEvidence } = require('./cache')
const MAX_CANVAS_PIXELS = 64 * 1024 * 1024

function printSettings(p = {}, defaultSize = 'original') {
  const size = p.size === undefined ? defaultSize : p.size
  const heightInches = p.heightInches === undefined ? 12 : p.heightInches
  const ppi = p.ppi === undefined ? 300 : p.ppi
  if (
    !['print', 'original'].includes(size) ||
    ![heightInches, ppi].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0) ||
    ppi > 10000
  )
    throw new Error('Choose a valid print height and resolution up to 10,000 PPI.')
  return { size, heightInches, ppi }
}

function printCanvas(width, height, settings) {
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new Error('The template has invalid canvas dimensions.')
  const targetHeight = settings.size === 'print' ? Math.round(settings.heightInches * settings.ppi) : height
  const targetWidth = settings.size === 'print' ? Math.round((width * targetHeight) / height) : width
  if (
    ![targetWidth, targetHeight].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 300000) ||
    targetWidth * targetHeight > MAX_CANVAS_PIXELS
  )
    throw new Error(
      `This print canvas exceeds the ${Math.floor(MAX_CANVAS_PIXELS / 1e6)} megapixel application limit. Choose a smaller physical size or resolution.`,
    )
  return { width: targetWidth, height: targetHeight, scale: targetHeight / height, ppi: settings.ppi }
}

async function psdDimensions(file, expectedDigest) {
  const { prefix: header } = await fileEvidence(file, { prefixBytes: 26, expectedDigest })
  if (header.length !== 26 || header.toString('ascii', 0, 4) !== '8BPS' || ![1, 2].includes(header.readUInt16BE(4)))
    throw new Error('The sheet has an invalid PSD header.')
  const width = header.readUInt32BE(18),
    height = header.readUInt32BE(14)
  if (!width || !height) throw new Error('The sheet has invalid dimensions.')
  return { width, height }
}

/** Apply the same production policy to planned headers and actually decoded pixels. */
function validateSheetPrint({ width, height }, settings, spec, n) {
  if (![width, height].every((v) => Number.isSafeInteger(v) && v > 0))
    throw new Error('The sheet has invalid dimensions.')
  if (settings.size === 'print' && height / settings.heightInches + 1e-7 < settings.ppi)
    throw new Error(
      `Spread ${n}'s sheet supplies ${(height / settings.heightInches).toFixed(1)} PPI at this print size, below the configured ${settings.ppi} PPI policy. Render a larger sheet or choose a smaller physical print size.`,
    )
  if (
    spec &&
    spec.widthInches > 0 &&
    spec.heightInches > 0 &&
    Math.abs(width / height - spec.widthInches / spec.heightInches) > 0.001
  )
    throw new Error(`Spread ${n}'s actual sheet proportions differ from the configured lab dimensions.`)
}

async function meetsPrintResolution(file, settings, expectedDigest) {
  if (settings.size === 'original') return true
  return (await psdDimensions(file, expectedDigest)).height / settings.heightInches + 1e-7 >= settings.ppi
}

module.exports = {
  printSettings,
  printCanvas,
  psdDimensions,
  meetsPrintResolution,
  validateSheetPrint,
  MAX_CANVAS_PIXELS,
}
