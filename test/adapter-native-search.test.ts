import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { normalizeContext, Type } from '@earendil-works/pi-ai'
import type { StreamOptions } from '@earendil-works/pi-ai'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { AssistantStreamAccumulator, BlockAssembler, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { openSubscriptionStore } from '../src/dsh-store.js'
import { subscriptionProfile } from '../src/index.js'
import { PROVIDER_ID } from '../src/catalog.js'
import { subscriptionProvider } from '../src/provider.js'
import { SubscriptionAdapter } from '../src/subscription-adapter.js'
import { SubscriptionManager } from '../src/dsh-store.js'
import { NativeSearchCapture, nativeSearchScope } from '../src/native-search.js'
import { SIWC_SCOPES } from '../src/siwc.js'

const MODEL = { id: 'gpt-5.4', name: 'GPT 5.4' }
const OFFLINE_IDENTITY = { issuer: 'https://auth.openai.com', clientId: 'oaiapp_offline', subject: 'offline-subject',
  hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001', scopes: [...SIWC_SCOPES] }
function manager(): SubscriptionManager {
  const value: SubscriptionManager = Object.create(SubscriptionManager.prototype)
  value.validCredential = async () => ({ type: 'oauth', access: 'offline-search-access', refresh: 'offline-search-refresh',
    expires: Date.now() + 3_600_000, clientId: 'oaiapp_offline', idToken: 'offline-id-token', scopes: [...SIWC_SCOPES],
    issuer: 'https://auth.openai.com', subject: 'offline-subject', hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' })
  return value
}
function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function adapterFixture(t: test.TestContext, onPayload?: StreamOptions['onPayload'], lifetime?: AbortSignal) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-native-search-offline-'))
  const store = await openSubscriptionStore(home)
  t.after(async () => { await store.dispose(); await rm(home, { recursive: true, force: true }) })
  await store.manager.credentialStore.modify(PROVIDER_ID, async () => manager().validCredential())
  let profiles = new Map([[PROVIDER_ID, subscriptionProfile(store.manager, [MODEL, { id: 'gpt-5.2', name: 'GPT 5.2' }], { identity: (await store.manager.snapshot()).identity!, ...(lifetime ? { lifetime } : {}) })]])
  if (onPayload) profiles = new Map([...profiles].map(([id, profile]) => {
    const provider = profile.piProvider!
    // Decorate only the public caller hook; all conversion, dispatch and SSE
    // processing still run through the actual subscription provider and Pi.
    return [id, { ...profile, piProvider: { ...provider,
      streamSimple: (model, context, options) => provider.streamSimple(model, context, { ...options, onPayload }),
    } }]
  }))
  const makePi = () => new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined,
    auth: { credentials: store.manager.credentialStore, authContext: { env: async () => undefined, fileExists: async () => false } } })
  const make = () => new SubscriptionAdapter(makePi())
  const fetch = globalThis.fetch
  t.after(() => { globalThis.fetch = fetch })
  return { make, makePi, setHeader: (header: string) => {
    profiles = new Map([...profiles].map(([id, profile]) => [id, { ...profile, headers: { 'x-native-test-generation': header } }]))
  } }
}
async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  const assembled = new BlockAssembler()
  const persisted = new AssistantStreamAccumulator()
  for await (const chunk of stream) {
    persisted.push({ time: chunks.length, chunk })
    chunks.push(chunk); assembled.push(chunk)
  }
  return { chunks, assembled }
}
async function runEntry(adapter: SubscriptionAdapter, entry: 'stream' | 'prepareCall', options: GenerateOptions) {
  return collect(entry === 'stream' ? adapter.stream(options)
    : (await adapter.prepareCall(options.provider, options.model)).stream(options))
}
const request = (): GenerateOptions => ({ provider: PROVIDER_ID, model: MODEL.id,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Find the source' }] }] })
const localRead = { name: 'read', description: 'Synthetic local read sentinel',
  parameters: { type: 'object', properties: { path: { type: 'string' } } } }

// A persisted legacy fixture, not a newly executable remote response. Contracts:
// installed PiAiReplayResponse v2 plus NativeResponse/ReplayToolIdentity v1 in
// native-search-replay.ts. Construct independently of production replay helpers
// so the guard cannot manufacture history through an unsafe fresh dispatch.
function persistedHistory(output: Record<string, any>[], kind: 'native' | 'pi' = 'native'): any {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
  const content: any[] = [], blocks: any[] = []
  for (const item of output) {
    if (item.type === 'web_search_call') continue
    if (item.type === 'reasoning') {
      content.push({ type: 'reasoning', text: item.summary.map((part: any) => part.text).join('') })
      blocks.push({ type: 'reasoning', thinkingSignature: JSON.stringify(item) })
    } else if (item.type === 'message') {
      content.push({ type: 'text', text: item.content.map((part: any) => part.text ?? part.refusal ?? '').join('') })
      blocks.push({ type: 'text', textSignature: JSON.stringify({ v: 1, id: item.id, ...(item.phase ? { phase: item.phase } : {}) }) })
    } else {
      assert.ok(item.type === 'function_call' || item.type === 'custom_tool_call')
      const id = item.call_id + '|' + item.id
      content.push({ type: 'tool-call', id, name: item.name,
        arguments: item.type === 'function_call' ? item.arguments : JSON.stringify({ input: item.input }) })
      const identity = { kind: 'chatgpt-subscription-tool', version: 1, id, name: item.name,
        namespace: item.namespace, type: item.type === 'custom_tool_call' ? 'custom' : 'function' }
      blocks.push({ type: 'tool-call', namespace: item.namespace, toolIdentity: { ...identity, fingerprint: hash(identity) } })
    }
  }
  const contentFingerprint = hash(content)
  const pi = { kind: 'pi-ai', version: 2, api: 'openai-responses', provider: PROVIDER_ID, model: MODEL.id,
    stopReason: content.some(block => block.type === 'tool-call') ? 'toolUse' : 'stop' }
  const piResponse = { ...pi, subscriptionReplay: { version: 1, contentFingerprint,
    stateFingerprint: hash({ response: pi, blocks, contentFingerprint }) } }
  const native = { kind: 'chatgpt-subscription-native', version: 1, provider: PROVIDER_ID, model: MODEL.id,
    output: structuredClone(output), piResponse, contentFingerprint, blockCount: content.length }
  const replayState = { response: kind === 'pi' ? piResponse : { ...native, stateFingerprint: hash({ response: native, blocks }) }, blocks }
  const message = { role: 'assistant', id: MessageId('persisted_fixture'), content,
    source: { kind: 'model', provider: PROVIDER_ID, model: MODEL.id, replayState } }
  assert.deepEqual(JSON.parse(JSON.stringify(message)), message, 'fixture is lossless JSON without a cleaning round trip')
  return message
}
function fakeDispatch(chunks: StreamChunk[]): string[] {
  const dispatched: string[] = []
  const localTools = new Map([['read', () => dispatched.push('LOCAL_READ_SENTINEL')]])
  // Model the host's name-based dispatcher at the executable block boundary.
  for (const chunk of chunks) if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') localTools.get(chunk.block.name)?.()
  return dispatched
}
function assertIdentityRefusal(result: Awaited<ReturnType<typeof collect>>) {
  assert.equal(result.assembled.finish.kind, 'error')
  if (result.assembled.finish.kind === 'error') {
    assert.equal(result.assembled.finish.failure.code, 'PI_AI_ERROR')
    assert.match(result.assembled.finish.failure.message, /tool call without a declared local execution binding/i)
  }
  assert.equal(result.assembled.replayState, undefined)
  assert.equal(result.chunks.some(chunk => chunk.type === 'tool-call-delta'
    || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
    || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')), false)
}

const annotation = { type: 'url_citation', start_index: 0, end_index: 6, title: 'Primary [source]', url: 'https://example.test/fact' }
function searchOutput(tag = 'one') {
  return [
    { type: 'web_search_call', id: `ws_${tag}`, status: 'completed',
      action: { type: 'search', query: 'synthetic fact', sources: [{ type: 'url', url: 'https://example.test/visited' }] } },
    { type: 'message', id: `msg_${tag}`, role: 'assistant', status: 'completed', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'A fact.', annotations: [annotation] }] },
  ]
}
function events(output: Record<string, any>[] = searchOutput()): unknown[] {
  return [...output.flatMap((item, output_index) => [
    { type: 'response.output_item.added', output_index, item: { ...item, ...(item.type === 'message' ? { content: [] } : {}) } },
    ...(item.type === 'message' ? [{ type: 'response.output_text.delta', output_index, content_index: 0, delta: 'A fact.' }] : []),
    { type: 'response.output_item.done', output_index, item },
  ]), { type: 'response.completed', response: { id: 'resp_native', status: 'completed', output,
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } }]
}

// Existing provider seam: red must fail on missing wire behavior, not a new module import.
test('both adapter entries filter host-owned DSH search schemas before sending the request', async t => {
  const f = await adapterFixture(t)
  const bodies: Record<string, any>[] = []
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return sse(events())
  }
  const options = { ...request(), tools: [localRead, { name: 'web_search', description: 'Host search', parameters: { type: 'object' } }] }
  for (const entry of ['stream', 'prepareCall'] as const) {
    const result = await runEntry(f.make(), entry, options)
    assert.equal(result.assembled.finish.kind, 'stop')
  }
  assert.equal(bodies.length, 2)
  for (const body of bodies) {
    assert.ok(body.tools.some((tool: any) => tool.type === 'web_search'))
    assert.deepEqual(body.tools.find((tool: any) => tool.type === 'namespace' && tool.name === 'dsh').tools.map((tool: any) => tool.name), ['read'])
  }
  assert.equal(options.tools.length, 2, 'the caller retains its host-owned schemas')
})

test('subscription main-model request declares native search outside the local tool namespace', async () => {
  const provider = subscriptionProvider(manager(), [MODEL], { identity: OFFLINE_IDENTITY })
  const model = provider.getModels()[0]!
  let body: Record<string, any> | undefined
  const response = await provider.streamSimple(model, normalizeContext({ messages: [], tools: [
    { name: 'read', description: 'Read', parameters: Type.Object({ path: Type.String() }) },
    { name: 'web_search', description: 'DSH search must not be sent', parameters: Type.Object({ query: Type.String() }) },
  ] }), { fetch: async (_input, init) => {
    body = JSON.parse(String(init?.body))
    return sse([{ type: 'response.completed', response: { status: 'completed', output: [] } }])
  } }).result()
  assert.equal(response.stopReason, 'stop')
  assert.ok(body)
  assert.deepEqual(body.tools.filter((tool: any) => tool.type === 'web_search'), [{ type: 'web_search' }])
  assert.equal(body.tools.find((tool: any) => tool.type === 'namespace').tools.some((tool: any) => tool.name === 'web_search'), false)
  assert.ok(body.include.includes('reasoning.encrypted_content'))
  assert.ok(body.include.includes('web_search_call.action.sources'))
})

for (const kind of ['function', 'custom', 'hosted'] as const) for (const entry of ['stream', 'prepareCall'] as const) {
  test(`${entry}: compaction rejects forbidden ${kind} calls before any executable event`, async t => {
    const fixture = await adapterFixture(t)
    const call = kind === 'hosted' ? { ...searchOutput('forbidden')[0]!,
      action: { type: 'search', query: 'SYNTHETIC_TOOL_SECRET' } } : {
      type: kind === 'function' ? 'function_call' : 'custom_tool_call',
      id: 'fc_forbidden', call_id: 'call_forbidden', name: 'read', namespace: 'dsh', status: 'completed',
      ...(kind === 'function' ? { arguments: '{"path":"SYNTHETIC_TOOL_SECRET"}' } : { input: 'SYNTHETIC_TOOL_SECRET' }) }
    const output = [searchOutput('partial')[1]!, call]
    const streamed = events(output) as any[]
    if (kind !== 'hosted') {
      streamed[3].item = { ...call, ...(kind === 'function' ? { arguments: '' } : { input: '' }) }
      streamed.splice(4, 0, {
        type: kind === 'function' ? 'response.function_call_arguments.delta' : 'response.custom_tool_call_input.delta',
        output_index: 1, delta: kind === 'function' ? '{"path":"SYNTHETIC_TOOL_SECRET"}' : 'SYNTHETIC_TOOL_SECRET',
      })
    }
    streamed.at(-1).response.usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110,
      input_tokens_details: { cached_tokens: 60, cache_write_tokens: 15 }, output_tokens_details: { reasoning_tokens: 3 } }
    let requests = 0
    globalThis.fetch = async (_input, init) => {
      requests++
      assert.equal(JSON.parse(String(init?.body)).tool_choice, 'none')
      return sse(streamed)
    }
    const adapter = fixture.make()
    const options = { ...request(), purpose: 'compaction' as const }
    const result = await collect(entry === 'stream' ? adapter.stream(options)
      : (await adapter.prepareCall(PROVIDER_ID, MODEL.id)).stream(options))
    assert.equal(requests, 1, 'no remedial model request')
    assert.equal(result.chunks.some(chunk => chunk.type === 'tool-call-delta'
      || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
      || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')), false,
    'never expose an executable tool event before failing')
    assert.equal(result.assembled.finish.kind, 'error')
    if (result.assembled.finish.kind !== 'error') assert.fail('expected policy failure')
    assert.match(result.assembled.finish.failure.message, /compaction.*tool|tool.*compaction/i)
    assert.equal(result.assembled.replayState, undefined)
    assert.deepEqual(result.assembled.blocks(), [{ type: 'text', text: 'A fact.' }])
    const usage = result.chunks.find(chunk => chunk.type === 'usage')
    assert.deepEqual(usage?.usage, { inputTokens: 25, outputTokens: 10, totalTokens: 110, cacheReadTokens: 60, cacheWriteTokens: 15 })
    assert.doesNotMatch(JSON.stringify(result.chunks), /SYNTHETIC_TOOL_SECRET|fc_forbidden|call_forbidden|引用来源/)
  })
}

for (const entry of ['stream', 'prepareCall'] as const) {
  test(`${entry}: compaction suppresses forbidden calls without overwriting later typed overflow`, async t => {
    const fixture = await adapterFixture(t)
    const partial = searchOutput('overflow_after_tool')[1]!
    const call = { type: 'function_call', id: 'fc_forbidden_overflow', call_id: 'call_forbidden_overflow',
      name: 'read', namespace: 'dsh', arguments: '{"path":"SYNTHETIC_TOOL_SECRET"}' }
    const failed = events([partial, call]) as any[]
    failed[failed.length - 1] = { type: 'response.failed', response: { status: 'failed',
      usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27,
        input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 } },
      error: { code: 'context_length_exceeded', message: 'SYNTHETIC_TOOL_SECRET' } } }
    let requests = 0
    globalThis.fetch = async (_input, init) => {
      requests++; assert.equal(JSON.parse(String(init?.body)).tool_choice, 'none'); return sse(failed)
    }
    const result = await runEntry(fixture.make(), entry, { ...request(), purpose: 'compaction' })
    assert.equal(requests, 1, 'drain existing response without a remedial request')
    assert.equal(result.chunks.some(chunk => chunk.type === 'tool-call-delta'
      || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
      || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')), false)
    assert.equal(result.assembled.finish.kind, 'error')
    if (result.assembled.finish.kind !== 'error') assert.fail('expected typed failure')
    assert.equal(result.assembled.finish.failure.code, 'CONTEXT_WINDOW_EXCEEDED')
    assert.equal(result.assembled.replayState, undefined)
    assert.deepEqual(result.assembled.blocks(), [{ type: 'text', text: 'A fact.' }])
    assert.deepEqual(result.chunks.find(chunk => chunk.type === 'usage')?.usage,
      { inputTokens: 13, outputTokens: 7, totalTokens: 27, cacheReadTokens: 5, cacheWriteTokens: 2 })
    assert.doesNotMatch(JSON.stringify(result.chunks), /SYNTHETIC_TOOL_SECRET|fc_forbidden_overflow|call_forbidden_overflow|引用来源/)
  })
}

for (const entry of ['stream', 'prepareCall'] as const) for (const kind of ['function', 'custom', 'hosted'] as const) {
  test(`${entry}: forbidden ${kind} frames preserve later failure classification and cancellation priority`, async t => {
    const fixture = await adapterFixture(t)
    for (const [code, expected] of [['context_length_exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
      ['subscription_sharing_usage_limit_exceeded', 'QUOTA'], ['unknown_error', 'PI_AI_ERROR']] as const) {
      for (const cancel of [false, true]) {
        const owner = new AbortController()
        const call = kind === 'hosted' ? { ...searchOutput('failed_forbidden')[0]!,
          action: { type: 'search', query: 'SYNTHETIC_TOOL_SECRET' } } : {
          type: kind === 'function' ? 'function_call' : 'custom_tool_call',
          id: 'fc_forbidden_failed', call_id: 'call_forbidden_failed', name: 'read', namespace: 'dsh',
          ...(kind === 'function' ? { arguments: '{"path":"SYNTHETIC_TOOL_SECRET"}' } : { input: 'SYNTHETIC_TOOL_SECRET' }) }
        const failed = events([searchOutput('partial_failed')[1]!, call]) as any[]
        failed[failed.length - 1] = { type: 'response.failed', response: { status: 'failed',
          usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27,
            input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 } },
          error: { code, message: 'SYNTHETIC_TOOL_SECRET' } } }
        let requests = 0
        globalThis.fetch = async (_input, init) => {
          requests++; assert.equal(JSON.parse(String(init?.body)).tool_choice, 'none'); return sse(failed)
        }
        const adapter = fixture.make()
        const options = { ...request(), purpose: 'compaction' as const, signal: owner.signal }
        const stream = entry === 'stream' ? adapter.stream(options) : (await adapter.prepareCall(PROVIDER_ID, MODEL.id)).stream(options)
        const chunks: StreamChunk[] = [], assembled = new BlockAssembler()
        for await (const chunk of stream) { chunks.push(chunk); assembled.push(chunk); if (cancel && chunk.type === 'usage') owner.abort() }
        const label = code + ',cancel=' + cancel
        assert.equal(requests, 1, label)
        assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'
          || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
          || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')), false, label)
        assert.equal(assembled.finish.kind, cancel ? 'aborted' : 'error', label)
        if (assembled.finish.kind !== 'error' && assembled.finish.kind !== 'aborted') assert.fail(label)
        assert.equal(assembled.finish.failure?.code, cancel ? 'ABORTED' : expected, label)
        assert.equal(assembled.replayState, undefined, label)
        assert.deepEqual(assembled.blocks(), [{ type: 'text', text: 'A fact.' }], label)
        assert.deepEqual(chunks.find(chunk => chunk.type === 'usage')?.usage,
          { inputTokens: 13, outputTokens: 7, totalTokens: 27, cacheReadTokens: 5, cacheWriteTokens: 2 }, label)
        assert.doesNotMatch(JSON.stringify(chunks), /SYNTHETIC_TOOL_SECRET|fc_forbidden_failed|call_forbidden_failed|引用来源/)
      }
    }
  })
}

