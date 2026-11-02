export interface LoopbackResult {
    code: string;
    clientId: string;
}
export interface LoopbackOptions {
    state: string;
    clientId?: string;
    signal?: AbortSignal;
    timeoutMs: number;
}
/** A single, state-bound callback. Invalid unsolicited callbacks do not consume it. */
export declare function startLoopback(options: LoopbackOptions): Promise<{
    redirectUri: string;
    result: Promise<LoopbackResult>;
    close: () => Promise<void>;
}>;
