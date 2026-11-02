import type { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { SiwcCredential } from './siwc.js';
import type { PlanStatus } from './plan-contract.js';
type PlanIdentity = Pick<SiwcCredential, 'clientId' | 'issuer' | 'subject' | 'email'>;
interface PlanStatusSource {
    /** Local read only. The implementation must never refresh or contact OpenAI. */
    credential(): Promise<PlanIdentity | undefined>;
    readonly credentials: Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>;
}
export declare class PlanStatusError extends Error {
    readonly code: 'NO_ACTIVE_ACCOUNT' | 'ACCOUNT_CHANGED' | 'INVALID_NOTICE_STATE';
    constructor(code: 'NO_ACTIVE_ACCOUNT' | 'ACCOUNT_CHANGED' | 'INVALID_NOTICE_STATE');
}
/** Only reads local state. In particular, never refreshes a grant or calls /models. */
export declare function readPlanStatus(source: PlanStatusSource, signal?: AbortSignal): Promise<PlanStatus>;
/** Records an informational notice only; it never changes OAuth consent or credits. */
export declare function acknowledgePlanNotice(source: PlanStatusSource, expectedId: string, signal?: AbortSignal): Promise<PlanStatus>;
export {};
