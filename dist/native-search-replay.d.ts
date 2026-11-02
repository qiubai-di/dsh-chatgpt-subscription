import type { ContentBlock, GenerateOptions, ReplayEnvelope } from '@deepseek-ai/dsh-llm';
import type { QualifiedToolIdentity } from './provider.js';
export interface ReplayToolIdentity extends QualifiedToolIdentity {
    id: string;
}
export interface NativeReplayPlan {
    start: string;
    end: string;
    output: Record<string, unknown>[];
}
/** Preserve identity even when full native replay is unavailable; never store old arguments here. */
export declare function toolIdentityReplay(output: Record<string, unknown>[] | undefined, pi: ReplayEnvelope | undefined, content: readonly ContentBlock[]): ReplayEnvelope | undefined;
/** Preserve old Pi envelopes. New invalid envelopes degrade to the current visible blocks, not stale raw output. */
export declare function prepareNativeHistory(options: GenerateOptions, plans: NativeReplayPlan[], tools?: ReplayToolIdentity[]): GenerateOptions;
/** Exact per-message spans; never match by text, output_index, or the first assistant item. */
export declare function restoreNativePayload(value: unknown, plans: readonly NativeReplayPlan[]): unknown;
/** Repair only identity/type lost by Pi; payload arguments and results remain current. */
export declare function restoreToolIdentityPayload(value: unknown, tools: readonly ReplayToolIdentity[]): unknown;
export declare function nativeReplay(output: Record<string, unknown>[] | undefined, pi: ReplayEnvelope | undefined, originalContent: readonly ContentBlock[], durableContent: readonly ContentBlock[], options: GenerateOptions): ReplayEnvelope | undefined;
