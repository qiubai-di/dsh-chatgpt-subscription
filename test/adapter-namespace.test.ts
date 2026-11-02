import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SubscriptionManager } from '../src/dsh-store.js'
import { subscriptionProfile } from '../src/index.js'
import { PROVIDER_ID } from '../src/catalog.js'
import { SIWC_SCOPES } from '../src/siwc.js'
import { SubscriptionAdapter } from '../src/subscription-adapter.js'
import { qualifiedToolKey, resolveToolIdentity } from '../src/provider.js'
import type { QualifiedToolIdentity } from '../src/provider.js'
import { readFile } from 'node:fs/promises'

const MODEL = { id: 'gpt-5.4', name: 'GPT 5.4' }
const READ = { type: 'function', name: 'read', description: 'Read a fixture', parameters: { type: 'object' } }
const EDIT = { type: 'custom', name: 'edit', format: { type: 'text' } }
const RUN = { type: 'function', name: 'run_code', parameters: { type: 'object', properties: { code: { type: 'string' } } } }
const entries = ['stream', 'prepareCall'] as const
type Entry = typeof entries[number]

// Only the public Pi provider boundary injects caller payload options that DSH's
// GenerateOptions cannot express. Conversion, subscription dispatch and projection
// are real; auth is memory-only and the final HTTP boundary never leaves the process.
async function fixture(t: test.TestContext) {
  const credential = { type: 'oauth' as const, access: 'synthetic-namespace-access', refresh: 'synthetic-namespace-refresh',
    expires: Date.now() + 3600000, issuer: 'https://auth.openai.com', clientId: 'oaiapp_namespace',
    subject: 'synthetic-namespace-account', idToken: 'synthetic-id-token', scopes: [...SIWC_SCOPES],
    hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' }
  const manager: SubscriptionManager = Object.create(SubscriptionManager.prototype)
  manager.validCredential = async () => structuredClone(credential)
  const credentials = new InMemoryCredentialStore()
  await credentials.modify(PROVIDER_ID, async () => credential)
  const profile = subscriptionProfile(manager, [MODEL], { identity: credential })
  const provider = profile.piProvider!
  let override: Record<string, unknown> = {}
  const injected = { ...provider, streamSimple: (model: Parameters<typeof provider.streamSimple>[0],
    context: Parameters<typeof provider.streamSimple>[1], options: Parameters<typeof provider.streamSimple>[2]) =>
    provider.streamSimple(model, context, { ...options, onPayload: payload => ({ ...payload as object, ...override }) }) }
  const profiles = new Map([[PROVIDER_ID, { ...profile, piProvider: injected }]])
  const adapter = new SubscriptionAdapter(new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined,
    auth: { credentials, authContext: { env: async () => undefined, fileExists: async () => false } } }))
  const bodies: Record<string, any>[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.openai.com/v1/responses')
    bodies.push(JSON.parse(String(init?.body)))
    const item = { type: 'message', id: 'msg_namespace', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Offline answer', annotations: [] }] }
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Offline answer' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_namespace', status: 'completed', output: [item],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } })
  }
  t.after(() => { globalThis.fetch = originalFetch })
  return { bodies, run: async (entry: Entry, payload: Record<string, unknown>, purpose?: GenerateOptions['purpose']) => {
    override = payload
    const options: GenerateOptions = { provider: PROVIDER_ID, model: MODEL.id, purpose,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Offline namespace contract' }] }] }
    const assembled = new BlockAssembler()
    const stream = entry === 'stream' ? adapter.stream(options) : (await adapter.prepareCall(PROVIDER_ID, MODEL.id)).stream(options)
    for await (const chunk of stream) assembled.push(chunk)
    return assembled
  } }
}

test('both entry points merge flat tools into the existing dsh group without losing namespace identity or order', async t => {
  const f = await fixture(t)
  const named = { type: 'namespace', name: 'dsh', description: 'Existing harness metadata', tools: [RUN] }
  const remote = { type: 'namespace', name: 'remote', description: 'Separate identity', tools: [READ] }
  const payload = { tools: [READ, remote, named, EDIT] }
  const before = structuredClone(payload)
  for (const entry of entries) {
    const result = await f.run(entry, payload)
    assert.equal(result.finish.kind, 'stop')
    assert.equal(result.usage?.totalTokens, 15)
    assert.ok(result.replayState)
    assert.equal(f.bodies.length, entry === 'stream' ? 1 : 2, 'actual final HTTP was reached')
    assert.deepEqual(f.bodies.at(-1)!.tools, [remote, { ...named, tools: [RUN, READ, EDIT] }, { type: 'web_search' }])
  }
  assert.deepEqual(payload, before)
})

