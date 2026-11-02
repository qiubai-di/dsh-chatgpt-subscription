import { isDeepStrictEqual } from 'node:util'
import { createProvider } from '@earendil-works/pi-ai'
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type {
  Api, AssistantMessage, Model, Provider, ProviderStreams, StreamOptions, TranscriptContext,
} from '@earendil-works/pi-ai'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { API_BASE_URL, PROVIDER_ID, subscriptionModelDefinitions } from './catalog.js'
import { validateSiwcCredential } from './siwc.js'
import type { SiwcModel } from './siwc.js'
import { assertSubscriptionIdentity, SubscriptionBindingError } from './dsh-store.js'
import type { SubscriptionManager, SubscriptionIdentity } from './dsh-store.js'
import { record, ResponsePolicy } from './response-policy.js'
import { SiwcError } from './siwc-error.js'
import { nativeSearchScope } from './native-search.js'
import { restoreNativePayload, restoreToolIdentityPayload } from './native-search-replay.js'

const TOOL_NAMESPACE = 'dsh'
const OMIT_FIELDS = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata',
  'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'prompt_cache_options',
  'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user',
  'previous_response_id',
] as const

export class CapabilityError extends Error {}

/** Namespace + name selects a tool; its function/custom kind must also remain paired. */
export interface QualifiedToolIdentity {
  readonly namespace: string
  readonly name: string
  readonly type: 'function' | 'custom'
}

export function qualifiedToolKey(identity: Pick<QualifiedToolIdentity, 'namespace' | 'name'>): string {
  return JSON.stringify([identity.namespace, identity.name])
}

/** Resolve only from supplied trusted declarations/identities; never assume a missing namespace is dsh. */
export function resolveToolIdentity(identities: readonly QualifiedToolIdentity[],
  selection: { name: unknown; namespace?: unknown; type?: unknown }): QualifiedToolIdentity {
  if (typeof selection.name !== 'string' || !selection.name.trim()
    || (selection.namespace !== undefined && (typeof selection.namespace !== 'string' || !selection.namespace.trim()))
    || (selection.type !== undefined && selection.type !== 'function' && selection.type !== 'custom')) {
    throw new CapabilityError('This ChatGPT subscription tool identity is not supported or is malformed.')
  }
  const unique = new Map<string, QualifiedToolIdentity>()
  for (const identity of identities) {
    const key = qualifiedToolKey(identity)
    if (unique.has(key) && unique.get(key)!.type !== identity.type) {
      throw new CapabilityError('Trusted ChatGPT subscription tool identities conflict for the same namespace and name.')
    }
    unique.set(key, identity)
  }
  const matches = new Map([...unique.values()].filter(identity => identity.name === selection.name
    && (selection.namespace === undefined || identity.namespace === selection.namespace)
    && (selection.type === undefined || identity.type === selection.type))
    .map(identity => [qualifiedToolKey(identity), identity]))
  if (matches.size > 1) throw new CapabilityError('The ChatGPT subscription tool identity is ambiguous; an explicit namespace is required.')
  if (matches.size === 0) throw new CapabilityError('The selected ChatGPT subscription tool identity is not declared.')
  return { ...matches.values().next().value! }
}

interface DeclaredTool { identity: QualifiedToolIdentity; definition: Record<string, unknown> }

function validateTool(tool: unknown, inNamespace = false): void {
  if (!record(tool)) throw new CapabilityError('ChatGPT subscription tools must be function/custom definitions or namespaces.')
  if (tool.type === 'web_search' || tool.type === 'web_search_preview') {
    throw new CapabilityError('Native web search is managed by the subscription adapter; caller-supplied hosted search is not enabled.')
  }
  if (tool.type === 'namespace' && !inNamespace) {
    if (typeof tool.name !== 'string' || !tool.name.trim() || !Array.isArray(tool.tools)) {
      throw new CapabilityError('ChatGPT subscription tool namespaces require a name and tools array.')
    }
    for (const child of tool.tools) validateTool(child, true)
    return
  }
  if (tool.type !== 'function' && tool.type !== 'custom') {
    throw new CapabilityError('This hosted or unknown tool type is not supported by the ChatGPT subscription route; only local function/custom tools are enabled.')
  }
  if (typeof tool.name !== 'string' || !tool.name.trim()) {
    throw new CapabilityError('ChatGPT subscription function/custom tools require a name.')
  }
}

