import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LlmRuntime, { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createModels, Type } from '@earendil-works/pi-ai'
import { openSubscriptionStore, SubscriptionManager, SUBSCRIPTION_KEY } from '../src/dsh-store.js'
import type { SubscriptionOperations } from '../src/dsh-store.js'
import { SIWC_SCOPES } from '../src/siwc.js'
import type { SiwcCredential } from '../src/siwc.js'
import { PROVIDER_ID, subscriptionModelDefinitions } from '../src/catalog.js'
import { subscriptionProvider, subscriptionPayload } from '../src/provider.js'
import { subscriptionProfile } from '../src/index.js'
import * as plugin from '../src/index.js'

const MODEL = { id: 'gpt-5.4', name: 'GPT 5.4' }
const HOST_ID = 'urn:uuid:00000000-0000-4000-8000-000000000001'
function grant(extra: Partial<SiwcCredential> = {}): SiwcCredential {
  return {
    type: 'oauth', access: 'offline-oauth-access', refresh: 'offline-refresh',
    expires: Date.now() + 3_600_000, clientId: 'oaiapp_offline', idToken: 'offline-id-token',
    scopes: [...SIWC_SCOPES], issuer: 'https://auth.openai.com', subject: 'offline-subject',
    hostId: HOST_ID, ...extra,
  }
}
const never = async (): Promise<never> => { throw new Error('Unexpected account network operation') }
function operations(overrides: Partial<SubscriptionOperations> = {}): SubscriptionOperations {
  return { login: never, refresh: never, revoke: never, fetchModels: never, ...overrides }
}
async function tempStore(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-subscription-offline-'))
  const store = await openSubscriptionStore(home)
  t.after(async () => { await store.dispose(); await rm(home, { recursive: true, force: true }) })
  return { ...store, home }
}
function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  })
}
function completeEvents(text = 'Offline response'): unknown[] {
  const item = { id: 'msg_offline', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] }
  return [
    { type: 'response.created', response: { id: 'resp_offline' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_offline', status: 'completed', output: [item],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
  ]
}
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

test('CLI credential bootstrap is offline, persistent, private, and disposes twice', async t => {
  const store = await tempStore(t)
  assert.equal((await store.manager.status()).signedIn, false)
  const first = await store.manager.hostId()
  const second = await openSubscriptionStore(store.home)
  t.after(() => second.dispose())
  assert.equal(await second.manager.hostId(), first)
  assert.equal((await stat(join(store.home, '.credentials.yaml'))).mode & 0o777, 0o600)
  await second.dispose()
  await second.dispose()
})

test('pending registration survives a failed exchange; catalog failure retains successful login', async t => {
  const store = await tempStore(t)
  let attempt = 0
  let hostId: string | undefined
  const manager = new SubscriptionManager(store.manager.credentials, operations({
    login: async (_interaction, options) => {
      ++attempt
      hostId ??= options.getDeviceId()
      assert.equal(options.getDeviceId(), hostId)
      if (attempt === 1) {
        await options.onRegistration?.({ clientId: 'oaiapp_offline', issuer: 'https://auth.openai.com' })
        throw new Error('Offline exchange failure')
      }
      assert.equal(options.registration?.clientId, 'oaiapp_offline')
      return grant({ hostId: `urn:uuid:${hostId}` })
    },
    fetchModels: async () => { throw new Error('Offline catalog failure') },
  }))
  await assert.rejects(manager.login({ notify() {} }), /Offline exchange failure/)
  assert.equal(await manager.credential(), undefined)
  assert.equal((await manager.registration())?.clientId, 'oaiapp_offline')
  await manager.login({ notify() {} })
  await assert.rejects(manager.refreshModels(), /Offline catalog failure/)
  assert.equal((await manager.status()).signedIn, true)
  assert.equal((await manager.status()).modelCount, 0)
})

test('catalog publishes only actual account slugs with pinned metadata and model capabilities', async t => {
  const store = await tempStore(t)
  const manager = new SubscriptionManager(store.manager.credentials, operations({
    fetchModels: async () => [MODEL, { id: 'unknown-account-model', name: 'Unknown' }],
  }))
  await manager.credentialStore.modify(PROVIDER_ID, async () => grant())
  assert.deepEqual(await manager.refreshModels(), [MODEL])
  const status = await manager.status()
  assert.deepEqual(status.unsupportedModels, ['unknown-account-model'])
  const models = subscriptionModelDefinitions(status.models)
  assert.equal(models.length, 1)
  assert.deepEqual(models[0]?.input, ['text', 'image'])
  assert.equal(models[0]?.provider, PROVIDER_ID)
  assert.equal(models[0]?.baseUrl, 'https://api.openai.com/v1')
})

test('two native credential contexts rotate OAuth once and keep failed revocation retryable', async t => {
  const store = await tempStore(t)
  await store.manager.credentialStore.modify(PROVIDER_ID, async () => grant({ expires: Date.now() - 1000 }))
  const other = await openSubscriptionStore(store.home)
  t.after(() => other.dispose())
  let refreshes = 0
  let revocations = 0
  const fake = operations({
    refresh: async credential => {
      ++refreshes
      await setImmediate()
      return grant({ access: 'rotated-access', refresh: `${credential.refresh}-rotated` })
    },
    revoke: async () => { if (++revocations === 1) throw new Error('Offline revocation failure') },
  })
  const left = new SubscriptionManager(store.manager.credentials, fake)
  const right = new SubscriptionManager(other.manager.credentials, fake)
  const collections = [left, right].map(manager => {
    const models = createModels({ credentials: manager.credentialStore,
      authContext: { env: async () => 'sk-paid-ambient-must-never-be-used', fileExists: async () => true } })
    models.setProvider(subscriptionProvider(manager, [MODEL], { identity: grant() }))
    return models
  })
  const [a, b] = await Promise.all(collections.map(models => models.getAuth(PROVIDER_ID)))
  assert.equal(refreshes, 1)
  assert.equal(a?.auth.apiKey, 'rotated-access')
  assert.equal(b?.auth.apiKey, 'rotated-access')
  await assert.rejects(left.logout(), /Offline revocation failure/)
  assert.equal((await left.credential())?.refresh, 'offline-refresh-rotated')
  await left.logout()
  assert.equal(await left.credential(), undefined)
  assert.equal((await left.registration())?.clientId, 'oaiapp_offline')
  assert.equal((await left.registration())?.idToken, undefined)
})

test('OAuth-only provider never resolves ambient or explicit paid API keys', async t => {
  const store = await tempStore(t)
  const manager = new SubscriptionManager(store.manager.credentials, operations())
  let ambientReads = 0
  const models = createModels({ credentials: manager.credentialStore, authContext: {
    env: async () => { ++ambientReads; return 'sk-paid-ambient' }, fileExists: async () => true,
  } })
  const provider = subscriptionProvider(manager, [MODEL], { identity: grant() })
  models.setProvider(provider)
  assert.equal(provider.auth.apiKey, undefined)
  assert.equal(await models.getAuth(PROVIDER_ID, { apiKey: 'sk-paid-explicit' }), undefined)
  assert.equal(ambientReads, 0)
  await assert.rejects(manager.credentialStore.modify(PROVIDER_ID, async () => ({ type: 'api_key', key: 'sk-paid' })))
  await manager.credentialStore.modify(PROVIDER_ID, async () => grant())
  const model = models.getModel(PROVIDER_ID, MODEL.id)
  assert.ok(model)
  let requests = 0
  const response = await models.completeSimple(model, { systemPrompt: 'Offline system', messages: [
    { role: 'user', content: 'Hello', timestamp: 0 },
  ], tools: [{ name: 'read', description: 'read', parameters: Type.Object({ path: Type.String() }) }] }, {
    apiKey: 'sk-paid-explicit', headers: { Authorization: 'Bearer sk-paid-header' },
    maxTokens: 17, temperature: 0.7,
    fetch: async (input, init) => {
      ++requests
      assert.equal(String(input), 'https://api.openai.com/v1/responses')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer offline-oauth-access')
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, MODEL.id)
      assert.equal(body.store, false)
      assert.equal(body.stream, true)
      assert.equal(body.max_output_tokens, undefined)
      assert.equal(body.temperature, undefined)
      assert.equal(body.input[0].role, 'developer')
      assert.equal(body.tools[0].type, 'namespace')
      assert.equal(body.tools[0].name, 'dsh')
      assert.equal(body.tools[0].tools[0].name, 'read')
      return sse(completeEvents())
    },
    onPayload: payload => ({ ...payload as object, store: true, stream: false,
      max_output_tokens: 555, model: 'paid-model-override' }),
  })
  assert.equal(response.stopReason, 'stop')
  assert.equal(response.provider, PROVIDER_ID)
  assert.equal(requests, 1)
  assert.equal(ambientReads, 0)
})

