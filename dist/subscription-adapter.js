import { BlockAssembler, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { NativeSearchCapture, nativeSearchScope, textMessageId } from './native-search.js';
import { nativeReplay, prepareNativeHistory, toolIdentityReplay } from './native-search-replay.js';
import { PROVIDER_ID } from './catalog.js';
import { CapabilityError } from './provider.js';
import { isolateSubscriptionSearch } from './search-tool-isolation.js';
/**
 * Add native Responses output/citations without replacing Pi's tool, image or
 * reasoning converter. Both entry points wrap the same frozen Pi generation.
 */
export class SubscriptionAdapter extends LlmAdapter {
    inner;
    constructor(inner) {
        super();
        this.inner = inner;
    }
    providerInfo(provider) { return this.inner.providerInfo(provider); }
    providerRetryPolicy(provider) { return this.inner.providerRetryPolicy(provider); }
    imageRequestPricing(provider, model) { return this.inner.imageRequestPricing(provider, model); }
    imageRequestTarget(provider, model, image) {
        return this.inner.imageRequestTarget(provider, model, image);
    }
    listModels(provider) { return this.inner.listModels(provider); }
    resolveModel(provider, model, signal) { return this.inner.resolveModel(provider, model, signal); }
    async prepareCall(provider, model, signal) {
        const prepared = await this.inner.prepareCall(provider, model, signal);
        return { model: prepared.model, stream: options => this.wrap(options, request => prepared.stream(request)) };
    }
    stream(options) {
        // Pi captures its profile synchronously here, before the consumer's first next.
        const prepared = this.inner.prepareCall(options.provider, options.model, options.signal);
        // Observe rejection even if the consumer abandons this unstarted iterable.
        void prepared.catch(() => { });
        return this.wrap(options, async function* (request) { yield* (await prepared).stream(request); });
    }
    async *wrap(options, stream) {
        if (options.provider !== PROVIDER_ID) {
            yield* stream(options);
            return;
        }
        const capture = new NativeSearchCapture(options.purpose === 'compaction');
        let request;
        try {
            request = prepareNativeHistory(isolateSubscriptionSearch(options), capture.plans, capture.historyTools);
        }
        catch (error) {
            if (!(error instanceof CapabilityError))
                throw error;
            yield { type: 'finish', reason: options.signal?.aborted ? { kind: 'aborted', failure: {
                        code: 'ABORTED', message: 'The ChatGPT subscription request was cancelled.',
                    } } : { kind: 'error', failure: { code: 'PI_AI_ERROR', message: error.message } } };
            return;
        }
        const original = new BlockAssembler();
        const durable = new BlockAssembler();
        const textEnds = new Map();
        let usage;
        const emit = (chunk) => { durable.push(chunk); return chunk; };
        const iterator = nativeSearchScope.run(capture, () => stream(request)[Symbol.asyncIterator]());
        let exhausted = false;
        let forbiddenToolCall = false;
        // Buffer the ordered tail from the first tool; otherwise later text would
        // overtake it and misalign durable blocks with Pi replay metadata.
        const pending = [];
        const isExecutable = (value) => value.type === 'tool-call-delta'
            || (value.type === 'block-start' && value.blockType === 'tool-call')
            || (value.type === 'block-end' && value.block.type === 'tool-call');
        try {
            while (true) {
                // Async generators execute on next(), not construction. Scope EVERY entry,
                // including cleanup, so interleaved requests never share provider-hook state.
                const next = await nativeSearchScope.run(capture, () => iterator.next());
                if (next.done) {
                    exhausted = true;
                    break;
                }
                const chunk = next.value;
                // Suppress every executable block before the host sees it, not just the
                // terminal tool-calls reason. Keep draining for trustworthy partial/usage.
                const executable = isExecutable(chunk);
                if (capture.compaction && executable) {
                    forbiddenToolCall = true;
                    continue;
                }
                original.push(chunk);
                // Pi drops namespaces on executable blocks. Hold them until completed raw
                // identities prove a declared local binding, never dispatch remote by name.
                if (executable) {
                    pending.push(chunk);
                    continue;
                }
                if (chunk.type === 'block-end' && chunk.block.type === 'text') {
                    textEnds.set(chunk.index, chunk);
                    continue;
                }
                if (chunk.type === 'usage') {
                    // Unknown Pi-internal zeros are not a provider report or DSH exact total.
                    if (capture.usageKnown)
                        usage = chunk;
                    continue;
                }
                if (chunk.type !== 'finish') {
                    if (pending.length)
                        pending.push(chunk);
                    else
                        yield emit(chunk);
                    continue;
                }
                forbiddenToolCall ||= capture.compaction && (capture.toolCallObserved || chunk.reason.kind === 'tool-calls');
                const toolChunks = pending.filter(isExecutable);
                const toolEnds = toolChunks.filter((value) => value.type === 'block-end');
                const endIndexes = new Set(toolEnds.map(end => end.index));
                const ids = new Set();
                const unboundToolCall = endIndexes.size !== toolEnds.length
                    || toolChunks.some(value => 'index' in value && !endIndexes.has(value.index))
                    || toolEnds.some(end => {
                        if (end.block.type !== 'tool-call' || ids.has(end.block.id))
                            return true;
                        ids.add(end.block.id);
                        return !capture.canExecuteLocal(end.block.id, end.block.name);
                    });
                const success = !forbiddenToolCall && !unboundToolCall && (chunk.reason.kind === 'stop' || chunk.reason.kind === 'tool-calls') && !options.signal?.aborted;
                for (const value of pending) {
                    if (!isExecutable(value) || (success && !options.signal?.aborted))
                        yield emit(value);
                }
                pending.length = 0;
                for (const [index, end] of textEnds) {
                    if (end.block.type !== 'text')
                        continue;
                    const suffix = success ? capture.citationSuffix(textMessageId(chunk.replayState?.blocks?.[index])) : '';
                    if (suffix)
                        yield emit({ type: 'text-delta', index, text: suffix });
                    yield emit({ ...end, block: { ...end.block, text: end.block.text + suffix } });
                }
                textEnds.clear();
                if (usage) {
                    yield emit(usage);
                    usage = undefined;
                }
                // The consumer can abort while a yielded citation, close or usage chunk
                // is being handled, after Pi has already buffered its completed finish.
                if (options.signal?.aborted || chunk.reason.kind === 'aborted') {
                    yield emit({ type: 'finish', reason: { kind: 'aborted', failure: {
                                code: 'ABORTED', message: 'The ChatGPT subscription request was cancelled.',
                            } } });
                    return;
                }
                // The guard must turn successful tool responses into failures, not erase
                // an already classified terminal failure (overflow/quota/transport).
                if (forbiddenToolCall && chunk.reason.kind !== 'error') {
                    yield emit({ type: 'finish', reason: { kind: 'error', failure: {
                                code: 'PI_AI_ERROR', message: 'The ChatGPT subscription compaction response returned a forbidden tool call.',
                            } } });
                    return;
                }
                if (unboundToolCall && chunk.reason.kind !== 'error') {
                    yield emit({ type: 'finish', reason: { kind: 'error', failure: {
                                code: 'PI_AI_ERROR', message: 'The ChatGPT subscription response returned a tool call without a declared local execution binding.',
                            } } });
                    return;
                }
                const pi = success ? toolIdentityReplay(capture.toolOutput(), chunk.replayState, durable.blocks()) : undefined;
                const replay = success ? nativeReplay(capture.output, pi, original.blocks(), durable.blocks(), options) ?? pi : undefined;
                // A missing optional value must be absent, not an own undefined property.
                // Strip stale inner state as well: failed output must never retain a success replay.
                const { replayState: _innerReplay, ...terminal } = chunk;
                yield emit(replay === undefined ? terminal : { ...terminal, replayState: replay });
                return;
            }
            // Preserve non-executable partial output on EOF/throw, but never release
            // tools without a successful, identity-validated terminal.
            for (const value of pending)
                if (!isExecutable(value))
                    yield emit(value);
            pending.length = 0;
            for (const end of textEnds.values())
                yield emit(end);
            if (usage)
                yield emit(usage);
        }
        catch (error) {
            for (const value of pending)
                if (!isExecutable(value))
                    yield emit(value);
            pending.length = 0;
            for (const end of textEnds.values())
                yield emit(end);
            if (usage)
                yield emit(usage);
            throw error;
        }
        finally {
            if (!exhausted)
                await nativeSearchScope.run(capture, () => iterator.return?.());
        }
    }
}
//# sourceMappingURL=subscription-adapter.js.map