/** SIWC requires a namespace for executable tools; validate late additions and named namespaces too. */
function namespaceTools(value: unknown, nativeSearch = false, declared = new Map<string, DeclaredTool>()): unknown {
  if (!Array.isArray(value)) throw new CapabilityError('ChatGPT subscription tools must be an array.')
  // Only the controlled route removes the local DSH search definition. Historical
  // calls/results are not declarations and must remain replayable.
  if (nativeSearch) value = value.flatMap(tool => {
    if (record(tool) && (tool.type === 'function' || tool.type === 'custom') && tool.name === 'web_search') return []
    if (record(tool) && tool.type === 'namespace' && tool.name === TOOL_NAMESPACE && Array.isArray(tool.tools)) {
      return [{ ...tool, tools: tool.tools.filter(child => !(record(child)
        && (child.type === 'function' || child.type === 'custom') && child.name === 'web_search')) }]
    }
    return [tool]
  })
  const tools = value as unknown[]
  for (const tool of tools) validateTool(tool)
  const flat = tools.filter((tool): tool is Record<string, unknown> => record(tool) && (tool.type === 'function' || tool.type === 'custom'))
  const groups = new Map<string, Record<string, unknown> & { tools: unknown[] }>()
  for (const tool of tools) {
    if (!record(tool) || tool.type !== 'namespace') continue
    const name = tool.name as string
    const existing = groups.get(name)
    if (!existing) groups.set(name, { ...tool, tools: [...tool.tools as unknown[]] })
    else {
      for (const [key, field] of Object.entries(tool)) {
        if (key === 'tools') continue
        if (Object.hasOwn(existing, key) && !isDeepStrictEqual(existing[key], field)) {
          throw new CapabilityError('ChatGPT subscription tool namespace metadata conflicts with an earlier declaration.')
        }
        Object.defineProperty(existing, key, { value: field, enumerable: true, writable: true, configurable: true })
      }
      existing.tools.push(...tool.tools as unknown[])
    }
  }
  if (flat.length) {
    const existing = groups.get(TOOL_NAMESPACE)
    if (existing) existing.tools.push(...flat)
    else groups.set(TOOL_NAMESPACE, { type: 'namespace', name: TOOL_NAMESPACE,
      description: 'Tools supplied by DeepSeek Harness', tools: flat })
  }
  for (const group of groups.values()) {
    const definitions = new Map<string, unknown>()
    for (const tool of group.tools as Record<string, unknown>[]) {
      const name = tool.name as string
      const identity: QualifiedToolIdentity = { namespace: group.name as string, name, type: tool.type as QualifiedToolIdentity['type'] }
      const key = qualifiedToolKey(identity)
      if (declared.has(key) && !isDeepStrictEqual(declared.get(key)!.definition, tool)) {
        throw new CapabilityError('ChatGPT subscription tool definitions conflict for the same qualified identity.')
      }
      declared.set(key, { identity, definition: tool })
      if (!definitions.has(name)) definitions.set(name, tool)
    }
    group.tools = [...definitions.values()]
  }
  return [...groups.values()]
}

/** The only wire projection layered on Pi's original Responses message/tool converter. */
export function subscriptionPayload(value: unknown, modelId: string): Record<string, unknown> {
  return projectPayload(value, modelId, false)
}