for (const entry of ['stream', 'prepareCall'] as const) {
  test(`${entry}: compaction rejects tool calls present only in terminal output`, async t => {
    const fixture = await adapterFixture(t)
    const output = searchOutput('terminal_only')
    const terminalOnly = events([output[1]!]) as any[]
    terminalOnly.at(-1).response.output = output
    let requests = 0
    globalThis.fetch = async (_input, init) => {
      requests++
      assert.equal(JSON.parse(String(init?.body)).tool_choice, 'none')
      return sse(terminalOnly)
    }
    const adapter = fixture.make()
    const options = { ...request(), purpose: 'compaction' as const }
    const result = await collect(entry === 'stream' ? adapter.stream(options)
      : (await adapter.prepareCall(PROVIDER_ID, MODEL.id)).stream(options))
    assert.equal(requests, 1)
    assert.equal(result.assembled.finish.kind, 'error')
    assert.equal(result.assembled.replayState, undefined)
    assert.deepEqual(result.assembled.blocks(), [{ type: 'text', text: 'A fact.' }])
    assert.ok(result.chunks.some(chunk => chunk.type === 'usage' && chunk.usage.totalTokens === 14))
  })
}

for (const entry of ['stream', 'prepareCall'] as const) test(`${entry}: compaction preserves owner cancellation over an observed forbidden call`, async t => {
  const owner = new AbortController()
  const fixture = await adapterFixture(t, undefined, owner.signal)
  let requests = 0
  globalThis.fetch = async (_input, init) => {
    requests++
    assert.equal(JSON.parse(String(init?.body)).tool_choice, 'none')
    const prefix = [
      { type: 'response.output_item.added', output_index: 0, item: searchOutput('owner_cancel')[0]! },
      { type: 'response.output_item.added', output_index: 1, item: { ...searchOutput('owner_cancel')[1]!, content: [] } },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Trusted partial' },
    ]
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('')))
      init?.signal?.addEventListener('abort', () => controller.close(), { once: true })
    } }), { headers: { 'content-type': 'text/event-stream' } })
  }
  const chunks: StreamChunk[] = []
  const adapter = fixture.make()
  const options = { ...request(), purpose: 'compaction' as const }
  const stream = entry === 'stream' ? adapter.stream(options) : (await adapter.prepareCall(PROVIDER_ID, MODEL.id)).stream(options)
  for await (const chunk of stream) {
    chunks.push(chunk)
    if (chunk.type === 'text-delta') owner.abort()
  }
  assert.equal(requests, 1)
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish')
  assert.equal(finish.reason.kind, 'aborted')
  assert.equal(finish.replayState, undefined)
})

for (const entry of ['stream', 'prepareCall'] as const) test(`${entry}: caller cancellation outranks buffered forbidden-tool failure and retains usage`, async t => {
  const fixture = await adapterFixture(t)
  let requests = 0
  globalThis.fetch = async (_input, init) => {
    requests++
    assert.equal(JSON.parse(String(init?.body)).tool_choice, 'none')
    return sse(events())
  }
  const adapter = fixture.make()
  const abort = new AbortController()
  const options = { ...request(), purpose: 'compaction' as const, signal: abort.signal }
  const stream = entry === 'stream' ? adapter.stream(options) : (await adapter.prepareCall(PROVIDER_ID, MODEL.id)).stream(options)
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
    if (chunk.type === 'usage') abort.abort()
  }
  assert.equal(requests, 1)
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish')
  assert.equal(finish.reason.kind, 'aborted')
  assert.equal(finish.replayState, undefined)
  assert.ok(chunks.some(chunk => chunk.type === 'usage' && chunk.usage.totalTokens === 14))
  assert.doesNotMatch(JSON.stringify(chunks), /引用来源/)
})

test('compaction rejects hosted progress even when completed output hides the call', async t => {
  const fixture = await adapterFixture(t)
  let requests = 0
  globalThis.fetch = async (_input, init) => {
    requests++
    assert.equal(JSON.parse(String(init?.body)).tool_choice, 'none')
    return sse([{ type: 'response.web_search_call.searching', output_index: 1, item_id: 'ws_hidden' },
      ...events([searchOutput('hidden')[1]!])])
  }
  const result = await collect(fixture.make().stream({ ...request(), purpose: 'compaction' }))
  assert.equal(requests, 1)
  assert.equal(result.assembled.finish.kind, 'error')
  assert.equal(result.assembled.replayState, undefined)
  assert.deepEqual(result.assembled.blocks(), [{ type: 'text', text: 'A fact.' }])
})

