import { createHash, randomUUID } from 'node:crypto'
import type { ContentBlock, GenerateOptions, ReplayEnvelope, RequestMessage } from '@deepseek-ai/dsh-llm'
import { PROVIDER_ID } from './catalog.js'
import { record } from './response-policy.js'
import { textMessageId } from './native-search.js'
import { CapabilityError, resolveToolIdentity } from './provider.js'
import type { QualifiedToolIdentity } from './provider.js'

const KIND = 'chatgpt-subscription-native'
const TYPES = ['message', 'reasoning', 'function_call', 'custom_tool_call', 'web_search_call']

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => [key, canonical(value[key])]))
  return value
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
interface NativeResponse {
  kind: typeof KIND
  version: 1
  provider: string
  model: string
  output: Record<string, unknown>[]
  piResponse: Record<string, unknown>
  contentFingerprint: string
  blockCount: number
  stateFingerprint: string
}
export interface ReplayToolIdentity extends QualifiedToolIdentity { id: string }

export interface NativeReplayPlan {
  start: string
  end: string
  output: Record<string, unknown>[]
}

/** Reject native replay whenever durable content, block alignment, route or metadata changed. */
function readNative(message: Extract<RequestMessage, { role: 'assistant' }>, options: GenerateOptions, identityOnly = false):
  { response: NativeResponse; blocks: Record<string, unknown>[] } | undefined {
  try {
    const state = message.source.replayState
    if (!record(state) || !record(state.response) || !Array.isArray(state.blocks) || !state.blocks.every(record)) return undefined
    const response = state.response
    if (response.kind !== KIND || response.version !== 1 || response.provider !== PROVIDER_ID
      || (!identityOnly && (response.provider !== message.source.provider || response.provider !== options.provider
        || response.model !== message.source.model || response.model !== options.model
        || response.blockCount !== message.content.length || state.blocks.length !== message.content.length
        || response.contentFingerprint !== fingerprint(message.content)))
      || !Array.isArray(response.output) || !response.output.every(item => record(item) && TYPES.includes(String(item.type)))
      || !record(response.piResponse) || response.piResponse.kind !== 'pi-ai' || response.piResponse.version !== 2
      || response.piResponse.api !== 'openai-responses' || response.piResponse.provider !== response.provider
      || response.piResponse.model !== response.model || !['stop', 'toolUse'].includes(String(response.piResponse.stopReason))) return undefined
    if (!identityOnly && state.blocks.some((block, index) => block.type !== message.content[index]?.type)) return undefined
    const { stateFingerprint, ...unsigned } = response
    if (stateFingerprint !== fingerprint({ response: unsigned, blocks: state.blocks })) return undefined
    return { response: response as unknown as NativeResponse, blocks: state.blocks }
  } catch { return undefined }
}

/** Per-call metadata survives unrelated edits/pruning. Hashes detect corruption, not an untrusted writer. */
function readToolIdentity(value: unknown, block: Extract<ContentBlock, { type: 'tool-call' }>): QualifiedToolIdentity | undefined {
  if (!record(value) || value.kind !== 'chatgpt-subscription-tool' || value.version !== 1
    || value.id !== block.id || value.name !== block.name) return undefined
  const { fingerprint: checksum, ...identity } = value
  if (checksum !== fingerprint(identity) || typeof value.namespace !== 'string'
    || (value.type !== 'function' && value.type !== 'custom')) return undefined
  return resolveToolIdentity([{ name: block.name, namespace: value.namespace, type: value.type }], { name: block.name })
}