test('cancelling a caller during admitted refresh does not discard the rotated refresh token', async t => {
  const store = await tempStore(t)
  let started!: () => void
  let finish!: () => void
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  const finishPromise = new Promise<void>(resolve => { finish = resolve })
  const abort = new AbortController()
  const manager = new SubscriptionManager(store.manager.credentials, operations({
    refresh: async (credential, options) => {
      started()
      await finishPromise
      assert.equal(options?.signal?.aborted, false)
      return grant({ refresh: `${credential.refresh}-safe-rotation` })
    },
  }))
  await manager.credentialStore.modify(PROVIDER_ID, async () => grant({ expires: Date.now() - 1000 }))
  const models = createModels({ credentials: manager.credentialStore })
  models.setProvider(subscriptionProvider(manager, [MODEL], { identity: grant() }))
  const pending = models.getAuth(PROVIDER_ID, { signal: abort.signal })
  await startedPromise
  abort.abort()
  await assert.rejects(pending)
  finish()
  assert.equal((await manager.validCredential()).refresh, 'offline-refresh-safe-rotation')
})

test('mandatory projection covers late tools and replay namespaces without changing IDs', () => {
  const projected = subscriptionPayload({ store: true, stream: false, previous_response_id: 'not-used',
    input: [
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'late' }] },
      { type: 'function_call', id: 'fc_replay', call_id: 'call_replay', name: 'read', arguments: '{}', namespace: 'dsh' },
      { type: 'custom_tool_call', id: 'ctc_replay', call_id: 'call_custom', name: 'custom', input: 'x', namespace: 'kept' },
    ],
  }, MODEL.id)
  assert.equal(projected.store, false)
  assert.equal(projected.stream, true)
  assert.equal(projected.previous_response_id, undefined)
  assert.deepEqual((projected.input as Record<string, unknown>[])[1], {
    type: 'function_call', id: 'fc_replay', call_id: 'call_replay', name: 'read', arguments: '{}', namespace: 'dsh',
  })
  assert.equal((projected.input as Record<string, unknown>[])[2]?.namespace, 'kept')
})