test('native search citations reach durable text and never become local tool calls', async t => {
  const fixture = await adapterFixture(t)
  globalThis.fetch = async () => sse(events())
  const { chunks, assembled } = await collect(fixture.make().stream(request()))
  assert.equal(assembled.finish.kind, 'stop')
  const visible = assembled.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
  assert.ok(visible.includes('[Primary \\[source\\]](https://example.test/fact)'))
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
  assert.ok(assembled.replayState)
  assert.ok(JSON.stringify(assembled.replayState).includes('ws_one'))
})


test('prepared call replays JSON-restored mixed native output at its exact position with function and custom results', async t => {
  const fixture = await adapterFixture(t)
  const output = [
    { type: 'reasoning', id: 'rs_mixed', summary: [], encrypted_content: 'synthetic-encrypted-reason' },
    searchOutput('mixed')[0]!,
    { ...searchOutput('commentary')[1]!, phase: 'commentary', content: [
      { type: 'output_text', text: 'A fact.', annotations: [annotation] },
      { type: 'output_text', text: ' A second part.', annotations: [] },
    ] },
    { type: 'function_call', id: 'fc_read', call_id: 'call_read', name: 'read', namespace: 'dsh', arguments: '{"path":"fixture"}', status: 'completed' },
    { type: 'custom_tool_call', id: 'ctc_edit', call_id: 'call_edit', name: 'edit', namespace: 'custom', input: 'a synthetic edit', status: 'completed' },
    searchOutput('final')[1]!,
  ]
  const historical = persistedHistory(output)
  assert.equal(historical.source.replayState.response.kind, 'chatgpt-subscription-native')
  let wire: any
  globalThis.fetch = async (_input, init) => { wire = JSON.parse(String(init?.body)); return sse(events(searchOutput('next'))) }
  const messages = JSON.parse(JSON.stringify([
    ...request().messages, historical,
    { role: 'tool', id: MessageId('tool_read'), toolCallId: ToolCallId('call_read|fc_read'),
      source: { kind: 'tool', callId: ToolCallId('call_read|fc_read') }, content: [{ type: 'text', text: 'read result' }] },
    { role: 'tool', id: MessageId('tool_edit'), toolCallId: ToolCallId('call_edit|ctc_edit'),
      source: { kind: 'tool', callId: ToolCallId('call_edit|ctc_edit') }, content: [{ type: 'text', text: 'edit result' }] },
    { role: 'user', content: [{ type: 'text', text: 'continue' }] },
  ]))
  const restored = fixture.make()
  const secondPrepared = await restored.prepareCall(PROVIDER_ID, MODEL.id)
  const second = await collect(secondPrepared.stream({ ...request(), messages }))
  assert.equal(second.assembled.finish.kind, 'stop')
  assert.deepEqual(wire.input.slice(1, 1 + output.length), output)
  assert.deepEqual(wire.input.slice(1 + output.length).map((item: any) => item.type ?? item.role),
    ['function_call_output', 'custom_tool_call_output', 'user'])
  assert.equal(wire.input.find((item: any) => item.type === 'function_call_output').call_id, 'call_read')
  assert.equal(wire.input.find((item: any) => item.type === 'custom_tool_call_output').call_id, 'call_edit')
  assert.equal(JSON.stringify(wire).includes('msg_dsh_'), false)
  assert.equal(wire.input.filter((item: any) => item.type === 'web_search_call').length, 1)
})

// A replay identity is not an execution binding: DSH dispatches by the bare block name.
for (const entry of ['stream', 'prepareCall'] as const) {
  test(entry + ': unbound remote call cannot dispatch the same-named local tool', async t => {
    const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools: [
      { type: 'function', name: 'read', parameters: { type: 'object' } },
      { type: 'namespace', name: 'remote', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] },
    ] }))
    const output = [{ type: 'function_call', id: 'fc_unbound_remote', call_id: 'call_unbound_remote',
      name: 'read', namespace: 'remote', arguments: JSON.stringify({ path: 'SYNTHETIC_REMOTE' }), status: 'completed' }]
    let requests = 0, wire: any
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/responses')
      requests++
      wire = JSON.parse(String(init?.body))
      return sse(events(output))
    }
    const first = await runEntry(fixture.make(), entry, { ...request(), tools: [{ name: 'read',
      description: 'Synthetic local read sentinel', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] })
    assert.equal(requests, 1, 'the real provider/Pi path reached the final mock HTTP exactly once')
    assert.ok(wire.tools.some((tool: any) => tool.type === 'namespace' && tool.name === 'remote'))
    assert.ok(wire.tools.some((tool: any) => tool.type === 'namespace' && tool.name === 'dsh'))
    assert.deepEqual(fakeDispatch(first.chunks), [], 'remote.read must not dispatch local read by bare name')
    assertIdentityRefusal(first)
  })
}

for (const entry of ['stream', 'prepareCall'] as const) {
  for (const kind of ['function', 'custom'] as const) test(entry + ': bound dsh ' + kind + ' remains executable', async t => {
    const declaration = kind === 'function' ? { type: 'function', name: 'read', parameters: { type: 'object' } }
      : { type: 'custom', name: 'read', format: { type: 'text' } }
    const fixture = await adapterFixture(t, payload => ({ ...payload as object,
      tools: [{ type: 'namespace', name: 'dsh', tools: [declaration] }] }))
    const output = [{ type: kind === 'function' ? 'function_call' : 'custom_tool_call', id: 'fc_bound',
      call_id: 'call_bound', name: 'read', namespace: 'dsh', status: 'completed',
      ...(kind === 'function' ? { arguments: '{"path":"SYNTHETIC_LOCAL"}' } : { input: 'SYNTHETIC_LOCAL' }) }]
    let requests = 0, wire: any
    globalThis.fetch = async (url, init) => { requests++; assert.equal(String(url), 'https://api.openai.com/v1/responses')
      wire = JSON.parse(String(init?.body)); return sse(events(output)) }
    const result = await runEntry(fixture.make(), entry, { ...request(), tools: [localRead] })
    assert.equal(requests, 1)
    assert.equal(wire.tools.find((group: any) => group.name === 'dsh').tools[0].type, kind)
    assert.equal(result.assembled.finish.kind, 'tool-calls')
    assert.deepEqual(fakeDispatch(result.chunks), ['LOCAL_READ_SENTINEL'], 'same host-style dispatcher is live for a bound local call')
    assert.ok(result.assembled.replayState)
  })
  test(entry + ': mixed local and remote output cannot release a same-named remote call', async t => {
    const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools: [
      { type: 'function', name: 'read', parameters: { type: 'object' } },
      { type: 'namespace', name: 'remote', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] },
    ] }))
    const output = ['dsh', 'remote'].map(namespace => ({ type: 'function_call', id: 'fc_' + namespace,
      call_id: 'call_' + namespace, name: 'read', namespace, arguments: JSON.stringify({ path: 'SYNTHETIC_' + namespace }), status: 'completed' }))
    let requests = 0, wire: any
    globalThis.fetch = async (_url, init) => { requests++; wire = JSON.parse(String(init?.body)); return sse(events(output)) }
    const result = await runEntry(fixture.make(), entry, { ...request(), tools: [localRead] })
    assert.equal(requests, 1)
    assert.ok(wire.tools.some((group: any) => group.name === 'remote'))
    assertIdentityRefusal(result)
    assert.deepEqual(fakeDispatch(result.chunks), [], 'the mixed turn is refused atomically before any local-name dispatch')
  })
  test(entry + ': one tool block cannot use a dsh item-done identity contradicted by terminal remote output', async t => {
    const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools: [
      { type: 'function', name: 'read', parameters: { type: 'object' } },
      { type: 'namespace', name: 'remote', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] },
    ] }))
    const item = { type: 'function_call', id: 'fc_identity_conflict', call_id: 'call_identity_conflict', name: 'read', namespace: 'dsh', arguments: '{}' }
    const streamed = events([item]) as any[]
    streamed.at(-1).response.output = [{ ...item, namespace: 'remote' }]
    let requests = 0
    globalThis.fetch = async () => { requests++; return sse(streamed) }
    const result = await runEntry(fixture.make(), entry, { ...request(), tools: [localRead] })
    assert.equal(requests, 1)
    assert.equal(streamed.filter(event => event.type === 'response.output_item.done').length, 1, 'one actual Pi block avoids the duplicate-block guard')
    assertIdentityRefusal(result)
    assert.deepEqual(fakeDispatch(result.chunks), [], 'terminal identity disagreement is not discarded by call-id de-duplication')
  })
  for (const phase of ['added', 'terminal'] as const) for (const namespace of ['dsh', 'remote'] as const) {
    test(entry + ': same item id rejects changed call id in ' + phase + ' with ' + namespace + ' namespace', async t => {
      const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools: [
        { type: 'function', name: 'read', parameters: { type: 'object' } },
        { type: 'namespace', name: 'remote', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] },
      ] }))
      const item = { type: 'function_call', id: 'fc_reassigned', call_id: 'call_original', name: 'read', namespace: 'dsh', arguments: '{}' }
      const streamed = events([item]) as any[]
      const changed = { ...item, call_id: 'call_reassigned', namespace }
      if (phase === 'added') streamed[0].item = changed
      else streamed.at(-1).response.output = [changed]
      let requests = 0
      globalThis.fetch = async () => { requests++; return sse(streamed) }
      const result = await runEntry(fixture.make(), entry, { ...request(), tools: [localRead] })
      assert.equal(requests, 1, 'identity failure must not retry or invoke a remedial model')
      assertIdentityRefusal(result)
      assert.deepEqual(fakeDispatch(result.chunks), [], 'same-item contradictory identity must not release any executable local block')
    })
  }
  test(entry + ': identity evidence rejects conflicting added or terminal id/name/type fields', async t => {
    const fixture = await adapterFixture(t)
    const item = { type: 'function_call', id: 'fc_fields_conflict', call_id: 'call_fields_conflict', name: 'read', namespace: 'dsh', arguments: '{}' }
    const conflicts = [
      { label: 'added namespace', added: { ...item, namespace: 'remote' } },
      { label: 'terminal item id', terminal: { ...item, id: 'fc_another' } },
      { label: 'terminal tool name', terminal: { ...item, name: 'another' } },
      { label: 'terminal call type', terminal: { ...item, type: 'custom_tool_call', input: 'SYNTHETIC_CUSTOM' } },
    ]
    for (const conflict of conflicts) {
      const streamed = events([item]) as any[]
      if (conflict.added) streamed[0].item = conflict.added
      if (conflict.terminal) streamed.at(-1).response.output = [conflict.terminal]
      let requests = 0
      globalThis.fetch = async () => { requests++; return sse(streamed) }
      const result = await runEntry(fixture.make(), entry, { ...request(), tools: [localRead] })
      assert.equal(requests, 1, conflict.label)
      assertIdentityRefusal(result)
      assert.deepEqual(fakeDispatch(result.chunks), [], conflict.label)
    }
  })
  test(entry + ': repeated call identity with remote and local namespaces is ambiguous', async t => {
    const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools: [
      { type: 'function', name: 'read', parameters: { type: 'object' } },
      { type: 'namespace', name: 'remote', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] },
    ] }))
    const output = ['remote', 'dsh'].map(namespace => ({ type: 'function_call', id: 'fc_conflicting',
      call_id: 'call_conflicting', name: 'read', namespace, arguments: JSON.stringify({ path: 'SYNTHETIC_' + namespace }) }))
    let requests = 0
    globalThis.fetch = async () => { requests++; return sse(events(output)) }
    const result = await runEntry(fixture.make(), entry, { ...request(), tools: [localRead] })
    assert.equal(requests, 1)
    assertIdentityRefusal(result)
    assert.deepEqual(fakeDispatch(result.chunks), [], 'last-write-wins capture must not conceal a conflicting remote identity')
  })
  test(entry + ': a remote custom call cannot dispatch local read', async t => {
    const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools: [
      { type: 'function', name: 'read', parameters: { type: 'object' } },
      { type: 'namespace', name: 'remote', tools: [{ type: 'custom', name: 'read', format: { type: 'text' } }] },
    ] }))
    let requests = 0
    globalThis.fetch = async () => { requests++; return sse(events([{ type: 'custom_tool_call', id: 'ctc_remote',
      call_id: 'call_custom_remote', name: 'read', namespace: 'remote', input: 'SYNTHETIC_REMOTE_CUSTOM' }])) }
    const result = await runEntry(fixture.make(), entry, { ...request(), tools: [localRead] })
    assert.equal(requests, 1)
    assertIdentityRefusal(result)
    assert.deepEqual(fakeDispatch(result.chunks), [])
  })
  test(entry + ': item-done binds a local call when terminal output cannot form native replay', async t => {
    const fixture = await adapterFixture(t)
    const output = [{ type: 'function_call', id: 'fc_partial', call_id: 'call_partial', name: 'read', namespace: 'dsh', arguments: '{}' }]
    const streamed = events(output) as any[]
    streamed.at(-1).response.output = []
    let requests = 0
    globalThis.fetch = async () => { requests++; return sse(streamed) }
    const first = await runEntry(fixture.make(), entry, { ...request(), tools: [localRead] })
    assert.equal(requests, 1)
    assert.equal(first.assembled.finish.kind, 'tool-calls')
    assert.deepEqual(fakeDispatch(first.chunks), ['LOCAL_READ_SENTINEL'])
    assert.equal((first.assembled.replayState?.response as any).kind, 'pi-ai')
    const historical = first.assembled.message({ provider: PROVIDER_ID, model: MODEL.id, replayState: first.assembled.replayState })
    let wire: any
    globalThis.fetch = async (_url, init) => { requests++; wire = JSON.parse(String(init?.body)); return sse(events()) }
    assert.equal((await runEntry(fixture.make(), entry, { ...request(), messages: [...request().messages, historical] })).assembled.finish.kind, 'stop')
    assert.equal(requests, 2)
    assert.equal(wire.input.find((item: any) => item.type === 'function_call').namespace, 'dsh')
  })
}