test('identical qualified declarations deduplicate stably within and across compatible groups', async t => {
  const f = await fixture(t)
  const first = { type: 'namespace', name: 'dsh', description: 'Harness', tools: [READ, RUN, READ] }
  const next = { type: 'namespace', name: 'dsh', description: 'Harness', tools: [EDIT, { name: 'read', type: 'function',
    parameters: { type: 'object' }, description: 'Read a fixture' }] }
  for (const entry of entries) {
    const result = await f.run(entry, { tools: [first, next, READ, EDIT] })
    assert.equal(result.finish.kind, 'stop')
    assert.deepEqual(f.bodies.at(-1)!.tools, [{ ...first, tools: [READ, RUN, EDIT] }, { type: 'web_search' }])
  }
  assert.equal(f.bodies.length, 2)
})


test('conflicting qualified type, parameters or metadata fails safely before HTTP through either entry', async t => {
  const f = await fixture(t)
  const sentinel = 'synthetic-conflicting-schema-sentinel'
  const group = { type: 'namespace', name: 'dsh', description: 'Harness', tools: [READ] }
  const cases = [
    [group, { type: 'custom', name: 'read', format: { type: 'text' } }],
    [group, { ...READ, parameters: { type: 'object', properties: { [sentinel]: { type: 'string' } } } }],
    [group, { ...READ, description: sentinel }],
    [group, { ...group, description: sentinel }],
    [{ ...group, tools: [READ, { ...READ, strict: true }] }],
  ]
  for (const entry of entries) for (const tools of cases) {
    const result = await f.run(entry, { tools })
    assert.equal(f.bodies.length, 0, 'conflicts never reach final HTTP')
    assert.equal(result.finish.kind, 'error')
    if (result.finish.kind === 'error') assert.match(result.finish.failure.message, /conflict/i)
    assert.equal(result.replayState, undefined)
    assert.doesNotMatch(JSON.stringify(result.finish), new RegExp(sentinel))
  }
})


test('additional_tools normalize only at their original history boundary with unchanged ordering', async t => {
  const f = await fixture(t)
  const first = { type: 'additional_tools', tools: [READ,
    { type: 'namespace', name: 'dsh', description: 'Late harness', tools: [RUN] }, READ] }
  const second = { type: 'additional_tools', tools: [EDIT,
    { type: 'namespace', name: 'remote', tools: [READ] }] }
  const history = [
    { role: 'user', content: 'Before additions' }, first,
    { role: 'user', content: 'After first addition' }, second,
    { type: 'function_call', namespace: 'remote', name: 'read', call_id: 'call_old', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_old', output: 'old result' },
    { type: 'web_search_call', id: 'ws_past', status: 'completed', action: { type: 'search', query: 'past' } },
  ]
  const before = structuredClone(history)
  for (const entry of entries) {
    const result = await f.run(entry, { tools: [], input: history })
    assert.equal(result.finish.kind, 'stop')
    const wire = f.bodies.at(-1)!
    assert.deepEqual(wire.tools, [{ type: 'web_search' }], 'late declarations never move to top level')
    assert.deepEqual(wire.input, [history[0],
      { type: 'additional_tools', tools: [{ type: 'namespace', name: 'dsh', description: 'Late harness', tools: [RUN, READ] }] },
      history[2], { type: 'additional_tools', tools: [second.tools[1],
        { type: 'namespace', name: 'dsh', description: 'Tools supplied by DeepSeek Harness', tools: [EDIT] }] },
      ...history.slice(4)])
  }
  assert.equal(f.bodies.length, 2)
  assert.deepEqual(history, before)
})


test('conflicting incremental redefinitions fail before HTTP without moving declaration boundaries', async t => {
  const f = await fixture(t)
  const changed = { ...READ, parameters: { type: 'object', required: ['changed'] } }
  for (const entry of entries) for (const prefix of [
    { tools: [READ], input: [] },
    { tools: [], input: [{ type: 'additional_tools', tools: [READ] }] },
  ]) {
    const result = await f.run(entry, { tools: prefix.tools, input: [...prefix.input,
      { role: 'user', content: 'Existing history stays in place' },
      { type: 'additional_tools', tools: [changed] }] })
    assert.equal(f.bodies.length, 0)
    assert.equal(result.finish.kind, 'error')
    if (result.finish.kind === 'error') assert.match(result.finish.failure.message, /conflict/i)
    assert.equal(result.replayState, undefined)
  }
})


test('unconfirmed forced function or custom selectors are rejected before HTTP despite valid declarations', async t => {
  const f = await fixture(t)
  const sentinel = 'synthetic-selector-sentinel'
  const tools = [{ type: 'namespace', name: 'remote', tools: [READ, EDIT] }, READ]
  for (const entry of entries) for (const tool_choice of [
    { type: 'function', name: 'read', namespace: 'remote' },
    { type: 'custom', name: 'edit', namespace: 'remote' },
    { type: 'function', name: 'read' },
    { type: 'function', name: 'undeclared' },
    { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'read', namespace: 'remote' }], [sentinel]: true },
  ]) {
    const result = await f.run(entry, { tools, tool_choice })
    assert.equal(f.bodies.length, 0, 'unknown SIWC selection never leaves the adapter')
    assert.equal(result.finish.kind, 'error')
    if (result.finish.kind === 'error') assert.match(result.finish.failure.message, /not supported|ambiguous|not declared/i)
    assert.equal(result.replayState, undefined)
    assert.doesNotMatch(JSON.stringify(result.finish), new RegExp(sentinel))
  }
})


