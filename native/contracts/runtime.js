// Canonical JSON contracts shared by Node and the browser bundle. Keep this module free
// of Node builtins, code generation, filesystem access, normalisation and domain mutation.
'use strict'
const manifest = require('./contract-manifest.json')
const document = require('./album-studio.schema.json')
const MAX_DEPTH = 64,
  MAX_NODES = 2000000,
  MAX_STRING = 1048576,
  MAX_TOTAL_STRING = 64 * 1024 * 1024,
  MAX_STEPS = 16000000,
  MAX_ISSUES = 32
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor'])
const patterns = new Map()
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const escape = (value) => String(value).replace(/~/g, '~0').replace(/\//g, '~1')
const at = (base, key) => `${base}/${escape(key)}`

class ContractError extends Error {
  constructor(message, issues = [], code = 'CONTRACT_INVALID') {
    super(message)
    this.name = 'ContractError'
    this.code = code
    this.issues = issues.slice(0, MAX_ISSUES)
    this.path = (this.issues[0] && this.issues[0].path) || ''
  }
}
function issue(list, path, message, keyword) {
  if (list.length < MAX_ISSUES) list.push({ path, message, keyword })
  return false
}
// Native JSON decoders and filesystem paths require Unicode scalar text. Refuse
// lone UTF-16 surrogates consistently before serializing across either boundary.
function scalarText(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++i)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
function jsonSafe(value) {
  let nodes = 0,
    characters = 0
  const active = new WeakSet(),
    issues = []
  const walk = (item, path, depth, optional = false) => {
    if (++nodes > MAX_NODES) return issue(issues, path, 'The JSON value exceeds the bounded node limit.', 'maxNodes')
    if (depth > MAX_DEPTH) return issue(issues, path, 'The JSON value exceeds the bounded depth limit.', 'maxDepth')
    if (item === undefined && optional) return true // JSON omits optional object properties.
    if (item === null || typeof item === 'boolean') return true
    if (typeof item === 'number')
      return Number.isFinite(item) || issue(issues, path, 'Numbers must be finite JSON values.', 'finite')
    if (typeof item === 'string') {
      if (!scalarText(item)) return issue(issues, path, 'Text must contain valid Unicode scalar values.', 'unicode')
      characters += item.length
      return (
        (item.length <= MAX_STRING && characters <= MAX_TOTAL_STRING) ||
        issue(issues, path, 'The strings exceed the bounded JSON string limit.', 'maxLength')
      )
    }
    if (typeof item !== 'object')
      return issue(
        issues,
        path,
        'Expected a JSON value; functions, bigint, symbols and undefined array items are unsupported.',
        'json',
      )
    if (Array.isArray(item) && item.length > 250000)
      return issue(issues, path, 'The array exceeds the bounded JSON item limit.', 'maxItems')
    if (active.has(item)) return issue(issues, path, 'Cyclic values cannot cross the JSON boundary.', 'cycle')
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return issue(issues, path, 'Only plain JSON objects may cross this boundary.', 'prototype')
    active.add(item)
    const keys = Object.keys(item)
    if (keys.length > 250000) {
      active.delete(item)
      return issue(issues, path, 'The object exceeds the bounded JSON entry limit.', 'maxProperties')
    }
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (Object.getOwnPropertySymbols(item).length)
      issue(issues, path, 'Symbol keys cannot cross the JSON boundary.', 'json')
    for (const key of Object.keys(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue
      const descriptor = descriptors[key]
      if (!descriptor.enumerable && !Array.isArray(item)) continue
      characters += key.length
      if (!scalarText(key)) {
        issue(issues, path, 'JSON keys must contain valid Unicode scalar values.', 'unicode')
        continue
      }
      if (characters > MAX_TOTAL_STRING) {
        issue(issues, path, 'The JSON keys exceed the bounded string limit.', 'maxLength')
        break
      }
      if (Array.isArray(item) && !/^(?:0|[1-9]\d*)$/.test(key)) {
        issue(issues, at(path, key), 'Arrays may only contain indexed JSON entries.', 'json')
        continue
      }
      if (forbiddenKeys.has(key)) {
        issue(issues, at(path, key), 'Prototype-control keys are not valid contract data.', 'propertyNames')
        continue
      }
      if (!own(descriptor, 'value')) {
        issue(issues, at(path, key), 'Accessor properties cannot cross the JSON boundary.', 'accessor')
        continue
      }
      walk(descriptor.value, at(path, key), depth + 1, !Array.isArray(item))
      if (issues.length >= MAX_ISSUES) break
    }
    if (Array.isArray(item))
      for (let i = 0; i < item.length; i++)
        if (!own(descriptors, String(i))) {
          issue(issues, at(path, i), 'Sparse array entries cannot cross the JSON boundary.', 'json')
          break
        }
    active.delete(item)
    return issues.length === 0
  }
  walk(value, '', 0)
  return issues
}
function resolve(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/'))
    throw new ContractError(
      'The canonical schema has an unsupported reference.',
      [{ path: '', message: 'Schema reference is not local.', keyword: '$ref' }],
      'CONTRACT_SCHEMA_INVALID',
    )
  let schema = document
  for (const piece of ref.slice(2).split('/')) {
    const key = piece.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!schema || typeof schema !== 'object' || !own(schema, key))
      throw new ContractError(
        'The canonical schema has an unresolved reference.',
        [{ path: '', message: `Missing schema reference ${ref}.`, keyword: '$ref' }],
        'CONTRACT_SCHEMA_INVALID',
      )
    schema = schema[key]
  }
  return schema
}
const typeMatches = (type, value) =>
  type === 'null'
    ? value === null
    : type === 'array'
      ? Array.isArray(value)
      : type === 'object'
        ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : type === 'integer'
          ? Number.isSafeInteger(value)
          : type === 'number'
            ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === type
function matches(schema, value, path, issues, depth = 0, budget = { steps: 0 }) {
  if (++budget.steps > MAX_STEPS)
    throw new ContractError('The contract validation exceeds the bounded work limit.', [
      { path, message: 'The schema traversal exceeded its work limit.', keyword: 'maxSteps' },
    ])
  if (depth > 512) return issue(issues, path, 'The canonical schema traversal exceeded its recursion limit.', '$ref')
  if (schema === true) return true
  if (schema === false) return issue(issues, path, 'This value is not permitted.', 'false')
  if (!schema || typeof schema !== 'object')
    throw new ContractError('The canonical schema is invalid.', [], 'CONTRACT_SCHEMA_INVALID')
  if (schema.$ref) return matches(resolve(schema.$ref), value, path, issues, depth + 1, budget)
  if (schema.anyOf || schema.oneOf) {
    let count = 0
    for (const candidate of schema.anyOf || schema.oneOf) {
      if (matches(candidate, value, path, [], depth + 1, budget)) count++
      if (count && schema.anyOf) return true
    }
    return (
      (schema.oneOf && count === 1) ||
      issue(
        issues,
        path,
        schema.oneOf ? 'Expected exactly one supported shape.' : 'Expected one of the supported shapes.',
        schema.oneOf ? 'oneOf' : 'anyOf',
      )
    )
  }
  if (schema.type && !typeMatches(schema.type, value)) return issue(issues, path, `Expected ${schema.type}.`, 'type')
  if (own(schema, 'const') && value !== schema.const)
    return issue(issues, path, 'The value does not match its fixed contract discriminator.', 'const')
  if (schema.enum && !schema.enum.some((candidate) => candidate === value))
    return issue(issues, path, 'The value is outside the supported choices.', 'enum')
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return issue(issues, path, 'Numbers must be finite.', 'finite')
    if (schema.minimum !== undefined && value < schema.minimum)
      return issue(issues, path, `The number is below ${schema.minimum}.`, 'minimum')
    if (schema.maximum !== undefined && value > schema.maximum)
      return issue(issues, path, `The number is above ${schema.maximum}.`, 'maximum')
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      return issue(issues, path, 'The string is too short.', 'minLength')
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      return issue(issues, path, 'The string is too long.', 'maxLength')
    if (schema.pattern) {
      if (!patterns.has(schema.pattern)) patterns.set(schema.pattern, new RegExp(schema.pattern, 'u'))
      if (!patterns.get(schema.pattern).test(value))
        return issue(issues, path, 'The string does not match the supported format.', 'pattern')
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return issue(issues, path, 'The array has too few items.', 'minItems')
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return issue(issues, path, 'The array has too many items.', 'maxItems')
    if (schema.items)
      for (let i = 0; i < value.length && issues.length < MAX_ISSUES; i++)
        matches(schema.items, value[i], at(path, i), issues, depth + 1, budget)
    // Canonical uniqueness policies are primitive-only (spread numbers/cache IDs).
    // Never stringify arbitrary nested values to establish uniqueness.
    if (schema.uniqueItems && new Set(value).size !== value.length)
      issue(issues, path, 'Array entries must be unique.', 'uniqueItems')
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined),
      properties = schema.properties || {}
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties)
      return issue(issues, path, 'The object has too many entries.', 'maxProperties')
    for (const key of schema.required || [])
      if (!own(value, key) || value[key] === undefined)
        issue(issues, at(path, key), 'A required field is missing.', 'required')
    for (const key of keys) {
      if (schema.propertyNames) matches(schema.propertyNames, key, at(path, key), issues, depth + 1, budget)
      if (own(properties, key)) matches(properties[key], value[key], at(path, key), issues, depth + 1, budget)
      else if (schema.additionalProperties === false)
        issue(issues, at(path, key), 'The field is not part of this closed contract.', 'additionalProperties')
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        matches(schema.additionalProperties, value[key], at(path, key), issues, depth + 1, budget)
      if (issues.length >= MAX_ISSUES) break
    }
  }
  return issues.length === 0
}
function validateSchema(schema, value, label = 'value') {
  const issues = jsonSafe(value)
  if (!issues.length) matches(schema, value, '', issues)
  if (issues.length)
    throw new ContractError(`Invalid ${label}: ${issues[0].message} (${issues[0].path || '/'}).`, issues)
  return value
}
function methodContract(method) {
  if (typeof method !== 'string' || !own(manifest.methods, method))
    throw new ContractError(
      'The requested method has no supported contract.',
      [{ path: '/method', message: 'Unknown method.', keyword: 'enum' }],
      'METHOD_UNKNOWN',
    )
  return manifest.methods[method]
}
function validateParams(method, params = {}) {
  return validateSchema(methodContract(method).params, params, `${method} parameters`)
}
function validateResult(method, result) {
  return validateSchema(methodContract(method).result, result, `${method} result`)
}
function validateRequest(request) {
  validateSchema(resolve('#/$defs/RequestEnvelope'), request, 'request envelope')
  validateParams(request.method, request.params === undefined ? {} : request.params)
  return request
}
function validateReply(method, reply) {
  methodContract(method)
  validateSchema(resolve('#/$defs/ReplyEnvelope'), reply, 'reply envelope')
  if (reply.ok) validateResult(method, reply.result)
  return reply
}
function validateEvent(event) {
  validateSchema(resolve('#/$defs/EventEnvelope'), event, 'event envelope')
  if (!own(manifest.events, event.event))
    throw new ContractError(
      'The event has no supported contract.',
      [{ path: '/event', message: 'Unknown event.', keyword: 'enum' }],
      'EVENT_UNKNOWN',
    )
  validateSchema(manifest.events[event.event].data, event.data === undefined ? {} : event.data, `${event.event} event`)
  return event
}
function validateProject(project) {
  return validateSchema(resolve('#/$defs/PersistedProject'), project, 'saved project')
}
function validateDefinition(name, value) {
  if (typeof name !== 'string' || !own(document.$defs, name))
    throw new ContractError('Unknown canonical definition.', [], 'CONTRACT_SCHEMA_INVALID')
  return validateSchema(document.$defs[name], value, name)
}
function field(object, key) {
  if (!object || typeof object !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && own(descriptor, 'value') ? descriptor.value : undefined
}
function arrayFields(value, maximum) {
  if (!Array.isArray(value)) return []
  const values = []
  for (let index = 0; index < Math.min(value.length, maximum); index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor && own(descriptor, 'value')) values.push(descriptor.value)
  }
  return values
}
const issueText = (value, fallback, maximum) => (typeof value === 'string' ? value.slice(0, maximum) : fallback)
const messageOf = (error) => {
  const message = typeof error === 'string' ? error : field(error, 'message')
  return typeof message === 'string' && message ? message.slice(0, 16384) : 'The operation could not be completed.'
}
function serializeError(error) {
  const code = field(error, 'code'),
    result = {
      error: messageOf(error),
      code: typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(code) ? code : 'OPERATION_FAILED',
    }
  const booleans = [
    'renderCommitted',
    'renderRestored',
    'projectCommitted',
    'deliveryCommitted',
    'recoveryRequired',
    'cancelled',
    'retryable',
  ]
  const paths = [
    'recoveryStage',
    'recoveryJournal',
    'recoveryLock',
    'snapshotPath',
    'retainedPath',
    'lockPath',
    'recoveryPath',
  ]
  const safePath = (value) =>
    typeof value === 'string' && value.startsWith('/') && !value.includes('\0') && value.length <= 4096
  let source = error
  const seen = new Set()
  for (
    let depth = 0;
    source && typeof source === 'object' && depth < 4 && !seen.has(source);
    depth++, source = field(source, 'cause')
  ) {
    seen.add(source)
    for (const key of booleans)
      if (!own(result, key) && typeof field(source, key) === 'boolean') result[key] = field(source, key)
    for (const key of paths) if (!own(result, key) && safePath(field(source, key))) result[key] = field(source, key)
    const retainedPaths = field(source, 'retainedPaths')
    if (!result.retainedPaths && Array.isArray(retainedPaths))
      result.retainedPaths = arrayFields(retainedPaths, 64).filter(safePath)
    const sourceCode = field(source, 'sourceCode')
    if (!result.sourceCode && typeof sourceCode === 'string' && sourceCode.length > 0 && sourceCode.length <= 128)
      result.sourceCode = sourceCode
    const closeErrors = field(source, 'closeErrors')
    if (!result.closeErrors && Array.isArray(closeErrors))
      result.closeErrors = arrayFields(closeErrors, 64).map(messageOf)
    for (const key of ['cleanupError', 'releaseError'])
      if (!result[key] && field(source, key)) result[key] = messageOf(field(source, key))
  }
  const issues = field(error, 'issues')
  if (Array.isArray(issues))
    result.details = {
      issues: arrayFields(issues, MAX_ISSUES).map((item) => ({
        path: issueText(field(item, 'path'), '', 4096),
        message: issueText(field(item, 'message'), 'Invalid contract value.', 4096),
        keyword: issueText(field(item, 'keyword'), 'contract', 128),
      })),
    }
  if (typeof field(error, 'field') === 'string') result.field = field(error, 'field').slice(0, 4096)
  return validateDefinition('ErrorData', result)
}

