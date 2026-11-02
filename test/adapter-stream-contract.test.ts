import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import * as pinnedSdk from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, PreparedAdapterCall, ReplayEnvelope, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { PROVIDER_ID } from '../src/catalog.js'
import { NativeSearchCapture, nativeSearchScope } from '../src/native-search.js'
import { SubscriptionAdapter } from '../src/subscription-adapter.js'

type Sdk = Pick<typeof pinnedSdk, 'AssistantStreamAccumulator' | 'expandAssistantStream' | 'BlockAssembler'>
type Entry = 'stream' | 'prepared'
const contracts: [string, Sdk][] = [['pinned SDK', pinnedSdk]]
// Explicit opt-in, not a skip: an invalid host path or missing API fails this file.
if (process.env.DSH_STREAM_TEST_HOST) {
  const requireHost = createRequire(join(process.env.DSH_STREAM_TEST_HOST, 'package.json'))
  const host = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-llm')).href) as Sdk
  for (const key of ['AssistantStreamAccumulator', 'expandAssistantStream', 'BlockAssembler'] as const) {
    assert.equal(typeof host[key], 'function', 'actual host must provide ' + key)
  }
  contracts.push(['actual host', host])
}
const MODEL: PreparedAdapterCall['model'] = { provider: PROVIDER_ID, id: 'gpt-5.4', name: 'GPT 5.4' }
const options = (signal?: AbortSignal): GenerateOptions => ({
  provider: PROVIDER_ID, model: MODEL.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'Offline stream contract' }] }],
  ...(signal ? { signal } : {}),
})
const text = (): StreamChunk[] => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Partial ' },
  { type: 'text-delta', index: 0, text: 'answer' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'Partial answer' } },
]
const usage: StreamChunk = { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }
const replay = (): ReplayEnvelope => ({
  response: { kind: 'pi-ai', version: 2, api: 'openai-responses', provider: PROVIDER_ID, model: MODEL.id, stopReason: 'stop' },
  blocks: [{ type: 'text' }],
})
const terminal = (reason: FinishReason, state?: ReplayEnvelope): StreamChunk => ({
  type: 'finish', reason, ...(state === undefined ? {} : { replayState: state }),
})

