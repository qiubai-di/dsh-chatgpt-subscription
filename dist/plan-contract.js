/** Browser-safe contract. This module must not import credential or Node code. */
export const PLAN_PROVIDER_ID = 'openai-chatgpt';
export const PLAN_RPC_CHANNEL = '/chatgpt-subscription';
export const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';
export const PLAN_NOTICE = {
    title: 'Using ChatGPT plan',
    account: 'ChatGPT account',
    manageUsage: 'Manage usage',
    body: 'Requests use the ChatGPT account shown here and count toward its existing plan limits. Connecting this app does not add an allowance. Credits may be used if you allow them in ChatGPT Settings → Usage.',
    pricing: 'An API cost estimate of zero is not a balance, free usage, or an unlimited allowance.',
    privacy: 'Prompts and provided content are sent to OpenAI. store:false does not mean zero data retention.',
    signIn: 'Manage sign-in with dsh-chatgpt login / logout after closing the running DSH service.',
};
//# sourceMappingURL=plan-contract.js.map