/** Preserve identity even when full native replay is unavailable; never store old arguments here. */
export function toolIdentityReplay(output: Record<string, unknown>[] | undefined, pi: ReplayEnvelope | undefined,
  content: readonly ContentBlock[]): ReplayEnvelope | undefined {
  if (!pi?.blocks || pi.blocks.length !== content.length) return pi
  const blocks = pi.blocks.map((metadata, index) => {
    const block = content[index]
    if (!record(metadata) || block?.type !== 'tool-call') return metadata
    const calls = output?.filter(item => (item.type === 'function_call' || item.type === 'custom_tool_call')
      && `${item.call_id}|${item.id}` === block.id && item.name === block.name)
    const call = calls?.length === 1 ? calls[0] : undefined
    if (!call || typeof call.namespace !== 'string' || !call.namespace.trim()) return metadata
    const identity = { kind: 'chatgpt-subscription-tool', version: 1, id: block.id, name: block.name,
      namespace: call.namespace, type: call.type === 'custom_tool_call' ? 'custom' : 'function' }
    return { ...metadata, toolIdentity: { ...identity, fingerprint: fingerprint(identity) } }
  })
  if (!record(pi.response)) return { ...pi, blocks }
  const contentFingerprint = fingerprint(content)
  return { response: { ...pi.response, subscriptionReplay: { version: 1, contentFingerprint,
    stateFingerprint: fingerprint({ response: pi.response, blocks, contentFingerprint }) } }, blocks }
}

/** Preserve old Pi envelopes. New invalid envelopes degrade to the current visible blocks, not stale raw output. */
export function prepareNativeHistory(options: GenerateOptions, plans: NativeReplayPlan[], tools: ReplayToolIdentity[] = []): GenerateOptions {
  const visibleCalls = new Set<string>()
  const wireIds = new Set<string>()
  return { ...options, messages: options.messages.map(message => {
    if (message.role === 'tool' && !visibleCalls.has(message.toolCallId)) {
      throw new CapabilityError('The historical ChatGPT tool result identity has no matching visible call.')
    }
    if (message.role !== 'assistant') return message
    const rawState = message.source.replayState
    const trusted = readNative(message, options, true)
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      const id = String(block.id).split('|')[0]!
      if (wireIds.has(id)) throw new CapabilityError('The historical ChatGPT tool call identity is ambiguous because its call id is duplicated.')
      wireIds.add(id)
      visibleCalls.add(block.id)
      const call = trusted?.response.output.find(item => `${item.call_id}|${item.id}` === block.id && item.name === block.name)
      const saved = (record(rawState) && Array.isArray(rawState.blocks) ? rawState.blocks : []).flatMap((metadata: unknown) => {
        const identity = record(metadata) ? readToolIdentity(metadata.toolIdentity, block) : undefined
        return identity ? [identity] : []
      }) ?? []
      if (call && typeof call.namespace === 'string' && ['function_call', 'custom_tool_call'].includes(String(call.type))) {
        saved.push({ name: block.name, namespace: call.namespace, type: call.type === 'custom_tool_call' ? 'custom' : 'function' })
      }
      if (!saved.length) throw new CapabilityError('The historical ChatGPT tool identity cannot be recovered safely; restore its original identity metadata.')
      const identity = resolveToolIdentity(saved, { name: block.name })
      tools.push({ ...identity, id })
    }
    if (!record(rawState) || !record(rawState.response)) return message
    if (rawState.response.kind === 'pi-ai') {
      const { subscriptionReplay, ...response } = rawState.response
      // Legacy Pi text envelopes remain compatible. Our envelopes additionally
      // bind signatures to the complete visible content and the original route.
      if (subscriptionReplay === undefined && response.provider === message.source.provider && response.provider === options.provider
        && response.model === message.source.model && response.model === options.model && Array.isArray(rawState.blocks)
        && !rawState.blocks.some(block => record(block) && block.toolIdentity !== undefined)) {
        // Legacy Pi has no whole-turn content binding. Keep harmless text IDs,
        // but never restore opaque reasoning that could contain edited/deleted context.
        return { ...message, source: { ...message.source, replayState: { response: rawState.response,
          blocks: rawState.blocks.map(block => record(block) && block.type === 'reasoning' ? { type: 'reasoning' } : block) } } }
      }
      if (record(subscriptionReplay) && subscriptionReplay.version === 1
        && response.provider === message.source.provider && response.provider === options.provider
        && response.model === message.source.model && response.model === options.model
        && subscriptionReplay.contentFingerprint === fingerprint(message.content)
        && subscriptionReplay.stateFingerprint === fingerprint({ response, blocks: rawState.blocks,
          contentFingerprint: subscriptionReplay.contentFingerprint })) return message
      return { ...message, source: { ...message.source, replayState: undefined } }
    }
    const state = readNative(message, options)
    if (!state) return { ...message, source: { ...message.source, replayState: undefined } }
    const start = `msg_dsh_start_${randomUUID().replaceAll('-', '')}`
    const end = `msg_dsh_end_${randomUUID().replaceAll('-', '')}`
    plans.push({ start, end, output: state.response.output })
    // Temporary signed text boundaries delegate ALL actual conversion to Pi, including
    // tool result correlation and images. They are removed by the final onPayload hook.
    const marker = { type: 'text' as const, text: '' }
    return { ...message, content: [marker, ...message.content, marker], source: { ...message.source, replayState: {
      response: state.response.piResponse,
      blocks: [{ type: 'text', textSignature: start }, ...state.blocks, { type: 'text', textSignature: end }],
    } } }
  }) }
}

