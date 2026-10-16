'use strict'
const { spreadInputs, hashInputValues } = require('./inputs')
const { BUILDER_VERSION, HEADROOM } = require('./render_recipe')

function renderInputHash(values) { return hashInputValues([BUILDER_VERSION, HEADROOM], values) }
async function spreadHash(spread, album, workspace) { return renderInputHash(await spreadInputs(spread, album, workspace)) }

module.exports = { spreadHash, renderInputHash }
