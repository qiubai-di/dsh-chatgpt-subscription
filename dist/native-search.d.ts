import { AsyncLocalStorage } from 'node:async_hooks';
import type { NativeReplayPlan, ReplayToolIdentity } from './native-search-replay.js';
/** Request-local bridge between the public Pi hooks and the outer DSH adapter. */
export declare const nativeSearchScope: AsyncLocalStorage<NativeSearchCapture>;
export declare class NativeSearchCapture {
    readonly compaction: boolean;
    constructor(compaction?: boolean);
    output?: Record<string, unknown>[];
    toolCallObserved: boolean;
    usageKnown: boolean;
    readonly plans: NativeReplayPlan[];
    readonly historyTools: ReplayToolIdentity[];
    private localFlatTools;
    private executionTools;
    private readonly completedCalls;
    private readonly callIdentities;
    private qualifyCall;
    /** Item-done is trustworthy identity even if terminal output cannot support full native replay. */
    toolOutput(): Record<string, unknown>[];
    /** Replay identity alone never grants a bare-name local execution binding. */
    canExecuteLocal(id: string, name: string): boolean;
    /** Only this request's actual flat declarations can establish local provenance. */
    declareTools(raw: unknown, projected: Record<string, unknown>): void;
    private readonly messageIds;
    private readonly annotations;
    observe(event: unknown): void;
    private observeMessage;
    /** Associate actual annotations with their message id, never SSE output_index == Pi block index. */
    citationSuffix(messageId: string | undefined): string;
}
/** Public Pi text signatures carry native message identity (and optionally phase). */
export declare function textMessageId(block: unknown): string | undefined;
