#!/usr/bin/env node
// Source-level architecture gate. This checks graph/inventory/packaging drift; it does
// not prove schema semantics, native execution, project migrations or workflow correctness.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { builtinModules } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const js = /\.(?:[cm]?js|tsx?)$/
const forward = (file) => file.split(path.sep).join('/')
export const defaultPolicy = {
  roots: ['src', 'native/backend', 'native/ui/src', 'native/contracts'],
  excludeDirectories: ['test', 'tests', 'node_modules', 'dist', 'target'],
  layers: [
    { name: 'contracts', prefixes: ['native/contracts/'], allows: ['contracts'] },
    { name: 'ui', prefixes: ['native/ui/src/'], allows: ['ui', 'contracts'], browser: true },
    { name: 'backend', prefixes: ['native/backend/'], allows: ['backend', 'shared', 'contracts'] },
    { name: 'shared', prefixes: ['src/'], allows: ['shared'] },
    { name: 'issuer', prefixes: ['server/'], allows: ['issuer'] },
  ],
  forbiddenPackages: ['electron', '@electron/', 'firebase-admin'],
  allowCycles: false,
  runtime: {
    entries: ['native/backend/server.js'],
    resources: [
      'src/license_public_key.pem',
      'native/contracts/contract-manifest.json',
      'native/contracts/album-studio.schema.json',
    ],
    collector: 'native/scripts/collect-backend.mjs',
  },
  reachability: {
    entries: ['native/backend/server.js', 'native/ui/src/main.tsx', 'server/index.js', 'server/keygen.js'],
    // Top-level tool scripts are entry points too: a module only a tool uses is still live.
    entryDirectories: ['native/scripts', 'scripts', 'bench'],
  },
  contracts: {
    manifest: 'native/contracts/contract-manifest.json',
    schema: 'native/contracts/album-studio.schema.json',
    methodRegistry: { file: 'native/backend/methods.js', variable: 'methods' },
    nativeSource: 'native/photocraft/apps/album-studio/src/shell.rs',
    nativeEventSources: ['native/photocraft/apps/album-studio/src/backend.rs'],
    runtime: 'native/contracts/runtime.js',
    types: 'native/contracts/types.ts',
    validationSites: ['native/backend/server.js', 'native/ui/src/bridge.ts'],
    typesGenerator: 'native/scripts/generate-contract-types.mjs',
  },
}

