import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { MessageId, ToolCallId, projectToolUpdates } from '@deepseek-ai/dsh-llm'
import type { Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.js'
import { PROVIDER_ID } from '../src/catalog.js'

// Exercise the real plugin, assembly waterfall and monotonic tool pipeline; only
// the agent's already-committed request header is a bounded metadata fixture.
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-search-isolation-'))
  const ctx = new Context()
  const credentials = await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false })
  const llm = await ctx.plugin(LlmRuntime)
  const prompt = await ctx.plugin(SystemPrompt, {})
  const tools = await ctx.plugin(ToolRuntime)
  let searchExecutions = 0
  for (const name of ['web_search', 'web_fetch', 'read', 'bash']) {
    ctx.tools.register({ name, description: name, parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
      execute: async () => { if (name === 'web_search') searchExecutions++; return 'fixture result' } })
  }
  ctx.systemPrompt.section({ name: 'tool:web_search', order: 2000, text: 'Use DSH web_search.' })
  ctx.systemPrompt.section({ name: 'tool:web_fetch', order: 2100, text: 'Use web_fetch.' })
  let selected = 'other-provider'
  // Reproduce model-selection's await-next semantics; the isolation listener
  // must inspect the returned variables, not the initial assembly or UI state.
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next()
    return { ...assembled, variables: { ...assembled.variables, provider: selected, model: 'fixture-model' } }
  })
  const subscription = await ctx.plugin(plugin)
  t.after(async () => {
    await subscription.dispose(); await tools.dispose(); await prompt.dispose()
    await llm.dispose(); await credentials.dispose(); await ctx.fiber.dispose()
    await rm(home, { recursive: true, force: true })
  })
  function agentFor(committedProvider: string) {
    const agent = Object.create(null) as Agent
    Object.assign(agent, { id: 'synthetic-search-agent', parent: undefined,
      options: { provider: selected },
      session: { requestHeader: () => ({ config: { provider: committedProvider, model: 'fixture-model' } }) } })
    return agent
  }
  return { ctx, subscription, select(provider: string) { selected = provider }, agentFor,
    searchExecutions: () => searchExecutions,
    execute(name: string, committedProvider: string) {
      return ctx.tools.execute({ callId: ToolCallId(`fixture:${name}`), name, arguments: {},
        agent: agentFor(committedProvider), signal: new AbortController().signal })
    } }
}

test('subscription assembly removes only DSH search after model selection; switching and unloading restore it', async t => {
  const f = await fixture(t)
  f.select(PROVIDER_ID)
  const selected = await f.ctx.systemPrompt.assemble()
  assert.deepEqual(selected.tools.map(tool => tool.name), ['bash', 'read', 'web_fetch'])
  assert.equal(selected.sections.some(section => section.name === 'tool:web_search'), false)
  assert.equal(selected.sections.some(section => section.name === 'tool:web_fetch'), true)
  assert.ok(f.ctx.tools.get('web_search'), 'keep the registry definition for other routes and historical presenters')

  f.select('other-provider')
  const other = await f.ctx.systemPrompt.assemble()
  assert.ok(other.tools.some(tool => tool.name === 'web_search'))
  assert.ok(other.sections.some(section => section.name === 'tool:web_search'))
  f.select(PROVIDER_ID)
  assert.equal((await f.ctx.systemPrompt.assemble()).tools.some(tool => tool.name === 'web_search'), false)
  await f.subscription.dispose()
  assert.ok((await f.ctx.systemPrompt.assemble()).tools.some(tool => tool.name === 'web_search'))
})

test('search execution guard follows committed provider, not the mutable selection; other tools and routes keep working', async t => {
  const f = await fixture(t)
  f.select('other-provider')
  const denied = await f.execute('web_search', PROVIDER_ID)
  assert.equal(denied.isError, true)
  assert.match(JSON.stringify(denied), /provider-native|OpenAI/)
  assert.equal(f.searchExecutions(), 0)
  for (const name of ['read', 'bash', 'web_fetch']) {
    assert.equal((await f.execute(name, PROVIDER_ID)).isError, false)
  }
  f.select(PROVIDER_ID)
  assert.equal((await f.execute('web_search', 'other-provider')).isError, false)
  assert.equal(f.searchExecutions(), 1)
  await f.subscription.dispose()
  assert.equal((await f.execute('web_search', PROVIDER_ID)).isError, false)
  assert.equal(f.searchExecutions(), 2)
})

test('monotonic guard blocks nested search even when pre-execute explicitly allows; never invokes search body', async t => {
  const f = await fixture(t)
  f.ctx.on('tools/pre-execute', async (_exec, next) => { await next(); return { kind: 'allow' } })
  f.ctx.tools.register({ name: 'nested', description: 'fixture nesting', parameters: { type: 'object' },
    output: { schema: { type: 'boolean' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async (_args, exec) => {
      const result = await f.ctx.tools.execute({ callId: ToolCallId('nested:search'), name: 'web_search',
        arguments: {}, agent: exec.agent, parent: exec.token, signal: exec.signal })
      return result.isError
    } })
  const result = await f.execute('nested', PROVIDER_ID)
  assert.equal(result.isError, false)
  assert.equal(result.value, true)
  assert.equal(f.searchExecutions(), 0)
})

test('current assembly keeps old search calls/results but excludes their late declarations from addition-only replay', async t => {
  const f = await fixture(t)
  f.select(PROVIDER_ID)
  const assembly = await f.ctx.systemPrompt.assemble()
  const read: ToolSchema = { name: 'read', description: 'read', parameters: { type: 'object' } }
  const search: ToolSchema = { name: 'web_search', description: 'old search', parameters: { type: 'object' } }
  const call: Message = { role: 'assistant', id: MessageId('old-search-call'),
    source: { kind: 'model', provider: PROVIDER_ID, model: 'fixture-model' },
    content: [{ type: 'tool-call', id: ToolCallId('old-call'), name: 'web_search', arguments: '{}' }] }
  const result: Message = { role: 'tool', id: MessageId('old-search-result'), toolCallId: ToolCallId('old-call'),
    source: { kind: 'tool', callId: ToolCallId('old-call') }, content: [{ type: 'text', text: 'old sources' }] }
  const messages: Message[] = [{ role: 'developer', id: MessageId('late-search'),
    content: [{ type: 'tool-addition', toolName: 'web_search' }], source: { kind: 'tool-registry' } }, call, result]
  const before = JSON.stringify(messages)
  const projected = projectToolUpdates(messages, assembly.tools, 'addition-only', {
    tools: [read], updates: [{ messageId: MessageId('late-search'), additions: [search] }],
  })
  assert.equal(projected.tools?.some(tool => tool.name === 'web_search'), false)
  assert.ok(projected.messages.includes(call))
  assert.ok(projected.messages.includes(result))
  assert.equal(projected.messages.some(message => message.role === 'developer'), false)
  assert.equal(JSON.stringify(messages), before)
})
