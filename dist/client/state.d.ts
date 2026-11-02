import type { PlanStatus } from '../plan-contract.js';
/** Deliberately narrow browser transport: no credential or Host implementation imports. */
export interface PlanRpc {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
}
export interface PlanClientSnapshot {
    readonly phase: 'idle' | 'loading' | 'ready' | 'error';
    readonly status?: PlanStatus;
    readonly confirming: boolean;
    readonly confirmationFailed: boolean;
}
/** Exact wire allowlist; reject unexpected fields rather than retaining a raw response. */
export declare function parsePlanStatus(value: unknown): PlanStatus;
/** Cancellation and monotone generations prevent stale account responses crossing sessions. */
export declare class PlanClientState {
    private readonly rpc;
    private snapshot;
    private readonly listeners;
    private active;
    private generation;
    private operation;
    constructor(rpc: PlanRpc);
    readonly getSnapshot: () => PlanClientSnapshot;
    readonly subscribe: (listener: () => void) => (() => void);
    private publish;
    setActive(active: boolean): void;
    refresh(force?: boolean): Promise<void>;
    acknowledge(): Promise<void>;
    private request;
    dispose(): void;
}