for (const entry of ['stream', 'prepareCall'] as const) {
  test(entry + ': failed or EOF tool-first response retains later partial text without executable chunks', async t => {
    const fixture = await adapterFixture(t)
    for (const status of ['failed', 'EOF']) {
      const output = [{ type: 'function_call', id: 'fc_partial_failed', call_id: 'call_partial_failed', name: 'read', namespace: 'dsh', arguments: '{"path":"SYNTHETIC_PARTIAL_TOOL_SECRET"}' },
        { type: 'message', id: 'msg_partial_failed', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'A fact.', annotations: [] }] }]
      const streamed = events(output) as any[]
      streamed.pop()
      if (status === 'failed') streamed.push({ type: 'response.failed', response: { status: 'failed',
        error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'SYNTHETIC_PARTIAL_TOOL_SECRET' },
        usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 } } })
      let requests = 0
      globalThis.fetch = async (_url, init) => { requests++; assert.equal(JSON.parse(String(init?.body)).tools[0].name, 'dsh'); return sse(streamed) }
      const result = await runEntry(fixture.make(), entry, { ...request(), tools: [localRead] })
      assert.equal(requests, 1, status)
      assert.equal(result.assembled.finish.kind, 'error', status)
      if (result.assembled.finish.kind === 'error') assert.equal(result.assembled.finish.failure.code, status === 'failed' ? 'QUOTA' : 'TRANSPORT', status)
      assert.deepEqual(result.assembled.blocks(), [{ type: 'text', text: 'A fact.' }], status)
      assert.equal(result.assembled.replayState, undefined, status)
      assert.equal(result.chunks.some(chunk => chunk.type === 'tool-call-delta'
        || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
        || (chunk.type === 'block-end' && chunk.block.type === 'tool-call')), false, status)
      assert.deepEqual(fakeDispatch(result.chunks), [], status)
      assert.doesNotMatch(JSON.stringify(result.chunks), /SYNTHETIC_PARTIAL_TOOL_SECRET|fc_partial_failed|call_partial_failed/, status)
      if (status === 'failed') assert.equal(result.assembled.usage?.totalTokens, 27)
    }
  })
}

for (const entry of ['stream', 'prepareCall'] as const) for (const withReasoning of [false, true]) {
  test(entry + ': buffered tool preserves source order before ' + (withReasoning ? 'reasoning and text' : 'text') + ' through fresh-adapter replay', async t => {
    const fixture = await adapterFixture(t)
    const output = [{ type: 'function_call', id: 'fc_ordered', call_id: 'call_ordered', name: 'read', namespace: 'dsh', arguments: '{"path":"ORDERED_FIXTURE"}' },
      ...(withReasoning ? [{ type: 'reasoning', id: 'rs_ordered', summary: [{ type: 'summary_text', text: 'ORDERED_REASONING' }], encrypted_content: 'ORDERED_ENCRYPTED' }] : []),
      { type: 'message', id: 'msg_ordered', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'A fact.', annotations: [] }] }]
    let requests = 0, wire: any
    globalThis.fetch = async (_url, init) => { requests++; wire = JSON.parse(String(init?.body)); return sse(events(output)) }
    const first = await runEntry(fixture.make(), entry, { ...request(), tools: [localRead] })
    assert.equal(requests, 1)
    assert.equal(first.assembled.finish.kind, 'tool-calls')
    const expected = withReasoning ? ['tool-call', 'reasoning', 'text'] : ['tool-call', 'text']
    assert.deepEqual(first.assembled.blocks().map(block => block.type), expected, 'durable content order follows the source even when the first tool is buffered')
    assert.deepEqual(first.assembled.replayState?.blocks?.map((block: any) => block.type), expected, 'Pi metadata stays index-aligned')
    assert.equal((first.assembled.replayState?.response as any).kind, 'chatgpt-subscription-native')
    const historical = first.assembled.message({ provider: PROVIDER_ID, model: MODEL.id, replayState: first.assembled.replayState })
    const restored = JSON.parse(JSON.stringify(historical))
    globalThis.fetch = async (_url, init) => { requests++; wire = JSON.parse(String(init?.body)); return sse(events()) }
    const next = await runEntry(fixture.make(), entry, { ...request(), messages: [...request().messages, restored,
      { role: 'tool', id: MessageId('ordered_result'), toolCallId: ToolCallId('call_ordered|fc_ordered'), source: { kind: 'tool', callId: ToolCallId('call_ordered|fc_ordered') },
        content: [{ type: 'text', text: 'ORDERED_RESULT' }] }, { role: 'user', content: [{ type: 'text', text: 'ORDERED_CONTINUE' }] }] })
    assert.equal(next.assembled.finish.kind, 'stop')
    assert.equal(requests, 2)
    assert.deepEqual(wire.input.slice(1, 1 + output.length), output, 'a fresh adapter replays the original native sequence at its exact span')
    assert.equal(wire.input[1 + output.length].type, 'function_call_output')
    assert.equal(wire.input[1 + output.length].call_id, 'call_ordered')
    assert.equal(wire.input[1 + output.length].output, 'ORDERED_RESULT')
    assert.match(JSON.stringify(wire.input.at(-1)), /ORDERED_CONTINUE/)
    assert.doesNotMatch(JSON.stringify(wire.input), /msg_dsh_/)
  })
}

test('both entries transmit synthetic Personal system/user instructions and skill results in order without stale replay context', async t => {
  const fixture = await adapterFixture(t)
  const system = (version: string) => ({ role: 'system' as const, id: MessageId('personal_system'), source: { kind: 'system-prompt' as const },
    content: [{ type: 'text' as const, text: 'PERSONAL_SYSTEM_' + version + ': use current input-understanding and output-align methods.' }] })
  const instructions = (version: string) => ({ role: 'user' as const, content: [{ type: 'text' as const,
    text: 'PERSONAL_USER_' + version + ': synthetic workspace Personal router; read the selected skill, preserve current requirements.' }] })
  const output = [searchOutput('personal_payload')[0]!, { type: 'function_call', id: 'fc_personal_skill',
    call_id: 'call_personal_skill', name: 'read', namespace: 'dsh', arguments: '{"path":"SYNTHETIC_SKILL.md"}' }]
  for (const entry of ['stream', 'prepareCall'] as const) {
    const bodies: any[] = []
    globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sse(events(output)) }
    const first = await runEntry(fixture.make(), entry, { ...request(), tools: [localRead], messages: [system('OLD'), instructions('OLD')] })
    assert.equal(first.assembled.finish.kind, 'tool-calls')
    const historical = first.assembled.message({ provider: PROVIDER_ID, model: MODEL.id, replayState: first.assembled.replayState })
    const skillResult = { role: 'tool' as const, id: MessageId('personal_skill_result'), toolCallId: ToolCallId('call_personal_skill|fc_personal_skill'),
      source: { kind: 'tool' as const, callId: ToolCallId('call_personal_skill|fc_personal_skill') }, content: [{ type: 'text' as const,
        text: '<skill_content>PERSONAL_SKILL_BODY: synthetic input-understanding → output-align; only verify payload transfer, not model compliance.</skill_content>' }] }
    globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sse(events()) }
    for (const version of ['CURRENT', 'REVISED']) {
      const next = await runEntry(fixture.make(), entry, { ...request(), tools: [localRead],
        messages: [system(version), instructions(version), historical, skillResult,
          { role: 'user', content: [{ type: 'text', text: 'PERSONAL_FOLLOWUP_' + version }] }] })
      assert.equal(next.assembled.finish.kind, 'stop')
      const input = bodies.at(-1).input
      assert.deepEqual(input.map((item: any) => item.type ?? item.role),
        ['developer', 'user', 'web_search_call', 'function_call', 'function_call_output', 'user'])
      assert.match(JSON.stringify(input[0]), new RegExp('PERSONAL_SYSTEM_' + version))
      assert.match(JSON.stringify(input[1]), new RegExp('PERSONAL_USER_' + version))
      assert.deepEqual(input.slice(2, 4), output, 'native output stays at its historical span')
      assert.equal(input[4].call_id, 'call_personal_skill')
      assert.match(input[4].output, /PERSONAL_SKILL_BODY.*input-understanding → output-align/)
      assert.match(JSON.stringify(input[5]), new RegExp('PERSONAL_FOLLOWUP_' + version))
      assert.doesNotMatch(JSON.stringify(bodies.at(-1)), /PERSONAL_SYSTEM_OLD|PERSONAL_USER_OLD|msg_dsh_/)
      if (version === 'REVISED') assert.doesNotMatch(JSON.stringify(bodies.at(-1)), /PERSONAL_SYSTEM_CURRENT|PERSONAL_USER_CURRENT|PERSONAL_FOLLOWUP_CURRENT/)
    }
    assert.equal(bodies.length, 3, 'one seed and two current-instruction requests use the real mocked HTTP')
    assert.match(JSON.stringify(bodies[0]), /PERSONAL_SYSTEM_OLD.*PERSONAL_USER_OLD/)
  }
})

