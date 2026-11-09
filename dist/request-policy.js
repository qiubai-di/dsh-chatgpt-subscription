const PROJECTION = 'pi-ai@1.3.0/openai-responses;subscription@0.2.0/native-replay-v2;tool-identity=v1;pi-replay-body-state=v1;' +
    'endpoint=api.openai.com/v1;store=false;stream=sse;system=developer;tools=dsh-namespace+web_search;' +
    'include=reasoning.encrypted_content+web_search_call.action.sources;cache=implicit-short;' +
    'omit=max-output,explicit-cache,temperature,top-p,previous-response';
/** Account identity stays in the provider closure; this generation is only a random lifecycle label. */
export function requestPolicyFacts(model, generation, lifetime, purpose) {
    const cache = Object.freeze({ mode: 'automatic', responseStart: 'forwarded-content',
        projection: PROJECTION + ';tool-choice=' + (purpose === 'compaction' ? 'none' : 'auto(default)') });
    const capacity = model === 'gpt-6.1-sol' ? Object.freeze({ totalOutputTokens: 128000,
        includesReasoning: true, invariant: 'all-native-generations-in-producer-scope',
        source: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol#maximum-output-tokens;' +
            'https://developers.openai.com/api/docs/guides/token-counting' }) : undefined;
    return Object.freeze({ version: 1, owner: 'dsh-chatgpt-subscription/native-responses-v1', generation,
        compactionTools: 'none', lifetime, cache, ...(capacity === undefined ? {} : { capacity }) });
}
//# sourceMappingURL=request-policy.js.map