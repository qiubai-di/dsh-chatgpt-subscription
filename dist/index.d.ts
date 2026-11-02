import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai';
import { SubscriptionManager } from './dsh-store.js';
import type { SubscriptionBinding } from './provider.js';
import type { SiwcModel } from './siwc.js';
export { openSubscriptionStore, SubscriptionManager, SUBSCRIPTION_KEY } from './dsh-store.js';
export { PROVIDER_ID } from './catalog.js';
export declare const name = "chatgpt-subscription";
export declare const inject: string[];
export interface Config {
    /** Existing subscription home, shared without copying its grant into the host. */
    credentialHome?: string;
}
export declare const Config: z<Config>;
export declare function subscriptionProfile(manager: SubscriptionManager, models: readonly SiwcModel[], binding?: SubscriptionBinding): ResolvedPiAiProviderProfile;
export declare function apply(ctx: Context, config?: Config): Promise<void>;