test('both entries preserve a persisted non-dsh call identity after visible arguments are edited', async t => {
  let tools: unknown[] = [{ type: 'namespace', name: 'remote', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] },
    { type: 'function', name: 'read', parameters: { type: 'object' } }]
  const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools }))
  const output = [{ type: 'function_call', id: 'fc_identity', call_id: 'call_identity', name: 'read', namespace: 'remote',
    arguments: '{"path":"PRIVATE_DIAGNOSTIC_OLD"}', status: 'completed' }]
  for (const entry of ['stream', 'prepareCall'] as const) {
    let wire: any
    const historical = persistedHistory(output)
    historical.content[0].arguments = '{"path":"CURRENT_EDIT"}'
    tools = [] // Current declarations cannot veto an otherwise trustworthy historical identity.
    globalThis.fetch = async (_input, init) => { wire = JSON.parse(String(init?.body)); return sse(events()) }
    const next = await runEntry(fixture.make(), entry, { ...request(), messages: [...request().messages, historical,
      { role: 'tool', id: MessageId('result_identity'), toolCallId: ToolCallId('call_identity|fc_identity'),
        source: { kind: 'tool', callId: ToolCallId('call_identity|fc_identity') }, content: [{ type: 'text', text: 'CURRENT_RESULT' }] }] })
    assert.equal(next.assembled.finish.kind, 'stop')
    const call = wire.input.find((item: any) => item.type === 'function_call')
    assert.equal(call.namespace, 'remote', 'editing visible content must not silently retarget the tool to dsh')
    assert.equal(call.arguments, '{"path":"CURRENT_EDIT"}')
    assert.equal(wire.input.find((item: any) => item.type === 'function_call_output').call_id, call.call_id)
    assert.doesNotMatch(JSON.stringify(wire), /PRIVATE_DIAGNOSTIC_OLD|msg_dsh_/)
  }
})

test('both entries keep function and custom call/result kinds through native and edited JSON replay', async t => {
  let tools: unknown[] = []
  const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools }))
  const output = [
    { type: 'function_call', id: 'fc_local', call_id: 'call_local', name: 'same', namespace: 'dsh', arguments: '{"value":"local"}' },
    { type: 'function_call', id: 'fc_remote', call_id: 'call_remote', name: 'same', namespace: 'remote', arguments: '{"value":"remote"}' },
    { type: 'custom_tool_call', id: 'ctc_remote', call_id: 'call_custom', name: 'same', namespace: 'custom', input: 'PRIVATE_DIAGNOSTIC_OLD_CUSTOM' },
  ]
  for (const entry of ['stream', 'prepareCall'] as const) {
    let wire: any
    let requests = 0
    const historical = persistedHistory(output)
    const results = output.map(item => ({ role: 'tool' as const, id: MessageId('result_' + item.call_id),
      toolCallId: ToolCallId(item.call_id + '|' + item.id), source: { kind: 'tool' as const, callId: ToolCallId(item.call_id + '|' + item.id) },
      content: [{ type: 'text' as const, text: 'CURRENT_' + item.call_id }] }))
    tools = []
    globalThis.fetch = async (_input, init) => { requests++; wire = JSON.parse(String(init?.body)); return sse(events()) }
    const replay = async () => runEntry(fixture.make(), entry, { ...request(), messages: [...request().messages, historical, ...results] })
    assert.equal((await replay()).assembled.finish.kind, 'stop')
    assert.deepEqual(wire.input.slice(1, 4), output)
    assert.deepEqual(wire.input.slice(4).map((item: any) => [item.type, item.call_id]), [
      ['function_call_output', 'call_local'], ['function_call_output', 'call_remote'], ['custom_tool_call_output', 'call_custom']])
    historical.content[2].arguments = '{"input":"CURRENT_CUSTOM"}'
    assert.equal((await replay()).assembled.finish.kind, 'stop')
    const calls = wire.input.filter((item: any) => item.type === 'function_call' || item.type === 'custom_tool_call')
    assert.deepEqual(calls.map((item: any) => [item.type, item.namespace, item.name, item.call_id]), [
      ['function_call', 'dsh', 'same', 'call_local'], ['function_call', 'remote', 'same', 'call_remote'],
      ['custom_tool_call', 'custom', 'same', 'call_custom']])
    assert.equal(calls[2].input, 'CURRENT_CUSTOM')
    assert.equal(Object.hasOwn(calls[2], 'arguments'), false)
    assert.deepEqual(wire.input.slice(4).map((item: any) => [item.type, item.call_id]), [
      ['function_call_output', 'call_local'], ['function_call_output', 'call_remote'], ['custom_tool_call_output', 'call_custom']])
    assert.equal(requests, 2)
    assert.doesNotMatch(JSON.stringify(wire), /PRIVATE_DIAGNOSTIC_OLD_CUSTOM|msg_dsh_/)
  }
})

test('both entries reject non-dsh and custom histories with missing identity before HTTP', async t => {
  let tools: unknown[] = []
  const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools }))
  for (const entry of ['stream', 'prepareCall'] as const) for (const kind of ['function', 'custom']) {
    tools = [{ type: 'namespace', name: 'remote', tools: [{ type: kind, name: 'PRIVATE_DIAGNOSTIC_NAME',
      ...(kind === 'function' ? { parameters: { type: 'object' } } : { format: { type: 'text' } }) }] }]
    const output = [{ type: kind === 'custom' ? 'custom_tool_call' : 'function_call', id: kind === 'custom' ? 'ctc_missing' : 'fc_missing',
      call_id: 'call_missing', name: 'PRIVATE_DIAGNOSTIC_NAME', namespace: 'remote',
      ...(kind === 'custom' ? { input: 'PRIVATE_DIAGNOSTIC_INPUT' } : { arguments: '{"value":"PRIVATE_DIAGNOSTIC_INPUT"}' }) }]
    const original = persistedHistory(output)
    const cases: [string, (message: any) => void][] = [
      ['missing envelope', message => { delete message.source.replayState }],
      ['missing namespace', message => { delete message.source.replayState.blocks[0].toolIdentity.namespace }],
      ['missing kind', message => { delete message.source.replayState.blocks[0].toolIdentity.type }],
      ['corrupt identity', message => { message.source.replayState.blocks[0].toolIdentity.fingerprint = 'corrupt' }],
      ['missing blocks', message => { delete message.source.replayState.blocks }],
      ['old untyped Pi', message => { message.source.replayState.response = message.source.replayState.response.piResponse;
        delete message.source.replayState.blocks[0].toolIdentity }],
      ['renamed call', message => { message.content[0].name = 'PRIVATE_DIAGNOSTIC_CHANGED' }],
      ['reidentified call', message => { message.content[0].id = 'call_changed|fc_changed' }],
    ]
    for (const [label, mutate] of cases) {
      const historical = JSON.parse(JSON.stringify(original))
      mutate(historical)
      let requests = 0
      globalThis.fetch = async () => { requests++; return sse(events()) }
      const next = await runEntry(fixture.make(), entry, { ...request(), tools: [
        { name: 'PRIVATE_DIAGNOSTIC_NAME', description: 'A current declaration is not historical provenance', parameters: { type: 'object' } }],
        messages: [...request().messages, historical] })
      assert.equal(requests, 0, label + ': unrecoverable identity never reaches HTTP')
      assert.equal(next.assembled.finish.kind, 'error', label)
      if (next.assembled.finish.kind === 'error') assert.match(next.assembled.finish.failure.message, /tool.*identity|identity.*tool/i)
      assert.equal(next.assembled.replayState, undefined)
      assert.doesNotMatch(JSON.stringify(next.chunks), /PRIVATE_DIAGNOSTIC_/)
    }
  }
})

test('both entries recover only durable tool identities across pruned, corrupt and switched-model envelopes', async t => {
  const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools: [
    { type: 'namespace', name: 'remote', tools: [{ type: 'function', name: 'same', parameters: { type: 'object' } }] },
    { type: 'namespace', name: 'custom', tools: [{ type: 'custom', name: 'edit', format: { type: 'text' } }] }] }))
  const output = [searchOutput('identity_fallback')[1]!,
    { type: 'message', id: 'msg_identity_removed', role: 'assistant', content: [{ type: 'output_text', text: 'PRIVATE_DIAGNOSTIC_DELETED', annotations: [] }] },
    { type: 'function_call', id: 'fc_fallback', call_id: 'call_fallback', name: 'same', namespace: 'remote', arguments: '{"value":"PRIVATE_DIAGNOSTIC_ARGUMENTS"}' },
    { type: 'custom_tool_call', id: 'ctc_fallback', call_id: 'call_edit', name: 'edit', namespace: 'custom', input: 'PRIVATE_DIAGNOSTIC_CUSTOM' }]
  for (const entry of ['stream', 'prepareCall'] as const) {
    const original = persistedHistory(output)
    const cases: [string, (message: any) => void, string?][] = [
      ['prune', message => { message.content.splice(1, 1); message.source.replayState.blocks.splice(1, 1) }],
      ['corrupt output', message => { message.source.replayState.response.output.push({ type: 'message', content: [{ type: 'output_text', text: 'PRIVATE_DIAGNOSTIC_CORRUPT' }] }) }],
      ['unknown envelope version', message => { message.source.replayState.response.version = 400 }],
      ['missing response envelope', message => { delete message.source.replayState.response }],
      ['model switch', () => {}, 'gpt-5.2'],
    ]
    for (const [label, mutate, model] of cases) {
      const historical = JSON.parse(JSON.stringify(original))
      mutate(historical)
      historical.content.find((block: any) => block.type === 'text').text = 'CURRENT_TEXT'
      historical.content.find((block: any) => block.id === 'call_fallback|fc_fallback').arguments = '{"value":"CURRENT_FUNCTION"}'
      historical.content.find((block: any) => block.id === 'call_edit|ctc_fallback').arguments = '{"input":"CURRENT_CUSTOM"}'
      if (label !== 'prune') { historical.content.splice(1, 1); historical.source.replayState.blocks.splice(1, 1) }
      let wire: any
      let requests = 0
      globalThis.fetch = async (_input, init) => { requests++; wire = JSON.parse(String(init?.body)); return sse(events()) }
      const next = await runEntry(fixture.make(), entry, { ...request(), model: model ?? MODEL.id,
        messages: [...request().messages, historical,
          { role: 'tool', id: MessageId('fallback_result'), toolCallId: ToolCallId('call_edit|ctc_fallback'),
            source: { kind: 'tool', callId: ToolCallId('call_edit|ctc_fallback') }, content: [{ type: 'text', text: 'CURRENT_RESULT' }] }] })
      assert.equal(next.assembled.finish.kind, 'stop', label)
      assert.equal(requests, 1, label)
      assert.deepEqual(wire.input.filter((item: any) => item.type === 'function_call' || item.type === 'custom_tool_call')
        .map((item: any) => [item.type, item.namespace, item.name]), [['function_call', 'remote', 'same'], ['custom_tool_call', 'custom', 'edit']], label)
      assert.equal(wire.input.find((item: any) => item.type === 'custom_tool_call_output').call_id, 'call_edit', label)
      assert.match(JSON.stringify(wire.input), /CURRENT_TEXT.*CURRENT_FUNCTION.*CURRENT_CUSTOM.*CURRENT_RESULT/)
      assert.doesNotMatch(JSON.stringify(wire.input), /PRIVATE_DIAGNOSTIC_|msg_dsh_|ws_identity/)
    }
  }
})

test('both entries supplement missing namespace only from the original trusted flat declaration', async t => {
  const fixture = await adapterFixture(t)
  const output = [{ type: 'function_call', id: 'fc_flat', call_id: 'call_flat', name: 'read', arguments: '{"path":"OLD_FLAT"}' }]
  for (const entry of ['stream', 'prepareCall'] as const) {
    let wire: any
    let requests = 0
    globalThis.fetch = async (_input, init) => { requests++; wire = JSON.parse(String(init?.body)); return sse(events(output)) }
    const first = await runEntry(fixture.make(), entry, { ...request(), tools: [
      { name: 'read', description: 'Local fixture', parameters: { type: 'object' } }] })
    assert.equal(first.assembled.finish.kind, 'tool-calls')
    assert.equal(wire.tools[0].name, 'dsh')
    const historical = JSON.parse(JSON.stringify(first.assembled.message({ provider: PROVIDER_ID, model: MODEL.id,
      replayState: first.assembled.replayState })))
    historical.content[0].arguments = '{"path":"CURRENT_FLAT"}'
    globalThis.fetch = async (_input, init) => { requests++; wire = JSON.parse(String(init?.body)); return sse(events()) }
    const next = await runEntry(fixture.make(), entry, { ...request(), messages: [...request().messages, historical] })
    assert.equal(next.assembled.finish.kind, 'stop')
    assert.equal(requests, 2)
    assert.equal(wire.input.find((item: any) => item.type === 'function_call').namespace, 'dsh')
    assert.equal(wire.input.find((item: any) => item.type === 'function_call').arguments, '{"path":"CURRENT_FLAT"}')
    assert.doesNotMatch(JSON.stringify(wire), /OLD_FLAT|msg_dsh_/)
  }
})