function filesUnder(root, policy) {
  const found = new Set()
  const walk = (folder) => {
    if (!fs.existsSync(folder)) return
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw Error(`Architecture inputs must be independent source files/directories: ${folder}/${entry.name}`)
      if (entry.isDirectory()) {
        if (!policy.excludeDirectories.includes(entry.name)) walk(path.join(folder, entry.name))
      } else if (entry.isFile() && js.test(entry.name))
        found.add(forward(path.relative(root, path.join(folder, entry.name))))
    }
  }
  for (const folder of policy.roots) walk(path.join(root, folder))
  return [...found].sort()
}
function resolveLocal(root, from, spec) {
  const base = path.resolve(root, path.dirname(from), spec)
  for (const file of [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.json`,
    path.join(base, 'index.js'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return forward(path.relative(root, file))
  }
  return null
}
const sourceOf = (file, text) =>
  ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  )
const callName = (expression) =>
  ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression)
      ? expression.name.text
      : null
const literal = (expression) =>
  expression && (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : null
function refsIn(source) {
  const edges = [],
    dynamic = []
  const add = (node, spec, runtime, kind) => {
    if (spec === null)
      dynamic.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind })
    else edges.push({ spec, runtime, kind })
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier)
      add(node, literal(node.moduleSpecifier), !node.importClause?.isTypeOnly, 'import')
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
      add(node, literal(node.moduleSpecifier), !node.isTypeOnly, 'export')
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add(node, literal(node.moduleReference.expression), !node.isTypeOnly, 'import-equals')
    else if (
      ts.isCallExpression(node) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    )
      add(
        node,
        literal(node.arguments[0]),
        true,
        node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require',
      )
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { edges, dynamic }
}
function objectKeys(source, variable) {
  let value
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === variable &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      value = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!value) throw Error(`No literal ${variable} registry in ${source.fileName}`)
  const keys = value.properties
    .map((property) => {
      if (ts.isSpreadAssignment(property) || !property.name || ts.isComputedPropertyName(property.name))
        throw Error(`The ${variable} registry needs explicit statically enumerable keys: ${source.fileName}`)
      return property.name.text
    })
    .sort()
  if (new Set(keys).size !== keys.length) throw Error(`Duplicate keys in ${variable}: ${source.fileName}`)
  return keys
}
function unionStrings(type) {
  if (!type) return null
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteralLike(type.literal)) return [type.literal.text]
  if (ts.isUnionTypeNode(type)) {
    const parts = type.types.map(unionStrings)
    return parts.every(Boolean) ? parts.flat() : null
  }
  return null
}
function staticStrings(expression, source, seen = new Set()) {
  const text = literal(expression)
  if (text !== null) return [text]
  if (!expression) return null
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression))
    return staticStrings(expression.expression, source, seen)
  if (ts.isConditionalExpression(expression)) {
    const a = staticStrings(expression.whenTrue, source, seen),
      b = staticStrings(expression.whenFalse, source, seen)
    return a && b ? [...new Set([...a, ...b])] : null
  }
  if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
    const next = new Set([...seen, expression.text])
    for (let scope = expression.parent; scope; scope = scope.parent) {
      if (ts.isFunctionLike(scope)) {
        const parameter = scope.parameters.find(
          (item) => ts.isIdentifier(item.name) && item.name.text === expression.text,
        )
        if (parameter)
          return (
            unionStrings(parameter.type) ||
            (parameter.initializer ? staticStrings(parameter.initializer, source, next) : null)
          )
      }
      const declarations = ts.isSourceFile(scope) || ts.isBlock(scope) ? scope.statements : []
      for (const statement of declarations)
        if (ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === expression.text)
              return (
                unionStrings(declaration.type) ||
                (declaration.initializer ? staticStrings(declaration.initializer, source, next) : null)
              )
          }
    }
  }
  return null
}
function protocolUse(source, root, file) {
  const calls = [],
    events = [],
    dynamicCalls = [],
    dynamicEvents = [],
    aliases = new Set(),
    eventAliases = new Set(['emit', 'onEvent']),
    namespaces = new Set()
  for (const statement of source.statements)
    if (ts.isImportDeclaration(statement) && statement.importClause && literal(statement.moduleSpecifier) !== null) {
      const target = resolveLocal(root, file, literal(statement.moduleSpecifier))
      if (target !== 'native/ui/src/bridge.ts') continue
      const bindings = statement.importClause.namedBindings
      if (bindings && ts.isNamedImports(bindings))
        for (const binding of bindings.elements) {
          if ((binding.propertyName || binding.name).text === 'call') aliases.add(binding.name.text)
          if ((binding.propertyName || binding.name).text === 'onEvent') eventAliases.add(binding.name.text)
        }
      else if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    }
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression),
        values = staticStrings(node.arguments[0], source),
        line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      const namespace =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        namespaces.has(node.expression.expression.text)
      if ((ts.isIdentifier(node.expression) && aliases.has(name)) || (namespace && name === 'call')) {
        if (values) calls.push(...values)
        else dynamicCalls.push({ file, line })
      }
      if (eventAliases.has(name) || (namespace && name === 'onEvent')) {
        if (values) events.push(...values.filter((value) => value !== '*'))
        else dynamicEvents.push({ file, line, name })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { calls, events, dynamicCalls, dynamicEvents }
}
function usesValidator(source, root, file, runtime) {
  const bindings = new Set()
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      literal(statement.moduleSpecifier) !== null &&
      resolveLocal(root, file, literal(statement.moduleSpecifier)) === runtime
    ) {
      if (statement.importClause?.name) bindings.add(statement.importClause.name.text)
      const named = statement.importClause?.namedBindings
      if (named && ts.isNamedImports(named)) for (const item of named.elements) bindings.add(item.name.text)
      else if (named && ts.isNamespaceImport(named)) bindings.add(named.name.text)
    }
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        const call = declaration.initializer
        if (
          !call ||
          !ts.isCallExpression(call) ||
          !ts.isIdentifier(call.expression) ||
          call.expression.text !== 'require' ||
          resolveLocal(root, file, literal(call.arguments[0]) || '') !== runtime
        )
          continue
        if (ts.isIdentifier(declaration.name)) bindings.add(declaration.name.text)
        else if (ts.isObjectBindingPattern(declaration.name))
          for (const element of declaration.name.elements)
            if (ts.isIdentifier(element.name)) bindings.add(element.name.text)
      }
  }
  let called = false
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      let base = node.expression
      while (ts.isPropertyAccessExpression(base)) base = base.expression
      if (ts.isIdentifier(base) && bindings.has(base.text)) called = true
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return called
}
function pointer(schema, ref) {
  if (typeof ref === 'object' && ref) ref = ref.$ref
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return false
  let value = schema
  for (const part of ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return false
    value = value[key]
  }
  return value && typeof value === 'object'
}
function schemaReferences(value, schema, invalid = new Set()) {
  if (!value || typeof value !== 'object') return invalid
  if (value.$ref !== undefined && !pointer(schema, value.$ref)) invalid.add(String(value.$ref))
  for (const child of Object.values(value))
    if (child && typeof child === 'object') schemaReferences(child, schema, invalid)
  return invalid
}
function cycles(nodes, edges) {
  const adjacency = new Map(nodes.map((file) => [file, []]))
  for (const edge of edges) if (edge.target && adjacency.has(edge.target)) adjacency.get(edge.from).push(edge.target)
  let index = 0
  const stack = [],
    indices = new Map(),
    low = new Map(),
    active = new Set(),
    groups = []
  const visit = (file) => {
    indices.set(file, index)
    low.set(file, index++)
    stack.push(file)
    active.add(file)
    for (const to of adjacency.get(file)) {
      if (!indices.has(to)) {
        visit(to)
        low.set(file, Math.min(low.get(file), low.get(to)))
      } else if (active.has(to)) low.set(file, Math.min(low.get(file), indices.get(to)))
    }
    if (low.get(file) === indices.get(file)) {
      const group = []
      let next
      do {
        next = stack.pop()
        active.delete(next)
        group.push(next)
      } while (next !== file)
      if (group.length > 1) groups.push(group.sort())
    }
  }
  for (const file of nodes) if (!indices.has(file)) visit(file)
  return groups
}

export function checkArchitecture(
  root = ROOT,
  { policy = defaultPolicy, packagedClosure, verifyCollector = true } = {},
) {
  root = path.resolve(root)
  const violations = [],
    nodes = filesUnder(root, policy),
    sources = new Map(),
    edges = []
  const add = (code, message, extra = {}) => violations.push({ code, message, ...extra })
  const layerOf = (file) => policy.layers.find((layer) => layer.prefixes.some((prefix) => file.startsWith(prefix)))
  for (const file of nodes) {
    const source = sourceOf(file, fs.readFileSync(path.join(root, file), 'utf8'))
    sources.set(file, source)
    for (const error of source.parseDiagnostics)
      add('SOURCE_PARSE', ts.flattenDiagnosticMessageText(error.messageText, ' '), { file })
    const parsed = refsIn(source)
    for (const dynamic of parsed.dynamic)
      add('DYNAMIC_DEPENDENCY', 'A dependency cannot be statically resolved for the runtime/layer gate.', {
        file,
        ...dynamic,
      })
    for (const reference of parsed.edges) {
      const edge = {
        from: file,
        ...reference,
        target: reference.spec.startsWith('.') ? resolveLocal(root, file, reference.spec) : null,
      }
      edges.push(edge)
      const fromLayer = layerOf(file),
        toLayer = edge.target && layerOf(edge.target)
      if (reference.spec.startsWith('.') && !edge.target)
        add('MISSING_DEPENDENCY', 'A local dependency cannot be resolved.', { file, spec: reference.spec })
      else if (path.isAbsolute(reference.spec))
        add('ABSOLUTE_DEPENDENCY', 'Runtime source dependencies must stay repository-relative.', {
          file,
          spec: reference.spec,
        })
      else if (edge.target && (edge.target.startsWith('../') || !toLayer || !fromLayer?.allows.includes(toLayer.name)))
        add(
          'FORBIDDEN_LAYER',
          `${fromLayer?.name || 'unclassified'} must not import ${toLayer?.name || 'outside the configured source layers'}.`,
          { file, target: edge.target },
        )
      else if (
        !edge.target &&
        (policy.forbiddenPackages.some(
          (name) => reference.spec === name || (name.endsWith('/') && reference.spec.startsWith(name)),
        ) ||
          (fromLayer?.browser && BUILTINS.has(reference.spec)))
      )
        add('FORBIDDEN_PACKAGE', 'This package/builtin crosses the configured runtime boundary.', {
          file,
          spec: reference.spec,
        })
    }
  }
  if (policy.reachability) {
    // Every module under the roots must be reachable from an application or tool entry point.
    // Entries outside the roots contribute their imports only; .d.ts files are types, and
    // non-code files (styles, JSON) have no imports to follow.
    const { entries = [], entryDirectories = [] } = policy.reachability
    for (const entry of entries) {
      if (!fs.existsSync(path.join(root, entry)))
        add('REACHABILITY_ENTRY_MISSING', 'A configured entry point does not exist.', { file: entry })
    }
    const tools = entryDirectories.flatMap((dir) =>
      !fs.existsSync(path.join(root, dir))
        ? []
        : fs
            .readdirSync(path.join(root, dir))
            .filter((name) => js.test(name) && !name.endsWith('.d.ts'))
            .map((name) => `${dir}/${name}`),
    )
    const reached = new Set(),
      queue = [...entries, ...tools]
    const outgoing = (file) =>
      sources.has(file)
        ? edges.filter((edge) => edge.from === file)
        : refsIn(sourceOf(file, fs.readFileSync(path.join(root, file), 'utf8'))).edges.map((ref) => ({
            ...ref,
            target: ref.spec.startsWith('.') ? resolveLocal(root, file, ref.spec) : null,
          }))
    while (queue.length) {
      const file = queue.pop()
      if (reached.has(file) || !fs.existsSync(path.join(root, file))) continue
      reached.add(file)
      if (!js.test(file)) continue
      for (const edge of outgoing(file)) if (edge.target) queue.push(edge.target)
    }
    for (const file of nodes) {
      if (reached.has(file) || file.endsWith('.d.ts')) continue
      add('UNREACHABLE_MODULE', 'No application or tool entry point reaches this module; import it or delete it.', {
        file,
      })
    }
  }
  const runtimeFiles = new Set(policy.runtime?.resources || []),
    runtimePackages = new Set(),
    queue = [...(policy.runtime?.entries || [])]
  while (queue.length) {
    const file = queue.pop()
    if (runtimeFiles.has(file)) continue
    runtimeFiles.add(file)
    for (const edge of edges.filter((item) => item.from === file && item.runtime)) {
      if (edge.target) queue.push(edge.target)
      else if (!BUILTINS.has(edge.spec) && !edge.spec.startsWith('.') && !path.isAbsolute(edge.spec))
        runtimePackages.add(
          edge.spec.startsWith('@') ? edge.spec.split('/').slice(0, 2).join('/') : edge.spec.split('/')[0],
        )
    }
  }
  for (const file of runtimeFiles)
    if (!fs.existsSync(path.join(root, file)))
      add('MISSING_RUNTIME_RESOURCE', 'Required runtime code/data is absent.', { file })
  if (policy.runtime && verifyCollector && !packagedClosure) {
    try {
      packagedClosure = JSON.parse(
        execFileSync(process.execPath, [path.join(root, policy.runtime.collector)], {
          cwd: root,
          encoding: 'utf8',
          timeout: 10000,
          maxBuffer: 4 * 1024 * 1024,
        }),
      )
    } catch (error) {
      add('COLLECTOR_FAILED', `The actual packaging collector did not return a complete closure: ${error.message}`)
    }
  }
  if (packagedClosure) {
    for (const file of runtimeFiles)
      if (!packagedClosure.files?.includes(file))
        add(
          'RUNTIME_NOT_PACKAGED',
          'A statically reachable runtime file/resource is omitted by the real packaging collector.',
          { file },
        )
    for (const name of runtimePackages)
      if (!packagedClosure.packages?.includes(name))
        add('PACKAGE_NOT_PACKAGED', 'A runtime package is omitted by the real packaging collector.', { package: name })
    for (const file of packagedClosure.files || []) {
      const layer = layerOf(file)
      if (!['backend', 'shared', 'contracts'].includes(layer?.name))
        add('RUNTIME_FORBIDDEN_FILE', 'The helper package includes code/data outside its permitted runtime layers.', {
          file,
        })
    }
  }
  let contracts = { status: 'not-configured' }
  if (policy.contracts) {
    const config = policy.contracts
    contracts = { status: 'incomplete', methods: [], shellMethods: [], events: [], uiCalls: [] }
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, config.manifest), 'utf8')),
        schemaBytes = fs.readFileSync(path.join(root, config.schema)),
        schema = JSON.parse(schemaBytes)
      const methods = manifest.methods,
        eventContracts = manifest.events
      if (
        !methods ||
        typeof methods !== 'object' ||
        Array.isArray(methods) ||
        !eventContracts ||
        typeof eventContracts !== 'object' ||
        Array.isArray(eventContracts)
      )
        throw Error('The canonical manifest must enumerate method and event contract objects.')
      for (const ref of schemaReferences(schema, schema))
        add('SCHEMA_REFERENCE_UNRESOLVED', 'The canonical schema contains an unresolved or nonlocal reference.', {
          ref,
        })
      const registered = objectKeys(sources.get(config.methodRegistry.file), config.methodRegistry.variable),
        shell = [],
        shellEvents = []
      if (config.nativeSource) {
        const native = fs.readFileSync(path.join(root, config.nativeSource), 'utf8'),
          start = native.indexOf('fn handle('),
          end = native.indexOf('\n    fn ', start + 1),
          handler = native.slice(start, end < 0 ? undefined : end)
        if (start < 0) throw Error('The native shell handler inventory could not be located.')
        for (const match of handler.matchAll(/^\s*"([^"]+)"\s*=>/gm)) shell.push(match[1])
        for (const match of native.matchAll(/"event"\s*:\s*"([^"]+)"/g)) shellEvents.push(match[1])
      }
      for (const file of config.nativeEventSources || []) {
        const native = fs.readFileSync(path.join(root, file), 'utf8')
        for (const match of native.matchAll(/"event"\s*:\s*"([^"]+)"/g)) shellEvents.push(match[1])
      }
      const allMethods = new Set([...registered, ...shell]),
        usedEvents = new Set(shellEvents),
        uiCalls = new Set()
      for (const [file, source] of sources) {
        if (!file.startsWith('native/backend/') && !file.startsWith('native/ui/src/')) continue
        const used = protocolUse(source, root, file)
        for (const name of used.calls) uiCalls.add(name)
        for (const name of used.events) usedEvents.add(name)
        for (const use of used.dynamicCalls)
          add('DYNAMIC_PROTOCOL_METHOD', 'A UI bridge method needs a statically bounded literal/union inventory.', use)
        for (const use of used.dynamicEvents)
          add('DYNAMIC_PROTOCOL_EVENT', 'A protocol event needs a statically bounded literal inventory.', use)
      }
      for (const name of allMethods)
        if (!Object.hasOwn(methods, name))
          add('METHOD_CONTRACT_MISSING', 'An actual backend/native method has no canonical contract.', { method: name })
      for (const [owner, names] of [
        ['backend', registered],
        ['shell', shell],
      ])
        for (const name of names) {
          if (Object.hasOwn(methods, name) && methods[name].owner !== owner)
            add('METHOD_OWNER_MISMATCH', 'Canonical method ownership must match its actual registered executor.', {
              method: name,
              expectedOwner: owner,
            })
        }
      for (const name of Object.keys(methods))
        if (!allMethods.has(name))
          add('METHOD_HANDLER_MISSING', 'A canonical contract has no actual backend/native handler.', { method: name })
      for (const name of uiCalls)
        if (!allMethods.has(name) || !Object.hasOwn(methods, name))
          add('UI_METHOD_UNDECLARED', 'A UI call has no matching canonical handler contract.', { method: name })
      for (const name of usedEvents)
        if (!Object.hasOwn(eventContracts, name))
          add('EVENT_CONTRACT_MISSING', 'An actual backend/native/UI event has no canonical contract.', { event: name })
      for (const name of Object.keys(eventContracts))
        if (!usedEvents.has(name))
          add(
            'EVENT_SOURCE_MISSING',
            'A canonical event has no actual source or consumer in the configured inventory.',
            { event: name },
          )
      for (const [name, entry] of Object.entries(methods)) {
        if (!pointer(schema, entry.params || entry.request) || !pointer(schema, entry.result || entry.response))
          add(
            'METHOD_SCHEMA_UNRESOLVED',
            'A method needs resolvable request/params and result/response schema references.',
            { method: name },
          )
      }
      for (const [name, entry] of Object.entries(eventContracts))
        if (!pointer(schema, entry.data || entry.schema || entry))
          add('EVENT_SCHEMA_UNRESOLVED', 'An event needs a resolvable data schema reference.', { event: name })
      for (const key of ['dto', 'errors', 'persistedProject', 'schemaVersions'])
        if (!manifest[key] || typeof manifest[key] !== 'object' || Array.isArray(manifest[key]))
          add('DOMAIN_CONTRACT_MISSING', `The canonical manifest does not define ${key}.`)
      for (const file of config.validationSites || [])
        if (!sources.has(file) || !usesValidator(sources.get(file), root, file, config.runtime))
          add('RUNTIME_VALIDATION_MISSING', 'The process boundary does not call its canonical runtime validator.', {
            file,
          })
      if (!fs.existsSync(path.join(root, config.types)))
        add('GENERATED_TYPES_MISSING', 'Canonical generated TypeScript types are missing.', { file: config.types })
      if (config.typesGenerator) {
        if (!fs.existsSync(path.join(root, config.typesGenerator)))
          add(
            'TYPES_PARITY_CHECK_MISSING',
            'Generated type parity needs an actual deterministic generator --check gate.',
            { file: config.typesGenerator },
          )
        else
          try {
            execFileSync(process.execPath, [path.join(root, config.typesGenerator), '--check'], {
              cwd: root,
              timeout: 10000,
              maxBuffer: 4 * 1024 * 1024,
              stdio: 'pipe',
            })
          } catch (error) {
            add(
              'GENERATED_TYPES_DRIFT',
              `Generated canonical types differ from the schema: ${error.stderr?.toString().trim() || error.message}`,
            )
          }
      }
      contracts = {
        status: 'inventoried',
        backendMethods: registered,
        shellMethods: shell.sort(),
        events: [...usedEvents].sort(),
        uiCalls: [...uiCalls].sort(),
        schemaSha256: hash(schemaBytes),
        limitations: [
          'Registry/reference/callsite parity does not prove validator semantics or migration correctness.',
          'Rust shell inventory is source-only; opaque serde_json::Value is not a typed Rust DTO or an executed native bridge test.',
        ],
      }
    } catch (error) {
      add('CONTRACT_CONFIGURATION', `Canonical runtime contracts could not be verified: ${error.message}`)
    }
  }
  const circular = cycles(nodes, edges)
  if (policy.allowCycles === false)
    for (const files of circular)
      add(
        'DEPENDENCY_CYCLE',
        'A dependency cycle crosses module ownership; extract a shared lower-level invariant or explicitly review a policy exception.',
        { files },
      )
  return {
    ok: violations.length === 0,
    sourceRoot: root,
    files: nodes,
    edges,
    cycles: circular,
    runtime: {
      files: [...runtimeFiles].sort(),
      packages: [...runtimePackages].sort(),
      comparedWithCollector: !!packagedClosure,
    },
    contracts,
    violations,
    limitations: [
      'Static source and literal call graph only; dynamic dependencies fail closed.',
      'Behavioural contracts, compatibility migrations, native execution and complete CI remain separate required evidence.',
    ],
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let root = ROOT,
      policy = defaultPolicy
    for (let i = 2; i < process.argv.length; i += 2) {
      if (process.argv[i] === '--root') root = path.resolve(process.argv[i + 1])
      else if (process.argv[i] === '--policy') policy = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'))
      else throw Error(`Unknown architecture option: ${process.argv[i]}`)
    }
    const result = checkArchitecture(root, { policy })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error.stack}\n`)
    process.exitCode = 1
  }
}