function auditSchema(schema) {
  if (schema === true)
    throw new ContractError('Unchecked true schemas are not supported.', [], 'CONTRACT_SCHEMA_INVALID')
  if (schema === false) return
  const supported = new Set([
    '$schema',
    '$id',
    '$comment',
    '$defs',
    'title',
    'description',
    '$ref',
    'type',
    'const',
    'enum',
    'anyOf',
    'oneOf',
    'properties',
    'required',
    'additionalProperties',
    'maxProperties',
    'propertyNames',
    'items',
    'minItems',
    'maxItems',
    'uniqueItems',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'pattern',
  ])
  for (const key of Object.keys(schema))
    if (!supported.has(key))
      throw new ContractError(`Unsupported canonical schema keyword ${key}.`, [], 'CONTRACT_SCHEMA_INVALID')
  if (schema.$ref) {
    resolve(schema.$ref)
    if (Object.keys(schema).some((key) => !['$ref', '$comment', 'description', 'title'].includes(key)))
      throw new ContractError(
        'Reference schemas cannot silently ignore sibling constraints.',
        [],
        'CONTRACT_SCHEMA_INVALID',
      )
  }
  if (schema.anyOf || schema.oneOf) {
    if (Object.keys(schema).some((key) => !['anyOf', 'oneOf', '$comment', 'description', 'title'].includes(key)))
      throw new ContractError(
        'Union schemas cannot silently ignore sibling constraints.',
        [],
        'CONTRACT_SCHEMA_INVALID',
      )
    for (const child of schema.anyOf || schema.oneOf) auditSchema(child)
  }
  if (schema.pattern) new RegExp(schema.pattern, 'u')
  if (
    schema.uniqueItems &&
    (!schema.items ||
      (!['string', 'number', 'integer', 'boolean', 'null'].includes(schema.items.type) &&
        !schema.items.enum?.every((value) => value === null || ['string', 'number', 'boolean'].includes(typeof value))))
  )
    throw new ContractError('Canonical unique arrays require primitive items.', [], 'CONTRACT_SCHEMA_INVALID')
  for (const child of Object.values(schema.$defs || {})) auditSchema(child)
  for (const child of Object.values(schema.properties || {})) auditSchema(child)
  for (const key of ['items', 'propertyNames']) if (schema[key]) auditSchema(schema[key])
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
    auditSchema(schema.additionalProperties)
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
auditSchema(document)
freeze(document)
freeze(manifest)

exports.manifest = manifest
exports.schema = document
exports.limits = Object.freeze({
  maxDepth: MAX_DEPTH,
  maxNodes: MAX_NODES,
  maxStringLength: MAX_STRING,
  maxTotalStringLength: MAX_TOTAL_STRING,
  maxSchemaSteps: MAX_STEPS,
})
exports.ContractError = ContractError
exports.validateRequest = validateRequest
exports.validateParams = validateParams
exports.validateResult = validateResult
exports.validateReply = validateReply
exports.validateEvent = validateEvent
exports.validateProject = validateProject
exports.validateDefinition = validateDefinition
exports.serializeError = serializeError