test('both entries preserve ordinary Pi replay identity but never restore edited hidden reasoning', async t => {
  let tools: unknown[] = []
  const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools }))
  const calls = [
    { type: 'function_call', id: 'fc_pi_local', call_id: 'call_pi_local', namespace: 'dsh', name: 'same', arguments: '{}' },
    { type: 'function_call', id: 'fc_pi_remote', call_id: 'call_pi_remote', namespace: 'remote', name: 'same', arguments: '{}' },
    { type: 'custom_tool_call', id: 'ctc_pi_custom', call_id: 'call_pi_custom', namespace: 'remote', name: 'edit', input: 'PRIVATE_DIAGNOSTIC_PI_INPUT' }]
  const output = [{ type: 'reasoning', id: 'rs_pi', encrypted_content: 'PRIVATE_DIAGNOSTIC_PI_REASON',
    summary: [{ type: 'summary_text', text: 'Original reasoning' }] }, searchOutput('pi')[1]!, ...calls]
  for (const entry of ['stream', 'prepareCall'] as const) {
    const historical = persistedHistory(output, 'pi')
    assert.equal(historical.source.replayState.response.kind, 'pi-ai')
    const results = calls.map(item => ({ role: 'tool' as const, id: MessageId('result_' + item.call_id),
      toolCallId: ToolCallId(item.call_id + '|' + item.id), source: { kind: 'tool' as const, callId: ToolCallId(item.call_id + '|' + item.id) },
      content: [{ type: 'text' as const, text: 'CURRENT_' + item.call_id }] }))
    tools = []
    let wire: any
    let requests = 0
    globalThis.fetch = async (_input, init) => { requests++; wire = JSON.parse(String(init?.body)); return sse(events()) }
    const replay = () => runEntry(fixture.make(), entry, { ...request(), messages: [...request().messages, historical, ...results] })
    assert.equal((await replay()).assembled.finish.kind, 'stop')
    assert.deepEqual(wire.input.filter((item: any) => item.type === 'function_call' || item.type === 'custom_tool_call')
      .map((item: any) => [item.type, item.namespace, item.name]), [['function_call', 'dsh', 'same'], ['function_call', 'remote', 'same'], ['custom_tool_call', 'remote', 'edit']])
    assert.deepEqual(wire.input.filter((item: any) => item.type?.endsWith('_output')).map((item: any) => [item.type, item.call_id]), [
      ['function_call_output', 'call_pi_local'], ['function_call_output', 'call_pi_remote'], ['custom_tool_call_output', 'call_pi_custom']])
    historical.content.find((block: any) => block.type === 'reasoning').text = 'CURRENT_REASONING'
    historical.content.find((block: any) => block.type === 'text').text = 'CURRENT_TEXT'
    historical.content.find((block: any) => block.name === 'edit').arguments = '{"input":"CURRENT_CUSTOM"}'
    assert.equal((await replay()).assembled.finish.kind, 'stop')
    assert.doesNotMatch(JSON.stringify(wire.input), /PRIVATE_DIAGNOSTIC_|msg_dsh_/)
    delete historical.source.replayState.response.subscriptionReplay
    assert.equal((await replay()).assembled.finish.kind, 'stop')
    assert.equal(requests, 3)
    assert.equal(wire.input.find((item: any) => item.type === 'custom_tool_call').input, 'CURRENT_CUSTOM')
    assert.doesNotMatch(JSON.stringify(wire.input), /PRIVATE_DIAGNOSTIC_|msg_dsh_/)
  }
})

test('both entries reject orphan results after their qualified calls were pruned', async t => {
  const fixture = await adapterFixture(t)
  for (const entry of ['stream', 'prepareCall'] as const) {
    let requests = 0
    globalThis.fetch = async () => { requests++; return sse(events()) }
    const next = await runEntry(fixture.make(), entry, { ...request(), messages: [...request().messages,
      { role: 'tool', id: MessageId('orphan'), toolCallId: ToolCallId('call_pruned|ctc_pruned'),
        source: { kind: 'tool', callId: ToolCallId('call_pruned|ctc_pruned') }, content: [{ type: 'text', text: 'PRIVATE_DIAGNOSTIC_ORPHAN' }] }] })
    assert.equal(requests, 0)
    assert.equal(next.assembled.finish.kind, 'error')
    if (next.assembled.finish.kind === 'error') assert.match(next.assembled.finish.failure.message, /identity|matching.*call/i)
    assert.equal(next.assembled.replayState, undefined)
    assert.doesNotMatch(JSON.stringify(next.chunks), /PRIVATE_DIAGNOSTIC_/)
  }
})

test('both entries refuse duplicate historical call ids instead of choosing a result identity', async t => {
  const fixture = await adapterFixture(t, payload => ({ ...payload as object,
    tools: [{ type: 'namespace', name: 'remote', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] }] }))
  const output = [{ type: 'function_call', id: 'fc_duplicate', call_id: 'call_duplicate', name: 'read', namespace: 'remote', arguments: '{}' }]
  for (const entry of ['stream', 'prepareCall'] as const) {
    const historical = persistedHistory(output)
    let requests = 0
    globalThis.fetch = async () => { requests++; return sse(events()) }
    const next = await runEntry(fixture.make(), entry, { ...request(), messages: [...request().messages, historical,
      { role: 'user', content: [{ type: 'text', text: 'A duplicated turn is ambiguous' }] }, historical] })
    assert.equal(requests, 0)
    assert.equal(next.assembled.finish.kind, 'error')
    if (next.assembled.finish.kind === 'error') assert.match(next.assembled.finish.failure.message, /ambiguous|duplicate|identity/i)
  }
})

test('a named dsh group or ambiguous bare declaration is not original flat provenance', async t => {
  let tools: unknown[] = []
  const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools }))
  for (const entry of ['stream', 'prepareCall'] as const) for (const kind of ['function', 'custom']) {
    const definition = { type: kind, name: 'read', ...(kind === 'function' ? { parameters: { type: 'object' } } : { format: { type: 'text' } }) }
    for (const declarations of [[{ type: 'namespace', name: 'dsh', tools: [definition] }],
      [definition, { type: 'namespace', name: 'remote', tools: [definition] }]]) {
      tools = declarations
      let requests = 0
      globalThis.fetch = async () => { requests++; return sse(events([{ type: kind === 'function' ? 'function_call' : 'custom_tool_call',
        id: kind === 'function' ? 'fc_unknown' : 'ctc_unknown', call_id: 'call_unknown', name: 'read',
        ...(kind === 'function' ? { arguments: '{}' } : { input: 'PRIVATE_DIAGNOSTIC_UNKNOWN' }) }])) }
      const first = await runEntry(fixture.make(), entry, request())
      assert.equal(requests, 1, 'ambiguous fresh output reached the real mocked HTTP')
      assertIdentityRefusal(first)
      assert.deepEqual(fakeDispatch(first.chunks), [])
      assert.doesNotMatch(JSON.stringify(first.chunks), /PRIVATE_DIAGNOSTIC_/)
    }
  }
})

test('both entries safely degrade edited, corrupt and missing text-only envelopes', async t => {
  const fixture = await adapterFixture(t)
  for (const entry of ['stream', 'prepareCall'] as const) {
    globalThis.fetch = async () => sse(events())
    const first = await runEntry(fixture.make(), entry, request())
    const original = first.assembled.message({ provider: PROVIDER_ID, model: MODEL.id, replayState: first.assembled.replayState })
    const cases: ((message: any) => void)[] = [message => { delete message.source.replayState },
      message => { message.source.replayState.response.version = 400 },
      message => { message.source.replayState.response.output[1].content[0].text = 'PRIVATE_DIAGNOSTIC_HIDDEN' }]
    for (const mutate of cases) {
      const historical = JSON.parse(JSON.stringify(original))
      historical.content[0].text = 'CURRENT_TEXT_ONLY'
      mutate(historical)
      let wire: any
      let requests = 0
      globalThis.fetch = async (_input, init) => { requests++; wire = JSON.parse(String(init?.body)); return sse(events()) }
      const next = await runEntry(fixture.make(), entry, { ...request(), model: 'gpt-5.2', messages: [...request().messages, historical] })
      assert.equal(next.assembled.finish.kind, 'stop')
      assert.equal(requests, 1)
      assert.match(JSON.stringify(wire.input), /CURRENT_TEXT_ONLY/)
      assert.doesNotMatch(JSON.stringify(wire.input), /PRIVATE_DIAGNOSTIC_HIDDEN|A fact|web_search_call|msg_dsh_/)
    }
  }
})

test('both entries keep repeated persisted input, append prefixes and session cache keys stable', async t => {
  const fixture = await adapterFixture(t, payload => ({ ...payload as object, tools: [{ type: 'namespace', name: 'remote', tools: [
    { type: 'function', name: 'read', parameters: { type: 'object' } }, { type: 'custom', name: 'edit', format: { type: 'text' } }] }] }))
  const output = [...searchOutput('stable'),
    { type: 'function_call', id: 'fc_stable', call_id: 'call_stable', name: 'read', namespace: 'remote', arguments: '{}' },
    { type: 'custom_tool_call', id: 'ctc_stable', call_id: 'call_stable_custom', name: 'edit', namespace: 'remote', input: 'stable custom' }]
  for (const entry of ['stream', 'prepareCall'] as const) {
    const historical = persistedHistory(output)
    const bodies: any[] = []
    globalThis.fetch = async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return sse(events()) }
    const options: GenerateOptions = { ...request(), sessionId: 'identity-stable-session' as GenerateOptions['sessionId'],
      messages: [...request().messages, historical] }
    for (let index = 0; index < 2; index++) assert.equal((await runEntry(fixture.make(), entry,
      JSON.parse(JSON.stringify(options)))).assembled.finish.kind, 'stop')
    assert.deepEqual(bodies[1].input, bodies[0].input)
    const appended = await runEntry(fixture.make(), entry, { ...options,
      messages: [...options.messages, { role: 'user', content: [{ type: 'text', text: 'Ordinary append' }] }] })
    assert.equal(appended.assembled.finish.kind, 'stop')
    assert.deepEqual(bodies[2].input.slice(0, bodies[0].input.length), bodies[0].input)
    assert.equal(bodies[0].prompt_cache_key, 'identity-stable-session')
    assert.deepEqual(bodies.map(body => body.prompt_cache_key), ['identity-stable-session', 'identity-stable-session', 'identity-stable-session'])
    assert.doesNotMatch(JSON.stringify(bodies), /msg_dsh_start_|msg_dsh_end_/)
    assert.equal(bodies.length, 3)
  }
})

