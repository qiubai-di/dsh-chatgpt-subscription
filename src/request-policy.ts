/** Producer facts describe this immutable native request projection, never usage or billing. */
export interface RequestPolicyFacts {
  version: 1
  owner: string
  generation: string
  compactionTools?: 'none'
  lifetime?: AbortSignal
  cache?: {
    mode: 'automatic' | 'explicit' | 'none'
    projection: string
    responseStart: 'forwarded-content' | 'native-body'
    nativeBridge?: 'optchat-anthropic-v1'
  }
  capacity?: {
    totalOutputTokens: number
    includesReasoning: true
    invariant: 'all-native-generations-in-producer-scope'
    source: string
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Synchronous admission facts. Updates and missing models return unknown. @mode bail */
    'optchat/request-policy'(provider: string, model: string, purpose: 'main' | 'compaction'): RequestPolicyFacts | undefined
  }
}

const PROJECTION = 'pi-ai@1.3.0/openai-responses;subscription@0.1.8/native-replay-v2;tool-identity=v1;pi-replay-body-state=v1;' +
  'endpoint=api.openai.com/v1;store=false;stream=sse;system=developer;tools=dsh-namespace+web_search;' +
  'include=reasoning.encrypted_content+web_search_call.action.sources;cache=implicit-short;' +
  'omit=max-output,explicit-cache,temperature,top-p,previous-response'

/** Account identity stays in the provider closure; this generation is only a random lifecycle label. */
export function requestPolicyFacts(model: string, generation: string, lifetime: AbortSignal,
  purpose: 'main' | 'compaction'): Readonly<RequestPolicyFacts> {
  const cache = Object.freeze({ mode: 'automatic' as const, responseStart: 'forwarded-content' as const,
    projection: PROJECTION + ';tool-choice=' + (purpose === 'compaction' ? 'none' : 'auto(default)') })
  const capacity = model === 'gpt-6.1-sol' ? Object.freeze({ totalOutputTokens: 128000,
    includesReasoning: true as const, invariant: 'all-native-generations-in-producer-scope' as const,
    source: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol#maximum-output-tokens;' +
      'https://developers.openai.com/api/docs/guides/token-counting' }) : undefined
  return Object.freeze({ version: 1, owner: 'dsh-chatgpt-subscription/native-responses-v1', generation,
    compactionTools: 'none', lifetime, cache, ...(capacity === undefined ? {} : { capacity }) })
}