/** Native search is added here, never accepted as arbitrary caller-hosted capability. */
function projectPayload(value: unknown, modelId: string, nativeSearch: boolean, compaction = false): Record<string, unknown> {
  if (!record(value)) throw new CapabilityError('The Responses request must be an object.')
  if (Object.hasOwn(value, 'programmatic_tool_calling')) {
    throw new CapabilityError('ChatGPT subscription does not support programmatic_tool_calling requests.')
  }
  const payload: Record<string, unknown> = { ...value, model: modelId, store: false, stream: true }
  for (const field of OMIT_FIELDS) delete payload[field]
  // Validate shared identities without moving or deduplicating declarations across history boundaries.
  const declared = new Map<string, DeclaredTool>()
  if (payload.tools !== undefined) payload.tools = namespaceTools(payload.tools, nativeSearch, declared)
  if (Array.isArray(payload.input)) {
    payload.input = payload.input.map(item => {
      if (!record(item)) return item
      if (item.type === 'configuration_update') {
        throw new CapabilityError('ChatGPT subscription does not support configuration_update history items.')
      }
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        // Typed raw calls are historical provenance, not declarations. Missing
        // namespace must already have been restored from trusted per-call metadata.
        if (typeof item.namespace !== 'string' || !item.namespace.trim()) {
          throw new CapabilityError('The historical ChatGPT tool identity has no trustworthy namespace.')
        }
      }
      return {
        ...item,
        ...(item.role === 'system' ? { role: 'developer' } : {}),
        ...(item.type === 'additional_tools' ? { tools: namespaceTools(item.tools, nativeSearch, declared) } : {}),
      }
    })
  }
  // Last policy wins over caller hooks and replay, before validating the effective selector.
  if (compaction) payload.tool_choice = 'none'
  if (payload.tool_choice !== undefined
    && !(typeof payload.tool_choice === 'string' && ['auto', 'none', 'required'].includes(payload.tool_choice))) {
    const choice = payload.tool_choice
    const managedSearch = nativeSearch && record(choice) && choice.type === 'web_search'
      && Object.keys(choice).every(key => key === 'type')
    if (!managedSearch) {
      if (record(choice) && (choice.type === 'function' || choice.type === 'custom')) {
        resolveToolIdentity([...declared.values()].map(tool => tool.identity),
          { name: choice.name, namespace: choice.namespace, type: choice.type })
      }
      if (record(choice) && (choice.type === 'web_search' || choice.type === 'web_search_preview')) {
        throw new CapabilityError('Caller-supplied hosted search selection is not enabled.')
      }
      // SIWC's namespace declaration schema does not establish a forced-selector schema.
      // Until route-specific evidence exists, do not guess function/custom or allowed_tools forms.
      throw new CapabilityError('This tool_choice form is not supported by the ChatGPT subscription route; no SIWC selector contract is confirmed.')
    }
  }
  if (nativeSearch) {
    payload.tools = [...(payload.tools as unknown[] | undefined ?? []), { type: 'web_search' }]
    payload.include = [...new Set([...(Array.isArray(payload.include) ? payload.include : []),
      'reasoning.encrypted_content', 'web_search_call.action.sources'])]
  }
  return payload
}

/**
 * Pi's pinned converter recognizes OpenAI's compound call IDs by built-in provider id.
 * Bind that implementation to OpenAI internally, then restore the public DSH route on
 * emitted messages. This keeps its original IDs, reasoning and replay conversion intact.
 */
function openaiTranscript(context: TranscriptContext): TranscriptContext {
  return {
    ...context,
    messages: context.messages.map(message => message.role === 'assistant' && message.provider === PROVIDER_ID
      ? { ...message, provider: 'openai' } : message),
  }
}

function restoreRoute(message: AssistantMessage): void {
  message.provider = PROVIDER_ID
}

export interface SubscriptionBinding {
  readonly identity: SubscriptionIdentity
  readonly lifetime?: AbortSignal
}

