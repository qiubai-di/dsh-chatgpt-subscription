import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
/**
 * Add native Responses output/citations without replacing Pi's tool, image or
 * reasoning converter. Both entry points wrap the same frozen Pi generation.
 */
export declare class SubscriptionAdapter extends LlmAdapter {
    private readonly inner;
    constructor(inner: PiAiAdapter);
    providerInfo(provider: string): import("@deepseek-ai/dsh-llm").LlmProviderInfo;
    providerRetryPolicy(provider: string): import("@deepseek-ai/dsh-llm").ResolvedRetryPolicy | undefined;
    imageRequestPricing(provider: string, model: string): import("@deepseek-ai/dsh-llm").LlmImageRequestPricing | undefined;
    imageRequestTarget(provider: string, model: string, image: ImageAttachmentRef): import("@deepseek-ai/dsh-attachment").ImageRequestTarget;
    listModels(provider: string): Promise<readonly import("@deepseek-ai/dsh-llm").LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<import("@deepseek-ai/dsh-llm").LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private wrap;
}
