// Optional, read-only consumer check. Supply an existing BC bundle explicitly.
// Evaluate only its original pure scanner/decision functions, never import BC or
// initialize its runtime, proxy, profile, state store or network. No copied BC implementation.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import vm from 'node:vm'

const bundle = process.argv[2]
assert.ok(bundle, 'Usage: node scripts/verify-bc-namespace.mjs <existing-bc-bundle.js>')
const source = await readFile(bundle, 'utf8')
const fixture = JSON.parse(await readFile(new URL('../test/fixtures/bc-namespace-contract.json', import.meta.url), 'utf8'))
const functions = new Set(['biliToolsDeclaredOnWire', 'observeDeclaredTools', 'resolveLaneDecisions',
  'hostProfileFor', 'mcpBiliToolName', 'extractBillingAttributionBlock', 'systemOf'])
const variables = new Set(['PROFILES', 'ANONYMOUS', 'RUN_CODE_TOOL_NAME', 'CODE_MODE_OMNIBUS_TOOL_NAMES'])
// These pinned pure functions contain no regexp or comment literals. Extract
// balanced function bodies without executing the rest of the bundle. Changes
// to their source shape fail this optional verifier rather than guessing a runtime.
const snippets = new Map()
for (const name of functions) {
  const starts = [...source.matchAll(new RegExp(`function ${name}\\(`, 'g'))]
  assert.equal(starts.length, 1, `missing or ambiguous consumer function ${name}`)
  const start = starts[0].index
  const open = source.indexOf('{', start)
  let depth = 0, quote = '', escape = false, end = -1
  for (let index = open; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (escape) escape = false
      else if (char === '\\') escape = true
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    if (char === '{') depth++
    if (char === '}' && --depth === 0) { end = index + 1; break }
  }
  assert.ok(end > open, `unterminated consumer function ${name}`)
  snippets.set(name, source.slice(start, end))
}
for (const name of variables) {
  const matches = [...source.matchAll(new RegExp(`var ${name}=([^;]+);`, 'g'))]
  assert.equal(matches.length, 1, `missing or ambiguous consumer constant ${name}`)
  snippets.set(name, matches[0][0])
}
const input = { pluginAgent: 'dsh', parsed: { tools: [...fixture.tools, { type: 'web_search' }] },
  protocol: 'responses', pluginMode: true, pluginHeaderPresent: true, shouldInject: true }
const code = [...variables, ...functions].map(name => snippets.get(name)).join('\n') + `
const decision = resolveLaneDecisions(input);
JSON.stringify({ observedTools: [...decision.observed.declaredTools],
  compressReachable: decision.toolsReachable.compress, compressSurfaceOn: decision.compressSurfaceOn });`
const result = JSON.parse(vm.runInNewContext(code, { input }, { timeout: 1000,
  contextCodeGeneration: { strings: false, wasm: false } }))
assert.deepEqual(result.observedTools, fixture.bcObservedToolNames)
assert.equal(result.compressReachable, fixture.bcCompressReachable)
assert.equal(result.compressSurfaceOn, fixture.bcCompressSurfaceOn)
console.log(JSON.stringify({ consumerBundleSha256: createHash('sha256').update(source).digest('hex'),
  ...result, scope: 'actual pure BC consumer functions only; known namespace gap remains; no BC runtime or model request' }, null, 2))