/** Exact per-message spans; never match by text, output_index, or the first assistant item. */
export function restoreNativePayload(value: unknown, plans: readonly NativeReplayPlan[]): unknown {
  if (!plans.length) return value
  if (!record(value) || !Array.isArray(value.input)) throw new Error('Native replay boundaries are unavailable.')
  let input: unknown[] = [...value.input]
  let previousEnd = -1
  const spans = plans.map(plan => {
    const starts = input.flatMap((item, index) => record(item) && item.type === 'message' && item.id === plan.start ? [index] : [])
    const ends = input.flatMap((item, index) => record(item) && item.type === 'message' && item.id === plan.end ? [index] : [])
    const start = starts[0]
    const end = ends[0]
    if (starts.length !== 1 || ends.length !== 1 || start === undefined || end === undefined
      || start <= previousEnd || end <= start) throw new Error('Native replay boundaries are inconsistent.')
    previousEnd = end
    return { start, end, output: plan.output }
  })
  for (const span of spans.reverse()) input.splice(span.start, span.end - span.start + 1, ...structuredClone(span.output))
  // Pi's current schema can project a historical custom result as function output.
  // Correct ONLY results of the actual preceding raw custom call, by its call_id.
  const calls = new Map<string, unknown>()
  input = input.map(item => {
    if (!record(item)) return item
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && typeof item.call_id === 'string') {
      calls.set(item.call_id, item.type)
    }
    if (item.type === 'function_call_output' && typeof item.call_id === 'string' && calls.get(item.call_id) === 'custom_tool_call') {
      return { ...item, type: 'custom_tool_call_output' }
    }
    return item
  })
  return { ...value, input }
}

/** Repair only identity/type lost by Pi; payload arguments and results remain current. */
export function restoreToolIdentityPayload(value: unknown, tools: readonly ReplayToolIdentity[]): unknown {
  if (!record(value) || !Array.isArray(value.input)) return value
  const calls = new Map<string, QualifiedToolIdentity>()
  return { ...value, input: value.input.map(item => {
    if (!record(item)) return item
    if ((item.type === 'function_call' || item.type === 'custom_tool_call') && typeof item.call_id === 'string') {
      const identities = tools.filter(tool => tool.id === item.call_id)
      if (identities.length) {
        const identity = resolveToolIdentity(identities, { name: item.name })
        calls.set(item.call_id, identity)
        if (identity.type === 'custom') {
          let input = item.input
          if (item.type === 'function_call') {
            try { input = JSON.parse(String(item.arguments)).input } catch { /* reject below */ }
          }
          if (typeof input !== 'string') throw new CapabilityError('The historical ChatGPT custom tool input is not recoverable from visible content.')
          const { arguments: _arguments, ...rest } = item
          return { ...rest, type: 'custom_tool_call', namespace: identity.namespace, input }
        }
        return { ...item, type: 'function_call', namespace: identity.namespace }
      }
    }
    if ((item.type === 'function_call_output' || item.type === 'custom_tool_call_output') && typeof item.call_id === 'string') {
      const identity = calls.get(item.call_id)
      if (identity) return { ...item, type: identity.type === 'custom' ? 'custom_tool_call_output' : 'function_call_output' }
    }
    return item
  }) }
}

