/** Producer facts describe this immutable native request projection, never usage or billing. */
export interface RequestPolicyFacts {
    version: 1;
    owner: string;
    generation: string;
    compactionTools?: 'none';
    lifetime?: AbortSignal;
    cache?: {
        mode: 'automatic' | 'explicit' | 'none';
        projection: string;
        responseStart: 'forwarded-content' | 'native-body';
        nativeBridge?: 'optchat-anthropic-v1';
    };
    capacity?: {
        totalOutputTokens: number;
        includesReasoning: true;
        invariant: 'all-native-generations-in-producer-scope';
        source: string;
    };
}
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** Synchronous admission facts. Updates and missing models return unknown. @mode bail */
        'optchat/request-policy'(provider: string, model: string, purpose: 'main' | 'compaction'): RequestPolicyFacts | undefined;
    }
}
/** Account identity stays in the provider closure; this generation is only a random lifecycle label. */
export declare function requestPolicyFacts(model: string, generation: string, lifetime: AbortSignal, purpose: 'main' | 'compaction'): Readonly<RequestPolicyFacts>;
