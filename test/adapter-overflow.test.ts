import assert from 'node:assert/strict'
import test from 'node:test'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { AssistantStreamAccumulator, BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PROVIDER_ID } from '../src/catalog.js'
import { SubscriptionManager } from '../src/dsh-store.js'
import { subscriptionProfile } from '../src/index.js'
import { SIWC_SCOPES } from '../src/siwc.js'
import type { SiwcCredential } from '../src/siwc.js'
import { SubscriptionAdapter } from '../src/subscription-adapter.js'

const MODEL = { id: 'gpt-5.4', name: 'GPT 5.4' }
const PRIVATE_DIAGNOSTIC = 'synthetic-upstream-private-diagnostic'
const USAGE = { input_tokens: 20, output_tokens: 7, total_tokens: 27,
  input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 },
  output_tokens_details: { reasoning_tokens: 3 } }
const grant = (): SiwcCredential => ({ type: 'oauth', access: 'offline-overflow-access', refresh: 'offline-overflow-refresh',
  expires: Date.now() + 3_600_000, clientId: 'oaiapp_offline', idToken: 'offline-id-token', scopes: [...SIWC_SCOPES],
  issuer: 'https://auth.openai.com', subject: 'offline-subject', hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' })
const request = (): GenerateOptions => ({ provider: PROVIDER_ID, model: MODEL.id,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Offline overflow regression' }] }] })

function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}
function partialEvents(): unknown[] {
  return [
    { type: 'response.created', response: { id: 'resp_overflow' } },
    { type: 'response.output_item.added', output_index: 0,
      item: { id: 'msg_overflow', type: 'message', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Partial answer' },
  ]
}

// Only auth and transport are fake: the public wrapper, provider, Pi converter and
// final serialized request all run unchanged. No credential files are opened.
async function fixture(t: test.TestContext, respond: () => Response | Promise<Response>) {
  const manager: SubscriptionManager = Object.create(SubscriptionManager.prototype)
  manager.validCredential = async () => grant()
  const profiles = new Map([[PROVIDER_ID, subscriptionProfile(manager, [MODEL], { identity: { ...grant(), scopes: [...SIWC_SCOPES].sort() } })]])
  const credentials = new InMemoryCredentialStore()
  await credentials.modify(PROVIDER_ID, async () => grant())
  const adapter = new SubscriptionAdapter(new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined,
    auth: { credentials, authContext: { env: async () => undefined, fileExists: async () => false } } }))
  const wire: Record<string, unknown>[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.match(String(input), /\/responses$/)
    assert.equal(init?.method, 'POST')
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>
    assert.equal(payload.model, MODEL.id)
    assert.equal(payload.store, false)
    assert.equal(payload.stream, true)
    assert.deepEqual(payload.input, [{ role: 'user', content: [{ type: 'input_text', text: 'Offline overflow regression' }] }])
    wire.push(payload)
    return respond()
  })
  return { adapter, wire }
}
async function collect(adapter: SubscriptionAdapter, entry: 'stream' | 'prepared', options = request(),
  onChunk?: (chunk: StreamChunk) => void) {
  const stream = entry === 'stream' ? adapter.stream(options)
    : (await adapter.prepareCall(options.provider, options.model, options.signal)).stream(options)
  const chunks: StreamChunk[] = []
  const assembled = new BlockAssembler()
  const persisted = new AssistantStreamAccumulator()
  for await (const chunk of stream) {
    // Validate raw events before JSON.stringify can silently drop invalid fields.
    persisted.push({ time: chunks.length, chunk })
    chunks.push(chunk); assembled.push(chunk); onChunk?.(chunk)
  }
  const finishes = chunks.filter(chunk => chunk.type === 'finish')
  assert.equal(finishes.length, 1)
  const finish = finishes[0]!
  assert.equal(finish.replayState, undefined)
  assert.doesNotMatch(JSON.stringify(chunks), new RegExp(PRIVATE_DIAGNOSTIC))
  return { chunks, assembled, finish }
}
function assertUsage(chunks: StreamChunk[]) {
  const usage = chunks.filter(chunk => chunk.type === 'usage')
  assert.equal(usage.length, 1)
  assert.deepEqual(usage[0]!.usage, { inputTokens: 13, outputTokens: 7, totalTokens: 27, cacheReadTokens: 5, cacheWriteTokens: 2 })
}

test('HTTP overflow classification survives long private error text beyond Pi diagnostic truncation', async t => {
  const { adapter, wire } = await fixture(t, () => new Response(JSON.stringify({ error: {
    message: PRIVATE_DIAGNOSTIC.repeat(200), code: 'context_length_exceeded',
  } }), { status: 400, headers: { 'content-type': 'application/json' } }))
  const { finish } = await collect(adapter, 'stream')
  assert.equal(wire.length, 1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('an unrelated HTTP error cannot become overflow just by mentioning its marker in private text', async t => {
  const { adapter, wire } = await fixture(t, () => new Response(JSON.stringify({ error: {
    code: 'invalid_request_error', message: `context_length_exceeded ${PRIVATE_DIAGNOSTIC}`,
  } }), { status: 400, headers: { 'content-type': 'application/json' } }))
  const { finish } = await collect(adapter, 'stream')
  assert.equal(wire.length, 1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure?.code, 'PI_AI_ERROR')
})

for (const entry of ['stream', 'prepared'] as const) {
  test(`${entry}: HTTP and transport negative controls retain their classifications without provider retries`, async t => {
    for (const [status, code, message, expected, retryable] of [
      [400, 'invalid_request_error', PRIVATE_DIAGNOSTIC, 'PI_AI_ERROR', false],
      [400, 'context_window_exceeded', `maximum context length ${PRIVATE_DIAGNOSTIC}`, 'PI_AI_ERROR', false],
      [400, 'prefix_context_length_exceeded_suffix', PRIVATE_DIAGNOSTIC, 'PI_AI_ERROR', false],
      [403, 'permission_denied', PRIVATE_DIAGNOSTIC, 'PI_AI_ERROR', false],
      [401, 'invalid_api_key', PRIVATE_DIAGNOSTIC, 'PI_AI_ERROR', false],
      [429, 'subscription_sharing_usage_limit_exceeded', PRIVATE_DIAGNOSTIC, 'QUOTA', false],
      [429, 'subscription_sharing_usage_unavailable', PRIVATE_DIAGNOSTIC, 'PI_AI_ERROR', false],
      [429, 'rate_limit_exceeded', PRIVATE_DIAGNOSTIC, 'RATE_LIMIT', true],
      [503, 'server_error', PRIVATE_DIAGNOSTIC, 'SERVER', true],
      [408, 'request_timeout', `Request timed out ${PRIVATE_DIAGNOSTIC}`, 'TIMEOUT', true],
      [0, 'connection_error', `network ${PRIVATE_DIAGNOSTIC}`, 'TRANSPORT', true],
    ] as const) {
      await t.test(`${status} ${code}`, async t => {
        const { adapter, wire } = await fixture(t, () => {
          if (status === 0) throw new Error(message)
          return new Response(JSON.stringify({ error: { code, message } }), { status, headers: {
            'content-type': 'application/json', 'retry-after-ms': '1', 'x-should-retry': 'true',
          } })
        })
        const { finish } = await collect(adapter, entry)
        assert.equal(wire.length, 1)
        assert.equal(finish.reason.kind, 'error')
        assert.equal(finish.reason.failure?.code, expected)
        const policy = adapter.providerRetryPolicy(PROVIDER_ID)
        assert.ok(policy?.mode === 'normal')
        assert.equal(policy.retryableCodes.includes(expected), retryable)
      })
    }
  })

  test(`${entry}: malformed and unrelated HTTP bodies cannot supply a typed overflow code`, async t => {
    for (const [name, body] of [
      ['plain text', `context_length_exceeded ${PRIVATE_DIAGNOSTIC}`],
      ['malformed JSON', `{"error":{"code":"context_length_exceeded","message":"${PRIVATE_DIAGNOSTIC}"`],
      ['null body', 'null'],
      ['array error', JSON.stringify({ error: [{ code: 'context_length_exceeded', message: PRIVATE_DIAGNOSTIC }] })],
      ['message and nested metadata', JSON.stringify({ error: { code: 'unknown_error',
        message: `context_length_exceeded ${PRIVATE_DIAGNOSTIC}`, metadata: { code: 'context_length_exceeded' } } })],
    ] as const) {
      await t.test(name, async t => {
        const { adapter, wire } = await fixture(t, () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } }))
        const { finish } = await collect(adapter, entry)
        assert.equal(wire.length, 1)
        assert.equal(finish.reason.kind, 'error')
        assert.equal(finish.reason.failure?.code, 'PI_AI_ERROR')
      })
    }
  })

  test(`${entry}: failed, incomplete, unknown and disconnected SSE never become overflow or successful replay`, async t => {
    for (const [name, terminal, expected, knownUsage] of [
      ['unknown code and marker in message', { type: 'response.failed', response: { status: 'failed', usage: USAGE,
        error: { code: 'unknown_error', message: `context_length_exceeded ${PRIVATE_DIAGNOSTIC}` } } }, 'PI_AI_ERROR', true],
      ['unverified alias', { type: 'response.failed', response: { status: 'failed', usage: USAGE,
        error: { code: 'context_window_exceeded', message: PRIVATE_DIAGNOSTIC } } }, 'PI_AI_ERROR', true],
      ['quota', { type: 'response.failed', response: { status: 'failed', usage: USAGE,
        error: { code: 'subscription_sharing_usage_limit_exceeded', message: PRIVATE_DIAGNOSTIC } } }, 'QUOTA', true],
      ['permission', { type: 'response.failed', response: { status: 'failed', usage: USAGE,
        error: { code: 'permission_denied', message: PRIVATE_DIAGNOSTIC } } }, 'PI_AI_ERROR', true],
      ['incomplete', { type: 'response.incomplete', response: { status: 'incomplete', usage: USAGE,
        incomplete_details: { reason: 'max_output_tokens' } } }, 'PI_AI_ERROR', true],
      ['unknown status', { type: 'response.completed', response: { status: 'queued', usage: USAGE } }, 'PI_AI_ERROR', true],
      ['unknown terminal error', { type: 'error', code: 'unknown_error', message: PRIVATE_DIAGNOSTIC }, 'PI_AI_ERROR', false],
      ['disconnect', undefined, 'TRANSPORT', false],
    ] as const) {
      await t.test(name, async t => {
        const { adapter, wire } = await fixture(t, () => sse([...partialEvents(), ...(terminal ? [terminal] : [])]))
        const { chunks, assembled, finish } = await collect(adapter, entry)
        assert.equal(wire.length, 1)
        assert.equal(finish.reason.kind, 'error')
        assert.equal(finish.reason.failure?.code, expected)
        assert.deepEqual(assembled.blocks().filter(block => block.type === 'text').map(block => block.text), ['Partial answer'])
        if (knownUsage) assertUsage(chunks)
        else assert.equal(chunks.some(chunk => chunk.type === 'usage'), false)
      })
    }
  })

  test(`${entry}: unknown failed or HTTP usage never crosses the public boundary as exact zero`, async t => {
    for (const respond of [
      () => sse([...partialEvents(), { type: 'response.failed', response: { status: 'failed',
        error: { code: 'context_length_exceeded', message: PRIVATE_DIAGNOSTIC } } }]),
      () => sse([...partialEvents(), { type: 'response.failed', response: { status: 'failed',
        usage: { ...USAGE, total_tokens: 900 }, error: { code: 'context_length_exceeded', message: PRIVATE_DIAGNOSTIC } } }]),
      () => new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: PRIVATE_DIAGNOSTIC } }), { status: 400 }),
    ]) {
      const { adapter, wire } = await fixture(t, respond)
      const { chunks, finish } = await collect(adapter, entry)
      assert.equal(wire.length, 1)
      assert.equal(finish.reason.kind, 'error')
      assert.equal(finish.reason.failure?.code, 'CONTEXT_WINDOW_EXCEEDED')
      assert.equal(chunks.some(chunk => chunk.type === 'usage'), false, 'no authoritative accounting report exists')
    }
  })

  test(`${entry}: overflow never manufactures accounting from missing or untrusted failed usage`, async t => {
    for (const usage of [undefined, null, { input_tokens: 20, output_tokens: 7 },
      { ...USAGE, input_tokens: -1 }, { ...USAGE, total_tokens: '27' }, { ...USAGE, total_tokens: 900 },
      { ...USAGE, input_tokens_details: { cached_tokens: 19, cache_write_tokens: 2 } },
      { ...USAGE, output_tokens_details: { reasoning_tokens: 8 } },
      { ...USAGE, input_tokens: Number.MAX_SAFE_INTEGER + 1 }]) {
      await t.test(JSON.stringify(usage) ?? 'missing usage', async t => {
        const { adapter, wire } = await fixture(t, () => sse([...partialEvents(), { type: 'response.failed', response: {
          status: 'failed', usage, error: { code: 'context_length_exceeded', message: PRIVATE_DIAGNOSTIC },
        } }]))
        const { chunks, assembled, finish } = await collect(adapter, entry)
        assert.equal(wire.length, 1)
        assert.equal(finish.reason.kind, 'error')
        assert.equal(finish.reason.failure?.code, 'CONTEXT_WINDOW_EXCEEDED')
        // Pi's required numeric sentinel is internal, not a DSH exact-total report.
        assert.equal(chunks.some(chunk => chunk.type === 'usage'), false)
        assert.deepEqual(assembled.blocks().filter(block => block.type === 'text').map(block => block.text), ['Partial answer'])
      })
    }
  })

  test(`${entry}: completed missing or malformed usage also remains unknown`, async t => {
    for (const usage of [undefined, { ...USAGE, total_tokens: 900 }]) {
      const { adapter, wire } = await fixture(t, () => sse([...partialEvents(), { type: 'response.completed', response: {
        status: 'completed', output: [], usage } }]))
      const options = request(), chunks: StreamChunk[] = []
      const stream = entry === 'stream' ? adapter.stream(options) : (await adapter.prepareCall(PROVIDER_ID, MODEL.id)).stream(options)
      for await (const chunk of stream) chunks.push(chunk)
      assert.equal(wire.length, 1)
      assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
      assert.equal(chunks.some(chunk => chunk.type === 'usage'), false)
    }
  })

  test(`${entry}: explicit valid provider zero usage remains exact on failed and completed responses`, async t => {
    for (const status of ['failed', 'completed'] as const) {
      const { adapter, wire } = await fixture(t, () => sse([{ type: 'response.' + status, response: {
        status, output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        ...(status === 'failed' ? { error: { code: 'context_length_exceeded', message: PRIVATE_DIAGNOSTIC } } : {}) } }]))
      const options = request(), chunks: StreamChunk[] = []
      const stream = entry === 'stream' ? adapter.stream(options) : (await adapter.prepareCall(PROVIDER_ID, MODEL.id)).stream(options)
      for await (const chunk of stream) chunks.push(chunk)
      assert.equal(wire.length, 1)
      assert.deepEqual(chunks.find(chunk => chunk.type === 'usage')?.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
      // A completed empty body is a host error, independently of known zero accounting.
      assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'error')
    }
  })

  test(`${entry}: cancellation wins over buffered overflow or success while retaining trusted content and usage`, async t => {
    for (const status of ['failed', 'completed'] as const) {
      await t.test(status, async t => {
        const abort = new AbortController()
        const { adapter, wire } = await fixture(t, () => sse([...partialEvents(), { type: `response.${status}`, response: {
          status, output: [], usage: USAGE,
          ...(status === 'failed' ? { error: { code: 'context_length_exceeded', message: PRIVATE_DIAGNOSTIC } } : {}),
        } }]))
        const { chunks, assembled, finish } = await collect(adapter, entry, { ...request(), signal: abort.signal }, chunk => {
          if (chunk.type === 'usage') abort.abort()
        })
        assert.equal(wire.length, 1)
        assertUsage(chunks)
        assert.deepEqual(assembled.blocks().filter(block => block.type === 'text').map(block => block.text), ['Partial answer'])
        assert.deepEqual(finish.reason, { kind: 'aborted', failure: {
          code: 'ABORTED', message: 'The ChatGPT subscription request was cancelled.',
        } })
      })
    }
  })

  for (const transport of ['HTTP 400', 'SSE failed'] as const) {
    test(`${entry}: ${transport} context_length_exceeded becomes a safe typed host failure`, async t => {
      const error = { code: 'context_length_exceeded', message: PRIVATE_DIAGNOSTIC, extra: { token: PRIVATE_DIAGNOSTIC } }
      const { adapter, wire } = await fixture(t, () => transport === 'HTTP 400'
        ? new Response(JSON.stringify({ error }), { status: 400, headers: { 'content-type': 'application/json' } })
        : sse([...partialEvents(), { type: 'response.failed', response: { status: 'failed', error, usage: USAGE } }]))
      const { chunks, assembled, finish } = await collect(adapter, entry)
      assert.equal(wire.length, 1, 'exactly one real final-wire attempt; no nested provider retry')
      if (transport === 'SSE failed') {
        assertUsage(chunks)
        assert.deepEqual(assembled.blocks().filter(block => block.type === 'text').map(block => block.text), ['Partial answer'])
      }
      assert.equal(finish.reason.kind, 'error')
      assert.equal(finish.reason.failure?.code, 'CONTEXT_WINDOW_EXCEEDED')
      assert.equal(finish.reason.failure?.message, 'ChatGPT subscription request failed (context_length_exceeded).')
    })
  }
}
