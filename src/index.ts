import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LlmError, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { API_BASE_URL, PROVIDER_ID } from './catalog.js'
import { openSubscriptionStore, SUBSCRIPTION_KEY, SubscriptionManager } from './dsh-store.js'
import { subscriptionProvider } from './provider.js'
import type { SubscriptionBinding } from './provider.js'
import { requestPolicyFacts } from './request-policy.js'
import type { RequestPolicyFacts } from './request-policy.js'
import { acquireOperationLease, LocalSetupError } from './runtime.js'
import type { OperationLease } from './runtime.js'
import type { SiwcModel } from './siwc.js'
import { PLAN_RPC_CHANNEL } from './plan-contract.js'
import { planRpcHandler } from './plan-rpc.js'
import { installSearchToolIsolation } from './search-tool-isolation.js'
import { SubscriptionAdapter } from './subscription-adapter.js'

export { openSubscriptionStore, SubscriptionManager, SUBSCRIPTION_KEY } from './dsh-store.js'
export { PROVIDER_ID } from './catalog.js'
export const name = 'chatgpt-subscription'
export const inject = ['credentials', 'llm']

export interface Config {
  /** Existing subscription home, shared without copying its grant into the host. */
  credentialHome?: string
}

export const Config: z<Config> = z.object({ credentialHome: z.string() })

export function subscriptionProfile(manager: SubscriptionManager, models: readonly SiwcModel[], binding?: SubscriptionBinding): ResolvedPiAiProviderProfile {
  return Object.freeze({
    provider: PROVIDER_ID, displayName: 'ChatGPT subscription',
    api: 'openai-responses', baseURL: API_BASE_URL,
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: resolveRetryPolicy(undefined, 'chatgpt-subscription'),
    transport: 'sse', cacheRetention: 'short',
    piProvider: subscriptionProvider(manager, models, binding),
    modelErrors: new Map(), configuredMaxTokens: new Map(),
  })
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (config.credentialHome !== undefined && !isAbsolute(config.credentialHome)) {
    throw new LocalSetupError('INVALID_CREDENTIAL_HOME', 'ChatGPT credentialHome 必须是绝对路径。')
  }
  ctx.inject(['tools', 'systemPrompt'], policy => installSearchToolIsolation(policy))
  await ctx.effect(async function* () {
    let store: Awaited<ReturnType<typeof openSubscriptionStore>> | undefined
    let lease: OperationLease | undefined
    let unsubscribe: (() => void) | undefined
    let stopped = false
    const lifetime = new AbortController()
    const instance = randomUUID()
    let sequence = 0
    // One owner enforces close-before-unlock on unload and failed startup alike.
    yield async () => {
      stopped = true
      sequence++
      // Feed changes only revoke new admissions. Only the producer's owner ends this lifetime.
      lifetime.abort(new Error('ChatGPT subscription route disposed'))
      unsubscribe?.()
      try { await store?.dispose() }
      finally { await lease?.release() }
    }
    let manager: SubscriptionManager
    if (config.credentialHome === undefined) {
      // The isolated launcher's run lease already covers this mode.
      manager = new SubscriptionManager(ctx.credentials)
    } else {
      lease = await acquireOperationLease(config.credentialHome, 'web')
      store = await openSubscriptionStore(config.credentialHome, { watch: true })
      manager = store.manager
    }
    // The optional Web half reuses this manager and Connection's authenticated carrier.
    ctx.inject(['connection', 'webServer'], web => {
      web.connection.rpc.handle(PLAN_RPC_CHANNEL, planRpcHandler(manager, () => !stopped))
    })
    type Publication = {
      profiles: Map<string, ResolvedPiAiProviderProfile>
      policies: Map<string, { main: Readonly<RequestPolicyFacts>; compaction: Readonly<RequestPolicyFacts> }>
    }
    const withdrawnProfile = subscriptionProfile(manager, [])
    const unavailable = (): Publication => ({ profiles: new Map([[PROVIDER_ID, withdrawnProfile]]), policies: new Map() })
    let published = unavailable()
    ctx.on('optchat/request-policy', (provider, model, purpose) =>
      stopped || provider !== PROVIDER_ID ? undefined : published.policies.get(model)?.[purpose])
    const adapter = new PiAiAdapter({
      profiles: () => published.profiles,
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
        attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
      resolveApiKey: async () => {
        if (await manager.credential() === undefined) {
          throw new LlmError('ChatGPT subscription is not signed in. Run dsh-chatgpt login first.', 'MISSING_CREDENTIAL')
        }
        return undefined
      },
      auth: {
        credentials: manager.credentialStore,
        authContext: { env: async () => undefined, fileExists: async () => false },
      },
      onReplayDegrade: ({ provider, model, reason }) =>
        ctx.logger.warn('chatgpt-subscription: unusable replay state for %s/%s (%s)', provider, model, reason),
    })
    const registration = ctx.llm.registerAdapter([PROVIDER_ID], new SubscriptionAdapter(adapter))
    const update = async () => {
      const selected = ++sequence
      // Native credential notifications are synchronous. Revoke before the first await,
      // including notifications emitted by this route's own token refresh.
      published = unavailable()
      registration.replace([PROVIDER_ID])
      const snapshot = await manager.snapshot()
      if (stopped || selected !== sequence) return
      const policies: Publication['policies'] = new Map()
      if (snapshot.identity !== undefined) {
        for (const model of snapshot.models) policies.set(model.id, {
          main: requestPolicyFacts(model.id, `${instance}:${selected}`, lifetime.signal, 'main'),
          compaction: requestPolicyFacts(model.id, `${instance}:${selected}`, lifetime.signal, 'compaction'),
        })
      }
      const profile = subscriptionProfile(manager, snapshot.models, snapshot.identity === undefined ? undefined :
        { identity: snapshot.identity, lifetime: lifetime.signal })
      // Profile, private identity and public facts are published in one synchronous swap.
      published = { profiles: new Map([[PROVIDER_ID, profile]]), policies }
      registration.replace([PROVIDER_ID])
    }
    const onRecordUpdated = (key: typeof SUBSCRIPTION_KEY) => {
      if (key !== SUBSCRIPTION_KEY) return
      return update().catch(() => {
        // A failed read leaves the route unknown. Do not log credential payloads.
        if (!stopped) ctx.logger.warn('chatgpt-subscription: credential snapshot unavailable')
      })
    }
    unsubscribe = store === undefined
      ? ctx.on('credentials/record-updated', onRecordUpdated)
      : store.onRecordUpdated(onRecordUpdated)
    // Subscribe before hydration; a later notification wins over any late initial read.
    await update()
  }, 'chatgpt-subscription credentials')
}