test('native PiAiAdapter retains namespace, tool IDs and reasoning across two mock turns', async t => {
  const store = await tempStore(t)
  await store.manager.credentialStore.modify(PROVIDER_ID, async () => grant())
  const profiles = new Map([[PROVIDER_ID, subscriptionProfile(store.manager, [MODEL], { identity: (await store.manager.snapshot()).identity! })]])
  const adapter = new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => undefined,
    auth: { credentials: store.manager.credentialStore,
      authContext: { env: async () => undefined, fileExists: async () => false } } })
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const reason = { type: 'reasoning', id: 'rs_offline', encrypted_content: 'encrypted-reasoning', summary: [] }
  const call = { type: 'function_call', id: 'fc_offline', call_id: 'call_offline', name: 'read',
    arguments: '{"path":"README"}', namespace: 'dsh', status: 'completed' }
  let turn = 0
  globalThis.fetch = async (_input, init) => {
    if (++turn === 1) return sse([
      { type: 'response.output_item.added', output_index: 0, item: reason },
      { type: 'response.output_item.done', output_index: 0, item: reason },
      { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
      { type: 'response.output_item.done', output_index: 1, item: call },
      { type: 'response.completed', response: { id: 'resp_tool', status: 'completed', output: [reason, call] } },
    ])
    const body = JSON.parse(String(init?.body))
    const replayed = body.input.find((item: Record<string, unknown>) => item.type === 'function_call')
    assert.equal(replayed.id, 'fc_offline')
    assert.equal(replayed.call_id, 'call_offline')
    assert.equal(replayed.namespace, 'dsh')
    assert.equal(body.input.find((item: Record<string, unknown>) => item.type === 'function_call_output').call_id, 'call_offline')
    assert.deepEqual(body.input.find((item: Record<string, unknown>) => item.type === 'reasoning'), reason)
    assert.equal(body.previous_response_id, undefined)
    return sse(completeEvents())
  }
  const firstOptions: GenerateOptions = {
    provider: PROVIDER_ID, model: MODEL.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'read' }] }],
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  }
  const first = await collect(adapter.stream(firstOptions))
  const finish = first.find(chunk => chunk.type === 'finish')
  assert.ok(finish?.type === 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')
  assert.ok(finish.replayState)
  const content = first.filter((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end')
    .map(chunk => chunk.block)
  const second = await collect(adapter.stream({ ...firstOptions, messages: [
    ...firstOptions.messages,
    { role: 'assistant', id: MessageId('offline-assistant'), content,
      source: { kind: 'model', provider: PROVIDER_ID, model: MODEL.id, replayState: finish.replayState } },
    { role: 'tool', id: MessageId('offline-tool'), toolCallId: ToolCallId('call_offline|fc_offline'),
      source: { kind: 'tool', callId: ToolCallId('call_offline|fc_offline') },
      content: [{ type: 'text', text: 'README contents' }] },
  ] }))
  assert.equal(second.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
  assert.equal(turn, 2)
})

test('incomplete stream and cancellation cannot become successful responses', async t => {
  const store = await tempStore(t)
  await store.manager.credentialStore.modify(PROVIDER_ID, async () => grant())
  const models = createModels({ credentials: store.manager.credentialStore })
  models.setProvider(subscriptionProvider(store.manager, [MODEL], { identity: grant() }))
  const model = models.getModel(PROVIDER_ID, MODEL.id)
  assert.ok(model)
  const incomplete = await models.completeSimple(model, { messages: [] }, {
    fetch: async () => sse([{ type: 'response.incomplete', response: { status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' } } }]),
  })
  assert.equal(incomplete.stopReason, 'error')
  const truncated = await models.completeSimple(model, { messages: [] }, {
    fetch: async () => sse([{ type: 'response.created', response: { id: 'resp_truncated' } }]),
  })
  assert.equal(truncated.stopReason, 'error')
  const abort = new AbortController()
  let signalSeen: AbortSignal | null | undefined
  const cancelled = models.completeSimple(model, { messages: [] }, {
    signal: abort.signal,
    fetch: async (_input, init) => {
      signalSeen = init?.signal
      abort.abort()
      throw new DOMException('Aborted', 'AbortError')
    },
  })
  assert.equal((await cancelled).stopReason, 'aborted')
  assert.equal(signalSeen?.aborted, true)
})

test('DSH context registers a separate route without exposing a Web login that bypasses the CLI lease', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-route-offline-'))
  const context = new Context()
  const credentials = await context.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
  const llm = await context.plugin(LlmRuntime)
  const auth = await context.plugin(AuthorizationService)
  const subscription = await context.plugin(plugin)
  t.after(async () => {
    await subscription.dispose(); await auth.dispose(); await llm.dispose(); await credentials.dispose()
    await rm(home, { recursive: true, force: true })
  })
  assert.ok(context.llm.listProviders().some(provider => provider.id === PROVIDER_ID))
  assert.equal(context.authorization.describe(SUBSCRIPTION_KEY), undefined)
  assert.deepEqual(await context.llm.listModels(PROVIDER_ID), [])
  const manager = new SubscriptionManager(context.credentials, operations({ fetchModels: async () => [MODEL] }))
  await manager.credentialStore.modify(PROVIDER_ID, async () => grant())
  await manager.refreshModels()
  await setImmediate()
  const discovered = await context.llm.listModels(PROVIDER_ID)
  assert.equal(discovered[0]?.id, MODEL.id)
  assert.deepEqual(discovered[0]?.inputModalities, ['text', 'image'])
})
