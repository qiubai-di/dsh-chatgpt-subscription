import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { openSubscriptionStore, SUBSCRIPTION_KEY, SubscriptionManager } from '../src/dsh-store.js'
import { PROVIDER_ID } from '../src/catalog.js'
import { acquireOperationLease, LocalSetupError } from '../src/runtime.js'
import { SIWC_SCOPES } from '../src/siwc.js'
import type { SiwcCredential, SiwcModel } from '../src/siwc.js'
import * as plugin from '../src/index.js'

const MODEL = { id: 'gpt-5.4', name: 'Offline GPT model' }
const NATIVE_PROVIDER = 'native-fixture'
const NATIVE_KEY = credentialKey('native-fixture', 'account')

function grant(): SiwcCredential {
  return {
    type: 'oauth', access: 'offline-web-access', refresh: 'offline-web-refresh',
    expires: Date.now() + 3_600_000, clientId: 'oaiapp_offline_web', idToken: 'offline-web-id-token',
    scopes: [...SIWC_SCOPES], issuer: 'https://auth.openai.com', subject: 'offline-web-subject',
    hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
  }
}

function busy(error: unknown): boolean {
  assert.ok(error instanceof LocalSetupError)
  assert.equal(error.code, 'SESSION_BUSY')
  return true
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-web-offline-'))
  const hostHome = join(root, 'native')
  const credentialHome = join(root, 'subscription')
  await Promise.all([hostHome, credentialHome].map(home => mkdir(home, { mode: 0o700 })))
  const cleanups: Array<() => Promise<unknown>> = []
  t.after(async () => {
    try {
      for (const cleanup of cleanups.reverse()) await cleanup()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  const source = await openSubscriptionStore(credentialHome)
  cleanups.push(() => source.dispose())
  const context = new Context()
  const credentials = await context.plugin(LocalCredentialProvider, { dshHome: hostHome, watch: false })
  cleanups.push(() => credentials.dispose())
  const llm = await context.plugin(LlmRuntime)
  cleanups.push(() => llm.dispose())
  return {
    context, source, hostHome, credentialHome,
    async mount(credentialHome?: string) {
      const subscription = await context.plugin(plugin, credentialHome === undefined ? {} : { credentialHome })
      cleanups.push(() => subscription.dispose())
      return subscription
    },
  }
}

async function seedCatalog(
  credentials: Awaited<ReturnType<typeof openSubscriptionStore>>['manager']['credentials'],
  models: SiwcModel[] = [MODEL],
): Promise<void> {
  await credentials.modifyRecord(SUBSCRIPTION_KEY, async () => ({
    kind: 'grant', payload: { version: 1, credential: grant(), models },
  }))
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000
  while (!await check()) {
    assert.ok(Date.now() < deadline, 'external credential update did not reach the host catalog')
    await setTimeout(20)
  }
}

class NativeFixtureAdapter extends LlmAdapter {
  override async listModels(provider: string) {
    return [{ provider, id: 'native-model', name: 'Existing native model' }]
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    throw new Error('Offline native-web tests must not invoke a model')
  }
}

test('external credential home adds GPT beside native providers without copying the OAuth grant', async t => {
  const { context, source, hostHome, credentialHome, mount } = await fixture(t)
  await seedCatalog(source.manager.credentials)
  const nativeRecord = { kind: 'grant', payload: { account: 'offline-native-account' } }
  await context.credentials.modifyRecord(NATIVE_KEY, async () => ({ kind: 'grant', payload: nativeRecord.payload }))
  const originalNativeFile = await readFile(join(hostHome, '.credentials.yaml'), 'utf8')
  const nativeRegistration = context.llm.registerAdapter([NATIVE_PROVIDER], new NativeFixtureAdapter())
  t.after(() => nativeRegistration())

  await mount(credentialHome)

  assert.deepEqual((await context.llm.listModels(PROVIDER_ID)).map(model => ({ id: model.id, name: model.name })), [MODEL])
  assert.deepEqual(await context.llm.listModels(NATIVE_PROVIDER), [
    { provider: NATIVE_PROVIDER, id: 'native-model', name: 'Existing native model' },
  ])
  assert.ok(context.llm.listProviders().some(provider => provider.id === PROVIDER_ID))
  assert.ok(context.llm.listProviders().some(provider => provider.id === NATIVE_PROVIDER))
  assert.equal(await context.credentials.readRecord(SUBSCRIPTION_KEY), undefined)
  assert.deepEqual(await context.credentials.readRecord(NATIVE_KEY), nativeRecord)
  assert.equal(await readFile(join(hostHome, '.credentials.yaml'), 'utf8'), originalNativeFile)
  assert.equal((await source.manager.credential())?.refresh, 'offline-web-refresh')
})

test('external catalog writes reach the host while its lease blocks account changes until disposal', async t => {
  const { context, source, credentialHome, mount } = await fixture(t)
  await seedCatalog(source.manager.credentials)
  const subscription = await mount(credentialHome)
  await assert.rejects(acquireOperationLease(credentialHome, 'logout'), busy)

  const updated = { ...MODEL, name: 'Updated external catalog name' }
  await seedCatalog(source.manager.credentials, [updated])
  await eventually(async () => (await context.llm.listModels(PROVIDER_ID))[0]?.name === updated.name)
  assert.equal(await context.credentials.readRecord(SUBSCRIPTION_KEY), undefined)

  await subscription.dispose()
  const lease = await acquireOperationLease(credentialHome, 'login')
  await lease.release()
})

test('failed profile hydration disposes the external store and releases its lease', async t => {
  const { context, source, credentialHome, mount } = await fixture(t)
  await seedCatalog(source.manager.credentials)
  const failure = new Error('Offline adapter registration failure')
  let externalProvider: LocalCredentialProvider | undefined
  const readRecord = LocalCredentialProvider.prototype.readRecord
  t.mock.method(LocalCredentialProvider.prototype, 'readRecord', function (this: LocalCredentialProvider, key: CredentialKey) {
    if (key === SUBSCRIPTION_KEY && this !== context.credentials) externalProvider = this
    return readRecord.call(this, key)
  })
  const snapshot = SubscriptionManager.prototype.snapshot
  t.mock.method(SubscriptionManager.prototype, 'snapshot', async function(this: SubscriptionManager) {
    await snapshot.call(this); throw failure
  })

  await assert.rejects(mount(credentialHome), error => error === failure)

  assert.ok(externalProvider, 'initialization must have reached the external store before the injected failure')
  await assert.rejects(externalProvider.modifyRecord(SUBSCRIPTION_KEY, async () => undefined), /disposed/)
  const lease = await acquireOperationLease(credentialHome, 'logout')
  await lease.release()
  assert.equal(await context.credentials.readRecord(SUBSCRIPTION_KEY), undefined)
})

test('default isolated mode reuses native credentials while preserving the launcher lease', async t => {
  const { context, hostHome, mount } = await fixture(t)
  await seedCatalog(context.credentials)
  const launcherLease = await acquireOperationLease(hostHome, 'run')
  try {
    const subscription = await mount()
    assert.equal((await context.llm.listModels(PROVIDER_ID))[0]?.id, MODEL.id)
    await subscription.dispose()
    await assert.rejects(acquireOperationLease(hostHome, 'logout'), busy)
  } finally {
    await launcherLease.release()
  }
})

test('credentialHome rejects relative paths before registering a provider', async t => {
  const { context, mount } = await fixture(t)
  for (const path of ['relative-subscription-home', '.']) {
    await assert.rejects(mount(path))
    assert.equal(context.llm.listProviders().some(provider => provider.id === PROVIDER_ID), false)
  }
})


test('private credential-home feed publishes and withdraws actual route facts on external deletion', async t => {
  const { context, source, credentialHome, mount } = await fixture(t)
  await seedCatalog(source.manager.credentials)
  const subscription = await mount(credentialHome)
  const facts = () => context.bail('optchat/request-policy', PROVIDER_ID, MODEL.id, 'compaction')
  const initial = facts()!
  assert.equal(initial.compactionTools, 'none')
  await source.manager.credentials.deleteRecord(SUBSCRIPTION_KEY)
  await eventually(async () => facts() === undefined && (await context.llm.listModels(PROVIDER_ID)).length === 0)
  assert.equal(initial.lifetime?.aborted, false, 'external removal revokes admissions, not the producer owner')
  await subscription.dispose()
  assert.equal(initial.lifetime?.aborted, true)
})