function subscriptionStreams(manager: SubscriptionManager, binding?: SubscriptionBinding): ProviderStreams {
  const api = openAIResponsesApi()
  const dispatch = (
    mode: 'stream' | 'streamSimple',
    model: Model<Api>,
    context: TranscriptContext,
    options: StreamOptions = {},
  ): AssistantMessageEventStream => {
    const signal = binding?.lifetime === undefined ? options.signal :
      AbortSignal.any([binding.lifetime, ...(options.signal === undefined ? [] : [options.signal])])
    options = { ...options, ...(signal === undefined ? {} : { signal }) }
    const output = new AssistantMessageEventStream()
    const policy = new ResponsePolicy()
    const native = nativeSearchScope.getStore()
    let partial: AssistantMessage | undefined
    const fail = (message: AssistantMessage): void => {
      restoreRoute(message)
      policy.observeErrorText(message.errorMessage)
      policy.fail(message, options.signal?.aborted === true || message.stopReason === 'aborted')
      output.push({ type: 'error', reason: message.stopReason === 'aborted' ? 'aborted' : 'error', error: message })
      output.end()
    }
    void (async () => {
      try {
        // Every dispatch must have a preparation-time identity, including direct low-level consumers.
        if (binding === undefined) throw new SubscriptionBindingError(true)
        // Ignore request-level API keys and auth headers: only the plugin's OAuth grant is usable.
        const credential = structuredClone(validateSiwcCredential(await manager.validCredential({ signal: options.signal })))
        options.signal?.throwIfAborted()
        if (binding !== undefined) assertSubscriptionIdentity(binding.identity, credential)
        const headers = Object.fromEntries(Object.entries(options.headers ?? {}).filter(([name]) =>
          !['authorization', 'api-key', 'x-api-key', 'cf-aig-authorization'].includes(name.toLowerCase())))
        const wireModel = { ...model, provider: 'openai', baseUrl: API_BASE_URL }
        const source = api[mode](wireModel, openaiTranscript(context), {
          ...options,
          // DSH owns normal network recovery; never let Pi nest retries, even for direct callers.
          maxRetries: 0,
          fetch: async (input, init) => {
            const response = await (options.fetch ?? globalThis.fetch)(input, init)
            await policy.observeHttpResponse(response)
            return response
          },
          apiKey: credential.access,
          headers,
          env: {},
          onProviderStreamEvent: async event => {
            policy.observe(event)
            if (native) native.usageKnown = policy.usageKnown
            native?.observe(event)
            await options.onProviderStreamEvent?.(event, model)
          },
          onPayload: async payload => {
            const override = await options.onPayload?.(payload, model)
            try {
              const restored = restoreToolIdentityPayload(restoreNativePayload(override ?? payload, native?.plans ?? []),
                native?.historyTools ?? [])
              const projected = projectPayload(restored, model.id, true, native?.compaction)
              native?.declareTools(restored, projected)
              return projected
            } catch (error) {
              if (error instanceof CapabilityError) policy.requestError = error.message
              throw error
            }
          },
        })
        for await (const event of source) {
          if ('partial' in event) { partial = event.partial; restoreRoute(partial) }
          if (event.type === 'error') { fail(event.error); return }
          if (event.type === 'done') {
            restoreRoute(event.message)
            if (!policy.succeeded() || options.signal?.aborted) fail(event.message)
            else { output.push(event); output.end() }
            return
          }
          output.push(event)
        }
        // A source without done/error must never resolve as a successful replay.
        throw new Error('Stream ended without a terminal message')
      } catch (error) {
        if (error instanceof SubscriptionBindingError) policy.requestError = error.message
        if (error instanceof SiwcError && error.code === 'REAUTHORIZATION_REQUIRED') {
          policy.reauthorizationRequired = true
        }
        // Retain an existing partial message instead of manufacturing zero usage/content.
        fail(partial ?? {
          role: 'assistant', content: [], api: model.api, provider: PROVIDER_ID, model: model.id,
          timestamp: Date.now(), stopReason: 'error',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        })
      }
    })()
    return output
  }
  return {
    stream: (model, context, options) => dispatch('stream', model, context, options),
    streamSimple: (model, context, options) => dispatch('streamSimple', model, context, options),
  }
}

export function subscriptionProvider(manager: SubscriptionManager, catalog: readonly SiwcModel[], binding?: SubscriptionBinding): Provider {
  const frozenBinding = binding === undefined ? undefined : Object.freeze({
    identity: Object.freeze({ issuer: binding.identity.issuer, clientId: binding.identity.clientId,
      subject: binding.identity.subject, hostId: binding.identity.hostId,
      scopes: Object.freeze([...new Set(binding.identity.scopes)].sort()) }),
    ...(binding.lifetime === undefined ? {} : { lifetime: binding.lifetime }),
  })
  const definitions = subscriptionModelDefinitions(catalog).map(model => {
    const definition = structuredClone(model)
    Object.freeze(definition.input); Object.freeze(definition.cost)
    if (definition.compat) Object.freeze(definition.compat)
    if (definition.thinkingLevelMap) Object.freeze(definition.thinkingLevelMap)
    return Object.freeze(definition)
  })
  return Object.freeze(createProvider({
    id: PROVIDER_ID,
    name: 'ChatGPT subscription',
    baseUrl: API_BASE_URL,
    auth: {
      oauth: {
        name: 'ChatGPT subscription', isSubscription: true, loginLabel: 'Sign in with ChatGPT',
        login: interaction => manager.login({ notify: event => {
          if (event.type === 'auth_url' && event.url !== undefined) {
            interaction.notify({ type: 'auth_url', url: event.url,
              ...(event.instructions === undefined ? {} : { instructions: event.instructions }) })
          } else {
            interaction.notify({ type: 'info', message: event.message ?? 'Continue signing in with ChatGPT.' })
          }
        } }, { signal: interaction.signal }),
        refresh: (credential, signal) => manager.refreshCredential(credential, signal),
        toAuth: async credential => ({
          apiKey: validateSiwcCredential(credential).access,
          baseUrl: API_BASE_URL,
        }),
      },
    },
    models: definitions,
    api: subscriptionStreams(manager, frozenBinding),
  }))
}
