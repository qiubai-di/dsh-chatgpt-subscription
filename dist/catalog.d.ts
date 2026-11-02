import type { Model } from '@earendil-works/pi-ai';
import type { SiwcModel } from './siwc.js';
export declare const PROVIDER_ID = "openai-chatgpt";
export declare const AGENT_NAME = "DeepSeek Harness";
export declare const API_BASE_URL = "https://api.openai.com/v1";
/** Account entitlement comes from SIWC; capability facts come from the pinned Pi catalog. */
export declare function subscriptionModelDefinitions(entries: readonly SiwcModel[]): Model<'openai-responses'>[];
export declare function supportedSubscriptionModels(entries: readonly SiwcModel[]): SiwcModel[];
