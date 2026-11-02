import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply, ChatgptPlan, inject, PlanStatusRow } from '../src/client/index.js'
import { PlanClientState, parsePlanStatus } from '../src/client/state.js'
import { MANAGE_USAGE_URL, PLAN_RPC_CHANNEL } from '../src/plan-contract.js'
import type { PlanStatus } from '../src/plan-contract.js'

const saved: PlanStatus = { authorization: 'saved', accountLabel: 'person@example.test', manageUsageUrl: MANAGE_USAGE_URL, noticeRequired: true, noticeId: 'a'.repeat(64) }
const confirmed: PlanStatus = { ...saved, noticeRequired: false, noticeId: undefined }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>(complete => { resolve = complete })
  return { promise, resolve }
}

test('client wire DTO rejects unexpected secrets, unsafe links, labels and incomplete notices', () => {
  assert.deepEqual(parsePlanStatus(saved), saved)
  for (const value of [null, [], { ...saved, accessToken: 'SECRET' }, { ...saved, manageUsageUrl: 'https://evil.test' }, { ...saved, accountLabel: '<x>\n' }, { ...saved, accountLabel: 'x'.repeat(321) }, { ...saved, noticeId: undefined }, { ...saved, authorization: 'missing' }]) {
    assert.throws(() => parsePlanStatus(value))
  }
})

test('inactive controller never reads account; activation sends only exact status request', async () => {
  const calls: unknown[][] = []
  const state = new PlanClientState({ call: async (...args) => { calls.push(args); return { ok: true, value: saved } } })
  await state.refresh()
  assert.equal(calls.length, 0)
  state.setActive(true)
  await tick()
  assert.deepEqual(calls[0]?.slice(0, 3), [PLAN_RPC_CHANNEL, 'status', {}])
  assert.equal(state.getSnapshot().status?.accountLabel, saved.accountLabel)
  state.setActive(false)
  assert.equal(state.getSnapshot().status, undefined)
  state.dispose()
})

test('provider switch aborts request and discards a late account response', async () => {
  const response = deferred()
  let signal: AbortSignal | undefined
  const state = new PlanClientState({ call: async (_c, _e, _p, value) => { signal = value; return response.promise } })
  state.setActive(true)
  state.setActive(false)
  assert.equal(signal?.aborted, true)
  response.resolve({ ok: true, value: saved })
  await tick()
  assert.equal(state.getSnapshot().phase, 'idle')
  assert.equal(state.getSnapshot().status, undefined)
})

test('connection reset supersedes an in-flight read without allowing old generation overwrite', async () => {
  const first = deferred()
  let calls = 0
  const state = new PlanClientState({ call: async () => ++calls === 1 ? first.promise : { ok: true, value: { ...saved, accountLabel: 'new@example.test' } } })
  state.setActive(true)
  await state.refresh(true)
  first.resolve({ ok: true, value: saved })
  await tick()
  assert.equal(state.getSnapshot().status?.accountLabel, 'new@example.test')
  state.dispose()
})

test('explicit acknowledgement uses opaque id and closes notice only after saved result', async () => {
  const response = deferred()
  const calls: unknown[][] = []
  const state = new PlanClientState({ call: async (...args) => { calls.push(args); return calls.length === 1 ? { ok: true, value: saved } : response.promise } })
  state.setActive(true)
  await tick()
  const operation = state.acknowledge()
  assert.equal(state.getSnapshot().confirming, true)
  assert.equal(state.getSnapshot().status?.noticeRequired, true)
  assert.deepEqual(calls[1]?.slice(0, 3), [PLAN_RPC_CHANNEL, 'acknowledge', { noticeId: saved.noticeId }])
  response.resolve({ ok: true, value: confirmed })
  await operation
  assert.equal(state.getSnapshot().status?.noticeRequired, false)
  assert.equal(state.getSnapshot().confirming, false)
  state.dispose()
})

test('rejected acknowledgement exposes no raw error or stale account and remains a failure', async () => {
  let calls = 0
  const state = new PlanClientState({ call: async () => {
    if (++calls === 1) return { ok: true, value: saved }
    throw new Error('SECRET account changed')
  } })
  state.setActive(true)
  await tick()
  await state.acknowledge()
  assert.equal(state.getSnapshot().confirmationFailed, true)
  assert.equal(state.getSnapshot().status, undefined)
  assert.doesNotMatch(JSON.stringify(state.getSnapshot()), /SECRET|person@example/)
  state.dispose()
})

test('transport rejection and business failure are safe and retryable', async () => {
  for (const call of [async () => { throw new Error('SECRET') }, async () => ({ ok: false, error: { message: 'SECRET' } })]) {
    const state = new PlanClientState({ call })
    state.setActive(true)
    await tick()
    assert.equal(state.getSnapshot().phase, 'error')
    assert.equal(state.getSnapshot().status, undefined)
    assert.doesNotMatch(JSON.stringify(state.getSnapshot()), /SECRET/)
    state.dispose()
  }
})

test('personal-use row contains only the plan source and safe usage link', () => {
  const html = renderToStaticMarkup(<PlanStatusRow />)
  assert.match(html, /Using ChatGPT plan/)
  assert.match(html, /href="https:\/\/chatgpt.com\/settings\/usage"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.doesNotMatch(html, /account|Retry|Plan details|<button|<dialog/)
})

test('personal-use slot registers without accessing Connection or account state', () => {
  assert.deepEqual(inject, ['slots', 'modelDirectories'])
  let registered = false
  const store = { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} }
  const context = {
    get connection() { throw new Error('account Connection must not be accessed') },
    modelDirectories: { directoryFor: () => ({ store }) },
    slots: {
      inject: (_name: string, setup: () => unknown) => setup(),
      register: (entry: { inject(sessionId: string): unknown }) => {
        registered = true
        assert.deepEqual(entry.inject('fixture'), { directory: store })
      },
    },
  } as unknown as Parameters<typeof apply>[0]
  apply(context)
  assert.equal(registered, true)
})


test('native slot stays empty for other providers and subagents without invoking RPC', () => {
  let calls = 0
  function props(provider: string, subagent: unknown) {
    const snapshot = { current: { provider, model: 'model' } }
    return {
      sessionId: 'offline-fixture', session: { subagent },
      directory: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      rpc: { call: async () => { ++calls; throw new Error('must not read account') } },
      subscribeReset: () => () => {},
    } as unknown as Parameters<typeof ChatgptPlan>[0]
  }
  assert.equal(renderToStaticMarkup(<ChatgptPlan {...props('deepseek', null)} />), '')
  assert.equal(renderToStaticMarkup(<ChatgptPlan {...props('openai-chatgpt', { address: 'subagent' })} />), '')
  const activeHtml = renderToStaticMarkup(<ChatgptPlan {...props('openai-chatgpt', null)} />)
  assert.match(activeHtml, /Using ChatGPT plan/)
  assert.match(activeHtml, /href="https:\/\/chatgpt.com\/settings\/usage"/)
  assert.doesNotMatch(activeHtml, /Loading account|Account information|ChatGPT account|Retry|Plan details|<dialog/)
  const section = activeHtml.match(/^<section\b[^>]*>/)?.[0] ?? ''
  assert.match(section, /box-sizing:border-box/)
  assert.match(section, /width:calc\(100% - var\(--dsh-composer-side-clearance\) - var\(--dsh-composer-side-clearance\)\)/)
  assert.match(section, /max-width:var\(--dsh-composer-card-max-width\)/)
  assert.match(section, /margin-inline:auto/)
  assert.doesNotMatch(section, /position:absolute|transform:/)
  assert.equal(calls, 0)
})
