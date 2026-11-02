import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmAdapter, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SUBSCRIPTION_KEY, SubscriptionManager } from '../src/dsh-store.js'
import { PROVIDER_ID } from '../src/catalog.js'
import { SIWC_SCOPES, SIWC_ENDPOINTS } from '../src/siwc.js'
import type { SiwcCredential } from '../src/siwc.js'
import { normalizeContext } from '@earendil-works/pi-ai'
import * as plugin from '../src/index.js'
import { subscriptionProvider } from '../src/provider.js'

const MODEL = { id: 'gpt-6.1-sol', name: 'GPT 6.1' }
const OTHER = { id: 'gpt-5.4', name: 'GPT 5.4' }
const grant = (subject = 'synthetic-account-A', extra: Partial<SiwcCredential> = {}): SiwcCredential => ({
  type: 'oauth', access: `synthetic-access-${subject}`, refresh: `synthetic-refresh-${subject}`,
  expires: Date.now() + 3600000, issuer: 'https://auth.openai.com', clientId: 'oaiapp_binding', subject,
  idToken: 'synthetic-id-token', email: 'synthetic@example.test', scopes: [...SIWC_SCOPES],
  hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001', ...extra,
})
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000
  while (!await check()) { assert.ok(Date.now() < deadline, 'owned offline state did not settle'); await setImmediate() }
}
function record(credential?: SiwcCredential) {
  return { kind: 'grant' as const, payload: { version: 1, models: [MODEL, OTHER], ...(credential ? { credential } : {}) } }
}
function events(text = 'Synthetic answer') {
  const item = { id: 'msg_binding', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] }
  return [{ type: 'response.created', response: { id: 'resp_binding' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_binding', status: 'completed', output: [item],
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }]
}
function sse() { return new Response(events().map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } }) }
const request = (): GenerateOptions => ({ provider: PROVIDER_ID, model: MODEL.id, purpose: 'compaction',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Synthetic history' }] }] })
async function collect(stream: AsyncIterable<StreamChunk>) {
  const assembled = new BlockAssembler()
  for await (const chunk of stream) assembled.push(chunk)
  return assembled
}
async function fixture(t: test.TestContext, credential = grant()) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bound-policy-offline-'))
  const ctx = new Context()
  const creds = await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
  const llm = await ctx.plugin(LlmRuntime)
  await ctx.credentials.modifyRecord(SUBSCRIPTION_KEY, async () => record(credential))
  let adapter!: LlmAdapter
  const register = ctx.llm.registerAdapter.bind(ctx.llm)
  t.mock.method(ctx.llm, 'registerAdapter', (providers: string[], selected: LlmAdapter) => { adapter = selected; return register(providers, selected) })
  const subscription = await ctx.plugin(plugin)
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('Unexpected external operation in offline fixture') }
  t.after(async () => {
    globalThis.fetch = originalFetch
    await subscription.dispose(); await llm.dispose(); await creds.dispose()
    await rm(home, { recursive: true, force: true })
  })
  return { ctx, adapter, subscription,
    facts: (purpose: 'main' | 'compaction' = 'compaction', model = MODEL.id) => ctx.bail('optchat/request-policy', PROVIDER_ID, model, purpose),
    seed: (credential?: SiwcCredential) => ctx.credentials.modifyRecord(SUBSCRIPTION_KEY, async () => record(credential)),
  }
}

test('actual producer facts are frozen opaque snapshot facts; missing route/model and disposed producer are unknown', async t => {
  const f = await fixture(t)
  const facts = f.facts()!
  assert.ok(Object.isFrozen(facts)); assert.ok(Object.isFrozen(facts.cache)); assert.ok(Object.isFrozen(facts.capacity))
  assert.equal(facts.compactionTools, 'none')
  assert.equal(facts.cache?.mode, 'automatic'); assert.equal(facts.cache.responseStart, 'forwarded-content')
  assert.equal(facts.capacity?.totalOutputTokens, 128000); assert.equal(facts.capacity.includesReasoning, true)
  assert.notEqual(f.facts('main')?.cache?.projection, facts.cache.projection)
  assert.equal(f.facts('main')?.generation, facts.generation)
  const { lifetime, ...identity } = facts
  assert.ok(lifetime instanceof AbortSignal)
  const json = JSON.stringify(identity)
  for (const secret of ['synthetic-account-A', 'synthetic-access', 'synthetic-refresh', 'subject', 'email', 'synthetic@example.test', 'idToken']) {
    assert.equal(json.includes(secret), false, secret)
  }
  assert.equal(f.facts('compaction', OTHER.id)?.capacity, undefined)
  assert.equal(f.facts('main', 'unrecognized-model'), undefined)
  assert.equal(f.ctx.bail('optchat/request-policy', 'another-provider', MODEL.id, 'main'), undefined)
  await f.subscription.dispose()
  assert.equal(lifetime.aborted, true); assert.equal(f.facts(), undefined)
})