// Only iteration/control-flow boundaries are synthetic. Pi conversion, HTTP and
// qualified tool dispatch are exercised in the existing integration test files.
function fixture(chunks: StreamChunk[], config: { throwAt?: number; error?: Error } = {}) {
  const trace: { phase: string; capture: NativeSearchCapture | undefined }[] = []
  let prepared = 0
  const mark = (phase: string) => { trace.push({ phase, capture: nativeSearchScope.getStore() }) }
  const inner: Pick<PiAiAdapter, 'prepareCall'> = {
    async prepareCall(): Promise<PreparedAdapterCall> {
      prepared++
      return { model: MODEL, stream: () => ({
        [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
          mark('iterator')
          // Pi's real prepared stream is an async generator: its finally also
          // runs on next() rejection and EOF, independently of return().
          const source = (async function* () {
            try {
              for (let index = 0; index <= chunks.length; index++) {
                mark('next')
                await Promise.resolve()
                mark('resume')
                const capture = nativeSearchScope.getStore()
                assert.ok(capture, 'inner next must run in this request capture')
                capture.usageKnown = true
                if (index === config.throwAt) throw config.error
                if (index === chunks.length) return
                yield chunks[index]!
              }
            } finally {
              mark('cleanup')
              await Promise.resolve()
              mark('cleanup-resume')
            }
          })()
          return {
            next: () => source.next(),
            async return() { mark('return'); return source.return() },
          }
        },
      }) }
    },
  }
  // Deliberately restrict the fake to the public prepared-call boundary.
  const adapter = new SubscriptionAdapter(inner as PiAiAdapter)
  return { adapter, trace, prepared: () => prepared }
}
async function open(adapter: SubscriptionAdapter, entry: Entry, request = options()) {
  return entry === 'stream' ? adapter.stream(request)
    : (await adapter.prepareCall(request.provider, request.model, request.signal)).stream(request)
}
function recording(sdk: Sdk) {
  const accumulator = new sdk.AssistantStreamAccumulator()
  const live = new sdk.BlockAssembler()
  const raw: { time: number; chunk: StreamChunk }[] = []
  return {
    raw, live,
    push(chunk: StreamChunk) {
      const timed = { time: 100 + raw.length * 3, chunk }
      // Match the host call-site: validate the original object BEFORE assembly,
      // snapshotting or any JSON serialization can erase own undefined values.
      const accepted = accumulator.push(timed)
      live.push(accepted.chunk)
      raw.push(timed)
    },
    check() {
      const expanded = sdk.expandAssistantStream(accumulator.snapshot())
      assert.deepEqual(expanded, raw, 'durable expansion preserves exact chunks and timestamps')
      const durable = new sdk.BlockAssembler()
      for (const event of expanded) durable.push(event.chunk)
      assert.deepEqual(durable.blocks(), live.blocks())
      assert.deepEqual(durable.finish, live.finish)
      assert.deepEqual(durable.usage, live.usage)
      assert.deepEqual(durable.replayState, live.replayState)
      return durable
    },
  }
}
async function collect(sdk: Sdk, stream: AsyncIterable<StreamChunk>, onChunk?: (chunk: StreamChunk) => void) {
  const result = recording(sdk)
  for await (const chunk of stream) { result.push(chunk); onChunk?.(chunk) }
  result.check()
  return result
}
function closed(f: ReturnType<typeof fixture>, count = 1) {
  assert.equal(f.trace.filter(event => event.phase === 'return').length, count, 'close unless exhausted or the stream delegate already failed')
  assert.equal(f.trace.filter(event => event.phase === 'cleanup').length, 1, 'inner resources must settle exactly once')
  assert.equal(f.trace.filter(event => event.phase === 'cleanup-resume').length, 1)
  const capture = f.trace[0]?.capture
  assert.ok(capture)
  assert.ok(f.trace.every(event => event.capture === capture), 'construction, next, async resumption and cleanup share one capture')
  assert.equal(nativeSearchScope.getStore(), undefined, 'request capture must not leak to its consumer')
  assert.equal(f.prepared(), 1)
  return capture
}
function finishOf(result: ReturnType<typeof recording>) {
  const finishes = result.raw.map(event => event.chunk).filter(chunk => chunk.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.equal(result.raw.at(-1)?.chunk, finishes[0])
  return finishes[0]!
}

for (const [host, sdk] of contracts) for (const entry of ['stream', 'prepared'] as const) {
  const label = host + ' / ' + entry + ': '
  for (const reason of [
    { kind: 'stop' }, { kind: 'tool-calls' }, { kind: 'max-tokens' },
    { kind: 'error', failure: { code: 'PI_AI_ERROR', message: 'Synthetic transport failure' } },
  ] satisfies FinishReason[]) test(label + 'raw no-replay ' + reason.kind + ' survives durable round-trip', async () => {
    const f = fixture([...text(), usage, terminal(reason)])
    const result = await collect(sdk, await open(f.adapter, entry))
    const finish = finishOf(result)
    assert.deepEqual(finish.reason, reason)
    assert.equal(Object.hasOwn(finish, 'replayState'), false)
    assert.deepEqual(result.live.blocks(), [{ type: 'text', text: 'Partial answer' }])
    assert.deepEqual(result.live.usage, usage.usage)
    closed(f)
  })
  for (const reason of [
    { kind: 'error', failure: { code: 'PI_AI_ERROR', message: 'Synthetic failure' } },
    { kind: 'aborted', failure: { code: 'ABORTED', message: 'Cancelled' } }, { kind: 'max-tokens' },
  ] satisfies FinishReason[]) test(label + reason.kind + ' drops stale success replay before raw persistence', async () => {
    const f = fixture([...text(), terminal(reason, replay())])
    const result = await collect(sdk, await open(f.adapter, entry))
    assert.equal(finishOf(result).reason.kind, reason.kind)
    assert.equal(Object.hasOwn(finishOf(result), 'replayState'), false)
    assert.equal(result.live.replayState, undefined)
    closed(f)
  })
  test(label + 'successful valid Pi replay remains durable and aligned', async () => {
    const state = replay()
    const f = fixture([...text(), terminal({ kind: 'stop' }, state)])
    const result = await collect(sdk, await open(f.adapter, entry))
    const finish = finishOf(result)
    assert.ok(finish.replayState)
    assert.deepEqual(finish.replayState.blocks, state.blocks)
    const { subscriptionReplay: _binding, ...response } = finish.replayState.response as Record<string, unknown>
    assert.deepEqual(response, state.response, 'all original Pi response fields survive')
    assert.deepEqual(result.live.replayState, finish.replayState)
    assert.deepEqual(state, replay(), 'wrapper must not mutate inner replay')
    closed(f)
  })
  test(label + 'malformed nested undefined is rejected, never JSON-cleaned into success', async () => {
    // This deliberately invalid raw reason is not a provider-wire fixture.
    const reason = { kind: 'stop', diagnostic: { nested: undefined } } as unknown as FinishReason
    const f = fixture([...text(), terminal(reason)])
    await assert.rejects(collect(sdk, await open(f.adapter, entry)), {
      name: 'TypeError', message: 'Assistant stream chunk must be losslessly JSON-serializable',
    })
    closed(f)
  })
  test(label + 'consumer return closes inner in its own capture, not caller capture', async () => {
    const f = fixture([...text(), terminal({ kind: 'stop' })])
    const iterator = (await open(f.adapter, entry))[Symbol.asyncIterator]()
    const result = recording(sdk)
    const first = await iterator.next()
    assert.equal(first.done, false)
    result.push(first.value!)
    const foreign = new NativeSearchCapture(true)
    await nativeSearchScope.run(foreign, async () => {
      await iterator.return?.()
      assert.equal(nativeSearchScope.getStore(), foreign)
    })
    const capture = closed(f)
    assert.notEqual(capture, foreign)
    result.check()
    assert.equal(result.raw.some(event => event.chunk.type === 'finish'), false)
  })
  test(label + 'consumer break invokes cleanup exactly once without terminal fabrication', async () => {
    const f = fixture([...text(), terminal({ kind: 'stop' })])
    const result = recording(sdk)
    for await (const chunk of await open(f.adapter, entry)) { result.push(chunk); break }
    result.check()
    assert.equal(result.raw.length, 1)
    closed(f)
  })
  test(label + 'inner next throw preserves error and flushes buffered text before cleanup', async () => {
    const error = new Error('Synthetic inner next failure')
    const f = fixture([...text(), usage], { throwAt: 5, error })
    const result = recording(sdk)
    await assert.rejects((async () => {
      for await (const chunk of await open(f.adapter, entry)) result.push(chunk)
    })(), caught => caught === error)
    result.check()
    assert.deepEqual(result.live.blocks(), [{ type: 'text', text: 'Partial answer' }])
    assert.deepEqual(result.live.usage, usage.usage)
    assert.equal(result.raw.some(event => event.chunk.type === 'finish'), false)
    // yield* in stream() has already closed its failed delegate; prepared has
    // no extra generator layer. In either case the resource finally ran once.
    closed(f, entry === 'stream' ? 0 : 1)
  })
  test(label + 'EOF flushes buffered text and usage but does not invent a terminal or double-close', async () => {
    const f = fixture([...text(), usage])
    const result = await collect(sdk, await open(f.adapter, entry))
    assert.equal(result.raw.some(event => event.chunk.type === 'finish'), false)
    assert.deepEqual(result.live.blocks(), [{ type: 'text', text: 'Partial answer' }])
    assert.deepEqual(result.live.usage, usage.usage)
    closed(f, 0)
  })
  test(label + 'return before first next never starts inner stream', async () => {
    const f = fixture([terminal({ kind: 'stop' })])
    const iterator = (await open(f.adapter, entry))[Symbol.asyncIterator]()
    await iterator.return?.()
    assert.equal(f.prepared(), 1)
    assert.deepEqual(f.trace, [])
    assert.equal(nativeSearchScope.getStore(), undefined)
  })
  test(label + 'interleaved requests keep next and foreign-scope cleanup isolated', async () => {
    const a = fixture([...text(), terminal({ kind: 'stop' })])
    const b = fixture([...text(), terminal({ kind: 'stop' })])
    const ai = (await open(a.adapter, entry))[Symbol.asyncIterator]()
    const bi = (await open(b.adapter, entry))[Symbol.asyncIterator]()
    const ar = recording(sdk), br = recording(sdk)
    for (let turn = 0; turn < 2; turn++) {
      const [av, bv] = await Promise.all([ai.next(), bi.next()])
      assert.equal(av.done, false); assert.equal(bv.done, false)
      ar.push(av.value!); br.push(bv.value!)
    }
    const foreign = new NativeSearchCapture(true)
    await nativeSearchScope.run(foreign, () => Promise.all([ai.return?.(), bi.return?.()]))
    const ac = closed(a), bc = closed(b)
    assert.notEqual(ac, bc); assert.notEqual(ac, foreign); assert.notEqual(bc, foreign)
    ar.check(); br.check()
  })
  for (const when of ['before-next', 'delta', 'buffered-close', 'usage'] as const) {
    test(label + 'abort at ' + when + ' cannot persist buffered success replay', async () => {
      const controller = new AbortController()
      const f = fixture([...text(), usage, terminal({ kind: 'stop' }, replay())])
      const stream = await open(f.adapter, entry, options(controller.signal))
      if (when === 'before-next') controller.abort()
      const result = await collect(sdk, stream, chunk => {
        if ((when === 'delta' && chunk.type === 'text-delta')
          || (when === 'buffered-close' && chunk.type === 'block-end')
          || (when === 'usage' && chunk.type === 'usage')) controller.abort()
      })
      const finish = finishOf(result)
      assert.equal(finish.reason.kind, 'aborted')
      assert.equal(finish.reason.failure?.code, 'ABORTED')
      assert.equal(Object.hasOwn(finish, 'replayState'), false)
      assert.equal(result.live.replayState, undefined)
      closed(f)
    })
  }
}
