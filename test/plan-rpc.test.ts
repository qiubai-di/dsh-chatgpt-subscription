import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { planRpcHandler } from '../src/plan-rpc.js'

function fixture() {
  let reads = 0
  let writes = 0
  const records = new Map<CredentialKey, CredentialRecord>()
  const source: Parameters<typeof planRpcHandler>[0] = {
    async credential() { reads++; return { issuer: 'https://auth.openai.com', subject: 'offline-subject', clientId: 'offline-client', email: 'owner@example.test' } },
    credentials: {
      async readRecord(key) { return records.get(key) },
      async modifyRecord(key, mutate) {
        const next = await mutate(records.get(key))
        if (next !== undefined) { writes++; records.set(key, next) }
        return records.get(key)
      },
    },
  }
  const request = new AbortController()
  const lifetime = new AbortController()
  const peer: PeerScope = {
    id: 'offline-owner' as PeerId, ctx: new Context(), principal: { kind: 'owner' },
    signal: lifetime.signal, interactions: 'none', async dispose() { lifetime.abort() },
  }
  return { source, peer, request, lifetime, get reads() { return reads }, get writes() { return writes } }
}

// Raw RPC is authenticated by Connection, but does not inherit API gateway owner policy.
// These tests cover the missing business boundary without serving any real endpoint.
test('plan RPC denies a non-owner before any local credential read', async () => {
  const f = fixture()
  Reflect.set(f.peer, 'principal', { kind: 'untrusted-fixture' })
  const result = await planRpcHandler(f.source)('status', {}, f.request.signal, f.peer)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'forbidden')
  assert.equal(f.reads, 0)
  assert.equal(f.writes, 0)
})

test('plan status is owner-only, local and has no mutation or raw identity', async () => {
  const f = fixture()
  const result = await planRpcHandler(f.source)('status', {}, f.request.signal, f.peer)
  assert.equal(result.ok, true)
  assert.match(JSON.stringify(result), /owner@example.test/)
  assert.doesNotMatch(JSON.stringify(result), /offline-client|offline-subject/)
  assert.equal(f.writes, 0)
})

test('only explicit valid acknowledgement writes an independent receipt', async () => {
  const f = fixture()
  const handler = planRpcHandler(f.source)
  const initial = await handler('status', {}, f.request.signal, f.peer)
  assert.ok(initial.ok)
  const value = initial.value as { noticeId: string }
  const result = await handler('acknowledge', { noticeId: value.noticeId }, f.request.signal, f.peer)
  assert.ok(result.ok)
  assert.match(JSON.stringify(result), /"noticeRequired":false/)
  assert.equal(f.writes, 1)
})

test('unexpected endpoints and payload fields are rejected before reading any account', async () => {
  for (const [endpoint, payload] of [
    ['login', {}], ['logout', {}], ['refresh', {}], ['models', {}], ['status', null],
    ['status', []], ['status', { owner: true }], ['status', { home: '/other-account' }],
    ['acknowledge', {}], ['acknowledge', { noticeId: 'bad' }],
    ['acknowledge', { noticeId: 'a'.repeat(64), patch: {} }],
  ] as const) {
    const f = fixture()
    const result = await planRpcHandler(f.source)(endpoint, payload, f.request.signal, f.peer)
    assert.equal(result.ok, false)
    assert.equal(f.reads, 0)
    assert.equal(f.writes, 0)
  }
})

test('request, peer and plugin disposal all deny reads before touching account state', async () => {
  for (const mode of ['request', 'peer', 'plugin']) {
    const f = fixture()
    if (mode === 'request') f.request.abort()
    if (mode === 'peer') f.lifetime.abort()
    const result = await planRpcHandler(f.source, () => mode !== 'plugin')('status', {}, f.request.signal, f.peer)
    assert.equal(result.ok, false)
    assert.equal(f.reads, 0)
  }
})

test('raw local errors do not escape into the Connection carrier', async () => {
  const f = fixture()
  f.source.credential = async () => { throw new Error('offline-refresh-secret /private/credential.yaml') }
  const result = await planRpcHandler(f.source)('status', {}, f.request.signal, f.peer)
  assert.equal(result.ok, false)
  assert.doesNotMatch(JSON.stringify(result), /offline-refresh-secret|private\/credential/)
})

test('disposed plugin cannot return account data after an asynchronous local read', async () => {
  const f = fixture()
  let active = true
  const read = f.source.credential
  f.source.credential = async () => { const value = await read(); active = false; return value }
  const result = await planRpcHandler(f.source, () => active)('status', {}, f.request.signal, f.peer)
  assert.equal(result.ok, false)
  assert.doesNotMatch(JSON.stringify(result), /owner@example.test/)
})
