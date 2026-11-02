import assert from 'node:assert/strict'
import test from 'node:test'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { PROVIDER_ID } from '../src/catalog.js'
import { MANAGE_USAGE_URL, PLAN_PROVIDER_ID } from '../src/plan-contract.js'
import { acknowledgePlanNotice, PlanStatusError, readPlanStatus } from '../src/plan-status.js'
import type { SubscriptionStatus } from '../src/dsh-store.js'

function fixture() {
  let state: Pick<SubscriptionStatus, 'signedIn' | 'clientId' | 'email'> & { subject?: string } = {
    signedIn: true, clientId: 'offline-client-secret-id', email: 'reader@example.test',
  }
  const records = new Map<CredentialKey, CredentialRecord>()
  let writes = 0
  const source = {
    async credential() {
      if (!state.signedIn || !state.clientId) return undefined
      return {
        clientId: state.clientId, email: state.email,
        issuer: 'https://auth.openai.com', subject: state.subject ?? 'offline-subject',
        access: 'offline-access-secret', refresh: 'offline-refresh-secret',
      }
    },
    credentials: {
      async readRecord(key: CredentialKey) { return records.get(key) },
      async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
        const next = await mutate(records.get(key))
        if (next !== undefined) { writes++; records.set(key, next) }
        return records.get(key)
      },
    },
  }
  return { source, records, get writes() { return writes }, set(next: typeof state) { state = next } }
}

// Official UX needs a safe account label and once-only information, not a raw grant.
// There was no account-status DTO or receipt coverage before this change.
test('plan DTO exposes only saved-state and account label, with no raw identifiers or writes', async () => {
  const f = fixture()
  const status = await readPlanStatus(f.source)
  assert.equal(PLAN_PROVIDER_ID, PROVIDER_ID)
  assert.equal(status.authorization, 'saved')
  assert.equal(status.accountLabel, 'reader@example.test')
  assert.equal(status.manageUsageUrl, MANAGE_USAGE_URL)
  assert.equal(status.noticeRequired, true)
  assert.match(status.noticeId!, /^[0-9a-f]{64}$/)
  assert.equal(JSON.stringify(status).includes('offline-client-secret-id'), false)
  assert.deepEqual(Object.keys(status).sort(), ['accountLabel', 'authorization', 'manageUsageUrl', 'noticeId', 'noticeRequired'])
  assert.equal(f.writes, 0)
})

test('missing authorization never shows a stale account or onboarding', async () => {
  const f = fixture()
  f.set({ signedIn: false, clientId: 'offline-stale', email: 'stale@example.test' })
  const status = await readPlanStatus(f.source)
  assert.equal(status.authorization, 'missing')
  assert.equal(status.noticeRequired, false)
  assert.equal(status.noticeId, undefined)
  assert.equal(JSON.stringify(status).includes('stale'), false)
  assert.equal(f.writes, 0)
})

test('no-email account uses a safe label, not a client ID', async () => {
  const f = fixture()
  f.set({ signedIn: true, clientId: 'offline-no-email' })
  assert.equal((await readPlanStatus(f.source)).accountLabel, 'Signed-in ChatGPT account')
})

test('notice acknowledgement is idempotent and survives sign-out/sign-in', async () => {
  const f = fixture()
  const initial = await readPlanStatus(f.source)
  assert.equal((await acknowledgePlanNotice(f.source, initial.noticeId!)).noticeRequired, false)
  await acknowledgePlanNotice(f.source, initial.noticeId!)
  assert.equal(f.writes, 1)
  f.set({ signedIn: false })
  assert.equal((await readPlanStatus(f.source)).noticeRequired, false)
  f.set({ signedIn: true, clientId: 'offline-client-secret-id', email: 'reader@example.test' })
  assert.equal((await readPlanStatus(f.source)).noticeRequired, false)
  assert.equal(f.records.size, 1)
})

test('old account confirmation cannot silently confirm a newly selected account', async () => {
  const f = fixture()
  const initial = await readPlanStatus(f.source)
  f.set({ signedIn: true, clientId: 'offline-other-account', email: 'other@example.test' })
  await assert.rejects(acknowledgePlanNotice(f.source, initial.noticeId!), (error: unknown) =>
    error instanceof PlanStatusError && error.code === 'ACCOUNT_CHANGED')
  assert.equal(f.writes, 0)
  const other = await readPlanStatus(f.source)
  assert.notEqual(other.noticeId, initial.noticeId)
  assert.equal(other.noticeRequired, true)
})

test('acknowledgement requires an active saved account', async () => {
  const f = fixture()
  f.set({ signedIn: false })
  await assert.rejects(acknowledgePlanNotice(f.source, 'invalid'), (error: unknown) =>
    error instanceof PlanStatusError && error.code === 'NO_ACTIVE_ACCOUNT')
  assert.equal(f.writes, 0)
})

test('aborted reads and confirmations do not write or call local status', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(readPlanStatus(f.source, controller.signal), { name: 'AbortError' })
  await assert.rejects(acknowledgePlanNotice(f.source, 'ignored', controller.signal), { name: 'AbortError' })
  assert.equal(f.writes, 0)
})

test('invalid receipt metadata fails safely instead of overwriting it or OAuth state', async () => {
  const f = fixture()
  const initial = await readPlanStatus(f.source)
  await acknowledgePlanNotice(f.source, initial.noticeId!)
  const key = [...f.records.keys()][0]!
  f.records.set(key, { kind: 'grant', payload: { version: 7, secret: 'offline-secret' } })
  await assert.rejects(readPlanStatus(f.source), (error: unknown) => {
    assert.ok(error instanceof PlanStatusError)
    assert.equal(error.code, 'INVALID_NOTICE_STATE')
    assert.equal(error.message.includes('offline-secret'), false)
    return true
  })
  assert.equal(f.writes, 1)
})

test('accounts sharing an OAuth client are isolated by issuer and subject', async () => {
  const f = fixture()
  const first = await readPlanStatus(f.source)
  await acknowledgePlanNotice(f.source, first.noticeId!)
  f.set({ signedIn: true, clientId: 'offline-client-secret-id', email: 'reader@example.test', subject: 'another-subject' })
  const second = await readPlanStatus(f.source)
  assert.equal(second.noticeRequired, true)
  assert.notEqual(second.noticeId, first.noticeId)
  await assert.rejects(acknowledgePlanNotice(f.source, first.noticeId!), (error: unknown) =>
    error instanceof PlanStatusError && error.code === 'ACCOUNT_CHANGED')
  f.set({ signedIn: true, clientId: 'offline-client-secret-id', email: 'renamed@example.test' })
  assert.equal((await readPlanStatus(f.source)).noticeRequired, false)
})
