import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeContext } from '@earendil-works/pi-ai'
import type { AssistantMessageEvent, StreamOptions } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { subscriptionPayload, subscriptionProvider } from '../src/provider.js'
import { subscriptionProfile } from '../src/index.js'
import { PROVIDER_ID } from '../src/catalog.js'
import { openSubscriptionStore, SubscriptionManager } from '../src/dsh-store.js'
import { SIWC_SCOPES } from '../src/siwc.js'
import type { SiwcCredential } from '../src/siwc.js'
import { SiwcError } from '../src/siwc-error.js'

// All grants and SSE data are synthetic; no real store or transport is consulted.
const MODEL = { id: 'gpt-5.4', name: 'GPT 5.4' }
const SECRET = 'fixture-upstream-secret-never-display'
const USAGE = { input_tokens: 20, output_tokens: 7, total_tokens: 27,
  input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
  output_tokens_details: { reasoning_tokens: 3 } }
const grant = (): SiwcCredential => ({ type: 'oauth', access: 'offline-policy-access', refresh: 'offline-policy-refresh',
  expires: Date.now() + 3_600_000, clientId: 'oaiapp_offline', idToken: 'offline-id-token', scopes: [...SIWC_SCOPES],
  issuer: 'https://auth.openai.com', subject: 'offline-subject', hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' })

function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
}
function partialEvents(): unknown[] {
  return [
    { type: 'response.created', response: { id: 'resp_policy' } },
    { type: 'response.output_item.added', output_index: 0,
      item: { id: 'msg_policy', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Partial answer' },
  ]
}
async function run(events: unknown[], options: StreamOptions = {}, simple = false) {
  const manager: SubscriptionManager = Object.create(SubscriptionManager.prototype)
  manager.validCredential = async () => grant()
  const provider = subscriptionProvider(manager, [MODEL], { identity: grant() })
  const model = provider.getModels()[0]
  assert.ok(model)
  const stream = simple ? provider.streamSimple(model, normalizeContext({ messages: [] }), { fetch: async () => sse(events), ...options })
    : provider.stream(model, normalizeContext({ messages: [] }), { fetch: async () => sse(events), ...options })
  const emitted: AssistantMessageEvent[] = []
  for await (const event of stream) emitted.push(event)
  return { emitted, message: await stream.result() }
}
function assertUsage(message: Awaited<ReturnType<typeof run>>['message']) {
  assert.equal(message.usage.input, 13)
  assert.equal(message.usage.output, 7)
  assert.equal(message.usage.cacheRead, 5)
  assert.equal(message.usage.cacheWrite, 2)
  assert.equal(message.usage.reasoning, 3)
  assert.equal(message.usage.totalTokens, 27)
}

for (const reason of ['max_output_tokens', 'content_filter']) {
  test(`incomplete ${reason} retains usage and partial output but emits error, never done`, async () => {
    let observed = false
    const result = await run([...partialEvents(), { type: 'response.incomplete', response: {
      status: 'incomplete', usage: USAGE, incomplete_details: { reason }, output: [],
    } }], { onProviderStreamEvent: event => {
      if ((event as { type: string }).type === 'response.incomplete') observed = true
    } })
    assert.equal(observed, true)
    assertUsage(result.message)
    assert.equal(result.message.stopReason, 'error')
    assert.equal(result.message.rawStopReason, `incomplete.${reason}`)
    assert.match(result.message.errorMessage ?? '', new RegExp(reason))
    assert.deepEqual(result.message.content.filter(block => block.type === 'text').map(block => block.text), ['Partial answer'])
    assert.equal(result.emitted.filter(event => event.type === 'error').length, 1)
    assert.equal(result.emitted.some(event => event.type === 'done'), false)
    assert.equal(result.message.provider, PROVIDER_ID)
  })
}

for (const code of ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'permission_denied']) {
  test(`failed ${code} preserves usage and exposes only fixed safe diagnosis`, async () => {
    const result = await run([...partialEvents(), { type: 'response.failed', response: {
      status: 'failed', usage: USAGE, error: { code, message: SECRET, extra: { token: SECRET } },
    } }])
    assertUsage(result.message)
    assert.equal(result.message.stopReason, 'error')
    assert.equal(result.message.content[0]?.type, 'text')
    assert.match(result.message.errorMessage ?? '', new RegExp(code))
    if (code.startsWith('subscription_sharing_')) assert.match(result.message.errorMessage ?? '', /https:\/\/chatgpt.com\/settings\/usage/)
    assert.doesNotMatch(JSON.stringify(result.message), new RegExp(SECRET))
    assert.equal(result.emitted.some(event => event.type === 'done'), false)
  })
}

test('normal completed responses keep Pi usage, successful content and route', async () => {
  for (const simple of [false, true]) {
    const result = await run([...partialEvents(), { type: 'response.completed', response: {
      status: 'completed', usage: USAGE, output: [],
    } }], {}, simple)
    assertUsage(result.message)
    assert.equal(result.message.stopReason, 'stop')
    assert.equal(result.message.rawStopReason, 'completed')
    assert.equal(result.message.errorMessage, undefined)
    assert.equal(result.emitted.at(-1)?.type, 'done')
    assert.equal(result.message.provider, PROVIDER_ID)
  }
})

test('caller cancellation takes priority over incomplete, failed and completed terminals without losing usage', async () => {
  for (const status of ['completed', 'incomplete', 'failed']) {
    const abort = new AbortController()
    const result = await run([...partialEvents(), { type: `response.${status}`, response: {
      status, usage: USAGE, output: [], incomplete_details: { reason: 'max_output_tokens' },
      error: { code: 'subscription_sharing_usage_limit_exceeded', message: SECRET },
    } }], { signal: abort.signal, onProviderStreamEvent: event => {
      if ((event as { type: string }).type === `response.${status}`) abort.abort()
    } })
    assertUsage(result.message)
    assert.equal(result.message.stopReason, 'aborted')
    assert.equal(result.emitted.at(-1)?.type, 'error')
    assert.match(result.message.errorMessage ?? '', /cancelled/)
    assert.doesNotMatch(result.message.errorMessage ?? '', /usage limit|fixture/)
  }
})

test('unknown reasons, statuses, stream errors and HTTP errors never reflect upstream secrets', async () => {
  const cases = [
    [{ type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: SECRET }, usage: USAGE } }],
    [{ type: 'response.failed', response: { status: 'failed', error: { code: SECRET, message: SECRET }, usage: USAGE } }],
    [{ type: 'response.completed', response: { status: SECRET, usage: USAGE } }],
    [{ type: 'response.completed', response: { status: 'queued', usage: USAGE } }],
    [{ type: 'response.completed', response: { usage: USAGE } }],
    [{ type: 'error', code: SECRET, message: SECRET }],
    [{ type: 'response.cancelled', response: { status: 'cancelled', error: { message: SECRET } } }],
  ]
  for (const events of cases) {
    const result = await run([...partialEvents(), ...events])
    assert.equal(result.message.stopReason, 'error')
    assert.equal(result.emitted.some(event => event.type === 'done'), false)
    assert.doesNotMatch(JSON.stringify(result.message), new RegExp(SECRET))
  }
  for (const code of ['unknown_error', 'subscription_sharing_usage_limit_exceeded']) {
    const result = await run([], { maxRetries: 0, fetch: async () => new Response(JSON.stringify({
      error: { code, message: SECRET, type: SECRET },
    }), { status: 403, headers: { 'content-type': 'application/json' } }) })
    assert.equal(result.message.stopReason, 'error')
    assert.doesNotMatch(JSON.stringify(result.message), new RegExp(SECRET))
    if (code.startsWith('subscription_sharing_')) assert.match(result.message.errorMessage ?? '', /settings\/usage/)
  }
})