test('managed search removes only the local dsh search declaration, not a different namespace identity', async t => {
  const f = await fixture(t)
  const search = { type: 'function', name: 'web_search', description: 'Local operation', parameters: { type: 'object' } }
  const remote = { type: 'namespace', name: 'remote', tools: [search, READ] }
  const local = { type: 'namespace', name: 'dsh', tools: [search, RUN] }
  for (const entry of entries) {
    const result = await f.run(entry, { tools: [remote, local, search], input: [
      { type: 'additional_tools', tools: [remote, search] }] })
    assert.equal(result.finish.kind, 'stop')
    assert.deepEqual(f.bodies.at(-1)!.tools, [remote, { ...local, tools: [RUN] }, { type: 'web_search' }])
    assert.deepEqual(f.bodies.at(-1)!.input, [{ type: 'additional_tools', tools: [remote] }])
  }
  assert.equal(f.bodies.length, 2)
})


test('empty and flat declarations keep supported selectors, hosted main search and deterministic compaction none', async t => {
  const f = await fixture(t)
  for (const entry of entries) {
    for (const tool_choice of ['auto', 'none', 'required', { type: 'web_search' }]) {
      const result = await f.run(entry, { tools: [], tool_choice })
      assert.equal(result.finish.kind, 'stop')
      assert.deepEqual(f.bodies.at(-1)!.tools, [{ type: 'web_search' }])
      assert.deepEqual(f.bodies.at(-1)!.tool_choice, tool_choice)
    }
    const payload = { tools: [READ, EDIT], tool_choice: 'required' }
    await f.run(entry, payload)
    const main = f.bodies.at(-1)!
    await f.run(entry, payload)
    assert.deepEqual(f.bodies.at(-1)!.tools, main.tools, 'repeat serialization is deterministic')
    assert.deepEqual(main.tools, [{ type: 'namespace', name: 'dsh', description: 'Tools supplied by DeepSeek Harness',
      tools: [READ, EDIT] }, { type: 'web_search' }])
    const summary = await f.run(entry, { ...payload, tool_choice: { type: 'function', name: 'read' } }, 'compaction')
    assert.equal(summary.finish.kind, 'stop')
    assert.deepEqual(f.bodies.at(-1)!.tools, main.tools)
    assert.equal(f.bodies.at(-1)!.tool_choice, 'none')
  }
  assert.equal(f.bodies.length, 14)
})


// Supplemental identity edge case: the adapter selectors above are the primary seam.
test('trusted identity resolution rejects contradictory kinds instead of silently choosing one', () => {
  const identities: QualifiedToolIdentity[] = [
    { namespace: 'remote', name: 'read', type: 'function' },
    { namespace: 'remote', name: 'read', type: 'custom' },
  ]
  assert.throws(() => resolveToolIdentity(identities, { name: 'read' }), /conflict/i)
})


