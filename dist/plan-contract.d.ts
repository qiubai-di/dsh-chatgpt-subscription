/** Browser-safe contract. This module must not import credential or Node code. */
export declare const PLAN_PROVIDER_ID = "openai-chatgpt";
export declare const PLAN_RPC_CHANNEL = "/chatgpt-subscription";
export declare const MANAGE_USAGE_URL = "https://chatgpt.com/settings/usage";
export interface PlanStatus {
    /** A saved grant is not an online validity or remaining-allowance check. */
    readonly authorization: 'saved' | 'missing';
    readonly accountLabel: string;
    readonly manageUsageUrl: typeof MANAGE_USAGE_URL;
    readonly noticeRequired: boolean;
    /** Opaque receipt binding, never an OAuth token or raw account identifier. */
    readonly noticeId?: string;
}
export declare const PLAN_NOTICE: {
    readonly title: 'Using ChatGPT plan';
    readonly account: 'ChatGPT account';
    readonly manageUsage: 'Manage usage';
    readonly body: 'Requests use the ChatGPT account shown here and count toward its existing plan limits. Connecting this app does not add an allowance. Credits may be used if you allow them in ChatGPT Settings → Usage.';
    readonly pricing: 'An API cost estimate of zero is not a balance, free usage, or an unlimited allowance.';
    readonly privacy: 'Prompts and provided content are sent to OpenAI. store:false does not mean zero data retention.';
    readonly signIn: 'Manage sign-in with dsh-chatgpt login / logout after closing the running DSH service.';
};