test('both entries safely downgrade edited legacy Pi reasoning without hidden original content', async t => {
  const fixture = await adapterFixture(t)
  const output = [{ type: 'reasoning', id: 'rs_legacy_edit', encrypted_content: 'PRIVATE_DIAGNOSTIC_LEGACY',
    summary: [{ type: 'summary_text', text: 'Old visible reasoning' }] }, searchOutput('legacy_edit')[1]!]
  globalThis.fetch = async () => sse(events(output))
  const first = await collect(fixture.makePi().stream(request()))
  const original = first.assembled.message({ provider: PROVIDER_ID, model: MODEL.id, replayState: first.assembled.replayState })
  for (const entry of ['stream', 'prepareCall'] as const) for (const model of [MODEL.id, 'gpt-5.2']) for (const editReasoning of [true, false]) {
    const historical = JSON.parse(JSON.stringify(original))
    if (editReasoning) historical.content.find((block: any) => block.type === 'reasoning').text = 'CURRENT_LEGACY_REASONING'
    historical.content.find((block: any) => block.type === 'text').text = 'CURRENT_LEGACY_TEXT'
    let wire: any
    let requests = 0
    globalThis.fetch = async (_input, init) => { requests++; wire = JSON.parse(String(init?.body)); return sse(events()) }
    const next = await runEntry(fixture.make(), entry, { ...request(), model, messages: [...request().messages, historical] })
    assert.equal(next.assembled.finish.kind, 'stop')
    assert.equal(requests, 1)
    assert.match(JSON.stringify(wire.input), /CURRENT_LEGACY_TEXT/)
    assert.doesNotMatch(JSON.stringify(wire.input), /PRIVATE_DIAGNOSTIC_LEGACY|Old visible reasoning/)
  }
})

test('annotation links reject unsafe schemes and escape Markdown destination delimiters', async t => {
  const fixture = await adapterFixture(t)
  const output: Record<string, any>[] = searchOutput('safe')
  output[1]!.content[0].annotations = [
    { ...annotation, title: 'Unsafe JS', url: 'javascript:alert(1)' },
    { ...annotation, title: 'Unsafe file', url: 'file:///private/synthetic' },
    { ...annotation, title: 'Unsafe data', url: 'data:text/html,synthetic' },
    { ...annotation, title: 'Unsafe credentials', url: 'https://name:password@example.test/' },
    { ...annotation, title: '<tag> [safe] \\n label', url: 'https://example.test/a_(b)?q=<x>' },
  ]
  globalThis.fetch = async () => sse(events(output))
  const result = await collect(fixture.make().stream(request()))
  const text = result.assembled.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
  assert.doesNotMatch(text, /Unsafe|javascript:|file:|data:|name:password/)
  assert.ok(text.includes('https://example.test/a_%28b%29?q=%3Cx%3E'))
  assert.ok(text.includes('\\<tag\\> \\[safe\\]'))
  assert.equal(text.includes('https://example.test/visited'), false)
})


test('edited, pruned, switched-model and corrupt native envelopes degrade to current visible text and tools', async t => {
  const fixture = await adapterFixture(t)
  const output: Record<string, any>[] = [
    { type: 'reasoning', id: 'rs_durable', summary: [], encrypted_content: 'must-not-reinject-reason' },
    ...searchOutput('durable'),
    { type: 'message', id: 'msg_deleted', role: 'assistant', content: [{ type: 'output_text', text: 'DELETED_CONTENT', annotations: [] }] },
    { type: 'function_call', id: 'fc_durable', call_id: 'call_durable', name: 'read', arguments: '{}', namespace: 'dsh' },
  ]
  globalThis.fetch = async () => sse(events(output))
  const first = await collect(fixture.make().stream({ ...request(), tools: [localRead] }))
  const original = first.assembled.message({ provider: PROVIDER_ID, model: MODEL.id, replayState: first.assembled.replayState })
  assert.equal((first.assembled.replayState?.response as any).kind, 'chatgpt-subscription-native')
  const cases: [string, (message: any) => void, string?][] = [
    ['edit', message => { message.content[1].text = 'CURRENT_EDIT' }],
    ['prune', message => { message.content.splice(2, 1); message.source.replayState.blocks.splice(2, 1) }],
    ['drop reasoning', message => { message.content.splice(0, 1); message.source.replayState.blocks.splice(0, 1) }],
    ['model switch', () => {}, 'gpt-5.2'],
    ['source mismatch', message => { message.source.provider = 'another-provider' }],
    ['unknown version', message => { message.source.replayState.response.version = 400 }],
    ['corrupt raw', message => { message.source.replayState.response.output.push({ type: 'message', id: 'msg_corrupt', content: [{ type: 'output_text', text: 'CORRUPT_CONTENT' }] }) }],
    ['corrupt signature', message => { message.source.replayState.blocks[0].thinkingSignature = '{' }],
  ]
  for (const [label, mutate, model] of cases) {
    const historical: any = JSON.parse(JSON.stringify(original))
    mutate(historical)
    let wire: any
    globalThis.fetch = async (_input, init) => { wire = JSON.parse(String(init?.body)); return sse(events(searchOutput('next'))) }
    const next = await collect(fixture.make().stream({ ...request(), model: model ?? MODEL.id,
      messages: [...request().messages, historical, { role: 'user', content: [{ type: 'text', text: 'continue' }] }] }))
    assert.equal(next.assembled.finish.kind, 'stop', label)
    assert.equal(wire.input.some((item: any) => item.type === 'web_search_call'), false, label)
    assert.equal(JSON.stringify(wire).includes('must-not-reinject-reason'), false, label)
    assert.equal(JSON.stringify(wire).includes('CORRUPT_CONTENT'), false, label)
    assert.ok(wire.input.some((item: any) => item.type === 'function_call' && item.name === 'read'), label)
    const visible = JSON.stringify(wire.input)
    assert.ok(visible.includes(label === 'edit' ? 'CURRENT_EDIT' : 'A fact.'), label)
    if (label === 'prune') assert.equal(visible.includes('DELETED_CONTENT'), false)
    assert.equal(visible.includes('msg_dsh_'), false)
  }
})

test('consecutive same-text turns replay once in order; a branch or compacted history never restores removed turns', async t => {
  const fixture = await adapterFixture(t)
  const assistant = async (tag: string) => {
    globalThis.fetch = async () => sse(events(searchOutput(tag)))
    const result = await collect(fixture.make().stream(request()))
    return result.assembled.message({ provider: PROVIDER_ID, model: MODEL.id, replayState: result.assembled.replayState })
  }
  const a = await assistant('branch_a')
  const b = await assistant('branch_b')
  const between = { role: 'user' as const, content: [{ type: 'text' as const, text: 'same question again' }] }
  for (const [history, expected] of [
    [[...request().messages, a, between, b, between], ['ws_branch_a', 'ws_branch_b']],
    [[...request().messages, a, between], ['ws_branch_a']],
    [[{ role: 'user', content: [{ type: 'text', text: 'Only the compacted summary remains' }] }], []],
  ] as const) {
    let wire: any
    globalThis.fetch = async (_input, init) => { wire = JSON.parse(String(init?.body)); return sse(events(searchOutput('next'))) }
    await collect(fixture.make().stream({ ...request(), messages: JSON.parse(JSON.stringify(history)) }))
    assert.deepEqual(wire.input.filter((item: any) => item.type === 'web_search_call').map((item: any) => item.id), expected)
    assert.equal(wire.input.filter((item: any) => item.type === 'message').length, expected.length)
  }
})


test('concurrent streams keep their native output, annotations and history scopes separate', async t => {
  const fixture = await adapterFixture(t)
  const adapter = fixture.make()
  let arrivals = 0
  let release!: () => void
  const both = new Promise<void>(resolve => { release = resolve })
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    const tag = body.input[0].content[0].text
    if (++arrivals === 2) release()
    await both
    const output: Record<string, any>[] = searchOutput(tag)
    output[1]!.content[0].annotations = [{ ...annotation, title: tag, url: `https://example.test/${tag}` }]
    return sse(events(output))
  }
  const run = async (tag: string) => collect(adapter.stream({ ...request(), messages: [
    { role: 'user', content: [{ type: 'text', text: tag }] },
  ] }))
  const [left, right] = await Promise.all([run('left'), run('right')])
  for (const [own, foreign, result] of [['left', 'right', left], ['right', 'left', right]] as const) {
    assert.equal(result.assembled.finish.kind, 'stop')
    const visible = JSON.stringify(result.assembled.blocks())
    const state = JSON.stringify(result.assembled.replayState)
    assert.ok(visible.includes(`https://example.test/${own}`))
    assert.equal(visible.includes(`https://example.test/${foreign}`), false)
    assert.ok(state.includes(`ws_${own}`))
    assert.equal(state.includes(`ws_${foreign}`), false)
  }
})

test('stream, item-done and terminal-only annotations bind by message id despite hosted output gaps', async t => {
  const fixture = await adapterFixture(t)
  for (const position of ['stream', 'item-done', 'terminal']) {
    const output: Record<string, any>[] = searchOutput(position)
    const all: any[] = events(output)
    const done = all.find(event => event.type === 'response.output_item.done' && event.item.type === 'message')
    const terminal = all.at(-1)
    done.item = structuredClone(done.item)
    terminal.response.output = structuredClone(terminal.response.output)
    if (position !== 'item-done') done.item.content[0].annotations = []
    if (position !== 'terminal') terminal.response.output[1].content[0].annotations = []
    if (position === 'stream') all.splice(4, 0, { type: 'response.output_text.annotation.added', output_index: 1,
      content_index: 0, annotation_index: 0, annotation })
    globalThis.fetch = async () => sse(all)
    const result = await collect(fixture.make().stream(request()))
    const text = result.assembled.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
    assert.ok(text.includes('https://example.test/fact'), position)
    assert.equal(text.split('https://example.test/fact').length, 2, position)
  }
})

test('body deltas arrive before terminal; citations arrive before block close and usage', async t => {
  const fixture = await adapterFixture(t)
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const all = events()
  const encode = (items: unknown[]) => new TextEncoder().encode(items.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(value) {
    controller = value
    controller.enqueue(encode(all.slice(0, 5)))
  } }), { headers: { 'content-type': 'text/event-stream' } })
  const chunks: StreamChunk[] = []
  let released = false
  for await (const chunk of fixture.make().stream(request())) {
    chunks.push(chunk)
    if (chunk.type === 'text-delta' && !released) {
      assert.equal(chunk.text, 'A fact.')
      assert.equal(chunks.some(chunk => chunk.type === 'block-end'), false)
      released = true
      controller.enqueue(encode(all.slice(5)))
      controller.close()
    }
  }
  assert.equal(released, true)
  const citation = chunks.findIndex(chunk => chunk.type === 'text-delta' && chunk.text.includes('引用来源'))
  const closed = chunks.findIndex(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')
  const usage = chunks.findIndex(chunk => chunk.type === 'usage')
  assert.ok(citation >= 0 && citation < closed && closed < usage)
  assert.equal(chunks.at(-1)?.type, 'finish')
})

test('failed, incomplete, EOF and abort keep safe errors and usage without native replay or search success', async t => {
  const fixture = await adapterFixture(t)
  const usage = { input_tokens: 20, output_tokens: 7, total_tokens: 27,
    input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } }
  for (const status of ['failed', 'incomplete', 'cancelled', 'EOF', 'abort']) {
    const abort = new AbortController()
    const all = events()
    all.pop()
    if (status !== 'EOF' && status !== 'abort') all.push({ type: `response.${status}`, response: { status, usage,
      incomplete_details: { reason: 'max_output_tokens' }, output: searchOutput(),
      error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'fixture-secret-do-not-display' } } })
    globalThis.fetch = async () => {
      if (status === 'abort') { abort.abort(); throw new DOMException('fixture-secret-do-not-display', 'AbortError') }
      return sse(all)
    }
    const result = await collect(fixture.make().stream({ ...request(), signal: abort.signal }))
    assert.equal(result.assembled.finish.kind, status === 'abort' ? 'aborted' : 'error', status)
    assert.equal(result.assembled.replayState, undefined, status)
    assert.equal(JSON.stringify(result.assembled.blocks()).includes('引用来源'), false, status)
    assert.equal(JSON.stringify(result.assembled.finish).includes('fixture-secret-do-not-display'), false, status)
    if (!['EOF', 'abort'].includes(status)) {
      assert.deepEqual(result.assembled.usage, { inputTokens: 13, outputTokens: 7, totalTokens: 27,
        cacheReadTokens: 5, cacheWriteTokens: 2 }, status)
    }
  }
  let requests = 0
  globalThis.fetch = async () => { ++requests; return new Response(JSON.stringify({ error: {
    code: 'subscription_sharing_usage_unavailable', message: 'fixture-secret-do-not-display',
  } }), { status: 429, headers: { 'content-type': 'application/json', 'x-should-retry': 'true', 'retry-after-ms': '1' } }) }
  const refused = await collect(fixture.make().stream(request()))
  assert.equal(requests, 1)
  assert.equal(refused.assembled.finish.kind, 'error')
  assert.equal(refused.assembled.replayState, undefined)
})