test('early EOF retains partial output and unknown credential/transport exceptions use fixed errors', async () => {
  const result = await run(partialEvents())
  assert.equal(result.message.stopReason, 'error')
  assert.equal(result.message.content[0]?.type, 'text')
  assert.equal(result.message.usage.totalTokens, 0)
  const transport = await run([], { maxRetries: 0, fetch: async () => { throw new Error(SECRET) } })
  assert.equal(transport.message.stopReason, 'error')
  assert.doesNotMatch(JSON.stringify(transport.message), new RegExp(SECRET))
  const manager: SubscriptionManager = Object.create(SubscriptionManager.prototype)
  manager.validCredential = async () => { throw new Error(SECRET) }
  const provider = subscriptionProvider(manager, [MODEL], { identity: grant() })
  const model = provider.getModels()[0]
  assert.ok(model)
  const failure = await provider.stream(model, normalizeContext({ messages: [] }), { fetch: async () => { throw new Error('must not fetch') } }).result()
  assert.equal(failure.stopReason, 'error')
  assert.doesNotMatch(JSON.stringify(failure), new RegExp(SECRET))
})

test('expired or revoked grant retains safe reauthorization guidance; forged errors cannot disclose secrets', async () => {
  const forged = Object.assign(new Error(SECRET), { name: 'SiwcError', code: 'REAUTHORIZATION_REQUIRED' })
  for (const error of [new SiwcError('REAUTHORIZATION_REQUIRED', SECRET), forged, new SiwcError('UNKNOWN', SECRET)]) {
    for (const cancelled of [false, true]) {
      const abort = new AbortController()
      const manager: SubscriptionManager = Object.create(SubscriptionManager.prototype)
      manager.validCredential = async () => { if (cancelled) abort.abort(); throw error }
      const provider = subscriptionProvider(manager, [MODEL], { identity: grant() })
      const model = provider.getModels()[0]
      assert.ok(model)
      let requests = 0
      const message = await provider.stream(model, normalizeContext({ messages: [] }), {
        signal: abort.signal, fetch: async () => { ++requests; throw new Error('must not fetch') },
      }).result()
      const reauthorize = error instanceof SiwcError && error.code === 'REAUTHORIZATION_REQUIRED'
      assert.equal(requests, 0)
      assert.equal(message.stopReason, cancelled ? 'aborted' : 'error')
      assert.equal(message.rawStopReason, cancelled ? 'cancelled' : reauthorize ? 'reauthorization_required' : 'stream_unfinished')
      if (reauthorize && !cancelled) {
        assert.match(message.errorMessage ?? '', /授权已过期或被撤销/)
        assert.match(message.errorMessage ?? '', /关闭当前 DSH 服务后运行 dsh-chatgpt login/)
      } else assert.doesNotMatch(message.errorMessage ?? '', /dsh-chatgpt login/)
      assert.doesNotMatch(JSON.stringify(message), new RegExp(SECRET))
    }
  }
})

