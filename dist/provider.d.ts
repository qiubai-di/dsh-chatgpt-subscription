import type { Provider } from '@earendil-works/pi-ai';
import type { SiwcModel } from './siwc.js';
import type { SubscriptionManager, SubscriptionIdentity } from './dsh-store.js';
export declare class CapabilityError extends Error {
}
/** Namespace + name selects a tool; its function/custom kind must also remain paired. */
export interface QualifiedToolIdentity {
    readonly namespace: string;
    readonly name: string;
    readonly type: 'function' | 'custom';
}
export declare function qualifiedToolKey(identity: Pick<QualifiedToolIdentity, 'namespace' | 'name'>): string;
/** Resolve only from supplied trusted declarations/identities; never assume a missing namespace is dsh. */
export declare function resolveToolIdentity(identities: readonly QualifiedToolIdentity[], selection: {
    name: unknown;
    namespace?: unknown;
    type?: unknown;
}): QualifiedToolIdentity;
/** The only wire projection layered on Pi's original Responses message/tool converter. */
export declare function subscriptionPayload(value: unknown, modelId: string): Record<string, unknown>;
export interface SubscriptionBinding {
    readonly identity: SubscriptionIdentity;
    readonly lifetime?: AbortSignal;
}
export declare function subscriptionProvider(manager: SubscriptionManager, catalog: readonly SiwcModel[], binding?: SubscriptionBinding): Provider;