test('old Pi envelopes retain text IDs without unbound opaque reasoning and foreign adapters retain visible text', async t => {
  const fixture = await adapterFixture(t)
  const output: Record<string, any>[] = [
    { type: 'reasoning', id: 'rs_legacy', summary: [], encrypted_content: 'legacy-synthetic-encrypted' },
    searchOutput('legacy')[1]!,
  ]
  globalThis.fetch = async () => sse(events(output))
  const old = await collect(fixture.makePi().stream(request()))
  const legacy = old.assembled.message({ provider: PROVIDER_ID, model: MODEL.id, replayState: old.assembled.replayState })
  let wire: any
  globalThis.fetch = async (_input, init) => { wire = JSON.parse(String(init?.body)); return sse(events()) }
  await collect(fixture.make().stream({ ...request(), messages: [...request().messages, legacy] }))
  assert.equal(wire.input.some((item: any) => item.type === 'reasoning'), false)
  assert.doesNotMatch(JSON.stringify(wire.input), /legacy-synthetic-encrypted/)
  assert.equal(wire.input.find((item: any) => item.type === 'message').id, 'msg_legacy')
  globalThis.fetch = async () => sse(events())
  const native = await collect(fixture.make().stream(request()))
  const historical = native.assembled.message({ provider: PROVIDER_ID, model: MODEL.id, replayState: native.assembled.replayState })
  globalThis.fetch = async (_input, init) => { wire = JSON.parse(String(init?.body)); return sse(events()) }
  await collect(fixture.makePi().stream({ ...request(), messages: [...request().messages, historical] }))
  assert.equal(wire.input.some((item: any) => item.type === 'web_search_call'), false)
  assert.ok(JSON.stringify(wire.input).includes('引用来源'))
})


test('prepared native stream keeps Pi generation frozen when current profile changes', async t => {
  const fixture = await adapterFixture(t)
  fixture.setHeader('first')
  const adapter = fixture.make()
  const prepared = await adapter.prepareCall(PROVIDER_ID, MODEL.id)
  fixture.setHeader('second')
  const seen: (string | null)[] = []
  globalThis.fetch = async (_input, init) => {
    seen.push(new Headers(init?.headers).get('x-native-test-generation'))
    return sse(events())
  }
  for (const stream of [prepared.stream(request()), adapter.stream(request())]) {
    const result = await collect(stream)
    assert.equal((result.assembled.replayState?.response as any).kind, 'chatgpt-subscription-native')
  }
  assert.deepEqual(seen, ['first', 'second'])
})

test('native replay with no text restores hosted search and reasoning without manufacturing assistant messages', async t => {
  const fixture = await adapterFixture(t)
  const output: Record<string, any>[] = [
    { type: 'reasoning', id: 'rs_no_text', summary: [], encrypted_content: 'no-text-synthetic-encrypted' },
    searchOutput('no_text')[0]!,
    { type: 'function_call', id: 'fc_no_text', call_id: 'call_no_text', name: 'read', arguments: '{}', namespace: 'dsh' },
  ]
  globalThis.fetch = async () => sse(events(output))
  const result = await collect(fixture.make().stream({ ...request(), tools: [localRead] }))
  const historical = result.assembled.message({ provider: PROVIDER_ID, model: MODEL.id, replayState: result.assembled.replayState })
  assert.equal(result.assembled.blocks().some(block => block.type === 'text'), false)
  let wire: any
  globalThis.fetch = async (_input, init) => { wire = JSON.parse(String(init?.body)); return sse(events()) }
  await collect(fixture.make().stream({ ...request(), messages: [...request().messages, historical] }))
  assert.deepEqual(wire.input.slice(1, 4), output)
  assert.equal(wire.input.some((item: any) => item.type === 'message'), false)
})

test('final wire projection filters late DSH search declarations but retains historical search calls and include union', async () => {
  const provider = subscriptionProvider(manager(), [MODEL], { identity: OFFLINE_IDENTITY })
  let wire: any
  const message = await provider.streamSimple(provider.getModels()[0]!, normalizeContext({ messages: [] }), {
    onPayload: payload => ({ ...(payload as object), include: ['message.output_text.logprobs'],
      tool_choice: { type: 'web_search' },
      tools: [{ type: 'function', name: 'web_search' }, { type: 'custom', name: 'edit' }],
      input: [
        { type: 'additional_tools', tools: [{ type: 'function', name: 'web_search' }, { type: 'function', name: 'read' },
          { type: 'namespace', name: 'dsh', tools: [{ type: 'custom', name: 'web_search' }, { type: 'custom', name: 'edit' }] }] },
        { type: 'function_call', namespace: 'dsh', call_id: 'call_old_search', id: 'fc_old_search', name: 'web_search', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_old_search', output: 'old durable search result' },
      ] }),
    fetch: async (_input, init) => { wire = JSON.parse(String(init?.body)); return sse(events()) },
  }).result()
  assert.equal(message.stopReason, 'stop')
  assert.deepEqual(wire.tool_choice, { type: 'web_search' })
  assert.deepEqual(wire.tools.at(-1), { type: 'web_search' })
  assert.equal(wire.tools[0].tools.some((tool: any) => tool.name === 'web_search'), false)
  assert.equal(wire.input[0].tools.some((group: any) => group.tools.some((tool: any) => tool.name === 'web_search')), false)
  assert.equal(wire.input[1].name, 'web_search')
  assert.equal(wire.input[2].output, 'old durable search result')
  assert.deepEqual(new Set(wire.include), new Set(['message.output_text.logprobs', 'reasoning.encrypted_content', 'web_search_call.action.sources']))
})


test('caller abort between usage and finish takes priority over buffered completed replay', async t => {
  const fixture = await adapterFixture(t)
  globalThis.fetch = async () => sse(events())
  const abort = new AbortController()
  const chunks: StreamChunk[] = []
  for await (const chunk of fixture.make().stream({ ...request(), signal: abort.signal })) {
    chunks.push(chunk)
    if (chunk.type === 'usage') abort.abort()
  }
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish')
  assert.equal(finish.reason.kind, 'aborted')
  assert.equal(finish.replayState, undefined)
  assert.ok(chunks.some(chunk => chunk.type === 'usage' && chunk.usage.totalTokens === 14))
})

test('both subscription entry points disable final compaction tools and keep identical declarations under interleaving', async t => {
  const fixture = await adapterFixture(t)
  const bodies: any[] = []
  globalThis.fetch = async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return sse(events()) }
  const adapter = fixture.make()
  const prepared = await adapter.prepareCall(PROVIDER_ID, MODEL.id)
  const streams = [adapter.stream({ ...request(), purpose: 'compaction' }), adapter.stream(request()),
    prepared.stream({ ...request(), purpose: 'compaction' }), prepared.stream(request())]
  await Promise.all(streams.map(collect))
  assert.equal(bodies.length, 4)
  assert.deepEqual(bodies.map(body => body.tool_choice ?? 'auto').sort(), ['auto', 'auto', 'none', 'none'])
  for (const body of bodies) assert.deepEqual(body.tools, bodies[0].tools)
  assert.ok(bodies[0].tools.some((tool: any) => tool.type === 'web_search'))
})

test('both adapter entries enforce final none after late hook and durable native replay without changing main history', async t => {
  let hookCalls = 0
  const fixture = await adapterFixture(t, payload => {
    hookCalls++
    return { ...payload as object, tool_choice: 'required' }
  })
  const adapter = fixture.make()
  globalThis.fetch = async () => sse(events(searchOutput('policy_history')))
  const first = await collect(adapter.stream(request()))
  assert.equal(first.assembled.finish.kind, 'stop')
  const historical = first.assembled.message({ provider: PROVIDER_ID, model: MODEL.id, replayState: first.assembled.replayState })
  const options: GenerateOptions = { ...request(), tools: [{ name: 'read', description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    messages: JSON.parse(JSON.stringify([...request().messages, historical])) }
  const bodies: any[] = []
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    bodies.push(body)
    return sse(events(body.tool_choice === 'none' ? [searchOutput('summary')[1]!] : searchOutput('main')))
  }
  const prepared = await adapter.prepareCall(PROVIDER_ID, MODEL.id)
  const compact = adapter.stream({ ...options, purpose: 'compaction' })
  const results = await Promise.all([collect(prepared.stream({ ...options, purpose: 'compaction' })),
    collect(adapter.stream(options)), collect(compact), collect(prepared.stream({ ...options, purpose: 'session-title' }))])
  assert.equal(hookCalls, 5)
  assert.equal(bodies.length, 4)
  assert.deepEqual(bodies.map(body => body.tool_choice).sort(), ['none', 'none', 'required', 'required'])
  for (const body of bodies) {
    assert.deepEqual(body.tools, [{ type: 'namespace', name: 'dsh', description: 'Tools supplied by DeepSeek Harness',
      tools: [{ type: 'function', name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } }, strict: false }] },
      { type: 'web_search' }])
    assert.deepEqual(body.input, bodies[0].input)
    assert.deepEqual(body.input.slice(1, 3), searchOutput('policy_history'))
    assert.equal(JSON.stringify(body).includes('msg_dsh_'), false)
  }
  assert.deepEqual(results.map(result => result.assembled.finish.kind), ['stop', 'stop', 'stop', 'stop'])
  assert.ok(JSON.stringify(results[1]!.assembled.blocks()).includes('引用来源'))
})

test('stream construction binds its real Pi prepared before delayed first next', async t => {
  const fixture = await adapterFixture(t)
  const adapter = fixture.make()
  fixture.setHeader('A')
  const bound = adapter.stream(request())
  fixture.setHeader('B')
  const seen: (string | null)[] = []
  globalThis.fetch = async (_input, init) => { seen.push(new Headers(init?.headers).get('x-native-test-generation')); return sse(events()) }
  await collect(bound)
  await collect(adapter.stream(request()))
  assert.deepEqual(seen, ['A', 'B'])
})


test('final compaction projection overrides late required/named tool choice and preserves native history', async () => {
  const provider = subscriptionProvider(manager(), [MODEL], { identity: OFFLINE_IDENTITY })
  for (const choice of ['required', { type: 'web_search' }, { type: 'function', name: 'read' }]) {
    let wire: any
    const result = await nativeSearchScope.run(new NativeSearchCapture(true), () =>
      provider.streamSimple(provider.getModels()[0]!, normalizeContext({ messages: [] }), {
        onPayload: payload => ({ ...(payload as object), tool_choice: choice,
          tools: [{ type: 'function', name: 'read' }], input: [
            { type: 'web_search_call', id: 'ws_historical', status: 'completed', action: { type: 'search', query: 'past' } },
          ] }),
        fetch: async (_input, init) => { wire = JSON.parse(String(init?.body)); return sse(events()) },
      }).result())
    assert.equal(result.stopReason, 'stop')
    assert.equal(wire.tool_choice, 'none'); assert.equal(wire.input[0].id, 'ws_historical')
    assert.deepEqual(wire.tools.map((tool: any) => tool.type), ['namespace', 'web_search'])
  }
})