test('invalid failed usage is not accepted as trustworthy accounting', async () => {
  for (const usage of [{ ...USAGE, input_tokens: -1 }, { ...USAGE, total_tokens: '27' },
    { ...USAGE, total_tokens: 900 }, { ...USAGE, input_tokens_details: { cached_tokens: 100 } }]) {
    const result = await run([{ type: 'response.failed', response: { status: 'failed', usage } }])
    assert.equal(result.message.usage.totalTokens, 0)
    assert.equal(result.message.stopReason, 'error')
  }
})

test('function/custom namespaces, late tools and replay call IDs are retained without mutating input', () => {
  const named = { type: 'namespace', name: 'existing', tools: [{ type: 'custom', name: 'edit', format: { type: 'text' } }] }
  const payload = { tools: [named, { type: 'function', name: 'read', parameters: { type: 'object' } }], input: [
    { type: 'additional_tools', tools: [named, { type: 'custom', name: 'late' }] },
    { type: 'function_call', namespace: 'existing', call_id: 'call_keep', id: 'fc_keep', arguments: '{}' },
    { type: 'custom_tool_call', namespace: 'existing', call_id: 'call_custom', id: 'ctc_keep', input: 'x' },
  ] }
  const before = structuredClone(payload)
  const result = subscriptionPayload(payload, MODEL.id)
  assert.deepEqual(payload, before)
  assert.deepEqual((result.tools as unknown[])[0], named)
  const input = result.input as Record<string, unknown>[]
  assert.deepEqual(input[1], before.input[1])
  assert.deepEqual(input[2], before.input[2])
  assert.deepEqual(input[0]?.tools, [named, { type: 'namespace', name: 'dsh', description: 'Tools supplied by DeepSeek Harness',
    tools: [{ type: 'custom', name: 'late' }] }])
  for (const tool_choice of ['auto', 'none', 'required']) {
    assert.deepEqual(subscriptionPayload({ tool_choice }, MODEL.id).tool_choice, tool_choice)
  }
  // A valid tool definition is not evidence for a valid SIWC forced-selector form.
  for (const tool_choice of [{ type: 'function', name: 'read', namespace: 'dsh' },
    { type: 'custom', name: 'edit', namespace: 'existing' }]) {
    assert.throws(() => subscriptionPayload({ tools: payload.tools, tool_choice }, MODEL.id), /not supported/)
  }
})

