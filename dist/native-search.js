import { AsyncLocalStorage } from 'node:async_hooks';
import { record } from './response-policy.js';
import { resolveToolIdentity } from './provider.js';
/** Request-local bridge between the public Pi hooks and the outer DSH adapter. */
export const nativeSearchScope = new AsyncLocalStorage();
function markdownLabel(value) {
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/([\\`*_[\]{}()<>!#|])/g, '\\$1');
}
function citationLink(value) {
    if (!record(value) || value.type !== 'url_citation' || typeof value.url !== 'string')
        return undefined;
    try {
        const url = new URL(value.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
            return undefined;
        // Encode destination delimiters, whitespace and backslashes, not arbitrary Markdown.
        const destination = url.href.replace(/[\s()<>\\]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
        const label = typeof value.title === 'string' && value.title.trim() ? value.title : value.url;
        return `[${markdownLabel(label)}](${destination})`;
    }
    catch {
        return undefined;
    }
}
export class NativeSearchCapture {
    compaction;
    constructor(compaction = false) {
        this.compaction = compaction;
    }
    output;
    toolCallObserved = false;
    usageKnown = false;
    plans = [];
    historyTools = [];
    localFlatTools = [];
    executionTools = [];
    completedCalls = new Map();
    callIdentities = [];
    qualifyCall(item) {
        if ((item.type !== 'function_call' && item.type !== 'custom_tool_call') || item.namespace !== undefined)
            return item;
        const type = item.type === 'custom_tool_call' ? 'custom' : 'function';
        const identity = this.localFlatTools.find(tool => tool.name === item.name && tool.type === type);
        return identity ? { ...item, namespace: identity.namespace } : item;
    }
    /** Item-done is trustworthy identity even if terminal output cannot support full native replay. */
    toolOutput() {
        const calls = new Map(this.completedCalls);
        for (const item of this.output ?? []) {
            if ((item.type === 'function_call' || item.type === 'custom_tool_call') && !calls.has(String(item.call_id))) {
                calls.set(String(item.call_id), item);
            }
        }
        return [...calls.values()].map(item => this.qualifyCall(item));
    }
    /** Replay identity alone never grants a bare-name local execution binding. */
    canExecuteLocal(id, name) {
        const [callId, itemId, extra] = id.split('|');
        if (!callId || !itemId || extra !== undefined)
            return false;
        const matches = this.toolOutput().filter(item => item.call_id === callId && item.id === itemId && item.name === name);
        if (matches.length !== 1)
            return false;
        const item = matches[0];
        const type = item.type === 'function_call' ? 'function' : item.type === 'custom_tool_call' ? 'custom' : undefined;
        // Map de-duplication is useful for replay, but cannot erase contradictory
        // added/done/terminal evidence before a local tool is released. Missing
        // fields are not contradictions; explicit remote identity is never local.
        const evidence = [...this.callIdentities, ...(this.output ?? [])];
        if (evidence.some(value => {
            if (value.call_id !== callId && value.id !== itemId)
                return false;
            const identity = this.qualifyCall(value);
            return ['type', 'id', 'call_id', 'name', 'namespace'].some(key => identity[key] !== undefined && identity[key] !== item[key]);
        }))
            return false;
        return item.namespace === 'dsh' && type !== undefined && this.executionTools.some(tool => tool.namespace === 'dsh' && tool.name === name && tool.type === type);
    }
    /** Only this request's actual flat declarations can establish local provenance. */
    declareTools(raw, projected) {
        const lists = (value) => !record(value) ? [] : [
            ...(Array.isArray(value.tools) ? value.tools : []),
            ...(Array.isArray(value.input) ? value.input.flatMap(item => record(item) && item.type === 'additional_tools'
                && Array.isArray(item.tools) ? item.tools : []) : []),
        ];
        const declared = lists(projected).flatMap(group => record(group) && group.type === 'namespace' && Array.isArray(group.tools)
            ? group.tools.flatMap(tool => record(tool) ? [{ namespace: String(group.name), name: String(tool.name),
                    type: tool.type }] : []) : []);
        this.executionTools = declared.filter(tool => tool.namespace === 'dsh');
        this.localFlatTools = lists(raw).flatMap(tool => {
            if (!record(tool) || (tool.type !== 'function' && tool.type !== 'custom'))
                return [];
            try {
                const identity = resolveToolIdentity(declared, { name: tool.name, type: tool.type });
                return identity.namespace === 'dsh' ? [identity] : [];
            }
            catch {
                return [];
            } // Ambiguous/missing provenance is never a local default.
        });
    }
    messageIds = new Map();
    annotations = new Map();
    observe(event) {
        if (!record(event))
            return;
        if (this.compaction && typeof event.type === 'string' && /^response\.[^.]+_call\./.test(event.type)) {
            this.toolCallObserved = true;
        }
        if ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && record(event.item)) {
            // Hosted calls may never become Pi tool blocks. Keep this sticky even if
            // a later completed response omits the call from its output.
            if (this.compaction && typeof event.item.type === 'string' && event.item.type.endsWith('_call')) {
                this.toolCallObserved = true;
            }
            if ((event.item.type === 'function_call' || event.item.type === 'custom_tool_call') && typeof event.item.call_id === 'string') {
                const identity = {};
                for (const key of ['type', 'id', 'call_id', 'name', 'namespace']) {
                    if (Object.hasOwn(event.item, key))
                        identity[key] = event.item[key];
                }
                this.callIdentities.push(identity);
                if (event.type === 'response.output_item.done')
                    this.completedCalls.set(event.item.call_id, structuredClone(event.item));
            }
            if (event.item.type === 'message' && typeof event.item.id === 'string' && typeof event.output_index === 'number') {
                this.messageIds.set(event.output_index, event.item.id);
                this.observeMessage(event.item);
            }
        }
        if (event.type === 'response.output_text.annotation.added' && typeof event.output_index === 'number') {
            const id = this.messageIds.get(event.output_index);
            if (id !== undefined)
                this.annotations.set(id, [...(this.annotations.get(id) ?? []), event.annotation]);
        }
        if (['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(String(event.type))) {
            this.output = undefined;
            if (this.compaction && record(event.response) && Array.isArray(event.response.output)
                && event.response.output.some(item => record(item) && typeof item.type === 'string' && item.type.endsWith('_call'))) {
                this.toolCallObserved = true;
            }
            if (event.type === 'response.completed' && record(event.response) && event.response.status === 'completed'
                && Array.isArray(event.response.output) && event.response.output.every(record)) {
                // Provider event objects are read-only; own a detached JSON value, not Pi's mutable partial.
                this.output = structuredClone(event.response.output).map((item) => this.qualifyCall(item));
                for (const item of this.output)
                    this.observeMessage(item);
            }
        }
    }
    observeMessage(item) {
        if (item.type !== 'message' || typeof item.id !== 'string' || !Array.isArray(item.content))
            return;
        const annotations = item.content.flatMap(part => record(part) && Array.isArray(part.annotations) ? part.annotations : []);
        this.annotations.set(item.id, [...(this.annotations.get(item.id) ?? []), ...annotations]);
    }
    /** Associate actual annotations with their message id, never SSE output_index == Pi block index. */
    citationSuffix(messageId) {
        if (!messageId)
            return '';
        const links = [...new Set((this.annotations.get(messageId) ?? []).map(citationLink).filter((link) => link !== undefined))];
        // A message-local reference list avoids guessing Unicode annotation index units.
        // Search action.sources are visited URLs, not citation annotations, so do not label them citations.
        return links.length ? `\n\n引用来源（对应以上正文）：${links.join(' · ')}` : '';
    }
}
/** Public Pi text signatures carry native message identity (and optionally phase). */
export function textMessageId(block) {
    if (!record(block) || block.type !== 'text' || typeof block.textSignature !== 'string')
        return undefined;
    if (!block.textSignature.startsWith('{'))
        return block.textSignature;
    try {
        const signature = JSON.parse(block.textSignature);
        return record(signature) && signature.v === 1 && typeof signature.id === 'string' ? signature.id : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=native-search.js.map