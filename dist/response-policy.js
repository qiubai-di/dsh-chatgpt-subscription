const USAGE_URL = 'https://chatgpt.com/settings/usage';
const SAFE_CODES = [
    // Preserve the standard marker recognized by DSH without forwarding upstream text.
    'context_length_exceeded',
    'subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable',
    'permission_denied', 'insufficient_permissions', 'invalid_api_key', 'model_not_found',
];
const INCOMPLETE_REASONS = ['max_output_tokens', 'content_filter'];
export function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Only allowlisted identifiers, never provider messages, cross the error boundary. */
function safeCode(value) {
    if (typeof value !== 'string')
        return undefined;
    return SAFE_CODES.find(code => value === code);
}
function tokenCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
/** Pi does not map usage on response.failed; accept only a complete, consistent token report. */
function terminalUsage(value, cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }) {
    if (!record(value) || !tokenCount(value.input_tokens) || !tokenCount(value.output_tokens)
        || !tokenCount(value.total_tokens) || value.total_tokens !== value.input_tokens + value.output_tokens)
        return undefined;
    const inputDetails = record(value.input_tokens_details) ? value.input_tokens_details : {};
    const outputDetails = record(value.output_tokens_details) ? value.output_tokens_details : {};
    const cached = inputDetails.cached_tokens ?? 0;
    const written = inputDetails.cache_write_tokens ?? 0;
    const reasoning = outputDetails.reasoning_tokens ?? 0;
    if (!tokenCount(cached) || !tokenCount(written) || !tokenCount(reasoning)
        || cached + written > value.input_tokens || reasoning > value.output_tokens)
        return undefined;
    return { input: value.input_tokens - cached - written, output: value.output_tokens,
        cacheRead: cached, cacheWrite: written, reasoning, totalTokens: value.total_tokens, cost };
}
/** Observe before Pi parses, but enforce success only after it has retained content and usage. */
export class ResponsePolicy {
    terminal;
    code;
    networkError;
    requestError;
    reauthorizationRequired = false;
    observe(event) {
        if (!record(event))
            return;
        if (['response.completed', 'response.incomplete', 'response.failed', 'response.cancelled'].includes(String(event.type))) {
            const response = record(event.response) ? event.response : {};
            this.terminal = { type: String(event.type), response };
            this.code = record(response.error) ? safeCode(response.error.code) : undefined;
        }
        else if (event.type === 'error') {
            this.code = safeCode(event.code);
        }
    }
    /** Read the actual HTTP error code before Pi truncates its diagnostic string. */
    async observeHttpResponse(response) {
        if (response.status !== 400)
            return;
        try {
            const body = await response.clone().json();
            if (record(body) && record(body.error) && body.error.code === 'context_length_exceeded') {
                this.code = body.error.code;
            }
        }
        catch { /* Unknown/non-JSON error bodies remain private and unclassified. */ }
    }
    /** Pi requires numeric usage even without a report; DSH must not expose that sentinel as exact accounting. */
    get usageKnown() { return terminalUsage(this.terminal?.response.usage) !== undefined; }
    succeeded() {
        return this.terminal?.type === 'response.completed' && this.terminal.response.status === 'completed';
    }
    fail(message, aborted) {
        const response = this.terminal?.response;
        const usage = terminalUsage(response?.usage, message.usage.cost);
        if (usage)
            message.usage = usage;
        message.stopReason = aborted ? 'aborted' : 'error';
        // Pi can include raw upstream error text here. Replace rather than append it.
        delete message.diagnostics;
        const incomplete = this.terminal?.type === 'response.incomplete' || response?.status === 'incomplete';
        const cancelled = this.terminal?.type === 'response.cancelled' || response?.status === 'cancelled';
        const details = record(response?.incomplete_details) ? response.incomplete_details : {};
        const reason = INCOMPLETE_REASONS.find(value => value === details.reason);
        message.rawStopReason = aborted || cancelled ? 'cancelled' : this.reauthorizationRequired
            ? 'reauthorization_required' : incomplete
            ? `incomplete${reason ? `.${reason}` : ''}` : this.terminal ? 'failed' : 'stream_unfinished';
        if (aborted)
            message.errorMessage = 'The ChatGPT subscription request was cancelled.';
        else if (this.reauthorizationRequired) {
            message.errorMessage = 'ChatGPT 授权已过期或被撤销。请关闭当前 DSH 服务后运行 dsh-chatgpt login 重新授权。';
        }
        else if (this.code === 'subscription_sharing_usage_limit_exceeded') {
            message.errorMessage = `ChatGPT subscription usage limit exceeded (subscription_sharing_usage_limit_exceeded). Manage usage: ${USAGE_URL}`;
        }
        else if (this.code === 'subscription_sharing_usage_unavailable') {
            message.errorMessage = `ChatGPT subscription usage is unavailable (subscription_sharing_usage_unavailable). Manage usage: ${USAGE_URL}`;
        }
        else if (this.code)
            message.errorMessage = `ChatGPT subscription request failed (${this.code}).`;
        else if (this.requestError)
            message.errorMessage = this.requestError;
        else if (incomplete)
            message.errorMessage = `The ChatGPT subscription response was incomplete${reason ? ` (${reason})` : ''}.`;
        else if (cancelled)
            message.errorMessage = 'The ChatGPT subscription response was cancelled before completion.';
        else
            message.errorMessage = this.terminal
                ? 'The ChatGPT subscription response failed.'
                : this.networkError ?? 'The ChatGPT subscription request failed or ended before a completed response.';
        return message;
    }
    /** Keep DSH's normal network-retry classes, but never forward the upstream diagnostic text. */
    observeErrorText(value) {
        if (this.code || typeof value !== 'string')
            return;
        // Overflow is accepted only from a structured HTTP/SSE code, not private prose.
        this.code = SAFE_CODES.find(code => code !== 'context_length_exceeded'
            && new RegExp(`(?:^|[^a-zA-Z0-9_])${code}(?:$|[^a-zA-Z0-9_])`).test(value));
        if (this.code || this.terminal || this.requestError)
            return;
        if (/\b429\b|rate.?limit/i.test(value)) {
            this.networkError = 'The ChatGPT subscription request rate limit was reached.';
        }
        else if (/\b5\d\d\b/.test(value)) {
            // Preserve only the numeric HTTP status used by DSH's SERVER classifier.
            this.networkError = `The ChatGPT subscription server request failed (HTTP ${value.match(/\b5\d\d\b/)?.[0]}).`;
        }
        else if (/\btime(?:d)?\s*out\b|timeout/i.test(value)) {
            this.networkError = 'The ChatGPT subscription request timed out.';
        }
        else if (/stream ended (?:before|without)\b/i.test(value)) {
            this.networkError = 'The ChatGPT subscription stream ended before a completed response.';
        }
        else if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|\bterminated\b|premature close/i.test(value)) {
            this.networkError = 'The ChatGPT subscription network request failed.';
        }
    }
}
//# sourceMappingURL=response-policy.js.map