for (const type of ['image_generation', 'file_search', 'code_interpreter', 'computer', 'computer_use_preview',
  'mcp', 'tool_search', 'programmatic_tool_calling', 'web_search', 'web_search_preview', SECRET]) {
  test(`reject ${type === SECRET ? 'unknown' : type} tools in all declaration locations before transport`, async () => {
    const tool = { type, name: 'unsafe', secret: SECRET }
    for (const payload of [{ tools: [tool] }, { tools: [{ type: 'namespace', name: 'hidden', tools: [tool] }] },
      { input: [{ type: 'additional_tools', tools: [tool] }] }, { tool_choice: tool }]) {
      assert.throws(() => subscriptionPayload(payload, MODEL.id), error => {
        assert.ok(error instanceof Error)
        assert.doesNotMatch(error.message, new RegExp(SECRET))
        assert.match(error.message, type.startsWith('web_search') ? /not enabled/ : /not supported/)
        return true
      })
    }
    let requests = 0
    const result = await run([], { onPayload: payload => ({ ...payload as object, tools: [tool] }),
      fetch: async () => { ++requests; throw new Error('must not fetch') } })
    assert.equal(requests, 0)
    assert.equal(result.message.stopReason, 'error')
    assert.match(result.message.errorMessage ?? '', type.startsWith('web_search') ? /not enabled/ : /not supported/)
    assert.doesNotMatch(JSON.stringify(result.message), new RegExp(SECRET))
  })
}

test('malformed tool lists and nested namespaces are rejected, not silently passed through', () => {
  for (const tools of [{}, null, [null], [{}], [{ type: 'function' }], [{ type: 'custom', name: '' }],
    [{ type: 'namespace', name: 'broken' }], [{ type: 'namespace', name: 'outer', tools: [{ type: 'namespace', name: 'inner', tools: [] }] }]]) {
    assert.throws(() => subscriptionPayload({ tools }, MODEL.id))
  }
  assert.throws(() => subscriptionPayload({ input: [{ type: 'additional_tools' }] }, MODEL.id))
})

test('top-level programmatic_tool_calling is explicitly refused before transport, never silently dropped', async () => {
  for (const programmatic_tool_calling of [true, false, null, {}, { code: SECRET }, undefined]) {
    assert.throws(() => subscriptionPayload({ programmatic_tool_calling }, MODEL.id), /does not support programmatic_tool_calling/)
    let requests = 0
    const result = await run([], { onPayload: payload => ({ ...payload as object, programmatic_tool_calling }),
      fetch: async () => { ++requests; throw new Error('must not fetch') } })
    assert.equal(requests, 0)
    assert.equal(result.message.stopReason, 'error')
    assert.match(result.message.errorMessage ?? '', /does not support programmatic_tool_calling/)
    assert.doesNotMatch(JSON.stringify(result.message), new RegExp(SECRET))
  }
})

