import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  openSubscriptionStore, SUBSCRIPTION_KEY, SubscriptionManager, SubscriptionStateError,
} from '../src/dsh-store.js'
import { PROVIDER_ID } from '../src/catalog.js'

test('local state errors have a fixed recognizable name and human-safe diagnosis', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-subscription-state-error-'))
  const store = await openSubscriptionStore(home)
  t.after(async () => { await store.dispose(); await rm(home, { recursive: true, force: true }) })
  await assert.rejects(store.manager.validCredential(), error => {
    assert.ok(error instanceof SubscriptionStateError)
    assert.equal(error.name, 'SubscriptionStateError')
    assert.match(error.message, /Run dsh-chatgpt login first/)
    return true
  })
  await store.manager.credentials.modifyRecord(SUBSCRIPTION_KEY, async () => ({
    kind: 'grant', payload: { version: 2, privateRawValue: 'must-not-appear' },
  }))
  await assert.rejects(store.manager.status(), error => {
    assert.ok(error instanceof SubscriptionStateError)
    assert.match(error.message, /unsupported format/)
    assert.doesNotMatch(error.message, /must-not-appear/)
    return true
  })
})

test('unclassified native storage errors propagate unchanged', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-subscription-native-error-'))
  const store = await openSubscriptionStore(home)
  t.after(async () => { await store.dispose(); await rm(home, { recursive: true, force: true }) })
  const upstream = Object.assign(new Error('Unclassified upstream detail'), { code: 'EACCES' })
  const credentials = Object.create(store.manager.credentials) as typeof store.manager.credentials
  credentials.readRecord = async () => { throw upstream }
  const manager = new SubscriptionManager(credentials)
  await assert.rejects(manager.credentialStore.read(PROVIDER_ID), error => error === upstream)
})
