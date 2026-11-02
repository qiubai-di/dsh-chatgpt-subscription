import type { Model } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import type { SiwcModel } from './siwc.js'

export const PROVIDER_ID = 'openai-chatgpt'
export const AGENT_NAME = 'DeepSeek Harness'
export const API_BASE_URL = 'https://api.openai.com/v1'

/** Account entitlement comes from SIWC; capability facts come from the pinned Pi catalog. */
export function subscriptionModelDefinitions(entries: readonly SiwcModel[]): Model<'openai-responses'>[] {
  const catalog = openaiProvider().getModels()
  return entries.flatMap((entry) => {
    const known = catalog.find(model => model.id === entry.id && model.api === 'openai-responses')
    if (known === undefined) return []
    return [{
      ...known,
      api: 'openai-responses' as const,
      provider: PROVIDER_ID,
      baseUrl: API_BASE_URL,
      name: entry.name,
      // User-requested local window; OpenAI still enforces the actual server limit.
      contextWindow: known.id === 'gpt-6.1-sol' ? 500_000 : known.contextWindow,
      // Keep pinned per-model modalities; account entitlement alone does not imply vision.
      input: [...known.input],
      // Subscription usage is not separately charged at API token prices.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        ...known.compat,
        supportsDeveloperRole: true,
        supportsMidConvoSystemMessages: true,
        supportsAdditionalTools: true,
        supportsToolSearch: false,
        supportsMaxOutputTokens: false,
        supportsLongCacheRetention: false,
      },
    }]
  })
}

export function supportedSubscriptionModels(entries: readonly SiwcModel[]): SiwcModel[] {
  return subscriptionModelDefinitions(entries).map(model => ({ id: model.id, name: model.name }))
}