test('subscription quota HTTP 429 makes one request even when a direct caller asks Pi to retry', async () => {
  for (const code of ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable']) {
    let requests = 0
    const result = await run([], { maxRetries: 7, fetch: async () => {
      ++requests
      return new Response(JSON.stringify({ error: { code, message: SECRET } }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after-ms': '1', 'x-should-retry': 'true' },
      })
    } })
    assert.equal(requests, 1)
    assert.equal(result.message.stopReason, 'error')
    assert.match(result.message.errorMessage ?? '', /settings\/usage/)
    assert.doesNotMatch(JSON.stringify(result.message), new RegExp(SECRET))
  }
})

test('DSH adapter retains failed usage without replay, stops quota retry and preserves network retry classes', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-policy-replay-offline-'))
  const store = await openSubscriptionStore(home)
  t.after(async () => { await store.dispose(); await rm(home, { recursive: true, force: true }) })
  await store.manager.credentialStore.modify(PROVIDER_ID, async () => grant())
  const profiles = new Map([[PROVIDER_ID, subscriptionProfile(store.manager, [MODEL], { identity: (await store.manager.snapshot()).identity! })]])
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined,
    auth: { credentials: store.manager.credentialStore, authContext: { env: async () => undefined, fileExists: async () => false } } })
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  for (const status of ['incomplete', 'failed', 'cancelled']) {
    globalThis.fetch = async () => sse([...partialEvents(), { type: `response.${status}`, response: {
      status, usage: USAGE, incomplete_details: { reason: 'max_output_tokens' }, output: [],
      error: { code: 'subscription_sharing_usage_limit_exceeded', message: SECRET },
    } }])
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: PROVIDER_ID, model: MODEL.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'offline' }] }] })) chunks.push(chunk)
    const finish = chunks.find(chunk => chunk.type === 'finish')
    assert.ok(finish?.type === 'finish')
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.replayState, undefined)
    const usage = chunks.find(chunk => chunk.type === 'usage')
    assert.ok(usage?.type === 'usage')
    assert.equal(usage.usage.totalTokens, 27)
    assert.doesNotMatch(JSON.stringify(finish), new RegExp(SECRET))
  }
  const policy = adapter.providerRetryPolicy(PROVIDER_ID)
  assert.ok(policy?.mode === 'normal')
  for (const [status, code, expected, retryable] of [
    [429, 'subscription_sharing_usage_limit_exceeded', 'QUOTA', false],
    [429, 'subscription_sharing_usage_unavailable', 'PI_AI_ERROR', false],
    [429, 'rate_limit_exceeded', 'RATE_LIMIT', true],
    [503, 'server_error', 'SERVER', true],
    [408, 'request_timeout', 'TIMEOUT', true],
    [0, 'connection_error', 'TRANSPORT', true],
  ] as const) {
    let requests = 0
    globalThis.fetch = async () => {
      ++requests
      if (status === 0) throw new Error(`network ${SECRET}`)
      return new Response(JSON.stringify({ error: { code, message: status === 408 ? `Request timed out ${SECRET}` : SECRET } }),
        { status, headers: { 'content-type': 'application/json' } })
    }
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: PROVIDER_ID, model: MODEL.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'offline' }] }] })) chunks.push(chunk)
    const finish = chunks.find(chunk => chunk.type === 'finish')
    assert.ok(finish?.type === 'finish' && finish.reason.kind === 'error')
    assert.equal(finish.reason.failure.code, expected)
    assert.equal(policy.retryableCodes.includes(finish.reason.failure.code), retryable)
    assert.equal(requests, 1)
    assert.equal(finish.replayState, undefined)
    assert.doesNotMatch(JSON.stringify(finish), new RegExp(SECRET))
  }
})