/** Do not save terminal-only content Pi never emitted: hidden replay must match the complete visible turn. */
function rawMatches(output: Record<string, unknown>[], content: readonly ContentBlock[], blocks: readonly unknown[]): boolean {
  const visible = output.filter(item => item.type !== 'web_search_call')
  if (visible.length !== content.length || blocks.length !== content.length) return false
  const used = new Set<Record<string, unknown>>()
  for (const [index, block] of content.entries()) {
    const metadata = blocks[index]
    let item: Record<string, unknown> | undefined
    if (block.type === 'text') {
      const id = textMessageId(metadata)
      const found = visible.filter(item => item.type === 'message' && item.id === id)
      if (found.length !== 1) return false
      item = found[0]!
      if (!Array.isArray(item.content) || item.content.map(part => record(part)
        ? part.type === 'output_text' ? part.text : part.refusal : '').join('') !== block.text) return false
    } else if (block.type === 'reasoning') {
      if (!record(metadata) || typeof metadata.thinkingSignature !== 'string') return false
      let signature: unknown
      try { signature = JSON.parse(metadata.thinkingSignature) } catch { return false }
      if (!record(signature)) return false
      const found = visible.filter(item => item.type === 'reasoning' && item.id === signature.id)
      if (found.length !== 1) return false
      item = found[0]!
      // Reasoning can be terminal-backfilled by Pi, but not otherwise changed behind the durable block.
      if (fingerprint(item) !== fingerprint(signature)) return false
    } else if (block.type === 'tool-call') {
      const [callId, itemId] = String(block.id).split('|')
      const found = visible.filter(item => (item.type === 'function_call' || item.type === 'custom_tool_call')
        && item.call_id === callId && item.id === itemId && item.name === block.name)
      if (found.length !== 1) return false
      item = found[0]!
      try {
        const args: unknown = JSON.parse(block.arguments)
        if (item.type === 'function_call') {
          if (typeof item.arguments !== 'string' || fingerprint(JSON.parse(item.arguments)) !== fingerprint(args)) return false
        } else if (!record(args) || args.input !== item.input) return false
      } catch { return false }
    } else return false
    if (used.has(item)) return false
    used.add(item)
  }
  return true
}

export function nativeReplay(output: Record<string, unknown>[] | undefined, pi: ReplayEnvelope | undefined,
  originalContent: readonly ContentBlock[], durableContent: readonly ContentBlock[], options: GenerateOptions): ReplayEnvelope | undefined {
  if (!output || !pi || !record(pi.response) || !pi.blocks || !output.every(item => TYPES.includes(String(item.type)))
    || !rawMatches(output, originalContent, pi.blocks)) return undefined
  const response = { kind: KIND, version: 1, provider: options.provider, model: options.model,
    output, piResponse: pi.response, contentFingerprint: fingerprint(durableContent), blockCount: durableContent.length }
  // JSON-normalize Pi's optional fields so persistence and a fresh adapter produce identical validation.
  return JSON.parse(JSON.stringify({ response: { ...response, stateFingerprint: fingerprint({ response, blocks: pi.blocks }) }, blocks: pi.blocks })) as ReplayEnvelope
}
