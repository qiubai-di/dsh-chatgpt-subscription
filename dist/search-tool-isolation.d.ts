import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
/** Keep DSH search for other routes and old history, not this provider's new calls. */
export declare function installSearchToolIsolation(ctx: Context): void;
/** Let Pi project tool history against this route's current callable schemas. */
export declare function isolateSubscriptionSearch(options: GenerateOptions): GenerateOptions;
