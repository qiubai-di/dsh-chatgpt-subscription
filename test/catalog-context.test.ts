import assert from 'node:assert/strict'
import test from 'node:test'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { subscriptionModelDefinitions } from '../src/catalog.js'

test('the active GPT 6.1 Sol window is 500k without changing other models or the shared catalog', () => {
  const catalog = openaiProvider().getModels().filter(model => model.api === 'openai-responses')
  const metadata = () => catalog.map(({ id, contextWindow, maxTokens, input, reasoning }) =>
    ({ id, contextWindow, maxTokens, input: [...input], reasoning }))
  const before = metadata()
  assert.ok(before.some(model => model.id === 'gpt-6.1-sol'))
  assert.ok(before.some(model => model.id === 'o3-mini' && !model.input.includes('image')))
  const models = subscriptionModelDefinitions(catalog.map(({ id, name }) => ({ id, name })))
  for (const expected of before) {
    const actual = models.find(model => model.id === expected.id)
    assert.equal(actual?.contextWindow, expected.id === 'gpt-6.1-sol' ? 500_000 : expected.contextWindow, expected.id)
    assert.equal(actual?.maxTokens, expected.maxTokens, expected.id)
    assert.deepEqual(actual?.input, expected.input, expected.id)
    assert.equal(actual?.reasoning, expected.reasoning, expected.id)
  }
  assert.deepEqual(metadata(), before)
})