test('legal run_code namespace fixture reaches final wire without flattening to satisfy a top-level consumer', async t => {
  const f = await fixture(t)
  const contract = JSON.parse(await readFile('test/fixtures/bc-namespace-contract.json', 'utf8'))
  for (const entry of entries) {
    const result = await f.run(entry, { tools: contract.tools })
    assert.equal(result.finish.kind, 'stop')
    assert.deepEqual(f.bodies.at(-1)!.tools, [...contract.tools, { type: 'web_search' }])
    assert.deepEqual(f.bodies.at(-1)!.tools[0].tools.map((tool: any) => ({ namespace: 'dsh', name: tool.name, type: tool.type })),
      [{ namespace: 'dsh', name: 'run_code', type: 'function' }])
    assert.equal(f.bodies.at(-1)!.tools.some((tool: any) => tool.name === 'run_code'), false)
  }
  assert.equal(f.bodies.length, 2)
})

test('malformed or unknown selector forms cannot coerce into a supported mode or hosted choice', async t => {
  const f = await fixture(t)
  for (const entry of entries) for (const tool_choice of [null, false, 1, ['auto'], { type: 'auto' },
    { type: 'web_search', name: 'extra-selector-field' }, { type: 'function', name: 'read', namespace: null }]) {
    const result = await f.run(entry, { tools: [READ], tool_choice })
    assert.equal(result.finish.kind, 'error')
    if (result.finish.kind === 'error') assert.match(result.finish.failure.message, /not supported|not enabled/i)
    assert.equal(f.bodies.length, 0)
    assert.equal(result.replayState, undefined)
  }
})

test('both entries reject raw historical calls without trusted namespace rather than guessing dsh', async t => {
  const f = await fixture(t)
  for (const entry of entries) for (const type of ['function_call', 'custom_tool_call']) {
    const result = await f.run(entry, { tools: [{ type: 'namespace', name: 'dsh', tools: [READ, EDIT] }],
      input: [{ type, name: type === 'function_call' ? 'read' : 'edit', call_id: 'call_raw',
        ...(type === 'function_call' ? { arguments: '{}' } : { input: 'PRIVATE_DIAGNOSTIC_INPUT' }) }] })
    assert.equal(f.bodies.length, 0)
    assert.equal(result.finish.kind, 'error')
    if (result.finish.kind === 'error') assert.match(result.finish.failure.message, /identity|namespace/i)
    assert.equal(result.replayState, undefined)
    assert.doesNotMatch(JSON.stringify(result.finish), /PRIVATE_DIAGNOSTIC_/)
  }
})

test('qualified identity resolution distinguishes namespace, kind, undeclared names and delimiter boundaries', () => {
  const identities: QualifiedToolIdentity[] = [
    { namespace: 'dsh', name: 'read', type: 'function' },
    { namespace: 'remote', name: 'read', type: 'function' },
    { namespace: 'remote', name: 'edit', type: 'custom' },
  ]
  assert.deepEqual(resolveToolIdentity(identities, { name: 'read', namespace: 'remote', type: 'function' }),
    { namespace: 'remote', name: 'read', type: 'function' })
  assert.deepEqual(resolveToolIdentity(identities, { name: 'edit' }), { namespace: 'remote', name: 'edit', type: 'custom' })
  assert.throws(() => resolveToolIdentity(identities, { name: 'read' }), /ambiguous/)
  assert.throws(() => resolveToolIdentity(identities, { name: 'missing' }), /not declared/)
  assert.throws(() => resolveToolIdentity(identities, { name: 'edit', type: 'function' }), /not declared/)
  assert.throws(() => resolveToolIdentity([], { name: 'read' }), /not declared/)
  assert.notEqual(qualifiedToolKey({ namespace: 'a.b', name: 'c' }), qualifiedToolKey({ namespace: 'a', name: 'b.c' }))
})


test('compatible namespace metadata preserves own JSON keys without interpreting object-prototype setters', async t => {
  const f = await fixture(t)
  const metadata = JSON.parse('{"type":"namespace","name":"dsh","__proto__":{"marker":"ordinary-metadata"},"tools":[]}')
  for (const entry of entries) {
    const result = await f.run(entry, { tools: [{ type: 'namespace', name: 'dsh', tools: [RUN] }, metadata] })
    assert.equal(result.finish.kind, 'stop')
    const group = f.bodies.at(-1)!.tools[0]
    assert.equal(Object.hasOwn(group, '__proto__'), true)
    assert.deepEqual(group.__proto__, { marker: 'ordinary-metadata' })
    assert.deepEqual(group.tools, [RUN])
  }
  assert.equal(f.bodies.length, 2)
})