test('credential feed revokes synchronously; late hydrate cannot resurrect removed records or overwrite newer B', async t => {
  const f = await fixture(t)
  const initial = f.facts()!
  const captured = deferred(); const release = deferred()
  const snapshot = SubscriptionManager.prototype.snapshot
  let delay = true
  t.mock.method(SubscriptionManager.prototype, 'snapshot', async function(this: SubscriptionManager) {
    const value = await snapshot.call(this)
    if (delay) { delay = false; captured.resolve(); await release.promise }
    return value
  })
  await f.seed(grant('synthetic-old-A'))
  assert.equal(f.facts(), undefined, 'notification revoked facts before its asynchronous read')
  await captured.promise
  await f.seed(grant('synthetic-new-B'))
  await until(() => f.facts() !== undefined)
  const b = f.facts()!
  assert.notEqual(b.generation, initial.generation)
  assert.equal(b.lifetime, initial.lifetime); assert.equal(initial.lifetime?.aborted, false)
  release.resolve(); await setImmediate()
  assert.equal(f.facts()?.generation, b.generation, 'late A did not overwrite B')
  // A second old hydration must also stay revoked when the record is deleted.
  const captured2 = deferred(); const release2 = deferred(); delay = true
  t.mock.method(SubscriptionManager.prototype, 'snapshot', async function(this: SubscriptionManager) {
    const value = await snapshot.call(this)
    if (delay) { delay = false; captured2.resolve(); await release2.promise }
    return value
  })
  await f.seed(grant()); await captured2.promise
  await f.ctx.credentials.modifyRecord(SUBSCRIPTION_KEY, async () => undefined)
  // Native modify(undefined) means no change; use the public delete operation for actual removal.
  await f.ctx.credentials.deleteRecord(SUBSCRIPTION_KEY)
  await until(() => f.facts() === undefined)
  release2.resolve(); await setImmediate()
  assert.equal(f.facts(), undefined)
})

for (const entry of ['stream', 'prepareCall'] as const) {
  test(`${entry}: prepared A waits original credential lock; B is rejected before HTTP and fresh B works`, async t => {
    const f = await fixture(t)
    const factsA = f.facts()!
    const bound = entry === 'stream' ? f.adapter.stream(request()) : (await f.adapter.prepareCall(PROVIDER_ID, MODEL.id)).stream(request())
    const lockEntered = deferred(); const release = deferred(); const dispatchEntered = deferred()
    const valid = SubscriptionManager.prototype.validCredential
    t.mock.method(SubscriptionManager.prototype, 'validCredential', function(this: SubscriptionManager, options: Parameters<SubscriptionManager['validCredential']>[0]) {
      dispatchEntered.resolve(); return valid.call(this, options)
    })
    const write = f.ctx.credentials.modifyRecord(SUBSCRIPTION_KEY, async () => {
      lockEntered.resolve(); await release.promise; return record(grant('synthetic-account-B'))
    })
    await lockEntered.promise
    let http = 0
    globalThis.fetch = async (_input, init) => {
      http++; assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-access-synthetic-account-B')
      return sse()
    }
    const pending = collect(bound)
    await dispatchEntered.promise
    assert.equal(http, 0)
    release.resolve(); await write
    const refused = await pending
    assert.equal(refused.finish.kind, 'error'); assert.match(refused.finish.kind === 'error' ? refused.finish.failure.message : '', /account or authorization changed/); assert.equal(refused.replayState, undefined); assert.equal(http, 0)
    await until(() => f.facts() !== undefined && f.facts()!.generation !== factsA.generation)
    assert.equal(factsA.lifetime?.aborted, false)
    const fresh = await collect((await f.adapter.prepareCall(PROVIDER_ID, MODEL.id)).stream(request()))
    assert.equal(fresh.finish.kind, 'stop'); assert.equal(http, 1)
  })
}

