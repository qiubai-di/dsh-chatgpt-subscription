import type { AssistantMessage } from '@earendil-works/pi-ai';
export declare function record(value: unknown): value is Record<string, unknown>;
/** Observe before Pi parses, but enforce success only after it has retained content and usage. */
export declare class ResponsePolicy {
    private terminal?;
    private code?;
    private networkError?;
    requestError?: string;
    reauthorizationRequired: boolean;
    observe(event: unknown): void;
    /** Read the actual HTTP error code before Pi truncates its diagnostic string. */
    observeHttpResponse(response: Response): Promise<void>;
    /** Pi requires numeric usage even without a report; DSH must not expose that sentinel as exact accounting. */
    get usageKnown(): boolean;
    succeeded(): boolean;
    fail(message: AssistantMessage, aborted: boolean): AssistantMessage;
    /** Keep DSH's normal network-retry classes, but never forward the upstream diagnostic text. */
    observeErrorText(value: unknown): void;
}
