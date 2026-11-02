import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateSync } from 'node:zlib'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SUBSCRIPTION_KEY } from '../src/dsh-store.js'
import { PROVIDER_ID } from '../src/catalog.js'
import { SIWC_SCOPES } from '../src/siwc.js'
import * as plugin from '../src/index.js'

// Run against an already installed host, without installing the optional native backend:
// DSH_IMAGE_TEST_HOST=/absolute/path/to/@deepseek-ai/dsh node --test .test-build/test/adapter-images.test.js
const host = process.env.DSH_IMAGE_TEST_HOST
const imageTest = host === undefined ? test.skip : test
const MODEL = { id: 'gpt-6.1-sol', name: 'GPT 6.1 Sol' }

/** A synthetic 1x1 RGBA PNG; no user image or network fixture is needed. */
function smallPng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; ++bit) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    const size = Buffer.alloc(4)
    size.writeUInt32BE(data.length)
    const checksum = Buffer.alloc(4)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))])
}
const PNG = smallPng()

type LocalBackend = new (ctx: Context, config: { dshHome: string; maxImageBytes?: number }) => AttachmentStore
async function fixture(t: test.TestContext, options: { attachments?: boolean; maxImageBytes?: number; root?: string } = {}) {
  assert.ok(host, 'DSH_IMAGE_TEST_HOST must identify the installed DSH for native image tests')
  const requireHost = createRequire(join(host, 'package.json'))
  const backend = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-attachment-local')).href) as { default: LocalBackend }
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-images-offline-'))
  const context = new Context()
  const cleanup: Array<() => Promise<unknown>> = []
  t.after(async () => {
    try { for (const dispose of cleanup.reverse()) await dispose() }
    finally { if (options.root === undefined) await rm(root, { recursive: true, force: true }) }
  })
  const credentials = await context.plugin(LocalCredentialProvider, { dshHome: root, watch: false })
  cleanup.push(() => credentials.dispose())
  if (options.attachments !== false) {
    const attachments = await context.plugin(backend.default, { dshHome: root, maxImageBytes: options.maxImageBytes })
    cleanup.push(() => attachments.dispose())
  }
  const llm = await context.plugin(LlmRuntime)
  cleanup.push(() => llm.dispose())
  await context.credentials.modifyRecord(SUBSCRIPTION_KEY, async () => ({ kind: 'grant', payload: {
    version: 1, models: [MODEL, { id: 'o3-mini', name: 'Text-only model' }], credential: {
      type: 'oauth', access: 'offline-image-access', refresh: 'offline-image-refresh',
      expires: Date.now() + 3_600_000, clientId: 'oaiapp_offline_images', idToken: 'offline-id-token',
      scopes: [...SIWC_SCOPES], issuer: 'https://auth.openai.com', subject: 'offline-image-subject',
      hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    },
  } }))
  const subscription = await context.plugin(plugin)
  cleanup.push(() => subscription.dispose())
  const requests: Array<Record<string, any>> = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.openai.com/v1/responses', 'no upload or other API may be called')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer offline-image-access')
    requests.push(JSON.parse(String(init?.body)))
    const item = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Offline image response', annotations: [] }] }
    const events = [
      { type: 'response.created', response: { id: `resp_${requests.length}` } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Offline image response' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `resp_${requests.length}`, status: 'completed', output: [item],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  })
  return { context, root, requests }
}
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

imageTest('plugin apply sends an admitted PNG through native PiAiAdapter to Responses input_image', async t => {
  const { context, requests } = await fixture(t)
  const content = await context.attachments.admitPromptContent([
    { type: 'text', text: 'Before image' },
    { type: 'image', mediaType: 'image/png', data: PNG.toString('base64'), name: '截图 🧪.png' },
    { type: 'text', text: 'After image' },
  ])
  const chunks = await collect(context.llm.stream({ provider: PROVIDER_ID, model: MODEL.id,
    messages: [{ role: 'user', content }] }))
  assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop', JSON.stringify(chunks))
  assert.equal(requests.length, 1)
  const body = requests[0]!
  assert.equal(body.model, 'gpt-6.1-sol')
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.equal(body.previous_response_id, undefined)
  assert.deepEqual(body.tools, [{ type: 'web_search' }], 'native search coexists with admitted image input')
  assert.deepEqual(body.input[0].content.map((part: { type: string }) => part.type),
    ['input_text', 'input_text', 'input_image', 'input_text'])
  assert.equal(body.input[0].content[0].text, 'Before image')
  assert.match(body.input[0].content[1].text, /截图 🧪\.png/)
  assert.equal(body.input[0].content[3].text, 'After image')
  assert.deepEqual(body.input[0].content[2], {
    type: 'input_image', detail: 'auto', image_url: `data:image/png;base64,${PNG.toString('base64')}`,
  })
  const model = (await context.llm.listModels(PROVIDER_ID)).find(model => model.id === MODEL.id)
  assert.deepEqual(model?.inputModalities, ['text', 'image'])
})

imageTest('durable user images replay through a fresh plugin context with text and image order intact', async t => {
  const first = await fixture(t)
  const content = await first.context.attachments.admitPromptContent([
    { type: 'image', mediaType: 'image/png', data: PNG.toString('base64'), name: 'first.png' },
    { type: 'text', text: 'Between images' },
    { type: 'image', mediaType: 'image/png', data: PNG.toString('base64'), name: 'second.png' },
  ])
  const options: GenerateOptions = { provider: PROVIDER_ID, model: MODEL.id, messages: [{ role: 'user', content }] }
  const chunks = await collect(first.context.llm.stream(options))
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.equal(finish?.reason.kind, 'stop')
  assert.ok(finish?.replayState)
  const blocks = chunks.filter((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end')
    .map(chunk => chunk.block)
  // Restore serialized durable messages into a new attachment store and adapter; no in-memory image cache is shared.
  const history = JSON.parse(JSON.stringify([
    ...options.messages,
    { role: 'assistant', id: MessageId('offline-image-assistant'), content: blocks,
      source: { kind: 'model', provider: PROVIDER_ID, model: MODEL.id, replayState: finish.replayState } },
    { role: 'user', content: [{ type: 'text', text: 'Compare the same images' }] },
  ])) as GenerateOptions['messages']
  const restored = await fixture(t, { root: first.root })
  const replay = await collect(restored.context.llm.stream({ ...options, messages: history }))
  assert.equal(replay.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
  const body = restored.requests[0]!
  assert.deepEqual(body.input[0], first.requests[0]!.input[0])
  assert.deepEqual(body.input[0].content.map((part: { type: string }) => part.type),
    ['input_text', 'input_image', 'input_text', 'input_text', 'input_image'])
  assert.match(body.input[0].content[0].text, /first\.png/)
  assert.match(body.input[0].content[3].text, /second\.png/)
  assert.equal(body.input.find((item: { role?: string }) => item.role === 'assistant').id, 'msg_1')
  assert.equal(body.previous_response_id, undefined)
})

imageTest('tool-result images use input_image without losing the local call ID or namespace', async t => {
  const { context, requests } = await fixture(t)
  const [attachment] = await context.attachments.saveImages([{ data: PNG, mediaType: 'image/png', name: 'tool.png' }])
  assert.ok(attachment)
  const callId = ToolCallId('call_image|fc_image')
  const transport = globalThis.fetch
  let first = true
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const response = await transport(input, init) // Retain the fixture's actual wire assertions/capture.
    if (!first) return response
    first = false
    const call = { type: 'function_call', id: 'fc_image', call_id: 'call_image', name: 'read_image', namespace: 'dsh', arguments: '{}' }
    return new Response([
      { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
      { type: 'response.output_item.done', output_index: 0, item: call },
      { type: 'response.completed', response: { id: 'resp_image_call', status: 'completed', output: [call] } },
    ].map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
  })
  const options: GenerateOptions = { provider: PROVIDER_ID, model: MODEL.id,
    tools: [{ name: 'read_image', description: 'Read fixture image', parameters: { type: 'object' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Read image' }] }] }
  // Generate identity through the real plugin/SSE path instead of inventing a
  // namespace-less historical call that the adapter must now safely refuse.
  const initial = await collect(context.llm.stream(options))
  const finish = initial.find(chunk => chunk.type === 'finish')
  assert.equal(finish?.reason.kind, 'tool-calls')
  assert.ok(finish?.replayState)
  const content = initial.flatMap(chunk => chunk.type === 'block-end' ? [chunk.block] : [])
  const historical = JSON.parse(JSON.stringify({ role: 'assistant', id: MessageId('tool-image-call'), content,
    source: { kind: 'model', provider: PROVIDER_ID, model: MODEL.id, replayState: finish.replayState } }))
  const chunks = await collect(context.llm.stream({ ...options, messages: [
    ...options.messages, historical,
    { role: 'tool', id: MessageId('tool-image-result'), toolCallId: callId, source: { kind: 'tool', callId },
      content: [{ type: 'text', text: 'Tool image' }, { type: 'image', attachment }] },
  ] }))
  assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop', JSON.stringify(chunks))
  assert.equal(requests.length, 2)
  const call = requests[1]!.input.find((item: { type: string }) => item.type === 'function_call')
  const result = requests[1]!.input.find((item: { type: string }) => item.type === 'function_call_output')
  assert.equal(call.namespace, 'dsh')
  assert.equal(result.call_id, call.call_id)
  assert.match(result.output[0].text, /Tool image/)
  assert.deepEqual(result.output[1], { type: 'input_image', detail: 'auto', image_url: `data:image/png;base64,${PNG.toString('base64')}` })
})

imageTest('text-only models keep the host omission policy and never send image bytes', async t => {
  const { context, requests } = await fixture(t)
  const content = await context.attachments.admitPromptContent([
    { type: 'text', text: 'Explain' }, { type: 'image', mediaType: 'image/png', data: PNG.toString('base64') },
  ])
  const model = (await context.llm.listModels(PROVIDER_ID)).find(model => model.id === 'o3-mini')
  assert.deepEqual(model?.inputModalities, ['text'])
  const chunks = await collect(context.llm.stream({ provider: PROVIDER_ID, model: 'o3-mini', messages: [{ role: 'user', content }] }))
  assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
  assert.match(requests[0]!.input[0].content[0].text, /image omitted because this model accepts text only/)
  assert.equal(JSON.stringify(requests).includes('input_image'), false)
  assert.equal(JSON.stringify(requests).includes(PNG.toString('base64')), false)
})

imageTest('native admission rejects a MIME mismatch and oversized bytes before Responses dispatch', async t => {
  const { context, requests } = await fixture(t, { maxImageBytes: PNG.length })
  const failure = (code: string) => (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error)
    assert.equal(error.code, code)
    return true
  }
  await assert.rejects(context.attachments.saveImages([{ data: PNG, mediaType: 'image/jpeg' }]), failure('IMAGE_TYPE_MISMATCH'))
  await assert.rejects(context.attachments.saveImages([{ data: Buffer.concat([PNG, Buffer.from([0])]), mediaType: 'image/png' }]),
    failure('IMAGE_TOO_LARGE'))
  assert.equal(requests.length, 0)
})

imageTest('missing durable service and cancelled image requests fail without sending bytes', async t => {
  const source = await fixture(t)
  const [attachment] = await source.context.attachments.saveImages([{ data: PNG, mediaType: 'image/png' }])
  assert.ok(attachment)
  const { context, requests } = await fixture(t, { attachments: false })
  const options: GenerateOptions = { provider: PROVIDER_ID, model: MODEL.id,
    messages: [{ role: 'user', content: [{ type: 'image', attachment }] }] }
  const chunks = await collect(context.llm.stream(options))
  const reason = chunks.find(chunk => chunk.type === 'finish')?.reason
  assert.equal(reason?.kind, 'error')
  assert.ok(reason?.kind === 'error')
  assert.equal(reason.failure.code, 'UNSUPPORTED_CONTENT')
  assert.match(reason.failure.message, /durable attachment service/)
  assert.equal(requests.length, 0)
  const abort = new AbortController()
  abort.abort()
  const cancelled = await collect(source.context.llm.stream({ ...options, signal: abort.signal }))
  assert.equal(cancelled.find(chunk => chunk.type === 'finish')?.reason.kind, 'aborted')
  assert.equal(source.requests.length, 0)
})

imageTest('host request sizing and explicit offload remain authoritative', async t => {
  const { context, requests } = await fixture(t)
  const [attachment] = await context.attachments.saveImages([{ data: PNG, mediaType: 'image/png', name: 'offloaded.png' }])
  assert.ok(attachment)
  assert.deepEqual(context.llm.imageRequestTarget(PROVIDER_ID, MODEL.id, attachment), { width: 1, height: 1, maxBytes: 1_048_576 })
  assert.deepEqual(context.llm.imageRequestTarget(PROVIDER_ID, MODEL.id, { ...attachment, width: 4096, height: 4096 }),
    { width: 2048, height: 2048, maxBytes: 1_048_576 })
  const chunks = await collect(context.llm.stream({ provider: PROVIDER_ID, model: MODEL.id,
    messages: [{ role: 'user', content: [{ type: 'image', attachment, offloaded: true }] }] }))
  assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
  assert.equal(JSON.stringify(requests).includes('input_image'), false)
  assert.match(requests[0]!.input[0].content[0].text, /offloaded/)
})