test('same-account native OAuth refresh and its synchronous feed preserve an already bound invocation', async t => {
  const f = await fixture(t, grant('synthetic-account-A', { expires: Date.now() - 1000 }))
  const facts = f.facts()!
  const prepared = await f.adapter.prepareCall(PROVIDER_ID, MODEL.id)
  let refresh = 0, requests = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === SIWC_ENDPOINTS.token) {
      refresh++
      assert.match(String(init?.body), /grant_type=refresh_token/)
      return Response.json({ access_token: 'synthetic-rotated-access', refresh_token: 'synthetic-rotated-refresh', token_type: 'Bearer', expires_in: 3600 })
    }
    assert.equal(new URL(url).pathname, '/v1/responses')
    requests++; assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-rotated-access')
    assert.equal(JSON.parse(String(init?.body)).tool_choice, 'none')
    return sse()
  }
  const result = await collect(prepared.stream(request()))
  assert.equal(result.finish.kind, 'stop'); assert.equal(refresh, 1); assert.equal(requests, 1)
  await until(() => f.facts() !== undefined && f.facts()!.generation !== facts.generation)
  assert.equal(f.facts()!.lifetime, facts.lifetime); assert.equal(facts.lifetime?.aborted, false)
})

test('unbound low-level provider fails closed before credentials or HTTP', async t => {
  const f = await fixture(t)
  const manager = new SubscriptionManager(f.ctx.credentials)
  let reads = 0, http = 0
  t.mock.method(manager, 'validCredential', async () => { reads++; return grant() })
  const provider = subscriptionProvider(manager, [MODEL])
  const message = await provider.streamSimple(provider.getModels()[0]!, normalizeContext({ messages: [] }), {
    fetch: async () => { http++; return sse() },
  }).result()
  assert.equal(message.stopReason, 'error'); assert.equal(reads, 0); assert.equal(http, 0)
})

const changedAuthorizations: [string, Partial<SiwcCredential>][] = [
  ['host binding', { hostId: 'urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
  ['granted scopes', { scopes: [...SIWC_SCOPES, 'synthetic_changed_authorization'] }],
]
for (const [name, extra] of changedAuthorizations) {
  test(`same subject with changed ${name} is refused before HTTP`, async t => {
    const f = await fixture(t)
    const prepared = await f.adapter.prepareCall(PROVIDER_ID, MODEL.id)
    let http = 0
    globalThis.fetch = async () => { http++; return sse() }
    await f.seed(grant('synthetic-account-A', extra))
    const result = await collect(prepared.stream(request()))
    assert.equal(result.finish.kind, 'error'); assert.equal(http, 0)
  })
}

test('chosen grant stays detached through later payload awaits instead of selecting the new account again', async t => {
  const f = await fixture(t)
  const manager = new SubscriptionManager(f.ctx.credentials)
  const snapshot = await manager.snapshot()
  assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.identity)); assert.ok(Object.isFrozen(snapshot.identity?.scopes))
  const provider = subscriptionProvider(manager, snapshot.models, { identity: snapshot.identity! })
  const payloadEntered = deferred(), release = deferred()
  let selected: string | null = null
  const pending = provider.streamSimple(provider.getModels().find(model => model.id === MODEL.id)!, normalizeContext({ messages: [] }), {
    onPayload: async payload => { payloadEntered.resolve(); await release.promise; return payload },
    fetch: async (_input, init) => { selected = new Headers(init?.headers).get('authorization'); return sse() },
  }).result()
  await payloadEntered.promise
  await f.seed(grant('synthetic-account-B'))
  release.resolve()
  assert.equal((await pending).stopReason, 'stop')
  assert.equal(selected, 'Bearer synthetic-access-synthetic-account-A')
})
